export type GroupMeFault = {
	id: "page-ceiling" | "ascending-order-weakening";
	target: "connectors/groupme/index.ts";
	preimage: string;
	replacement: string;
	ownerTest: string;
	ownerAssertion: string;
};

export const GROUPME_FAULTS: readonly GroupMeFault[] = [
	{
		id: "page-ceiling",
		target: "connectors/groupme/index.ts",
		preimage: `	const usedCursors = new Set<string>([startAfterId]);

	for (;;) {
		await progressWithSignals("Fetching group messages", {
			stream: "group_messages",`,
		replacement: `	const usedCursors = new Set<string>([startAfterId]);

	let mutationPageCount = 0;
	for (;;) {
		mutationPageCount += 1;
		if (mutationPageCount > 200) {
			throw new Error("reintroduced 200-page ceiling");
		}
		await progressWithSignals("Fetching group messages", {
			stream: "group_messages",`,
		ownerTest:
			">old-cap discriminator: a group's forward walk pages past 200 full pages with no truncation (mutation-killing)",
		ownerAssertion: "no cap-truncation past 200 pages",
	},
	{
		id: "ascending-order-weakening",
		target: "connectors/groupme/index.ts",
		preimage: `function isAscendingByCreatedAt(messages: readonly GroupMeMessage[]): boolean {
	for (let i = 1; i < messages.length; i += 1) {
		const prev = messages[i - 1];
		const curr = messages[i];
		if (prev && curr && curr.created_at < prev.created_at) {
			return false;
		}
	}
	return true;
}`,
		replacement: `function isAscendingByCreatedAt(_messages: readonly GroupMeMessage[]): boolean {
	return true;
}`,
		ownerTest:
			"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError",
		ownerAssertion:
			"a non-ascending forward page must fail, not be silently trusted",
	},
];

export const EQUALITY_CONTROL = {
	target: "connectors/groupme/index.ts",
	preimage: "curr.created_at < prev.created_at",
	replacement: "curr.created_at <= prev.created_at",
	ownerTest:
		"repeated/nonprogressing cursor: a forward page violating documented ascending order fails as NonProgressError",
};
