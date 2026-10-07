import { readFile } from "node:fs/promises";
import path from "node:path";
import { RequestContext } from "@mastra/core/request-context";
import { adaptationPlanSchema } from "../domain";
import type { AdaptationPlannerPort, CreativeAgentPort } from "../application/ports";
import { generateWithGuard } from "./generation-guard";
import { requireStructuredOutput, structuredOutputOptions } from "./structured-output";

async function instructions() {
  return (await readFile(path.resolve(process.env.INIT_CWD ?? process.cwd(), "src", "mastra", "prompts", "adaptation-plan.md"), "utf8")).replace(/^---\n[\s\S]*?\n---\n/, "").trim();
}

export function createAdaptationPlanner(agent: CreativeAgentPort): AdaptationPlannerPort {
  return {
    async plan(input) {
      const prompt = `${await instructions()}\n\n目标作品：${input.novel.title}\n当前下一章：${input.novel.nextChapter}\n应用范围：第 ${input.scope.fromChapter}-${input.scope.toChapter} 章\n\n目标作品蓝图：\n${input.novel.blueprint}\n\n目标作品连续性账本：\n${input.novel.ledger}\n\n已选机制级洞察（不含参考书原文）：\n${JSON.stringify(input.insights)}`;
      const requestContext = new RequestContext([["taskType", "adaptation-planning"], ["modelProfile", "writer"]]);
      const result = await generateWithGuard("生成仿写适配提案", (abortSignal) => agent.generate(prompt, { requestContext, abortSignal, ...structuredOutputOptions(adaptationPlanSchema), modelSettings: { maxOutputTokens: 3_000 } }));
      return requireStructuredOutput(adaptationPlanSchema, result.object, "仿写适配提案");
    },
  };
}
