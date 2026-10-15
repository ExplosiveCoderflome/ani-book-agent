import { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { parse, stringify } from "yaml";
import { criticResultSchema, executionEnvelopeSchema, productionInteractionModeSchema, productionJobRequestSchema, volumeTensionCurveSchema, volumeTensionPath, volumeTensionPointSchema, type CriticResult, type ExecutionEnvelope, type ProductionJobRequest, type ReferenceAdaptation } from "../../domain";
import type { CreativeAgentPort, ModelSettingsPort, NovelWorkflowStore } from "../../application/ports";
import { generateWithGuard } from "../generation-guard";
import { readSkill } from "../skill-loader";
import { generateStructuredOutput, structuredOutputOptions } from "../structured-output";

export const productionWorkflowInputSchema = productionJobRequestSchema.extend({
  novelId: z.string().uuid(), jobId: z.string(),
  baseStateHash: z.string().length(64),
  skillVersions: z.record(z.string(), z.string()).default({}),
  execution: executionEnvelopeSchema.optional(),
  tensionCurveRequired: z.boolean().default(false),
  interactionMode: productionInteractionModeSchema.default("standard"),
  retryOf: z.string().optional(),
  attempt: z.number().int().positive().default(1),
});
const resumeSchema = z.object({ action: z.enum(["continue", "revise", "cancel"]), feedback: z.string().max(2_000).optional() });
const suspendSchema = z.object({ jobId: z.string(), checkpoint: z.enum(["curve_confirmation", "chapter_review"]).default("chapter_review"), chapter: z.number().int().positive(), summary: z.string(), issues: criticResultSchema.shape.issues });
const outputSchema = z.object({ status: z.enum(["completed", "canceled"]), novelId: z.string().uuid(), jobId: z.string(), completedThrough: z.number().int().nonnegative(), exportPath: z.string().optional(), reportPath: z.string().optional() });
const generatedVolumePlanSchema = z.object({
  plan: z.string().min(200).max(100_000),
  curve: z.object({ title: z.string().min(1).max(120), points: z.array(volumeTensionPointSchema.extend({ source: z.literal("ai"), locked: z.literal(false) })).min(1).max(500) }),
});
export const projectReviewResultSchema = z.object({
  summary: z.string().min(1).max(4_000),
  strengths: z.array(z.string().max(500)).max(10).default([]),
  findings: z.array(z.object({
    severity: z.enum(["low", "medium", "high", "critical"]),
    category: z.string().min(1).max(80),
    title: z.string().min(1).max(200),
    evidence: z.array(z.object({ path: z.string().min(1).max(240), excerpt: z.string().min(1).max(1_000) })).min(1).max(5),
    explanation: z.string().min(1).max(2_000),
    recommendation: z.string().min(1).max(2_000),
  })).max(30).default([]),
});
type ProjectReviewResult = z.infer<typeof projectReviewResultSchema>;
type ReviewSource = { path: string; content: string };
type WorkflowDependencies = { novels: NovelWorkflowStore; models: ModelSettingsPort; novelAgent: CreativeAgentPort; novelCritic: CreativeAgentPort };
let workflowDependencies: WorkflowDependencies | undefined;
const dependency = () => { if (!workflowDependencies) throw new Error("小说生产工作流尚未完成组合根绑定"); return workflowDependencies; };
const repository = new Proxy({} as NovelWorkflowStore, { get: (_target, property) => (...args: unknown[]) => (dependency().novels as any)[property](...args) });
const modelSettings = new Proxy({} as ModelSettingsPort, { get: (_target, property) => (...args: unknown[]) => (dependency().models as any)[property](...args) });
const novelAgent = new Proxy({} as CreativeAgentPort, { get: (_target, property) => (...args: unknown[]) => (dependency().novelAgent as any)[property](...args) });
const novelCritic = new Proxy({} as CreativeAgentPort, { get: (_target, property) => (...args: unknown[]) => (dependency().novelCritic as any)[property](...args) });
const productionProviderOptions = {
  deepseek: { thinking: { type: "disabled" as const } },
  custom: { reasoningEffort: "none" as const },
};

function requestContext(execution: ExecutionEnvelope, profile: "writer" | "critic", stage: ExecutionEnvelope["stage"] = execution.stage) {
  const current = executionEnvelopeSchema.parse({ ...execution, stage });
  return new RequestContext([
    ["novelId", current.novelId], ["taskType", profile], ["modelProfile", profile], ["skillVersions", current.skillVersions], ["execution", current],
    ["runId", current.runId], ["stage", current.stage], ["traceId", current.traceId], ["preferenceVersion", current.preferenceVersion], ["novelStateHash", current.novelStateHash],
  ]);
}
async function settings(profile: "writer" | "critic", outputCap: number) {
  const selected = await modelSettings.runtimeSelection(profile);
  return { temperature: selected.parameters.temperature, topP: selected.parameters.topP, maxOutputTokens: Math.min(selected.parameters.maxOutputTokens ?? outputCap, outputCap) };
}

async function generateValidatedStructure<T extends z.ZodType>({
  schema, label, prompt, agent, context, selected, parentAbortSignal,
}: {
  schema: T;
  label: string;
  prompt: string;
  agent: CreativeAgentPort;
  context: ReturnType<typeof requestContext>;
  selected: Awaited<ReturnType<typeof settings>>;
  parentAbortSignal?: AbortSignal;
}) {
  return generateStructuredOutput({
    schema, label, prompt,
    generate: (currentPrompt, mode) => generateWithGuard(
      `${label}${mode === "json-text" ? "（JSON 兼容输出）" : ""}`,
      (abortSignal) => agent.generate(currentPrompt, {
        requestContext: context,
        abortSignal,
        ...(mode === "native" ? structuredOutputOptions(schema) : { toolChoice: "none" as const }),
        providerOptions: productionProviderOptions,
        modelSettings: selected,
      }),
      undefined,
      { abortSignal: parentAbortSignal, progressId: context.get("runId") },
    ),
  });
}

export function characterAssetPaths(paths: string[]) { return paths.filter((path) => path.startsWith("book/characters/") && path.endsWith(".md")).sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true })); }

async function readCharacterAssets(novelId: string, paths: string[], maxChars = 50_000) {
  const parts: string[] = [];
  const basis: Record<string, string> = {};
  let remaining = maxChars;
  for (const path of characterAssetPaths(paths)) {
    if (remaining <= 0) break;
    const file = await repository.readProjectFile(novelId, path, 0, Math.min(12_000, remaining));
    basis[file.path] = file.sha256;
    const section = `### ${path}\n${file.content}`;
    parts.push(section);
    remaining -= section.length;
  }
  return { text: parts.join("\n\n"), basis };
}

function renderAdaptations(adaptations: ReferenceAdaptation[], stage: "planning" | "writing" | "review") {
  if (!adaptations.length) return "";
  const payload = adaptations.map((item) => ({
    id: item.id, scope: item.scope, summary: item.summary,
    mechanisms: item.selectedInsights.map(({ id, title, mechanism, adaptationHint, doNotCopy }) => ({ id, title, mechanism, adaptationHint, doNotCopy })),
    constraints: item.constraints[stage],
  }));
  return `## 已批准的机制级仿写约束\n${JSON.stringify(payload)}\n\n这些内容不包含参考作品原文。只能迁移抽象机制，必须使用本作人物、设定、冲突和语言完成；不得复制专有名字、设定组合、情节组合或句式。`;
}

async function adaptationsForRange(novelId: string, fromChapter: number, toChapter: number) {
  return (await repository.adaptations(novelId)).filter(({ adaptation }) => adaptation.status === "approved" && adaptation.scope.fromChapter <= toChapter && adaptation.scope.toChapter >= fromChapter);
}

async function assertAdaptationVersions(execution: ExecutionEnvelope) {
  const expected = execution.adaptationVersions;
  if (!Object.keys(expected).length) return;
  const current = new Map((await repository.adaptations(execution.novelId)).map((item) => [item.adaptation.id, item.file.sha256]));
  if (Object.entries(expected).some(([id, sha]) => current.get(id) !== sha)) throw new Error("仿写提案已经变化，请重新启动生产任务");
}

async function ensureVolumePlan(execution: ExecutionEnvelope, fromChapter: number, toChapter: number, parentAbortSignal?: AbortSignal) {
  const { novelId, skillVersions } = execution;
  const state = await repository.get(novelId);
  const volumePath = `volumes/volume-${String(state.currentVolume).padStart(3, "0")}.md`;
  const curvePath = volumeTensionPath(state.currentVolume);
  const [existingPlan, existingCurveFile] = await Promise.all([
    state.files[volumePath] ? repository.readProjectFile(novelId, volumePath, 0, 500_000) : undefined,
    state.files[curvePath] ? repository.readProjectFile(novelId, curvePath, 0, 500_000) : undefined,
  ]);
  const existingCurve = existingCurveFile ? volumeTensionCurveSchema.parse(parse(existingCurveFile.content)) : undefined;
  const { missingPlanChapters, missingCurveChapters } = volumePlanningGaps(existingPlan?.content, existingCurve?.points ?? [], fromChapter, toChapter);
  const existingCurveChapters = new Set(existingCurve?.points.map((point) => point.chapter) ?? []);
  if (!missingPlanChapters.length && !missingCurveChapters.length) return { volumePath, curvePath, created: false };

  const generationFrom = Math.min(missingPlanChapters[0] ?? Number.POSITIVE_INFINITY, missingCurveChapters[0] ?? Number.POSITIVE_INFINITY);
  if (!Number.isFinite(generationFrom) || generationFrom > toChapter) throw new Error(`当前卷计划或张力曲线没有覆盖第 ${fromChapter}-${toChapter} 章，请重新生成当前卷规划`);

  const [blueprint, bookCurve, ledger, characters, skill, adaptationItems] = await Promise.all([
    repository.readProjectFile(novelId, "book/blueprint.md", 0, 80_000),
    repository.readProjectFile(novelId, "book/tension-curve.yaml", 0, 30_000),
    repository.readProjectFile(novelId, "book/ledger.yaml", 0, 50_000),
    readCharacterAssets(novelId, Object.keys(state.files)),
    readSkill("volume-planning", skillVersions["volume-planning"]),
    adaptationsForRange(novelId, fromChapter, toChapter),
  ]);
  const adaptations = adaptationItems.map((item) => item.adaptation);
  const basis = { ...characters.basis, ...Object.fromEntries([
    blueprint, bookCurve, ledger, ...(existingPlan ? [existingPlan] : []), ...(existingCurveFile ? [existingCurveFile] : []), ...adaptationItems.map((item) => item.file),
  ].map((file) => [file.path, file.sha256])) };
  const context = requestContext(execution, "writer", "planning");
  const selected = await settings("writer", 5_000);
  const prompt = `${skill}\n\n作品蓝图：\n${blueprint.content}\n\n全书张力曲线：\n${bookCurve.content}${characters.text ? `\n\n角色档案（长期设计）：\n${characters.text}` : ""}\n\n连续性账本（当前事实）：\n${ledger.content}${existingPlan ? `\n\n已有卷计划（原文必须保持成立）：\n${existingPlan.content}` : ""}${existingCurve ? `\n\n已有本卷张力曲线（已有节点必须保持不变）：\n${existingCurveFile!.content}` : ""}${adaptations.length ? `\n\n${renderAdaptations(adaptations, "planning")}` : ""}\n\n补齐第 ${generationFrom}-${toChapter} 章。plan 输出这段范围内完整的 Markdown 章节卡，每章必须使用“## 第 N 章”标题并写明目标、阻力、转折、角色推进、回报和钩子；已有章卡只用于保持事实一致，系统只会追加缺失章卡。curve.points 必须严格按第 ${generationFrom} 到 ${toChapter} 章排列，source 固定 ai，locked 固定 false；系统会保留所有已有节点。张力只是创作方向，不要求正文机械达到分数。`;
  const generated = await generateValidatedStructure({ schema: generatedVolumePlanSchema, label: "卷计划与张力曲线", prompt, agent: novelAgent, context, selected, parentAbortSignal });
  if (!chapterPlanCoversRange(generated.plan, generationFrom, toChapter)) throw new Error(`模型返回的卷计划没有完整覆盖第 ${generationFrom}-${toChapter} 章`);
  const generatedCurve = volumeTensionCurveSchema.parse({ schemaVersion: 1, kind: "volume", volume: state.currentVolume, title: generated.curve.title, chapterRange: { from: generationFrom, to: toChapter }, basis: { blueprintSha256: blueprint.sha256, bookCurveSha256: bookCurve.sha256, volumePlanSha256: existingPlan?.sha256 ?? "0".repeat(64), adaptationsSha256: execution.adaptationsSha256, generatedAt: new Date().toISOString() }, calibration: { status: "aligned", reasons: [] }, points: generated.curve.points });
  const planChanged = missingPlanChapters.length > 0;
  const newPlanCards = missingPlanChapters.map((chapter) => extractChapterPlan(generated.plan, chapter)).join("\n\n");
  const plan = existingPlan
    ? planChanged ? `${existingPlan.content}\n\n${newPlanCards}\n` : existingPlan.content
    : `${newPlanCards}\n`;
  const curve = volumeTensionCurveSchema.parse({
    schemaVersion: 1,
    kind: "volume",
    volume: state.currentVolume,
    title: existingCurve?.title ?? generatedCurve.title,
    chapterRange: { from: Math.min(existingCurve?.chapterRange.from ?? generationFrom, generationFrom), to: Math.max(existingCurve?.chapterRange.to ?? toChapter, toChapter) },
    basis: { ...(existingCurve?.basis ?? generatedCurve.basis), blueprintSha256: blueprint.sha256, bookCurveSha256: bookCurve.sha256, adaptationsSha256: execution.adaptationsSha256, generatedAt: new Date().toISOString() },
    calibration: existingCurve?.calibration ?? generatedCurve.calibration,
    points: [...(existingCurve?.points ?? []), ...generatedCurve.points.filter((point) => !existingCurveChapters.has(point.chapter))].sort((left, right) => left.chapter - right.chapter),
  });
  const changes = [
    ...(planChanged || !existingPlan ? [{ operation: existingPlan ? "replace" as const : "create" as const, path: volumePath, ...(existingPlan ? { baseSha256: existingPlan.sha256 } : {}), content: plan }] : []),
    { operation: existingCurveFile ? "replace" as const : "create" as const, path: curvePath, ...(existingCurveFile ? { baseSha256: existingCurveFile.sha256 } : {}), content: stringify(curve, { lineWidth: 0 }) },
  ];
  parentAbortSignal?.throwIfAborted();
  await repository.commitProductionPlan(novelId, execution.runId, changes, basis);
  return { volumePath, curvePath, created: true };
}

export function selectReviewPaths(files: string[], scope: ProductionJobRequest["scope"]) {
  if (scope.paths?.length) return [...new Set(scope.paths)];
  const chapters = files.filter((path) => path.startsWith("chapters/")).sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
  if (scope.fromChapter || scope.toChapter) {
    const from = scope.fromChapter ?? 1;
    const to = scope.toChapter ?? Number.MAX_SAFE_INTEGER;
    if (to < from) throw new Error("审查章节范围无效");
    return chapters.filter((path) => { const chapter = Number(path.match(/\d+/)?.[0]); return chapter >= from && chapter <= to; });
  }
  return files.filter((path) => /\.(?:md|ya?ml|json|txt)$/i.test(path) && !path.startsWith("exports/") && !path.startsWith("workspace/reviews/") && !path.startsWith("workspace/proposals/"));
}

export function chunkReviewSources(sources: ReviewSource[], maxChars = 24_000) {
  const pieces = sources.flatMap((source) => source.content.length <= maxChars
    ? [source]
    : Array.from({ length: Math.ceil(source.content.length / maxChars) }, (_, index) => ({ path: source.path, content: source.content.slice(index * maxChars, (index + 1) * maxChars) })));
  const batches: ReviewSource[][] = [];
  for (const source of pieces) {
    const current = batches.at(-1);
    const size = current?.reduce((total, item) => total + item.content.length, 0) ?? 0;
    if (!current || size + source.content.length > maxChars) batches.push([source]); else current.push(source);
  }
  return batches;
}

export function renderProjectReviewReport(brief: string, paths: string[], results: ProjectReviewResult[]) {
  const findings = results.flatMap((result) => result.findings);
  const strengths = [...new Set(results.flatMap((result) => result.strengths))];
  const lines = [
    "# 项目审查报告", "", `> 审查目标：${brief}`, "", `审查范围：${paths.join("、")}`, "",
    "## 总结", "", ...results.map((result) => result.summary), "",
  ];
  if (strengths.length) lines.push("## 已成立的部分", "", ...strengths.map((item) => `- ${item}`), "");
  lines.push("## 问题与建议", "");
  if (!findings.length) lines.push("未发现有充分文本证据支持的阻断问题。", "");
  for (const [index, finding] of findings.entries()) {
    lines.push(`### ${index + 1}. [${finding.severity.toUpperCase()}] ${finding.title}`, "", `- 类别：${finding.category}`, `- 说明：${finding.explanation}`, `- 建议：${finding.recommendation}`, "- 证据：", ...finding.evidence.map((item) => `  - \`${item.path}\`：${item.excerpt}`), "");
  }
  lines.push("---", "", "本报告只记录审查结论，不会自动覆盖任何正文。需要修改时，由 Agent 基于证据另行提交补丁。", "");
  return lines.join("\n");
}

export function validateProjectReviewEvidence(result: ProjectReviewResult, sources: ReviewSource[]): ProjectReviewResult {
  const contentByPath = new Map(sources.map((source) => [source.path, normalizedProse(source.content)]));
  const findings = result.findings.map((finding) => ({
    ...finding,
    evidence: finding.evidence.filter((item) => contentByPath.get(item.path)?.includes(normalizedProse(item.excerpt))),
  })).filter((finding) => finding.evidence.length > 0);
  const removed = result.findings.length - findings.length;
  return { ...result, summary: removed ? `证据校验后保留 ${findings.length} 项可定位问题；另有 ${removed} 项因摘录与标注文件不匹配，未纳入报告。` : result.summary, findings };
}

function compactAuthority(source: ReviewSource) {
  if (source.content.length <= 12_000) return source;
  return { ...source, content: `${source.content.slice(0, 5_000)}\n\n[中间内容已省略]\n\n${source.content.slice(-7_000)}` };
}

async function reviewProject(input: z.infer<typeof productionWorkflowInputSchema>, execution: ExecutionEnvelope, parentAbortSignal?: AbortSignal) {
  const files = await repository.listFiles(input.novelId);
  const paths = selectReviewPaths(files.map((file) => file.path), input.scope);
  if (!paths.length) throw new Error("当前范围内没有可审查的作品文件");
  const existing = new Set(files.map((file) => file.path));
  const invalid = paths.find((path) => !existing.has(path));
  if (invalid) throw new Error(`审查文件不存在：${invalid}`);
  const authorityPaths = ["book/blueprint.md", "book/ledger.yaml", ...files.filter((file) => file.path.startsWith("volumes/")).map((file) => file.path)].filter((path) => existing.has(path));
  const [sourceFiles, skill] = await Promise.all([
    Promise.all([...new Set([...authorityPaths, ...paths])].map((path) => repository.readProjectFile(input.novelId, path, 0, 80_000))),
    readSkill("project-review", input.skillVersions["project-review"]),
  ]);
  const byPath = new Map(sourceFiles.map((file) => [file.path, file]));
  const authority = authorityPaths.map((path) => compactAuthority(byPath.get(path)!));
  const sources = paths.map((path) => byPath.get(path)!);
  const basis = Object.fromEntries(sourceFiles.map((file) => [file.path, file.sha256]));
  const brief = input.brief ?? "审查所选作品文件，找出有明确文本证据的问题并给出可执行建议。";
  const authorityText = authority.map((item) => `## ${item.path}\n${item.content}`).join("\n\n");
  const batches = chunkReviewSources(sources);
  const results: ProjectReviewResult[] = [];
  for (const [index, batch] of batches.entries()) {
    const selected = await settings("critic", 4_000);
    const sourceText = batch.map((item) => `## ${item.path}\n${item.content}`).join("\n\n");
    const prompt = `${skill}\n\n作者的审查目标：\n${brief}\n\n权威约束：\n${authorityText}\n\n本批待审文件：\n${sourceText}\n\n根据作者目标自主选择检查角度。只报告有上述文件直接证据的问题；evidence.path 必须使用本轮提供的真实路径。`;
    const parsed = await generateValidatedStructure({ schema: projectReviewResultSchema, label: `项目审查第 ${index + 1}/${batches.length} 批`, prompt, agent: novelCritic, context: requestContext(execution, "critic", "reviewing"), selected, parentAbortSignal });
    results.push(validateProjectReviewEvidence(parsed, [...authority, ...batch]));
  }
  const report = renderProjectReviewReport(brief, paths, results);
  parentAbortSignal?.throwIfAborted();
  return (await repository.commitReviewReport(input.novelId, input.jobId, report, basis)).path;
}

function chineseChapterNumber(value: string) {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const units: Record<string, number> = { 十: 10, 百: 100, 千: 1_000 };
  let total = 0;
  let digit = 0;
  for (const character of value) {
    if (character in digits) digit = digits[character]!;
    else if (character in units) {
      total += (digit || 1) * units[character]!;
      digit = 0;
    } else return Number.NaN;
  }
  return total + digit;
}

export function chapterPlanNumbers(plan: string) {
  const heading = /^#{1,6}\s*第\s*([\d零〇一二两三四五六七八九十百千]+)\s*章(?=\s|《|[：:—-]|$).*$/gm;
  const matches = [...plan.matchAll(heading)];
  return matches.map((match) => chineseChapterNumber(match[1]!)).filter(Number.isFinite);
}

export function chapterPlanCoversRange(plan: string, fromChapter: number, toChapter: number) {
  const chapters = new Set(chapterPlanNumbers(plan));
  return Array.from({ length: toChapter - fromChapter + 1 }, (_, index) => fromChapter + index).every((chapter) => chapters.has(chapter));
}

export function volumePlanningGaps(plan: string | undefined, points: Array<{ chapter: number }>, fromChapter: number, toChapter: number) {
  const requested = Array.from({ length: toChapter - fromChapter + 1 }, (_, index) => fromChapter + index);
  const planned = new Set(plan ? chapterPlanNumbers(plan) : []);
  const curved = new Set(points.map((point) => point.chapter));
  return {
    missingPlanChapters: requested.filter((chapter) => !planned.has(chapter)),
    missingCurveChapters: requested.filter((chapter) => !curved.has(chapter)),
  };
}

export function extractChapterPlan(plan: string, chapter: number) {
  const heading = /^#{1,6}\s*第\s*([\d零〇一二两三四五六七八九十百千]+)\s*章(?=\s|《|[：:—-]|$).*$/gm;
  const matches = [...plan.matchAll(heading)];
  const current = matches.findIndex((match) => chineseChapterNumber(match[1]!) === chapter);
  if (current < 0) throw new Error(`当前卷计划缺少第 ${chapter} 章章节卡`);
  const start = matches[current]!.index!;
  const end = matches[current + 1]?.index ?? plan.length;
  return plan.slice(start, end).trim();
}

export function chapterJobBrief(brief: string | undefined) {
  const value = brief?.trim();
  return value ? `## 作者本次任务要求（本次生产的显式约束）\n${value}\n\n若它与预存章节卡的可变细节冲突，以本段为准；不得因此违反连续性账本、世界硬规则或作者保护。` : "";
}

function normalizedProse(value: string) { return value.toLocaleLowerCase("zh-CN").replace(/[^\p{L}\p{N}]+/gu, ""); }

export function chapterOverlapRatio(previous: string, candidate: string) {
  const left = normalizedProse(previous);
  const right = normalizedProse(candidate);
  if (left.length < 200 || right.length < 200) return 0;
  let common = 0;
  const limit = Math.min(left.length, right.length);
  while (common < limit && left[common] === right[common]) common += 1;
  return common / left.length;
}

async function chapterContext(novelId: string, chapter: number, volumePath: string, brief?: string) {
  const state = await repository.get(novelId);
  const previousPath = chapter > 1 ? `chapters/chapter-${String(chapter - 1).padStart(3, "0")}.md` : undefined;
  const curvePath = volumeTensionPath(state.currentVolume);
  const [blueprint, characters, ledger, volume, curveFile, previous, adaptationItems] = await Promise.all([
    repository.readProjectFile(novelId, "book/blueprint.md", 0, 50_000),
    readCharacterAssets(novelId, Object.keys(state.files)),
    repository.readProjectFile(novelId, "book/ledger.yaml", 0, 50_000),
    repository.readProjectFile(novelId, volumePath, 0, 50_000),
    repository.readProjectFile(novelId, curvePath, 0, 30_000),
    previousPath ? repository.readProjectFile(novelId, previousPath, 0, 20_000) : undefined,
    repository.activeAdaptations(novelId, chapter),
  ]);
  const adaptations = adaptationItems.map((item) => item.adaptation);
  const basis = { ...characters.basis, ...Object.fromEntries([
    blueprint, ledger, volume, curveFile, ...(previous ? [previous] : []), ...adaptationItems.map((item) => item.file),
  ].map((file) => [file.path, file.sha256])) };
  const currentPlan = extractChapterPlan(volume.content, chapter);
  const curve = curveFile ? volumeTensionCurveSchema.parse(parse(curveFile.content)) : undefined;
  const pointIndex = curve?.points.findIndex((point) => point.chapter === chapter) ?? -1;
  const tensionWindow = curve ? curve.points.slice(Math.max(0, pointIndex - 1), pointIndex + 2) : undefined;
  const source = [
    `## 本次唯一任务\n创作第 ${chapter} 章，只执行下方“当前章节卡”。其他章节卡不属于本次任务。`,
    chapterJobBrief(brief),
    `## 当前章节卡（唯一执行目标）\n${currentPlan}`,
    tensionWindow ? `## 当前张力目标（方向约束，不在正文输出分数）\n${stringify(tensionWindow, { lineWidth: 0 })}` : "",
    `## 作品蓝图（全局约束）\n${blueprint.content}`,
    characters.text ? `## 角色档案（长期设计，不代表已经发生）\n${characters.text}` : "",
    `## 连续性账本（稳定事实）\n${ledger.content}`,
    previous ? `## 上一章稳定正文（只用于承接）\n${previous.content}\n\n上一章内容已经发生，严禁复制、改写或重新表演。第 ${chapter} 章必须从其结尾状态继续，并产生新的目标推进、阻力、转折和净变化。` : "",
    renderAdaptations(adaptations, "writing"),
    adaptations.length ? `## 仿写验收约束\n${renderAdaptations(adaptations, "review")}` : "",
  ].filter(Boolean).join("\n\n");
  return { source, previousChapter: previous?.content, basis };
}

async function writeChapter(execution: ExecutionEnvelope, chapter: number, source: string, feedback = "", parentAbortSignal?: AbortSignal) {
  const { skillVersions } = execution;
  const skill = await readSkill("chapter-writing", skillVersions["chapter-writing"]);
  const context = requestContext(execution, "writer", "writing");
  const selected = await settings("writer", 6_000);
  const result = await generateWithGuard(`生成第 ${chapter} 章`, (abortSignal) => novelAgent.generate(`${skill}\n\n第 ${chapter} 章权威上下文：\n${source}${feedback ? `\n\n作者处理意见：${feedback}` : ""}\n\n直接从上一章结束后的新动作、新压力或新决定写起。不得复述上一章，不得把上一章正文包含在输出中。只输出第 ${chapter} 章正文。`, { requestContext: context, abortSignal, toolChoice: "none", providerOptions: productionProviderOptions, modelSettings: selected }), undefined, { abortSignal: parentAbortSignal, progressId: execution.runId });
  if (!result.text?.trim()) throw new Error("模型没有返回可用章节正文");
  return result.text.trim();
}

async function critiqueChapter(execution: ExecutionEnvelope, chapter: number, source: string, text: string, parentAbortSignal?: AbortSignal): Promise<CriticResult> {
  const { skillVersions } = execution;
  const context = requestContext(execution, "critic", "reviewing");
  const [skill, characterSkill, selected] = await Promise.all([readSkill("critique", skillVersions.critique), readSkill("character-planning", skillVersions["character-planning"]), settings("critic", 2_500)]);
  const prompt = `${skill}\n\n需要创建新角色档案时遵循以下方法：\n${characterSkill}\n\n第 ${chapter} 章权威上下文：\n${source}\n\n待验收正文：\n${text}\n\n必须逐项比较“上一章稳定正文”和待验收正文。若待验收正文复制、近似改写或重新表演上一章的主要段落/事件，不得 accepted；可删除重复部分且剩余正文仍完整则 repair，否则 replan。`;
  return generateValidatedStructure({ schema: criticResultSchema, label: `第 ${chapter} 章验收`, prompt, agent: novelCritic, context, selected, parentAbortSignal });
}

export const MAX_CHAPTER_QUALITY_REWRITES = 2;
export function chapterQualityAction(verdict: CriticResult["verdict"], completedRewrites: number): "accept" | "rewrite" | "fail" {
  if (verdict === "accepted") return "accept";
  return completedRewrites < MAX_CHAPTER_QUALITY_REWRITES ? "rewrite" : "fail";
}

async function rewriteChapterForQuality(execution: ExecutionEnvelope, chapter: number, source: string, text: string, review: CriticResult, rewriteNumber: number, interactionMode: z.infer<typeof productionInteractionModeSchema>, parentAbortSignal?: AbortSignal) {
  const context = requestContext(execution, "writer", "writing");
  const [skill, selected] = await Promise.all([readSkill("chapter-writing", execution.skillVersions["chapter-writing"]), settings("writer", 7_000)]);
  const action = review.verdict === "replan"
    ? "先在内部重新规划本章的目标、阻力、转折、因果链与章末钩子，再据此彻底重写"
    : "保持已经成立的事件结果与连续性，只修复审查指出的问题并重写受影响段落";
  const modeLabel = interactionMode === "autonomous_opening" ? "全自动开书" : "章节生产";
  const prompt = `${skill}\n\n这是${modeLabel}的第 ${rewriteNumber}/${MAX_CHAPTER_QUALITY_REWRITES} 次质量重写。${action}。\n\n第 ${chapter} 章权威上下文：\n${source}\n\n独立验收结果：\n${JSON.stringify(review)}\n\n待重写正文：\n${text}\n\n不得降低或回避验收标准。最终只输出完整的第 ${chapter} 章正文，不输出提纲、分析、自查或说明。`;
  const result = await generateWithGuard(`自动重写第 ${chapter} 章（第 ${rewriteNumber} 次）`, (abortSignal) => novelAgent.generate(prompt, { requestContext: context, abortSignal, toolChoice: "none", providerOptions: productionProviderOptions, modelSettings: selected }), undefined, { abortSignal: parentAbortSignal, progressId: execution.runId });
  const rewritten = result.text?.trim();
  if (!rewritten) throw new Error(`第 ${chapter} 章第 ${rewriteNumber} 次自动重写没有返回可用正文`);
  return rewritten;
}

function enforceOverlapGuard(review: CriticResult, chapter: number, previousChapter: string | undefined, text: string): CriticResult {
  const overlap = previousChapter ? chapterOverlapRatio(previousChapter, text) : 0;
  if (overlap < 0.6) return review;
  return {
    ...review,
    verdict: "repair",
    summary: `第 ${chapter} 章开头与上一章有 ${Math.round(overlap * 100)}% 的实质重叠，禁止提交。`,
    issues: [{ evidence: "待验收正文从开头复制或近似改写了上一章主体。", severity: "critical", repair: "删除全部复演内容，从上一章结尾后的新事件直接开始，只保留当前章节卡要求的事件。" }, ...review.issues],
  };
}

const runStep = createStep({
  id: "run-production", description: "在一个可恢复运行中完成通用项目审查、导出、修订或严格串行的章节生产。",
  inputSchema: productionWorkflowInputSchema, outputSchema, suspendSchema, resumeSchema, retries: 0,
  execute: async ({ inputData, resumeData, suspend, abortSignal }) => {
    try {
    const state = await repository.get(inputData.novelId);
    const execution = inputData.execution;
    if (!execution || state.productionAuthorization?.jobId !== inputData.jobId) throw new Error("此任务缺少生产授权，请取消旧任务并重新启动");
    await assertAdaptationVersions(execution);
    if (execution.runId !== inputData.jobId || execution.novelId !== inputData.novelId || execution.novelStateHash !== inputData.baseStateHash) throw new Error("执行信封与任务输入不一致");
    if (state.activeJobId !== inputData.jobId) throw new Error("活动任务标识已经变化");
    if (resumeData?.action === "cancel") {
      await repository.finishProductionJob(inputData.novelId, inputData.jobId, "canceled");
      return { status: "canceled" as const, novelId: inputData.novelId, jobId: inputData.jobId, completedThrough: state.nextChapter - 1 };
    }
    if (repository.stateHash(state) !== inputData.baseStateHash && !resumeData) throw new Error("任务输入已经过期，请重新启动");
    if (inputData.interactionMode === "autonomous_opening" && inputData.goal !== "write_chapters") throw new Error("全自动开书模式只允许生产前三章");
    if (inputData.goal === "review_project") {
      const reportPath = await reviewProject(inputData, execution, abortSignal);
      await repository.finishProductionJob(inputData.novelId, inputData.jobId, "completed");
      return { status: "completed" as const, novelId: inputData.novelId, jobId: inputData.jobId, completedThrough: state.nextChapter - 1, reportPath };
    }
    if (inputData.goal === "export") {
      abortSignal?.throwIfAborted();
      const exported = await repository.exportNovel(inputData.novelId, inputData.jobId);
      await repository.finishProductionJob(inputData.novelId, inputData.jobId, "completed");
      return { status: "completed" as const, novelId: inputData.novelId, jobId: inputData.jobId, completedThrough: state.nextChapter - 1, exportPath: exported.path };
    }
    if (inputData.goal === "revise_files") throw new Error("修订任务必须先由 Agent 提交文件补丁");
    if (!state.files["book/blueprint.md"] || !state.files["book/ledger.yaml"]) throw new Error("请先确认作品蓝图");
    if (!state.files["book/tension-curve.yaml"]) throw new Error("请先确认作品蓝图与全书张力曲线");
    const from = inputData.scope.fromChapter ?? state.nextChapter;
    const to = inputData.scope.toChapter ?? (inputData.interactionMode === "autonomous_opening" ? 3 : from + 2);
    if (from !== state.nextChapter || to < from || to > from + 4) throw new Error(`章节范围必须从第 ${state.nextChapter} 章开始，单次最多 5 章`);
    if (inputData.interactionMode === "autonomous_opening" && (from > 3 || to !== 3)) throw new Error("全自动开书任务必须从当前未完成章节继续，并以第 3 章结束");
    const { volumePath } = await ensureVolumePlan(execution, from, to, abortSignal);
    if (inputData.interactionMode === "standard" && !resumeData) return suspend({ jobId: inputData.jobId, checkpoint: "curve_confirmation", chapter: from, summary: `第 ${from}-${to} 章卷计划与目标张力曲线已经生成，请确认后继续。`, issues: [] });
    let cursor = (await repository.get(inputData.novelId)).nextChapter;
    for (; cursor <= to; cursor += 1) {
      const context = await chapterContext(inputData.novelId, cursor, volumePath, inputData.brief);
      let text = await writeChapter(execution, cursor, context.source, resumeData?.feedback ?? "", abortSignal);
      let review = enforceOverlapGuard(await critiqueChapter(execution, cursor, context.source, text, abortSignal), cursor, context.previousChapter, text);
      let completedRewrites = 0;
      while (chapterQualityAction(review.verdict, completedRewrites) === "rewrite") {
        completedRewrites += 1;
        text = await rewriteChapterForQuality(execution, cursor, context.source, text, review, completedRewrites, inputData.interactionMode, abortSignal);
        review = enforceOverlapGuard(await critiqueChapter(execution, cursor, context.source, text, abortSignal), cursor, context.previousChapter, text);
      }
      if (chapterQualityAction(review.verdict, completedRewrites) === "fail") throw new Error(`第 ${cursor} 章经过 ${MAX_CHAPTER_QUALITY_REWRITES} 次自动重写后仍未通过独立验收：${review.summary}`);
      abortSignal?.throwIfAborted();
      await repository.commitChapter(inputData.novelId, { jobId: inputData.jobId, chapter: cursor, text, review, basis: context.basis });
    }
    await repository.finishProductionJob(inputData.novelId, inputData.jobId, "completed");
    return { status: "completed" as const, novelId: inputData.novelId, jobId: inputData.jobId, completedThrough: to };
    } catch (error) {
      await repository.finishProductionJob(inputData.novelId, inputData.jobId, "failed").catch(() => undefined);
      throw error;
    }
  },
});

const novelProductionWorkflow = createWorkflow({ id: "novel-production", description: "单书单链的可恢复创作、审查与导出任务。", inputSchema: productionWorkflowInputSchema, outputSchema }).then(runStep).commit();
export function createNovelProductionWorkflow(deps: WorkflowDependencies) {
  if (workflowDependencies && workflowDependencies !== deps) throw new Error("小说生产工作流已经绑定");
  workflowDependencies = deps;
  return novelProductionWorkflow;
}
