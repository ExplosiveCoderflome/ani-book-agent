import { Agent } from "@mastra/core/agent";
import { TokenLimiterProcessor, UnicodeNormalizer } from "@mastra/core/processors";
import { Memory } from "@mastra/memory";
import { modelSettings } from "../../infrastructure/model-settings";
import { NovelRepository } from "../../infrastructure/novel-repository";
import { projectTools } from "../tools/project-tools";
import { loadCorePrompt, readSkill } from "../skill-loader";
import { createNovelSkillWorkspace } from "../workspace/novel-skill-workspace";

const repository = new NovelRepository();
const processors = [new UnicodeNormalizer({ stripControlChars: true, preserveEmojis: true, collapseWhitespace: false, trim: false }), new TokenLimiterProcessor({ limit: 32_000, trimMode: "contiguous" })];

export const novelAgent = new Agent({
  id: "novel-agent", name: "小说创作 Agent",
  instructions: async ({ requestContext }) => {
    const id = requestContext.get("novelId");
    const state = typeof id === "string" ? await repository.get(id).catch(() => undefined) : undefined;
    return `${await loadCorePrompt()}\n\n当前状态：${state ? `作品《${state.title}》，阶段 ${state.phase}，下一章 ${state.nextChapter}，${state.activeJobId ? "已有运行任务" : "当前空闲"}` : "未绑定作品"}。`;
  },
  workspace: async ({ requestContext }) => createNovelSkillWorkspace(requestContext, "novel-agent"),
  model: async ({ requestContext }) => (await modelSettings.runtimeSelection(String(requestContext.get("modelProfile") ?? "chat") as "chat" | "writer" | "critic")).model,
  memory: new Memory({ options: { lastMessages: 30 } }), tools: projectTools, inputProcessors: processors, maxRetries: 2,
});

export const novelCritic = new Agent({
  id: "novel-critic", name: "小说独立验收 Critic",
  instructions: async ({ requestContext }) => {
    const versions = requestContext.get("skillVersions") as Record<string, string> | undefined;
    return `${await readSkill("critique", versions?.critique)}\n\n你只能验收和抽取事实，不调用工具、不修改文件。严格输出调用方 Schema。`;
  },
  workspace: async ({ requestContext }) => createNovelSkillWorkspace(requestContext, "novel-critic"),
  model: async ({ requestContext }) => (await modelSettings.runtimeSelection("critic")).model,
  inputProcessors: processors, maxRetries: 2,
});
