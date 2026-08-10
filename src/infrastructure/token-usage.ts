import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export async function recordTokenUsage(novelId: string, event: { task: string; promptVersion: string; usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number } }) {
  if (!/^[0-9a-f-]{36}$/i.test(novelId)) return;
  const root = path.resolve(process.env.ANI_NOVEL_PROJECT_DIR ?? process.env.INIT_CWD ?? process.cwd(), "novels", novelId, "production");
  await mkdir(root, { recursive: true });
  const usage = event.usage;
  const measurement = usage && [usage.inputTokens, usage.outputTokens, usage.totalTokens].some((value) => typeof value === "number") ? "exact" : "unavailable";
  await appendFile(path.join(root, "token-usage.jsonl"), `${JSON.stringify({ at: new Date().toISOString(), task: event.task, promptVersion: event.promptVersion, measurement, ...(usage ?? { reason: "runtime_usage_not_exposed" }) })}\n`, "utf8");
}
