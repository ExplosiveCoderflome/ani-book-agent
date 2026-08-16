import { readFile } from "node:fs/promises";

const lock = await readFile(new URL("../.mastra/dev.lock", import.meta.url), "utf8")
  .then(JSON.parse)
  .catch(() => undefined);

if (Number.isInteger(lock?.pid)) {
  try {
    process.kill(lock.pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") process.exit(0);
    if (error?.code !== "EPERM") throw error;
  }
  console.error("检测到 Mastra 开发服务仍在运行。请先停止 pnpm dev，再执行生产构建。");
  process.exitCode = 1;
}
