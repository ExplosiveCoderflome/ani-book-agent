import { z } from "zod";

export const TENSION_CURVE_SCHEMA_VERSION = 1 as const;

export const emotionKindSchema = z.enum(["anticipation", "curiosity", "pressure", "fear", "exhilaration", "grief", "warmth", "relief"]);
export const storyFunctionSchema = z.enum(["hook", "setup", "escalation", "turn", "reveal", "payoff", "breather", "climax", "aftermath"]);
export const pointSourceSchema = z.enum(["ai", "author"]);

export const EMOTION_LABELS: Record<z.infer<typeof emotionKindSchema>, string> = {
  anticipation: "期待", curiosity: "好奇", pressure: "压迫", fear: "恐惧",
  exhilaration: "爽感", grief: "悲伤", warmth: "温暖", relief: "释然",
};
export const STORY_FUNCTION_LABELS: Record<z.infer<typeof storyFunctionSchema>, string> = {
  hook: "钩子", setup: "铺垫", escalation: "升级", turn: "转折", reveal: "揭示",
  payoff: "兑现", breather: "喘息", climax: "高潮", aftermath: "余波",
};

const shaSchema = z.string().length(64);
const emotionSchema = z.object({ kind: emotionKindSchema, intensity: z.number().int().min(1).max(5) });
const targetPointFields = {
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(1).max(120),
  tension: z.number().int().min(0).max(100),
  emotion: emotionSchema,
  function: storyFunctionSchema,
  rationale: z.string().trim().min(1).max(1_000),
  source: pointSourceSchema,
  locked: z.boolean(),
};

export const bookTensionPointSchema = z.object({ ...targetPointFields, progress: z.number().int().min(0).max(100) });
export const volumeTensionPointSchema = z.object({ ...targetPointFields, chapter: z.number().int().positive() });
export const actualTensionPointSchema = z.object({
  id: z.string().trim().min(1).max(80), chapter: z.number().int().positive(), tension: z.number().int().min(0).max(100),
  emotion: emotionSchema, function: storyFunctionSchema,
  evidence: z.array(z.string().trim().min(1).max(1_000)).min(1).max(5), confidence: z.number().min(0).max(1),
});

const calibrationSchema = z.object({ status: z.enum(["aligned", "needs_recalibration"]).default("aligned"), reasons: z.array(z.string().max(300)).default([]) }).default({ status: "aligned", reasons: [] });

export const bookTensionCurveSchema = z.object({
  schemaVersion: z.literal(TENSION_CURVE_SCHEMA_VERSION), kind: z.literal("book"), title: z.string().trim().min(1).max(120),
  basis: z.object({ blueprintSha256: shaSchema, generatedAt: z.string() }), calibration: calibrationSchema,
  points: z.array(bookTensionPointSchema).min(2).max(60),
}).superRefine((curve, context) => {
  if (curve.points[0]?.progress !== 0) context.addIssue({ code: "custom", path: ["points", 0, "progress"], message: "全书曲线必须从 0 开始" });
  if (curve.points.at(-1)?.progress !== 100) context.addIssue({ code: "custom", path: ["points", curve.points.length - 1, "progress"], message: "全书曲线必须在 100 结束" });
  curve.points.forEach((point, index) => { if (index && point.progress <= curve.points[index - 1]!.progress) context.addIssue({ code: "custom", path: ["points", index, "progress"], message: "全书节点进度必须严格递增" }); });
  uniquePointIds(curve.points, context);
});

export const volumeTensionCurveSchema = z.object({
  schemaVersion: z.literal(TENSION_CURVE_SCHEMA_VERSION), kind: z.literal("volume"), volume: z.number().int().positive(), title: z.string().trim().min(1).max(120),
  chapterRange: z.object({ from: z.number().int().positive(), to: z.number().int().positive() }),
  basis: z.object({ blueprintSha256: shaSchema, bookCurveSha256: shaSchema, volumePlanSha256: shaSchema, generatedAt: z.string() }), calibration: calibrationSchema,
  points: z.array(volumeTensionPointSchema).min(1).max(500),
}).superRefine((curve, context) => {
  if (curve.chapterRange.to < curve.chapterRange.from) context.addIssue({ code: "custom", path: ["chapterRange"], message: "章节范围无效" });
  const expected = Array.from({ length: curve.chapterRange.to - curve.chapterRange.from + 1 }, (_, index) => curve.chapterRange.from + index);
  if (curve.points.length !== expected.length || curve.points.some((point, index) => point.chapter !== expected[index])) context.addIssue({ code: "custom", path: ["points"], message: "分卷曲线必须按顺序完整覆盖规划章节，且章节不可重复" });
  uniquePointIds(curve.points, context);
});

export const actualTensionObservationSchema = actualTensionPointSchema.omit({ id: true, chapter: true });
export const actualTensionCurveSchema = z.object({
  schemaVersion: z.literal(TENSION_CURVE_SCHEMA_VERSION), kind: z.literal("actual"), volume: z.number().int().positive(),
  basis: z.object({ targetCurveSha256: shaSchema, volumePlanSha256: shaSchema, chapterHashes: z.record(z.string(), shaSchema), generatedAt: z.string() }),
  points: z.array(actualTensionPointSchema).max(500), diagnostics: z.array(z.object({ type: z.enum(["flat", "sustained_pressure", "weak_climax", "late_payoff", "deviation"]), fromChapter: z.number().int().positive(), toChapter: z.number().int().positive(), message: z.string() })).default([]),
}).superRefine((curve, context) => {
  curve.points.forEach((point, index) => { if (index && point.chapter <= curve.points[index - 1]!.chapter) context.addIssue({ code: "custom", path: ["points", index, "chapter"], message: "实际曲线章节必须严格递增" }); });
  uniquePointIds(curve.points, context);
});

export const targetTensionCurveSchema = z.union([bookTensionCurveSchema, volumeTensionCurveSchema]);
export const tensionCurveAssetSchema = z.union([bookTensionCurveSchema, volumeTensionCurveSchema, actualTensionCurveSchema]);
export type BookTensionCurve = z.infer<typeof bookTensionCurveSchema>;
export type VolumeTensionCurve = z.infer<typeof volumeTensionCurveSchema>;
export type ActualTensionCurve = z.infer<typeof actualTensionCurveSchema>;
export type TargetTensionCurve = z.infer<typeof targetTensionCurveSchema>;
export type ActualTensionObservation = z.infer<typeof actualTensionObservationSchema>;
export type TensionDiagnostic = ActualTensionCurve["diagnostics"][number];

function uniquePointIds(points: Array<{ id: string }>, context: z.RefinementCtx) {
  const seen = new Set<string>();
  points.forEach((point, index) => { if (seen.has(point.id)) context.addIssue({ code: "custom", path: ["points", index, "id"], message: "节点 id 不可重复" }); seen.add(point.id); });
}

export function isTensionCurvePath(path: string) {
  return path === "book/tension-curve.yaml" || /^volumes\/volume-\d{3}-tension\.yaml$/.test(path) || /^workspace\/analysis\/volume-\d{3}-tension-actual\.yaml$/.test(path);
}
export function isTargetTensionCurvePath(path: string) { return path === "book/tension-curve.yaml" || /^volumes\/volume-\d{3}-tension\.yaml$/.test(path); }
export function volumeTensionPath(volume: number) { return `volumes/volume-${String(volume).padStart(3, "0")}-tension.yaml`; }
export function actualTensionPath(volume: number) { return `workspace/analysis/volume-${String(volume).padStart(3, "0")}-tension-actual.yaml`; }

export function lockedPointChanges(before: TargetTensionCurve, after: TargetTensionCurve) {
  const next = new Map(after.points.map((point) => [point.id, point]));
  return before.points.filter((point) => point.locked && JSON.stringify(point) !== JSON.stringify(next.get(point.id))).map((point) => point.id);
}

export function markAuthorEdits(before: TargetTensionCurve, after: TargetTensionCurve): TargetTensionCurve {
  const old = new Map(before.points.map((point) => [point.id, point]));
  const points = after.points.map((point) => {
    const prior = old.get(point.id);
    if (prior && JSON.stringify(prior) === JSON.stringify(point)) return point;
    const explicitUnlock = prior?.locked && !point.locked && JSON.stringify({ ...prior, source: "author", locked: false }) === JSON.stringify({ ...point, source: "author", locked: false });
    return { ...point, source: "author" as const, locked: !explicitUnlock };
  });
  return targetTensionCurveSchema.parse({ ...after, points });
}

export function tensionCurveDependencyReasons(curve: TargetTensionCurve, hashes: Record<string, string | undefined>) {
  const reasons: string[] = [];
  if (hashes["book/blueprint.md"] && hashes["book/blueprint.md"] !== curve.basis.blueprintSha256) reasons.push("作品蓝图已变化");
  if (curve.kind === "volume") {
    const planPath = `volumes/volume-${String(curve.volume).padStart(3, "0")}.md`;
    if (hashes["book/tension-curve.yaml"] && hashes["book/tension-curve.yaml"] !== curve.basis.bookCurveSha256) reasons.push("全书张力曲线已变化");
    if (hashes[planPath] && hashes[planPath] !== curve.basis.volumePlanSha256) reasons.push("卷计划已变化，章节卡待校准");
  }
  return reasons;
}

const rewardFunctions = new Set(["turn", "reveal", "payoff"]);
export function diagnoseTension(actual: ActualTensionCurve["points"], target: VolumeTensionCurve["points"] = []): TensionDiagnostic[] {
  const diagnostics: TensionDiagnostic[] = [];
  const add = (type: TensionDiagnostic["type"], slice: ActualTensionCurve["points"], message: string) => { const first = slice[0]; const last = slice.at(-1); if (first && last && !diagnostics.some((item) => item.type === type && item.fromChapter === first.chapter && item.toChapter === last.chapter)) diagnostics.push({ type, fromChapter: first.chapter, toChapter: last.chapter, message }); };
  for (let index = 0; index <= actual.length - 4; index += 1) {
    const slice = actual.slice(index, index + 4); const values = slice.map((point) => point.tension);
    if (Math.max(...values) - Math.min(...values) <= 10 && !slice.some((point) => rewardFunctions.has(point.function) || point.function === "breather")) add("flat", slice, "连续 4 章张力变化过小，且没有结构性转折、回报或明确喘息。");
    if (slice.every((point) => point.tension >= 80) && !slice.some((point) => point.function === "breather" || point.function === "aftermath")) add("sustained_pressure", slice, "连续 4 章保持高压却没有释放节点，读者可能疲劳。");
  }
  for (let index = 0; index <= actual.length - 5; index += 1) { const slice = actual.slice(index, index + 5); if (!slice.some((point) => rewardFunctions.has(point.function))) add("late_payoff", slice, "连续 5 章没有转折、揭示或兑现，回报可能过晚。"); }
  actual.forEach((point, index) => {
    const planned = target.find((item) => item.chapter === point.chapter);
    if (point.function === "climax") { const earlier = actual.slice(Math.max(0, index - 4), index); const priorPeak = Math.max(0, ...earlier.map((item) => item.tension)); if (point.tension < 85 && point.tension < priorPeak + 10) add("weak_climax", [point], `第 ${point.chapter} 章被指定为高潮，但强度没有明显高于此前常规节点。`); }
    if (planned && Math.abs(point.tension - planned.tension) >= 25) add("deviation", [point], `第 ${point.chapter} 章实际张力与目标偏差达到 25。`);
    const previous = actual[index - 1]; const previousPlan = previous && target.find((item) => item.chapter === previous.chapter);
    if (planned && previous && previousPlan && Math.abs(point.tension - planned.tension) >= 15 && Math.abs(previous.tension - previousPlan.tension) >= 15) add("deviation", [previous, point], "连续两章实际张力与目标偏差达到 15。");
  });
  return diagnostics;
}
