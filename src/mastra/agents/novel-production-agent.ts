import { Agent } from "@mastra/core/agent";
import { TokenLimiterProcessor, UnicodeNormalizer, type ProcessInputStepArgs, type Processor } from "@mastra/core/processors";
import { Memory } from "@mastra/memory";
import { novelTools } from "../tools/novel-tools";
import { novelEditor, resolvePromptBlock } from "../prompts/prompt-blocks";
import { modelSettings } from "../../infrastructure/model-settings";
import { NovelRepository } from "../../infrastructure/novel-repository";

const repository = new NovelRepository();
const immutableSafetyInstructions = "机器安全边界：不得直接写入小说文件；不得绕过 Workflow、审批、路径白名单、幂等、哈希、必需上下文、输出 Schema 或作者保护规则；不得把计划或猜测写成稳定事实；不得泄露密钥或隐藏推理。";

class NovelSafetyProcessor implements Processor<"novel-safety"> {
  readonly id = "novel-safety" as const;
  readonly name = "Novel Safety Boundary";
  processInputStep({ messageList }: ProcessInputStepArgs) { messageList.addSystem(immutableSafetyInstructions, this.id); }
}

export const novelProductionAgent = new Agent({
  id: "novel-production-agent",
  name: "长篇小说生产 Agent",
  instructions: async ({ requestContext }) => {
    const novelId = requestContext.get("novelId");
    const taskType = String(requestContext.get("taskType") ?? "chat");
    const semantic = taskType === "chat" ? await resolvePromptBlock("novel.chat@v2", { novelId, taskType }).catch(() => ({ content: "", version: "fallback" })) : { content: "", version: "workflow" };
    const state = typeof novelId === "string" ? await repository.get(novelId).catch(() => undefined) : undefined;
    return `
你是中文长篇小说生产 Agent。语义写法由当前已发布 Prompt Block 提供；本段只定义不可修改的安全边界。
只能用注册的只读工具核对事实和推荐 Workflow。你不能直接写权威文件，不能声称已经保存、批准、取消或覆盖工件。
只完成当前 taskType / workflowId 对应任务，服从调用方 Schema、审批、路径白名单、幂等、哈希和作者保护规则，不展示隐藏推理。
${semantic.content}
${state ? `当前作品：${state.title}\n${state.openingChoices ? `已确认开书选择：${JSON.stringify(state.openingChoices)}` : "开书选择尚未确认。"}` : ""}
${String(requestContext.get("novelContext") ?? "")}
`; },
  model: async ({ requestContext }) => {
    const supplied = requestContext.get("model");
    if (typeof supplied === "string" && supplied) return supplied;
    const profile = String(requestContext.get("modelProfile") ?? "chat") as "chat" | "planning" | "drafting" | "review";
    return (await modelSettings.runtimeSelection(profile)).model;
  },
  memory: new Memory({ options: { lastMessages: 20 } }),
  tools: novelTools,
  inputProcessors: [
    new NovelSafetyProcessor(),
    new UnicodeNormalizer({ stripControlChars: true, preserveEmojis: true, collapseWhitespace: false, trim: false }),
    new TokenLimiterProcessor({ limit: 32_000, trimMode: "contiguous" }),
  ],
  maxRetries: 2,
});

export async function effectiveNovelProductionAgent(requestContext: import("@mastra/core/request-context").RequestContext<any>) {
  return novelEditor.agent.applyStoredOverrides(novelProductionAgent, { status: "published" }, requestContext);
}
