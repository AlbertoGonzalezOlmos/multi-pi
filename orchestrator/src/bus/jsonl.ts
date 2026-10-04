/**
 * LF-only JSON Lines framing.
 *
 * Pi's own RPC layer makes the same choice and for the same reason
 * (pi/packages/coding-agent/src/modes/rpc/jsonl.ts:8-20): Node's `readline` splits on
 * U+2028 and U+2029 in addition to \n, and both are legal inside a JSON string. A record
 * whose payload contains either character would be cut in half and silently dropped.
 *
 * So: split on "\n" only, strip one optional preceding "\r" to tolerate CRLF, and never
 * treat any other code point as a record boundary.
 */

/** Splits a buffer into complete records, returning the unconsumed remainder. */
export function splitRecords(buffer: string): { records: string[]; rest: string } {
	const records: string[] = [];
	let rest = buffer;
	let newline = rest.indexOf("\n");
	while (newline !== -1) {
		let record = rest.slice(0, newline);
		rest = rest.slice(newline + 1);
		if (record.endsWith("\r")) record = record.slice(0, -1);
		if (record.length > 0) records.push(record);
		newline = rest.indexOf("\n");
	}
	return { records, rest };
}

/**
 * Incremental reader for a stream of chunks. Holds the partial record between chunks so a
 * record split across a chunk boundary is still delivered whole.
 */
export class LineAccumulator {
	#rest = "";

	push(chunk: string): string[] {
		const { records, rest } = splitRecords(this.#rest + chunk);
		this.#rest = rest;
		return records;
	}

	/** Flush a trailing record that arrived without a terminating newline (stream ended). */
	flush(): string[] {
		const rest = this.#rest;
		this.#rest = "";
		const trimmed = rest.endsWith("\r") ? rest.slice(0, -1) : rest;
		return trimmed.length > 0 ? [trimmed] : [];
	}

	get pending(): string {
		return this.#rest;
	}
}

/** Serialise one record. Rejects embedded newlines, which would corrupt the stream. */
export function serializeRecord(record: unknown): string {
	const text = JSON.stringify(record);
	if (text === undefined) throw new Error("record is not JSON serialisable");
	if (text.includes("\n")) throw new Error("record must not contain a raw newline");
	return `${text}\n`;
}

/** Parse one record, returning undefined instead of throwing on malformed input. */
export function parseRecord<T = unknown>(line: string): T | undefined {
	try {
		return JSON.parse(line) as T;
	} catch {
		return undefined;
	}
}
