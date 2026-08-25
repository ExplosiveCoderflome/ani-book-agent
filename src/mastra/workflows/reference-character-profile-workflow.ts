import { readFile } from "node:fs/promises";
import path from "node:path";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { referenceCharacterProfileSchema } from "../../domain";
import { modelSettings } from "../../infrastructure/model-settings";
import { ReferenceRepository } from "../../infrastructure/reference-repository";
import { deconstructionAgent } from "../agents/deconstruction-agent";
import { generateWithGuard } from "../generation-guard";
import { requireStructuredOutput, structuredOutputOptions } from "../structured-output";

const repository = new ReferenceRepository();
const inputSchema = z.object({ referenceId: z.string().uuid(), analysisId: z.string(), name: z.string().min(1).max(120) });
const outputSchema = z.object({ referenceId: z.string().uuid(), analysisId: z.string(), name: z.string(), status: z.literal("completed") });
const modelEvidenceSchema = z.object({ chapterId: z.string(), excerpt: z.string().min(1).max(240) });
const modelSchema = referenceCharacterProfileSchema.omit({ version: true, name: true, evidence: true, createdAt: true }).extend({ evidence: z.array(modelEvidenceSchema).max(12).default([]) });

async function prompt() { return readFile(path.resolve(process.cwd(), "src", "mastra", "prompts", "deconstruction", "character-profile.md"), "utf8"); }

const generate = createStep({
  id: "generate-reference-character-profile",
  inputSchema,
  outputSchema,
  retries: 1,
  execute: async ({ inputData }) => {
    const [state, manifest, section, source] = await Promise.all([repository.get(inputData.referenceId), repository.manifest(inputData.referenceId), repository.section(inputData.referenceId, inputData.analysisId, "character_system"), repository.source(inputData.referenceId)]);
    const candidate = section.characterCandidates.find((item) => item.name === inputData.name);
    if (!candidate) throw new Error("没有找到这个角色候选。");
    const ranges = manifest.chapters.filter((item) => candidate.chapterIds.includes(item.id));
    const excerpts = ranges.map((item) => `章节 ${item.id}《${item.title}》：\n${source.slice(item.start, item.end)}`).join("\n\n");
    const request = `${await prompt()}\n\n参考书：${state.title}\n角色候选：${JSON.stringify(candidate)}\n人物系统：${JSON.stringify(section.structuredData)}\n\n原文范围：\n${excerpts.slice(0, 80_000)}`;
    const selected = await modelSettings.runtimeSelection("analysis");
    const result = await generateWithGuard("生成角色档案", (abortSignal) => deconstructionAgent.generate(request, { abortSignal, ...structuredOutputOptions(modelSchema), modelSettings: { temperature: selected.parameters.temperature, topP: selected.parameters.topP, maxOutputTokens: Math.min(selected.parameters.maxOutputTokens ?? 8_000, 8_000) } }));
    const draft = requireStructuredOutput(modelSchema, result.object, "角色档案");
    const evidence = draft.evidence.flatMap((item) => {
      const range = ranges.find((value) => value.id === item.chapterId); const offset = range ? source.slice(range.start, range.end).indexOf(item.excerpt) : -1;
      return range && offset >= 0 ? [{ chapterId: item.chapterId, excerpt: item.excerpt, start: range.start + offset, end: range.start + offset + item.excerpt.length }] : [];
    });
    const profile = referenceCharacterProfileSchema.parse({ ...draft, version: 1, name: candidate.name, role: candidate.role, evidence, createdAt: new Date().toISOString() });
    await repository.writeAnalysisFile(inputData.referenceId, inputData.analysisId, `characters/${encodeURIComponent(candidate.name)}.yaml`, stringify(profile, { lineWidth: 0 }));
    const analysis = state.analyses.find((item) => item.id === inputData.analysisId)!;
    await repository.updateAnalysis(inputData.referenceId, { ...analysis, characterProfiles: [...analysis.characterProfiles.filter((item) => item.name !== candidate.name), { name: candidate.name, status: "generated", updatedAt: new Date().toISOString() }], updatedAt: new Date().toISOString() });
    return { referenceId: inputData.referenceId, analysisId: inputData.analysisId, name: candidate.name, status: "completed" as const };
  },
});

export const referenceCharacterProfileWorkflow = createWorkflow({ id: "reference-character-profile", description: "按需生成参考书角色档案。", inputSchema, outputSchema }).then(generate).commit();
