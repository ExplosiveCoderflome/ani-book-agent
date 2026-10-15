import { Worker } from "node:worker_threads";
import { AppError } from "../application/errors";
import type { ChapterPatternMatcher } from "../domain";

export const CHAPTER_PATTERN_TIMEOUT_MS = 2_000;

// Keep the worker self-contained so Mastra's bundled server needs no extra file.
const workerSource = `
const { parentPort, workerData } = require("node:worker_threads");
try {
  const patterns = workerData.patterns.map((pattern) => new RegExp(pattern, "iu"));
  if (patterns.some((pattern) => pattern.test(""))) {
    parentPort.postMessage({ error: "empty" });
  } else {
    const matches = workerData.lines.map((line) => patterns.findIndex((pattern) => pattern.test(line.slice(0, 160))));
    parentPort.postMessage({ matches });
  }
} catch {
  parentPort.postMessage({ error: "invalid" });
}
`;

export const matchChapterPatterns: ChapterPatternMatcher = (patterns, lines) => new Promise((resolve, reject) => {
  const worker = new Worker(workerSource, { eval: true, execArgv: [], workerData: { patterns, lines } });
  const finish = (result: { matches: number[] } | { error: AppError }) => {
    clearTimeout(timer);
    worker.removeAllListeners();
    void worker.terminate();
    if ("error" in result) reject(result.error);
    else resolve(result.matches);
  };
  const timer = setTimeout(() => finish({ error: new AppError("REFERENCE_PATTERN_TIMEOUT", "章节正则匹配超过 2 秒，已停止。请简化规则，避免嵌套重复匹配后重试。", 422, true) }), CHAPTER_PATTERN_TIMEOUT_MS);
  worker.once("message", (result: { matches: number[] } | { error: string }) => {
    if ("error" in result) finish({ error: new AppError("REFERENCE_PATTERN_INVALID", result.error === "empty" ? "章节正则不能匹配空行。" : "章节正则语法无效。", 422, true) });
    else finish(result);
  });
  worker.once("error", () => finish({ error: new AppError("REFERENCE_PATTERN_FAILED", "章节规则校验未完成，请简化规则后重试。", 422, true) }));
  worker.once("exit", () => finish({ error: new AppError("REFERENCE_PATTERN_FAILED", "章节规则校验意外停止，请重试。", 422, true) }));
});
