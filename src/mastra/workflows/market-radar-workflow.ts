import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { marketRadarSnapshotSchema } from "../../domain";
import type { MarketRadarStore } from "../../application/ports";

export function createMarketRadarWorkflow(marketRadar: MarketRadarStore) {
  const refreshStep = createStep({ id: "refresh-market-radar", inputSchema: z.object({}), outputSchema: marketRadarSnapshotSchema, retries: 1, execute: async () => marketRadar.refresh() });
  return createWorkflow({ id: "market-radar", description: "读取公开榜单元数据并保存最近一次可查看快照。", inputSchema: z.object({}), outputSchema: marketRadarSnapshotSchema }).then(refreshStep).commit();
}
