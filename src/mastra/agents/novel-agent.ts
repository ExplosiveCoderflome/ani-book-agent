import { Agent } from "@mastra/core/agent";
import { TokenLimiterProcessor, UnicodeNormalizer } from "@mastra/core/processors";
import { Memory } from "@mastra/memory";
import type { ModelSettingsPort, NovelProjectStore, PreferencesStore } from "../../application/ports";
import { createTransientModelRetryProcessor } from "../model-retry";

const processors = [new UnicodeNormalizer({ stripControlChars: true, preserveEmojis: true, collapseWhitespace: false, trim: false }), new TokenLimiterProcessor({ limit: 32_000, trimMode: "contiguous" })];

export function createNovelAgents(deps: {
  models: ModelSettingsPort;
  novels: NovelProjectStore;
  preferences: PreferencesStore;
  projectTools: Record<string, any>;
  loadCorePrompt(): Promise<string>;
  readSkill(id: string, versionId?: string): Promise<string>;
  workspace(requestContext: { get(key: string): unknown }, agentId: "novel-agent" | "novel-critic"): Promise<any>;
}) {
  const novelAgent = new Agent({
    id: "novel-agent", name: "小说创作 Agent",
    instructions: async ({ requestContext }) => {
      const id = requestContext.get("novelId");
      const state = typeof id === "string" ? await deps.novels.get(id).catch(() => undefined) : undefined;
      const preferences = typeof id === "string" && requestContext.get("taskType") === "chat" ? await deps.preferences.prompt(id) : "";
      return `${await deps.loadCorePrompt()}\n\n当前状态：${state ? `作品《${state.title}》，阶段 ${state.phase}，下一章 ${state.nextChapter}，交互模式 ${state.approvalMode}，${state.activeJobId ? "已有运行任务" : "当前空闲"}` : "未绑定作品"}。${preferences ? `\n\n作者偏好记录（作者通过快捷选择或反馈明确提交；当前请求冲突时以当前请求为准）：\n${preferences}` : ""}`;
    },
    workspace: async ({ requestContext }) => deps.workspace(requestContext, "novel-agent"),
    model: async ({ requestContext }) => (await deps.models.runtimeSelection(String(requestContext.get("modelProfile") ?? "chat") as "chat" | "writer" | "critic")).modelConfig,
    memory: new Memory({ options: { lastMessages: 30 } }), tools: deps.projectTools, inputProcessors: processors,
    maxRetries: 0, maxProcessorRetries: 3, errorProcessors: [createTransientModelRetryProcessor()],
  });

  const novelWriter = new Agent({
    id: "novel-writer", name: "小说生产 Writer",
    instructions: "你负责生产链中的规划、正文写作和有限修复。所有权威上下文与创作方法都由调用方明确提供；不得读取项目、调用工具或延续聊天记忆。严格遵守调用方的结构化输出 Schema。",
    model: async () => (await deps.models.runtimeSelection("writer")).modelConfig,
    inputProcessors: processors,
    maxRetries: 0, maxProcessorRetries: 3, errorProcessors: [createTransientModelRetryProcessor()],
  });

  const novelCritic = new Agent({
    id: "novel-critic", name: "小说独立验收 Critic",
    instructions: async ({ requestContext }) => {
      const versions = requestContext.get("skillVersions") as Record<string, string> | undefined;
      return `${await deps.readSkill("critique", versions?.critique)}\n\n你只能验收和抽取事实，不调用工具、不修改文件。严格输出调用方 Schema。`;
    },
    workspace: async ({ requestContext }) => deps.workspace(requestContext, "novel-critic"),
    model: async () => (await deps.models.runtimeSelection("critic")).modelConfig,
    inputProcessors: processors,
    maxRetries: 0, maxProcessorRetries: 3, errorProcessors: [createTransientModelRetryProcessor()],
  });
  return { novelAgent, novelWriter, novelCritic };
}
