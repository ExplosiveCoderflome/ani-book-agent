import { marketRadarRunSchema } from "../domain";
import { AppError } from "./errors";
import type { WorkbenchDependencies } from "./workbench-dependencies";

export function createMarketService(deps: Pick<WorkbenchDependencies, "market" | "marketRefresh" | "marketSummary" | "sanitizeError">) {
  async function marketRadarSnapshot(capturedAt?: string) {
    const snapshot = await deps.market.get(capturedAt);
    if (capturedAt && !snapshot) throw new AppError("MARKET_RADAR_SNAPSHOT_NOT_FOUND", "没有找到这个时间的市场快照。", 404, false);
    const [summary, history] = await Promise.all([deps.market.getSummary(snapshot?.capturedAt), deps.market.history()]);
    return { snapshot, summary, history, summaryCurrent: Boolean(summary && snapshot?.capturedAt === summary.snapshotCapturedAt) };
  }
  async function refreshMarketRadar() {
    const run = await deps.marketRefresh.createRun();
    void run.start({ inputData: {} }).catch((error) => console.warn("市场趋势更新失败", { runId: run.runId, message: deps.sanitizeError(error) }));
    return marketRadarRunSchema.parse({ id: run.runId, status: "running" });
  }
  async function summarizeMarketRadar(input: { sourceIds: string[]; capturedAt?: string }) {
    const run = await deps.marketSummary.createRun();
    void run.start({ inputData: input }).catch((error) => console.warn("市场题材总结失败", { runId: run.runId, message: deps.sanitizeError(error) }));
    return marketRadarRunSchema.parse({ id: run.runId, status: "running" });
  }
  async function marketRadarRun(runId: string) {
    const run = await deps.marketRefresh.getWorkflowRunById(runId, { fields: ["error"] })
      ?? await deps.marketSummary.getWorkflowRunById(runId, { fields: ["error"] });
    if (!run) throw new AppError("MARKET_RADAR_RUN_NOT_FOUND", "没有找到这次市场趋势更新。", 404, false);
    return marketRadarRunSchema.parse({
      id: runId,
      status: run.status === "success" ? "completed" : run.status === "failed" || run.status === "canceled" ? "failed" : "running",
      error: run.status === "failed" ? deps.sanitizeError(run.error?.message ?? "市场趋势更新失败") : undefined,
    });
  }
  return { marketRadarSnapshot, refreshMarketRadar, summarizeMarketRadar, marketRadarRun };
}
