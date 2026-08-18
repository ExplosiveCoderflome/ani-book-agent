import { Agent } from "@mastra/core/agent";
import { TokenLimiterProcessor, UnicodeNormalizer } from "@mastra/core/processors";
import { modelSettings } from "../../infrastructure/model-settings";

export const deconstructionAgent = new Agent({
  id: "deconstruction-agent", name: "长篇拆书 Agent",
  instructions: "你负责依据用户提供的参考文本做结构化小说拆解。只使用本轮文本和已验证的中间分析，不凭记忆补充原作；区分证据与推断，不续写、不仿写、不输出可替代原作的长段文字。严格输出调用方 Schema。",
  model: async () => (await modelSettings.runtimeSelection("analysis")).model,
  inputProcessors: [new UnicodeNormalizer({ stripControlChars: true, preserveEmojis: true, collapseWhitespace: false, trim: false }), new TokenLimiterProcessor({ limit: 32_000, trimMode: "contiguous" })],
  maxRetries: 2,
});
