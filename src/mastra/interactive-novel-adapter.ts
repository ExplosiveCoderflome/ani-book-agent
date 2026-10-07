import { RequestContext } from "@mastra/core/request-context";
import { z } from "zod";
import type { CreativeAgentPort, InteractiveNovelPort, ModelSettingsPort } from "../application/ports";
import { AppError } from "../application/errors";
import { requireStructuredOutput, structuredOutputOptions } from "./structured-output";

export function createInteractiveNovelAdapter(agent: CreativeAgentPort, models: ModelSettingsPort, sanitizeError: (error: unknown) => string): InteractiveNovelPort {
  return {
    async recall(novelId) {
      const memory = await agent.getMemory?.(); if (!memory) return [];
      const thread = await memory.getThreadById({ threadId: novelId });
      return thread ? (await memory.recall({ threadId: novelId, resourceId: novelId, perPage: 100, page: 0 })).messages : [];
    },
    async testConnection() {
      const selection = await models.runtimeSelection("chat"); const started = performance.now(); const schema = z.object({ ok: z.literal(true) });
      try {
        const result = await agent.generate("连接测试，只返回 ok=true。", { requestContext: new RequestContext([["modelProfile", "chat"]]), ...structuredOutputOptions(schema) });
        requireStructuredOutput(schema, result.object, "模型连接测试");
        return { ok: true as const, latencyMs: Math.round(performance.now() - started), model: selection.model };
      } catch (error) { throw new AppError("MODEL_CONNECTION_FAILED", `连接测试失败：${sanitizeError(error)}`, 502, true); }
    },
    async testSkill(prompt) {
      const started = performance.now();
      const result = await agent.generate(prompt, { requestContext: new RequestContext([["taskType", "skill-test"], ["modelProfile", "chat"]]), toolChoice: "none", modelSettings: { maxOutputTokens: 2_000 } });
      return { output: result.text?.trim() ?? "", elapsedMs: Math.round(performance.now() - started), traceId: result.traceId };
    },
  };
}
