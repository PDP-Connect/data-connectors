import path from "node:path";

function errorCause(error, depth = 0) {
	if (!error || depth > 4) return undefined;
	return {
		name: error.name,
		code: error.code,
		message: error.message,
		stack: error.stack,
		cause: errorCause(error.cause, depth + 1),
	};
}

function eventKey(data) {
	return `${data.file ?? "unknown"}#${data.testId}`;
}

export default async function* nodeReporter(source) {
	const starts = new Map();
	let completed = 0;
	let summary;
	for await (const event of source) {
		const data = event.data;
		if (event.type === "test:start") {
			starts.set(eventKey(data), data);
			continue;
		}
		if (event.type === "test:complete") {
			completed += 1;
			const isFileWrapper = data.file && path.resolve(process.cwd(), data.name) === path.resolve(data.file);
			if (data.details.type !== "test" || isFileWrapper) continue;
			const lineage = [];
			let current = starts.get(eventKey(data)) ?? data;
			while (current) {
				lineage.unshift(current.name);
				current = current.parentId === undefined
					? undefined
					: starts.get(eventKey({ file: current.file, testId: current.parentId }));
			}
			const error = data.details.error;
			const status = data.skip
				? "skipped"
				: data.todo
					? "todo"
					: error?.name === "CancelledByParentError" || error?.name === "AbortError"
						? "cancelled"
						: data.details.passed
							? "passed"
							: "failed";
			yield `${JSON.stringify({
				kind: "test",
				eventId: `${data.file ?? "unknown"}#${data.testId}`,
				identity: {
					file: data.file ? path.relative(process.cwd(), data.file) : undefined,
					hierarchy: lineage,
					line: data.line,
					column: data.column,
				},
				status,
				durationMs: data.details.duration_ms,
				error: errorCause(error),
			})}\n`;
			continue;
		}
		if (event.type === "test:summary") {
			summary = data.counts;
		}
	}
	if (summary) {
		yield `${JSON.stringify({ kind: "complete", completionEvents: completed, counts: summary })}\n`;
	}
}
