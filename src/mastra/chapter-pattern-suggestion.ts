import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { normalizeChapterPatternSuggestion, type ChapterPatternMatcher } from "../domain";
import type { ChapterPatternAdvisorPort, CreativeAgentPort, ModelSettingsPort } from "../application/ports";
import { AppError } from "../application/errors";
import { generateWithGuard } from "./generation-guard";
import { requireStructuredOutput, structuredOutputOptions } from "./structured-output";

const sampleSchema = z.string().trim().min(2, "请至少输入一条章节标题样例。").max(5_000, "样例请控制在 5,000 字以内。");
const modelSuggestionSchema = z.object({
  name: z.string().trim().min(1).max(80).default("AI 章节规则"),
  pattern: z.string().trim().min(1).max(500),
  explanation: z.string().trim().min(1).max(800).default("根据所给章节标题样例生成。"),
});

export function createChapterPatternAdvisor(modelSettings: ModelSettingsPort, deconstructionAgent: CreativeAgentPort, matchPatterns: ChapterPatternMatcher): ChapterPatternAdvisorPort {
  return { async suggest(rawSample: unknown) {
    const sample = sampleSchema.parse(rawSample);
    const instructions = await readFile(path.resolve(process.env.INIT_CWD ?? process.cwd(), "src", "mastra", "prompts", "deconstruction", "chapter-regex.md"), "utf8");
    const selected = await modelSettings.runtimeSelection("analysis");
    const request = `${instructions.replace(/^---\n[\s\S]*?\n---\n/, "").trim()}\n\n<chapter-title-samples>\n${sample}\n</chapter-title-samples>`;
    const generated = await generateWithGuard("生成章节正则", (abortSignal) => deconstructionAgent.generate(request, {
      abortSignal, ...structuredOutputOptions(modelSuggestionSchema), providerOptions: { deepseek: { thinking: { type: "disabled" as const } } },
      modelSettings: { ...selected.parameters, maxOutputTokens: Math.min(selected.parameters.maxOutputTokens ?? 1_200, 1_200) },
    }));
    const suggestion = await normalizeChapterPatternSuggestion(requireStructuredOutput(modelSuggestionSchema, generated.object, "章节正则建议"), sample, matchPatterns);
    if (!suggestion) throw new AppError("REFERENCE_PATTERN_NO_MATCH", "模型生成的正则格式无法应用。请保留真实章节标题并重试，系统不会保存这条无效规则。", 422, true);
    return suggestion;
  } };
}
