import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const baseline = process.argv[2];
if (!baseline) {
	console.error("usage: node scripts/compare-provider-truth-renders.mjs <runs dir rendered at the base commit>");
	process.exit(2);
}
execFileSync(process.execPath, ["dist/assessment-cli.js", "render", "--provider-truth=off"], { stdio: "pipe" });

async function programs(root, relative = "") {
	const entries = await readdir(path.join(root, relative), { withFileTypes: true });
	const result = [];
	for (const entry of entries) {
		if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
		const name = path.join(relative, entry.name);
		if (entry.isDirectory()) result.push(...await programs(root, name));
		else if (/^assessment\.(js|py|ts)$/.test(entry.name)) result.push(name);
	}
	return result.sort();
}

const expected = await programs(baseline);
const actual = await programs("runs");
assert.ok(expected.length > 0, "No baseline programs found");
assert.deepEqual(actual, expected, "Rendered program sets differ");
for (const name of expected) {
	assert.ok((await readFile(path.join("runs", name))).equals(await readFile(path.join(baseline, name))), `Render differs: ${name}`);
}
console.log(`Compared ${expected.length} programs; ${expected.length} byte-identical.`);
