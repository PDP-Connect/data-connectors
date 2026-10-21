// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * A Link header shaped like GitHub's for the page `request` names: targets keep
 * the selection, user lists are named by account id, later pages link back, and
 * a result that fits on the first page has no header at all.
 */
export function githubLink(request: string, next: boolean): string | null {
	const url = new URL(request);
	const page = Number(url.searchParams.get("page"));
	const target = (n: number) => {
		const linked = new URL(url);
		linked.pathname = linked.pathname.replace(/^\/users\/[^/]+\//u, "/user/1001/");
		linked.searchParams.set("page", String(n));
		return `<${linked.href}>`;
	};
	const relations = [
		...(page > 1 ? [`${target(page - 1)}; rel="prev"`] : []),
		...(next ? [`${target(page + 1)}; rel="next"`] : []),
		...(page > 1 ? [`${target(1)}; rel="first"`] : []),
	];
	return relations.length === 0 ? null : relations.join(", ");
}
