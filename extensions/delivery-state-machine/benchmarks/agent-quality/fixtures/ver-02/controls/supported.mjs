import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOnce } from "../lib/write.mjs";

const scratch = mkdtempSync(join(tmpdir(), "write-once-"));
try {
	const file = join(scratch, "value");
	writeOnce(file, "ok");
	assert.equal(readFileSync(file, "utf8"), "ok");
	console.log("pass");
} finally {
	rmSync(scratch, { recursive: true, force: true });
}
