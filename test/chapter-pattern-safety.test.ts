import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

test("untrusted chapter patterns time out without blocking requests or replacing the saved parser", { timeout: 15_000 }, async () => {
  // A separate process keeps this regression test bounded if matching is ever
  // accidentally moved back onto the server's main thread.
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { mkdtemp, readFile, rm } from "node:fs/promises";
    import os from "node:os";
    import path from "node:path";
    import { setTimeout as delay } from "node:timers/promises";
    import { chapterParserConfigSchema, normalizeChapterPatternSuggestion } from "./src/domain/index.ts";
    import { matchChapterPatterns } from "./src/infrastructure/chapter-pattern-matcher.ts";
    import { ReferenceRepository, buildChapterManifest } from "./src/infrastructure/reference-repository.ts";

    const root = await mkdtemp(path.join(os.tmpdir(), "ani-pattern-safety-"));
    try {
      const source = "a".repeat(40) + "!";
      const parser = chapterParserConfigSchema.parse({ version: 1, patterns: [{ id: "unsafe", name: "复杂规则", pattern: "^(a+)+$", enabled: true, source: "author" }] });
      const repository = new ReferenceRepository(root);
      const imported = await repository.import({ fileName: "sample.txt", bytes: Buffer.from(source) });
      const parserPath = path.join(root, imported.state.referenceId, "source", "parser.yaml");
      const original = await readFile(parserPath, "utf8");
      const timedOut = (error) => error.code === "REFERENCE_PATTERN_TIMEOUT" && error.status === 422;
      const checks = Promise.all([
        assert.rejects(buildChapterManifest(source, "a".repeat(64), 8000, parser), timedOut),
        assert.rejects(normalizeChapterPatternSuggestion({ name: "复杂规则", pattern: "^(a+)+$", explanation: "样例规则" }, source, matchChapterPatterns), timedOut),
        assert.rejects(repository.saveParser(imported.state.referenceId, parser), timedOut),
      ]);
      const started = performance.now();
      await delay(50);
      assert.ok(performance.now() - started < 1000, "the main event loop must remain responsive");
      await checks;
      assert.equal(await readFile(parserPath, "utf8"), original);
      await assert.rejects(matchChapterPatterns(["^a*"], ["abc"]), (error) => error.code === "REFERENCE_PATTERN_INVALID" && error.message.includes("空行"));
      await assert.rejects(matchChapterPatterns(["^["], ["abc"]), (error) => error.code === "REFERENCE_PATTERN_INVALID");
      assert.deepEqual(await matchChapterPatterns(["^第[0-9]+章"], ["第1章 开始", "正文"]), [0, -1]);
      console.log("bounded matching and persisted parser preserved");
    } finally {
      assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
      await rm(root, { recursive: true, force: true });
    }
  `], { cwd: path.resolve(import.meta.dirname, ".."), timeout: 12_000, windowsHide: true });
  assert.match(stdout, /bounded matching and persisted parser preserved/);
});
