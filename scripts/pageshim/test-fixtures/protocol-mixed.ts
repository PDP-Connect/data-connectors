// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

declare const PAGESHIM_LEGACY_FIRST: boolean;

(globalThis as Record<string, unknown>).__pageshimMain = async (page: {
	setData: (key: string, value: unknown) => Promise<void>;
}) => {
	if (PAGESHIM_LEGACY_FIRST) {
		await page.setData("result", JSON.stringify({ legacy: true }));
		await page.setData("result:begin", { scope: "chatgpt.conversations" });
		return;
	}
	await page.setData("result:begin", { scope: "chatgpt.conversations" });
	await page.setData("result", JSON.stringify({ legacy: true }));
};
