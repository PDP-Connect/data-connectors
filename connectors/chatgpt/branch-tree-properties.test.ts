// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import fc from "fast-check";
import { describe, expect, it } from "vitest";

fc.configureGlobal({ seed: 1928, numRuns: 100 });
import {
	countBranchMessages,
	extractMessageWithBlob,
	flattenTreeCurrentBranch,
	reconcileEmittedBranchMessages,
} from "./parsers.ts";
import {
	processConversationDetail,
	setChatGptDiagnosticSink,
} from "./index.ts";
import type { ChatGptNode } from "./types.ts";

// ─── Generator ────────────────────────────────────────────────────────────
// Builds a mapping plus the generator-known main chain, so the expected
// branch is an oracle independent of the walk implementation.

type NodeKind =
	| "user"
	| "assistant"
	| "system"
	| "messageNull" // tombstoned under D3
	| "roleLess" // message present, author.role missing
	| "emptyText" // parts: [""] — must be emitted as ""
	| "emptyParts" // parts: [] — unknown, content null
	| "mixedEmptyAsset"; // parts: ["", asset] — unknown, content null

interface GenTree {
	mapping: Record<string, ChatGptNode>;
	/** Main chain, root→tip, as constructed (before any defect is applied). */
	chain: string[];
	currentNode: string;
}

const nodeIdArb = fc
	.string({ minLength: 1, maxLength: 12 })
	.filter((s) => /^\S+$/.test(s));

function messageFor(kind: NodeKind, role: string): ChatGptNode["message"] {
	switch (kind) {
		case "messageNull":
			return null as unknown as ChatGptNode["message"];
		case "roleLess":
			return {
				author: {},
				content: { content_type: "text", parts: ["x"] },
			} as ChatGptNode["message"];
		case "emptyText":
			return {
				author: { role },
				content: { content_type: "text", parts: [""] },
			} as ChatGptNode["message"];
		case "emptyParts":
			return {
				author: { role },
				content: { content_type: "text", parts: [] },
			} as ChatGptNode["message"];
		case "mixedEmptyAsset":
			return {
				author: { role },
				content: { content_type: "text", parts: ["", { pointer: "asset:1" }] },
			} as ChatGptNode["message"];
		default:
			return {
				author: { role },
				content: { content_type: "text", parts: [`msg-${kind}`] },
			} as ChatGptNode["message"];
	}
}

function kindRole(kind: NodeKind): string {
	if (kind === "system") return "system";
	if (kind === "assistant") return "assistant";
	return "user";
}

/** A mapping with one main chain, optional side branches, and a chosen tip. */
const treeArb: fc.Arbitrary<GenTree> = fc
	.tuple(
		fc.integer({ min: 1, max: 12 }), // main-chain length (excluding root)
		fc.array(
			fc.oneof(
				fc.constant("user" as const),
				fc.constant("assistant" as const),
				fc.constant("system" as const),
				fc.constant("emptyText" as const),
			),
			{ minLength: 1, maxLength: 12 },
		),
		fc.integer({ min: 0, max: 3 }), // side-branch count
	)
	.chain(([chainLen, kinds, sideCount]) =>
		fc
			.tuple(
				fc.uniqueArray(nodeIdArb, {
					minLength: chainLen + sideCount + 2,
					maxLength: chainLen + sideCount + 2,
				}),
				fc.integer({ min: 0, max: chainLen }), // tip index: 0=root..chainLen
			)
			.map(([ids, tipIdx]) => {
				const mapping: Record<string, ChatGptNode> = Object.create(null);
				const chain: string[] = [];
				// Synthetic root: message null, no parent.
				const root = ids[0]!;
				mapping[root] = { parent: null, children: [], message: null };
				chain.push(root);
				let prev = root;
				for (let i = 0; i < chainLen; i++) {
					const id = ids[1 + i]!;
					const kind = kinds[i % kinds.length]!;
					mapping[id] = {
						parent: prev,
						children: [],
						message: messageFor(kind, kindRole(kind)),
					};
					mapping[prev]!.children!.push(id);
					chain.push(id);
					prev = id;
				}
				// Side branches off random chain nodes; never on the main chain.
				for (let s = 0; s < sideCount; s++) {
					const off = chain[s % chain.length]!;
					const id = ids[1 + chainLen + s]!;
					mapping[id] = {
						parent: off,
						children: [],
						message: messageFor("assistant", "assistant"),
					};
					mapping[off]!.children!.push(id);
				}
				return { mapping, chain, currentNode: chain[tipIdx]! };
			}),
	);

const deepChainArb = (depth: number): fc.Arbitrary<GenTree> =>
	fc
		.uniqueArray(nodeIdArb, { minLength: depth + 1, maxLength: depth + 1 })
		.map((ids) => {
			const mapping: Record<string, ChatGptNode> = Object.create(null);
			const chain: string[] = [];
			ids.forEach((id, i) => {
				mapping[id] = {
					parent: i === 0 ? null : ids[i - 1]!,
					children: [],
					message:
						i === 0
							? null
							: messageFor(
									i % 2 === 0 ? "assistant" : "user",
									i % 2 === 0 ? "assistant" : "user",
								),
				};
				chain.push(id);
			});
			return { mapping, chain, currentNode: ids[ids.length - 1]! };
		});

// ─── Parsers block ────────────────────────────────────────────────────────

describe("flattenTreeCurrentBranch", () => {
	it("T1: walk equals the generator-known chain prefix (P1, P2)", () => {
		fc.assert(
			fc.property(treeArb, ({ mapping, chain, currentNode }) => {
				const tipIdx = chain.indexOf(currentNode);
				const expected = chain.slice(0, tipIdx + 1);
				const got = flattenTreeCurrentBranch(mapping, currentNode).map(
					(x) => x.nodeId,
				);
				expect(got).toEqual(expected);
				// Order follows parent links exactly: each step's parent is previous.
				for (let i = 1; i < got.length; i++) {
					expect(mapping[got[i]!]!.parent).toBe(got[i - 1]);
				}
			}),
		);
	});

	it("T2: current_node on a non-leaf truncates at the tip (P1, P2)", () => {
		fc.assert(
			fc.property(treeArb, ({ mapping, chain, currentNode }) => {
				const got = flattenTreeCurrentBranch(mapping, currentNode);
				expect(got[got.length - 1]!.nodeId).toBe(currentNode);
				// No side-branch node ever appears.
				const chainSet = new Set(chain);
				for (const { nodeId } of got) expect(chainSet.has(nodeId)).toBe(true);
			}),
		);
	});

	it("T3: missing current_node yields an empty walk (P8)", () => {
		fc.assert(
			fc.property(treeArb, ({ mapping }) => {
				expect(flattenTreeCurrentBranch(mapping, "no-such-node")).toEqual([]);
				expect(flattenTreeCurrentBranch(mapping, null)).toEqual([]);
				expect(flattenTreeCurrentBranch(mapping, undefined)).toEqual([]);
			}),
		);
	});

	it("T4: dangling parent yields the reachable prefix, silently (P8)", () => {
		fc.assert(
			fc.property(treeArb, ({ mapping, chain, currentNode }) => {
				const tipIdx = chain.indexOf(currentNode);
				if (tipIdx < 2) return; // need a mid-chain cut point
				const cut = chain[1]!;
				const broken = {
					...mapping,
					[cut]: { ...mapping[cut]!, parent: "missing-parent" },
				};
				const got = flattenTreeCurrentBranch(broken, currentNode).map(
					(x) => x.nodeId,
				);
				// Prefix from the cut node up to the tip; nothing root-ward of it.
				expect(got).toEqual(chain.slice(1, tipIdx + 1));
			}),
		);
	});

	it("T5: cycles terminate and never repeat a node (P9)", () => {
		fc.assert(
			fc.property(treeArb, ({ mapping, chain, currentNode }) => {
				const tipIdx = chain.indexOf(currentNode);
				if (tipIdx < 2) return;
				// Point the root's parent at the tip: a cycle on the chain.
				const cyclic = {
					...mapping,
					[chain[0]!]: { ...mapping[chain[0]!]!, parent: currentNode },
				};
				const got = flattenTreeCurrentBranch(cyclic, currentNode).map(
					(x) => x.nodeId,
				);
				expect(new Set(got).size).toBe(got.length);
				expect(got).toEqual(chain.slice(0, tipIdx + 1));
			}),
		);
		// Self-loop variant (single-node cycle).
		const self: Record<string, ChatGptNode> = {
			a: { parent: "a", children: [], message: messageFor("user", "user") },
		};
		expect(flattenTreeCurrentBranch(self, "a").map((x) => x.nodeId)).toEqual([
			"a",
		]);
	});

	it("T6: deep chains do not recurse (P10)", () => {
		fc.assert(
			fc.property(deepChainArb(500), ({ mapping, chain, currentNode }) => {
				expect(
					flattenTreeCurrentBranch(mapping, currentNode).map((x) => x.nodeId),
				).toEqual(chain);
			}),
		);
		// Opt-in 10k smoke (slow): raise via env/flag in CI, not by default.
	});

	it("T7: countBranchMessages counts role-bearing walk nodes only (P1)", () => {
		fc.assert(
			fc.property(treeArb, ({ mapping, chain, currentNode }) => {
				const tipIdx = chain.indexOf(currentNode);
				const expected = chain
					.slice(0, tipIdx + 1)
					.filter((id) => mapping[id]!.message?.author?.role).length;
				expect(countBranchMessages(mapping, currentNode)).toBe(expected);
			}),
		);
	});
});

describe("message extraction (P5, P6, P7)", () => {
	it("T8: explicit empty text is emitted as empty, not dropped (P5)", () => {
		const node: ChatGptNode = {
			parent: null,
			children: [],
			message: messageFor("emptyText", "user"),
		};
		const rec = extractMessageWithBlob("n1", node, "c1", true).record!;
		expect(rec.role).toBe("user");
		expect(rec.content).toBe(""); // pins encodePdppSafeText("") === ""; see report P5
		expect(rec.on_current_branch).toBe(true);
	});

	it("T9: empty-parts vs mixed-empty-asset vs message-null (P5, P7)", () => {
		const emptyParts = extractMessageWithBlob(
			"n1",
			{ parent: null, children: [], message: messageFor("emptyParts", "user") },
			"c1",
			true,
		).record!;
		expect(emptyParts.content).toBeNull();
		const mixed = extractMessageWithBlob(
			"n2",
			{
				parent: null,
				children: [],
				message: messageFor("mixedEmptyAsset", "user"),
			},
			"c1",
			true,
		).record!;
		expect(mixed.content).toBeNull();
		// Tombstoned (D3): no message at all → no record; the index-level filter
		// (non_message) is pinned by the seam test, not here.
		expect(
			extractMessageWithBlob(
				"n3",
				{
					parent: null,
					children: [],
					message: messageFor("messageNull", "user"),
				},
				"c1",
				true,
			).record,
		).toBeNull();
		// Role-less message: record exists with role null; index.ts drops it.
		const roleLess = extractMessageWithBlob(
			"n4",
			{ parent: null, children: [], message: messageFor("roleLess", "user") },
			"c1",
			true,
		).record!;
		expect(roleLess.role).toBeNull();
	});

	it("T10: system nodes and unknown metadata are not filtered (P6)", () => {
		const node: ChatGptNode = {
			parent: null,
			children: [],
			message: messageFor("system", "system"),
			hidden: true, // unmodeled marker (D3): must not change extraction
			deleted: true,
		} as ChatGptNode;
		const rec = extractMessageWithBlob("n1", node, "c1", true).record!;
		expect(rec.role).toBe("system");
		expect(rec.content).not.toBeNull();
	});

	it("T11: reconcile relinks across gaps, keeps the first parent (P2)", () => {
		const msgs = [
			{ id: "a", parent_id: "synthetic-root", on_current_branch: true },
			{ id: "c", parent_id: "b", on_current_branch: true }, // b filtered out
			{ id: "off", parent_id: "a", on_current_branch: false },
		];
		const out = reconcileEmittedBranchMessages(msgs as never[]);
		expect(out.messages.map((m) => m.id)).toEqual(["a", "c"]);
		expect(out.messages[0]!.parent_id).toBe("synthetic-root");
		expect(out.messages[1]!.parent_id).toBe("a");
		expect(out.currentNode).toBe("c");
		expect(out.count).toBe(2);
	});
});

// ─── Seam block: processConversationDetail (P3, P4, P11) ──────────────────
// Verify publication and gaps at the connector boundary.

describe("processConversationDetail seam", () => {
	async function runDetail(
		mapping: Record<string, ChatGptNode>,
		currentNode: string | null,
		selected?: (stream: string, data: Record<string, unknown>) => boolean,
	) {
		const emitted: Array<{ stream: string; data: unknown }> = [];
		const records: Array<{ stream: string; data: unknown }> = [];
		const diagnostics: string[] = [];
		setChatGptDiagnosticSink((line: string) => {
			diagnostics.push(line);
		});
		try {
			const deps = {
				emit: async (msg: unknown) => {
					emitted.push({ stream: "diagnostic-or-gap", data: msg });
				},
				emitRecord: async (stream: string, data: unknown) => {
					records.push({ stream, data });
				},
				isRecordSelected: selected,
				emittedMessageIdsThisRun: new Set<string>(),
				emittedMessageParentsThisRun: new Map<string, string | null>(),
			};
			const conv: { id: string; current_node: string | null } = {
				id: "conv-1",
				current_node: currentNode,
			};
			const detail = {
				status: 200,
				json: { mapping, current_node: currentNode },
			};
			const conversations: unknown[] = [];
			const outcome = await processConversationDetail(
				deps as never,
				conv as never,
				detail as never,
				async (_c: unknown, d: unknown) => {
					conversations.push(d);
				},
			);
			return { emitted, records, diagnostics, conversations, outcome };
		} finally {
			setChatGptDiagnosticSink(undefined);
		}
	}

	function simpleChain(): {
		mapping: Record<string, ChatGptNode>;
		tip: string;
	} {
		const mapping: Record<string, ChatGptNode> = {
			root: { parent: null, children: ["u1"], message: null },
			u1: {
				parent: "root",
				children: ["a1"],
				message: {
					author: { role: "user" },
					content: { content_type: "text", parts: ["hi"] },
				},
			},
			a1: {
				parent: "u1",
				children: [],
				message: {
					author: { role: "assistant" },
					content: { content_type: "text", parts: ["reply"] },
				},
			},
		};
		return { mapping, tip: "a1" };
	}

	it("S1: clean branch emits messages + conversation, no gap (P3, P11)", async () => {
		const { mapping, tip } = simpleChain();
		const r = await runDetail(mapping, tip);
		expect(r.outcome).toEqual({ complete: true });
		expect(r.records.filter((x) => x.stream === "messages")).toHaveLength(2);
		expect(r.emitted).toHaveLength(0);
	});

	it("a null root and hidden system turn remain complete", async () => {
		const { mapping, tip } = simpleChain();
		mapping.root = { parent: null, children: ["sys"], message: null };
		mapping.sys = {
			parent: "root",
			children: ["u1"],
			message: {
				author: { role: "system" },
				content: { content_type: "text", parts: ["hidden"] },
				metadata: { is_visually_hidden_from_conversation: true },
			},
		};
		mapping.u1 = { ...mapping.u1!, parent: "sys" };
		const r = await runDetail(mapping, tip);
		expect(r.outcome).toEqual({ complete: true });
		expect(r.records.filter((x) => x.stream === "messages")).toHaveLength(3);
		expect(r.emitted).toHaveLength(0);
	});

	it("caller-selected message filtering does not create a gap", async () => {
		const { mapping, tip } = simpleChain();
		const r = await runDetail(
			mapping,
			tip,
			(_stream, data) => data.node_id !== "u1",
		);
		expect(r.outcome).toEqual({ complete: true });
		expect(r.records.filter((x) => x.stream === "messages")).toHaveLength(1);
		expect(r.emitted).toHaveLength(0);
	});

	it("a roleless non-root tip is incomplete", async () => {
		const { mapping } = simpleChain();
		mapping.a1 = { ...mapping.a1!, message: null };
		const r = await runDetail(mapping, "a1");
		expect(r.outcome).toEqual({
			complete: false,
			reason: "branch_structurally_incomplete",
		});
		expect(r.records).toHaveLength(0);
		expect(r.emitted).toHaveLength(1);
	});

	it("S2: dangling parent gaps and emits nothing (P4a, P8)", async () => {
		const { mapping, tip } = simpleChain();
		mapping["u1"] = { ...mapping["u1"]!, parent: "missing" };
		const r = await runDetail(mapping, tip);
		expect(r.outcome).toEqual({
			complete: false,
			reason: "branch_structurally_incomplete",
		});
		expect(r.records).toHaveLength(0);
		expect(r.emitted).toHaveLength(1); // the DETAIL_GAP
	});

	it("S3: cycle gaps and emits nothing (P4a, P9)", async () => {
		const { mapping, tip } = simpleChain();
		mapping["root"] = { ...mapping["root"]!, parent: tip };
		const r = await runDetail(mapping, tip);
		expect(r.outcome).toEqual({
			complete: false,
			reason: "branch_structurally_incomplete",
		});
		expect(r.records).toHaveLength(0);
	});

	it("S4: a missing mid-branch message gaps and emits nothing", async () => {
		const { mapping, tip } = simpleChain();
		mapping["u1"] = { ...mapping["u1"]!, children: ["d"] };
		mapping["d"] = { parent: "u1", children: ["a1"], message: null };
		mapping["a1"] = { ...mapping["a1"]!, parent: "d" };
		const r = await runDetail(mapping, tip);
		expect(r.outcome).toEqual({
			complete: false,
			reason: "branch_structurally_incomplete",
		});
		expect(r.records).toHaveLength(0);
		expect(r.conversations).toHaveLength(0);
		expect(r.emitted).toHaveLength(1);
	});

	it("S5: shape rejection anywhere gaps the whole conversation (F2)", async () => {
		const { mapping, tip } = simpleChain();
		// Off-branch node with a whitespace id: fails messageIdSchema.
		mapping["bad id"] = {
			parent: "root",
			children: [],
			message: {
				author: { role: "user" },
				content: { content_type: "text", parts: ["x"] },
			},
		};
		const r = await runDetail(mapping, tip);
		expect(r.outcome).toEqual({
			complete: false,
			reason: "message_shape_rejected",
		});
		expect(r.records).toHaveLength(0);
	});
});
