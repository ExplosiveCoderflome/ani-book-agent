import { RequestContext } from "@mastra/core/request-context";
import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { characterProfileCreateSchema, continuityDeltaSchema, criticResultSchema, productionJobRequestSchema, type CriticResult, type ProductionJobRequest } from "../../domain";
import { modelSettings } from "../../infrastructure/model-settings";
import { NovelRepository, novelStateHash } from "../../infrastructure/novel-repository";
import { novelAgent, novelCritic } from "../agents/novel-agent";
import { generateWithGuard } from "../generation-guard";
import { readSkill } from "../skill-loader";
import { requireStructuredOutput, structuredOutputOptions } from "../structured-output";

export const productionWorkflowInputSchema = productionJobRequestSchema.extend({
  novelId: z.string().uuid(), jobId: z.string(),
  baseStateHash: z.string().length(64),
  skillVersions: z.record(z.string(), z.string()).default({}),
});
const resumeSchema = z.object({ action: z.enum(["continue", "revise", "cancel"]), feedback: z.string().max(2_000).optional() });
const suspendSchema = z.object({ jobId: z.string(), chapter: z.number().int().positive(), summary: z.string(), issues: criticResultSchema.shape.issues });
const outputSchema = z.object({ status: z.enum(["completed", "canceled"]), novelId: z.string().uuid(), jobId: z.string(), completedThrough: z.number().int().nonnegative(), exportPath: z.string().optional(), reportPath: z.string().optional() });
const repairedChapterResultSchema = z.object({
  verdict: z.enum(["accepted", "replan"]),
  summary: z.string().min(1),
  text: z.string(),
  continuityDelta: continuityDeltaSchema,
  newCharacterProfiles: z.array(characterProfileCreateSchema).max(5).default([]),
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
const repository = new NovelRepository();
const productionProviderOptions = { deepseek: { thinking: { type: "disabled" as const } } };

function requestContext(novelId: string, profile: "writer" | "critic", skillVersions: Record<string, string> = {}) { return new RequestContext([["novelId", novelId], ["taskType", profile], ["modelProfile", profile], ["skillVersions", skillVersions]]); }
async function settings(profile: "writer" | "critic", outputCap: number) {
  const selected = await modelSettings.runtimeSelection(profile);
  return { temperature: selected.parameters.temperature, topP: selected.parameters.topP, maxOutputTokens: Math.min(selected.parameters.maxOutputTokens ?? outputCap, outputCap) };
}

export function characterAssetPaths(paths: string[]) { return paths.filter((path) => path.startsWith("book/characters/") && path.endsWith(".md")).sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true })); }

async function readCharacterAssets(novelId: string, paths: string[], maxChars = 50_000) {
  const parts: string[] = [];
  let remaining = maxChars;
  for (const path of characterAssetPaths(paths)) {
    if (remaining <= 0) break;
    const file = await repository.readProjectFile(novelId, path, 0, Math.min(12_000, remaining));
    const section = `### ${path}\n${file.content}`;
    parts.push(section);
    remaining -= section.length;
  }
  return parts.join("\n\n");
}

async function ensureVolumePlan(novelId: string, fromChapter: number, toChapter: number, skillVersions: Record<string, string>) {
  const state = await repository.get(novelId);
  const volumePath = `volumes/volume-${String(state.currentVolume).padStart(3, "0")}.md`;
  if (state.files[volumePath]) return volumePath;
  const [blueprint, ledger, characters, skill] = await Promise.all([
    repository.readProjectFile(novelId, "book/blueprint.md", 0, 80_000),
    repository.readProjectFile(novelId, "book/ledger.yaml", 0, 50_000),
    readCharacterAssets(novelId, Object.keys(state.files)),
    readSkill("volume-planning", skillVersions["volume-planning"]),
  ]);
  const context = requestContext(novelId, "writer", skillVersions);
  const result = await generateWithGuard("生成当前卷计划", (abortSignal) => novelAgent.generate(`${skill}\n\n作品蓝图：\n${blueprint.content}${characters ? `\n\n角色档案（长期设计）：\n${characters}` : ""}\n\n连续性账本（当前事实）：\n${ledger.content}\n\n请规划第 ${fromChapter}-${toChapter} 章。直接输出可保存为当前卷计划的完整 Markdown；每张章节卡都写明目标、阻力、转折、角色推进、回报和钩子。不要输出 JSON、代码围栏或额外说明。`, { requestContext: context, abortSignal, toolChoice: "none", providerOptions: productionProviderOptions, modelSettings: awaitSettings(3_000) }));
  const plan = result.text?.trim();
  if (!plan || plan.length < 200) throw new Error("模型没有返回可用的当前卷计划");
  const proposal = await repository.prepareProposal(novelId, { intent: "建立当前卷计划", summary: `规划第 ${fromChapter}-${toChapter} 章`, changes: [{ operation: "create", path: volumePath, content: plan }] });
  await repository.applyProposal({ ...proposal, approval: "auto" }, true);
  return volumePath;
}

function awaitSettings(maxOutputTokens: number) { return { maxOutputTokens, temperature: 0.7 }; }

export function selectReviewPaths(files: string[], scope: ProductionJobRequest["scope"]) {
  if (scope.paths?.length) return [...new Set(scope.paths)];
  const chapters = files.filter((path) => path.startsWith("chapters/")).sort((left, right) => left.localeCompare(right, "zh-CN", { numeric: true }));
  if (scope.fromChapter || scope.toChapter) {
    const from = scope.fromChapter ?? 1;
    const to = scope.toChapter ?? Number.MAX_SAFE_INTEGER;
    if (to < from) throw new Error("审查章节范围无效");
    return chapters.filter((path) => { const chapter = Number(path.match(/\d+/)?.[0]); return chapter >= from && chapter <= to; });
  }
  return files.filter((path) => /\.(?:md|ya?ml|json|txt)$/i.test(path) && !path.startsWith("exports/") && !path.startsWith("workspace/reviews/"));
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

async function reviewProject(input: z.infer<typeof productionWorkflowInputSchema>, stateHash: string) {
  const files = await repository.listFiles(input.novelId);
  const paths = selectReviewPaths(files.map((file) => file.path), input.scope);
  if (!paths.length) throw new Error("当前范围内没有可审查的作品文件");
  const existing = new Set(files.map((file) => file.path));
  const invalid = paths.find((path) => !existing.has(path));
  if (invalid) throw new Error(`审查文件不存在：${invalid}`);
  const authorityPaths = ["book/blueprint.md", "book/ledger.yaml", ...files.filter((file) => file.path.startsWith("volumes/")).map((file) => file.path)].filter((path) => existing.has(path));
  const [authority, sources, skill] = await Promise.all([
    Promise.all(authorityPaths.map(async (path) => compactAuthority(await repository.readProjectFile(input.novelId, path, 0, 50_000)))),
    Promise.all(paths.map((path) => repository.readProjectFile(input.novelId, path, 0, 80_000))),
    readSkill("project-review", input.skillVersions["project-review"]),
  ]);
  const brief = input.brief ?? "审查所选作品文件，找出有明确文本证据的问题并给出可执行建议。";
  const authorityText = authority.map((item) => `## ${item.path}\n${item.content}`).join("\n\n");
  const batches = chunkReviewSources(sources);
  const results: ProjectReviewResult[] = [];
  for (const [index, batch] of batches.entries()) {
    const selected = await settings("critic", 4_000);
    const sourceText = batch.map((item) => `## ${item.path}\n${item.content}`).join("\n\n");
    const result = await generateWithGuard(`审查作品第 ${index + 1}/${batches.length} 批`, (abortSignal) => novelCritic.generate(`${skill}\n\n作者的审查目标：\n${brief}\n\n权威约束：\n${authorityText}\n\n本批待审文件：\n${sourceText}\n\n根据作者目标自主选择检查角度。只报告有上述文件直接证据的问题；evidence.path 必须使用本轮提供的真实路径。`, { requestContext: requestContext(input.novelId, "critic", input.skillVersions), abortSignal, ...structuredOutputOptions(projectReviewResultSchema), providerOptions: productionProviderOptions, modelSettings: selected }));
    const parsed = requireStructuredOutput(projectReviewResultSchema, result.object, "项目审查");
    results.push(validateProjectReviewEvidence(parsed, [...authority, ...batch]));
  }
  if (novelStateHash(await repository.get(input.novelId)) !== stateHash) throw new Error("审查期间作品发生变化，请重新启动审查");
  const reportPath = `workspace/reviews/review-${input.jobId}.md`;
  const report = renderProjectReviewReport(brief, paths, results);
  const proposal = await repository.prepareProposal(input.novelId, { intent: "保存项目审查报告", summary: brief, changes: [{ operation: "create", path: reportPath, content: report }] });
  await repository.applyProposal(proposal);
  return reportPath;
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

export function extractChapterPlan(plan: string, chapter: number) {
  const heading = /^#{1,6}\s*第\s*([\d零〇一二两三四五六七八九十百千]+)\s*章(?=\s|《|[：:—-]|$).*$/gm;
  const matches = [...plan.matchAll(heading)];
  const current = matches.findIndex((match) => chineseChapterNumber(match[1]!) === chapter);
  if (current < 0) return plan;
  const start = matches[current]!.index!;
  const end = matches[current + 1]?.index ?? plan.length;
  return plan.slice(start, end).trim();
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

async function chapterContext(novelId: string, chapter: number, volumePath: string) {
  const state = await repository.get(novelId);
  const previousPath = chapter > 1 ? `chapters/chapter-${String(chapter - 1).padStart(3, "0")}.md` : undefined;
  const [blueprint, characters, ledger, volume, previous] = await Promise.all([
    repository.readProjectFile(novelId, "book/blueprint.md", 0, 50_000),
    readCharacterAssets(novelId, Object.keys(state.files)),
    repository.readProjectFile(novelId, "book/ledger.yaml", 0, 50_000),
    repository.readProjectFile(novelId, volumePath, 0, 50_000),
    previousPath ? repository.readProjectFile(novelId, previousPath, 0, 20_000) : undefined,
  ]);
  const currentPlan = extractChapterPlan(volume.content, chapter);
  const source = [
    `## 本次唯一任务\n创作第 ${chapter} 章，只执行下方“当前章节卡”。其他章节卡不属于本次任务。`,
    `## 当前章节卡（唯一执行目标）\n${currentPlan}`,
    `## 作品蓝图（全局约束）\n${blueprint.content}`,
    characters ? `## 角色档案（长期设计，不代表已经发生）\n${characters}` : "",
    `## 连续性账本（稳定事实）\n${ledger.content}`,
    previous ? `## 上一章稳定正文（只用于承接）\n${previous.content}\n\n上一章内容已经发生，严禁复制、改写或重新表演。第 ${chapter} 章必须从其结尾状态继续，并产生新的目标推进、阻力、转折和净变化。` : "",
  ].filter(Boolean).join("\n\n");
  return { source, previousChapter: previous?.content };
}

async function writeChapter(novelId: string, chapter: number, source: string, feedback = "", skillVersions: Record<string, string> = {}) {
  const skill = await readSkill("chapter-writing", skillVersions["chapter-writing"]);
  const context = requestContext(novelId, "writer", skillVersions);
  const selected = await settings("writer", 6_000);
  const result = await generateWithGuard(`生成第 ${chapter} 章`, (abortSignal) => novelAgent.generate(`${skill}\n\n第 ${chapter} 章权威上下文：\n${source}${feedback ? `\n\n作者处理意见：${feedback}` : ""}\n\n直接从上一章结束后的新动作、新压力或新决定写起。不得复述上一章，不得把上一章正文包含在输出中。只输出第 ${chapter} 章正文。`, { requestContext: context, abortSignal, toolChoice: "none", providerOptions: productionProviderOptions, modelSettings: selected }));
  if (!result.text?.trim()) throw new Error("模型没有返回可用章节正文");
  return result.text.trim();
}

async function critiqueChapter(novelId: string, chapter: number, source: string, text: string, skillVersions: Record<string, string>): Promise<CriticResult> {
  const context = requestContext(novelId, "critic", skillVersions);
  const [skill, characterSkill, selected] = await Promise.all([readSkill("critique", skillVersions.critique), readSkill("character-planning", skillVersions["character-planning"]), settings("critic", 2_500)]);
  const result = await generateWithGuard(`验收第 ${chapter} 章`, (abortSignal) => novelCritic.generate(`${skill}\n\n需要创建新角色档案时遵循以下方法：\n${characterSkill}\n\n第 ${chapter} 章权威上下文：\n${source}\n\n待验收正文：\n${text}\n\n必须逐项比较“上一章稳定正文”和待验收正文。若待验收正文复制、近似改写或重新表演上一章的主要段落/事件，不得 accepted；可删除重复部分且剩余正文仍完整则 repair，否则 replan。`, { requestContext: context, abortSignal, ...structuredOutputOptions(criticResultSchema), providerOptions: productionProviderOptions, modelSettings: selected }));
  return requireStructuredOutput(criticResultSchema, result.object, "章节验收");
}

async function repairChapter(novelId: string, chapter: number, source: string, text: string, review: CriticResult, feedback = "", skillVersions: Record<string, string> = {}) {
  const context = requestContext(novelId, "writer", skillVersions);
  const [characterSkill, selected] = await Promise.all([readSkill("character-planning", skillVersions["character-planning"]), settings("writer", 7_000)]);
  const result = await generateWithGuard(`修复第 ${chapter} 章`, (abortSignal) => novelAgent.generate(`只做一次范围受控的章节修复。保持已经成立的事件、事实和因果，解决审查证据中的阻断问题。\n\n需要创建新角色档案时遵循以下方法：\n${characterSkill}\n\n权威上下文：\n${source}\n\n审查：\n${JSON.stringify(review)}${feedback ? `\n作者意见：${feedback}` : ""}\n\n待修正文：\n${text}\n\n返回修复后的完整正文，并且只根据修复后的最终正文重新抽取 continuityDelta。若有限修复无法成立，verdict 返回 replan；不得沿用待修稿的角色变化。新增长期角色只有在最终正文中仍然成立且没有对应角色档案时才进入 newCharacterProfiles。`, { requestContext: context, abortSignal, ...structuredOutputOptions(repairedChapterResultSchema), providerOptions: productionProviderOptions, modelSettings: selected }));
  const repaired = requireStructuredOutput(repairedChapterResultSchema, result.object, "章节修复");
  if (repaired.verdict === "accepted" && !repaired.text.trim()) throw new Error("模型没有返回可用修复正文");
  return { ...repaired, text: repaired.text.trim() };
}

const runStep = createStep({
  id: "run-production", description: "在一个可恢复运行中完成通用项目审查、导出、修订或严格串行的章节生产。",
  inputSchema: productionWorkflowInputSchema, outputSchema, suspendSchema, resumeSchema, retries: 1,
  execute: async ({ inputData, resumeData, suspend }) => {
    const state = await repository.get(inputData.novelId);
    if (state.activeJobId !== inputData.jobId) throw new Error("活动任务标识已经变化");
    if (resumeData?.action === "cancel") { await repository.setActiveJob(inputData.novelId, undefined); return { status: "canceled" as const, novelId: inputData.novelId, jobId: inputData.jobId, completedThrough: state.nextChapter - 1 }; }
    if (novelStateHash(state) !== inputData.baseStateHash && !resumeData) throw new Error("任务输入已经过期，请重新启动");
    if (inputData.goal === "review_project") {
      const reportPath = await reviewProject(inputData, inputData.baseStateHash);
      await repository.setActiveJob(inputData.novelId, undefined);
      return { status: "completed" as const, novelId: inputData.novelId, jobId: inputData.jobId, completedThrough: state.nextChapter - 1, reportPath };
    }
    if (inputData.goal === "export") {
      const exported = await repository.exportNovel(inputData.novelId); await repository.setActiveJob(inputData.novelId, undefined);
      return { status: "completed" as const, novelId: inputData.novelId, jobId: inputData.jobId, completedThrough: state.nextChapter - 1, exportPath: exported.path };
    }
    if (inputData.goal === "revise_files") throw new Error("修订任务必须先由 Agent 提交文件补丁");
    if (!state.files["book/blueprint.md"] || !state.files["book/ledger.yaml"]) throw new Error("请先确认作品蓝图");
    const from = inputData.scope.fromChapter ?? state.nextChapter;
    const to = inputData.scope.toChapter ?? from + 2;
    if (from !== state.nextChapter || to < from || to > from + 4) throw new Error(`章节范围必须从第 ${state.nextChapter} 章开始，单次最多 5 章`);
    const volumePath = await ensureVolumePlan(inputData.novelId, from, to, inputData.skillVersions);
    let cursor = (await repository.get(inputData.novelId)).nextChapter;
    for (; cursor <= to; cursor += 1) {
      const context = await chapterContext(inputData.novelId, cursor, volumePath);
      let text = await writeChapter(inputData.novelId, cursor, context.source, resumeData?.feedback ?? "", inputData.skillVersions);
      let review = await critiqueChapter(inputData.novelId, cursor, context.source, text, inputData.skillVersions);
      const overlap = context.previousChapter ? chapterOverlapRatio(context.previousChapter, text) : 0;
      if (overlap >= 0.6) review = {
        ...review,
        verdict: "repair",
        summary: `第 ${cursor} 章开头与上一章有 ${Math.round(overlap * 100)}% 的实质重叠，禁止提交。`,
        issues: [{ evidence: "待验收正文从开头复制或近似改写了上一章主体。", severity: "critical", repair: "删除全部复演内容，从上一章结尾后的新事件直接开始，只保留当前章节卡要求的事件。" }, ...review.issues],
      };
      if (review.verdict === "replan" && !resumeData) return suspend({ jobId: inputData.jobId, chapter: cursor, summary: review.summary, issues: review.issues });
      if (review.verdict !== "accepted") {
        const repaired = await repairChapter(inputData.novelId, cursor, context.source, text, review, resumeData?.feedback ?? "", inputData.skillVersions);
        if (repaired.verdict === "replan") return suspend({ jobId: inputData.jobId, chapter: cursor, summary: repaired.summary, issues: review.issues });
        text = repaired.text;
        review = { ...review, verdict: "accepted", summary: repaired.summary, issues: [], continuityDelta: repaired.continuityDelta, newCharacterProfiles: repaired.newCharacterProfiles };
      }
      const repairedOverlap = context.previousChapter ? chapterOverlapRatio(context.previousChapter, text) : 0;
      if (repairedOverlap >= 0.6) return suspend({ jobId: inputData.jobId, chapter: cursor, summary: `第 ${cursor} 章修复后仍与上一章重复，已阻止提交。`, issues: [{ evidence: `修复稿与上一章开头仍有 ${Math.round(repairedOverlap * 100)}% 的实质重叠。`, severity: "critical", repair: "重新规划本章开场与事件链，确认后再继续。" }] });
      await repository.commitChapter(inputData.novelId, cursor, text, review.continuityDelta, review.newCharacterProfiles);
    }
    await repository.setActiveJob(inputData.novelId, undefined);
    return { status: "completed" as const, novelId: inputData.novelId, jobId: inputData.jobId, completedThrough: to };
  },
});

export const novelProductionWorkflow = createWorkflow({ id: "novel-production", description: "单书单链的可恢复创作、审查与导出任务。", inputSchema: productionWorkflowInputSchema, outputSchema }).then(runStep).commit();
