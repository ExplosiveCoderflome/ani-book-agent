import { rename } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export async function prepareMastraDevOutput(projectRoot = process.cwd()) {
  const output = path.join(projectRoot, ".mastra", "output");
  const stale = path.join(projectRoot, ".mastra", `output-stale-${process.pid}-${Date.now()}`);
  try {
    await rename(output, stale);
    console.log("已隔离上一次 Mastra 输出，正在启动开发服务。");
    return stale;
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await prepareMastraDevOutput();
