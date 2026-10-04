/**
 * JSONL framing tests.
 *
 * The U+2028/U+2029 case is the regression that matters: Node's `readline` treats both as record
 * boundaries, and both are legal inside a JSON string. Pi hit this and worked around it
 * (pi/packages/coding-agent/src/modes/rpc/jsonl.ts:8-20); we must not reintroduce it.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { LineAccumulator, parseRecord, serializeRecord, splitRecords } from "../src/bus/jsonl.ts";

test("splitRecords splits only on LF", () => {
	const { records, rest } = splitRecords('{"a":1}\n{"b":2}\n{"c":3');
	assert.deepEqual(records, ['{"a":1}', '{"b":2}']);
	assert.equal(rest, '{"c":3');
});

test("splitRecords tolerates CRLF", () => {
	const { records } = splitRecords('{"a":1}\r\n{"b":2}\r\n');
	assert.deepEqual(records, ['{"a":1}', '{"b":2}']);
});

test("U+2028 and U+2029 inside a JSON string are NOT record boundaries", () => {
	// A model's message body can contain either character verbatim. Node's readline would split
	// this into two half-records and both would fail to parse.
	const body = { text: "line separator \u2028 paragraph separator \u2029 end" };
	const line = serializeRecord(body);
	assert.ok(!line.slice(0, -1).includes("\n"), "serialised record must contain no raw newline");
	const { records } = splitRecords(line);
	assert.equal(records.length, 1);
	assert.deepEqual(parseRecord(records[0] ?? ""), body);
});

test("splitRecords drops empty lines", () => {
	const { records } = splitRecords("\n\n{\"a\":1}\n\n");
	assert.deepEqual(records, ['{"a":1}']);
});

test("LineAccumulator reassembles a record split across chunks", () => {
	const accumulator = new LineAccumulator();
	assert.deepEqual(accumulator.push('{"he'), []);
	assert.deepEqual(accumulator.push('llo":"wor'), []);
	assert.deepEqual(accumulator.push('ld"}\n'), ['{"hello":"world"}']);
	assert.equal(accumulator.pending, "");
});

test("LineAccumulator handles many records in one chunk", () => {
	const accumulator = new LineAccumulator();
	const records = accumulator.push('{"a":1}\n{"b":2}\n{"c":3}\n');
	assert.equal(records.length, 3);
});

test("flush returns a trailing record with no newline", () => {
	const accumulator = new LineAccumulator();
	accumulator.push('{"a":1}');
	assert.deepEqual(accumulator.flush(), ['{"a":1}']);
	assert.deepEqual(accumulator.flush(), []);
});

test("a value containing a newline stays one record because JSON escapes it", () => {
	// The stream stays intact without serializeRecord needing to throw: JSON.stringify escapes
	// \n as \\n, so a multi-line body is still exactly one LF-terminated record.
	const line = serializeRecord({ body: "first\nsecond" });
	assert.equal(line.split("\n").length, 2, "exactly one record plus the terminator");
	assert.deepEqual(parseRecord(line.trimEnd()), { body: "first\nsecond" });
});

test("serializeRecord produces exactly one trailing newline", () => {
	const line = serializeRecord({ a: 1 });
	assert.equal(line, '{"a":1}\n');
});

test("parseRecord returns undefined on malformed input rather than throwing", () => {
	assert.equal(parseRecord("not json"), undefined);
	assert.equal(parseRecord(""), undefined);
	assert.deepEqual(parseRecord('{"a":1}'), { a: 1 });
});
