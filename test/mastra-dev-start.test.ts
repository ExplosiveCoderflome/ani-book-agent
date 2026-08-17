import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/prepare-mastra-dev.mjs", import.meta.url));

test("development startup isolates an existing Mastra output directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ani-mastra-dev-"));
  try {
    const output = path.join(root, ".mastra", "output");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "native.node"), "locked build output", "utf8");
    await execFileAsync(process.execPath, [script], { cwd: root });
    const entries = await readdir(path.join(root, ".mastra"));
    assert.equal(entries.length, 1);
    assert.match(entries[0]!, /^output-stale-/);
    await execFileAsync(process.execPath, [script], { cwd: root });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
