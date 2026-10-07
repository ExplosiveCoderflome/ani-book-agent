import { Agent } from "@mastra/core/agent";
import { TokenLimiterProcessor, UnicodeNormalizer } from "@mastra/core/processors";
import type { ModelSettingsPort } from "../../application/ports";

export function createMarketRadarAgent(modelSettings: ModelSettingsPort) { return new Agent({
  id: "market-radar-agent", name: "市场题材分析 Agent",
  instructions: "你只依据调用方提供的公开榜单元数据做题材观察。不得把排名写成成功保证，不得虚构未提供的数据，不得给出具体作品仿写方案；严格输出调用方 Schema。",
  model: async () => (await modelSettings.runtimeSelection("analysis")).modelConfig,
  inputProcessors: [new UnicodeNormalizer({ stripControlChars: true, preserveEmojis: true, collapseWhitespace: false, trim: false }), new TokenLimiterProcessor({ limit: 16_000, trimMode: "contiguous" })],
  maxRetries: 2,
}); }
