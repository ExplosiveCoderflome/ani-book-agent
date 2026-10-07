import { referenceAdaptationSchema, type ReferenceAdaptation } from "../domain";
import { AppError } from "./errors";
import type { AdaptationPlannerPort, NovelProjectStore, ReferenceLibraryStore } from "./ports";

type Dependencies = {
  novels: NovelProjectStore;
  references: ReferenceLibraryStore;
  planner: AdaptationPlannerPort;
  newId: () => string;
  now?: () => string;
};

const sameVersions = (left: Record<string, string>, right: Record<string, string>) => {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every((key) => left[key] === right[key]);
};

export function createReferenceAdaptationService({ novels, references, planner, newId, now = () => new Date().toISOString() }: Dependencies) {
  async function refresh(novelId: string) {
    const state = await novels.get(novelId);
    const authority = novels.adaptationAuthorityFiles(state);
    const items = await novels.adaptations(novelId);
    const refreshed = [];
    for (const item of items) {
      const reasons: ReferenceAdaptation["staleReasons"] = [];
      const reference = await references.get(item.adaptation.referenceId).catch(() => undefined);
      const analysis = reference?.analyses.find((value) => value.id === item.adaptation.analysisId);
      const analysisHash = analysis ? await references.analysisHash(item.adaptation.referenceId, item.adaptation.analysisId).catch(() => undefined) : undefined;
      if (!analysis || analysis.status !== "completed" || analysis.stale || analysisHash !== item.adaptation.analysisSha256) reasons.push("analysis");
      if (!sameVersions(authority, item.adaptation.authorityFiles)) reasons.push("authority");
      if (reasons.length && ["proposed", "approved"].includes(item.adaptation.status)) refreshed.push(await novels.markAdaptationStale(novelId, item.adaptation.id, reasons));
      else refreshed.push(item);
    }
    return refreshed;
  }

  async function create(referenceId: string, analysisId: string, input: { novelId: string; selectedInsightIds: string[]; fromChapter?: number; toChapter?: number }) {
    const reference = await references.get(referenceId);
    const analysis = reference.analyses.find((item) => item.id === analysisId);
    if (!analysis || analysis.status !== "completed" || analysis.stale) throw new AppError("REFERENCE_ANALYSIS_NOT_READY", "只能使用已完成且未过期的拆书结果。", 409, true, undefined, "reread");
    const selectedIds = [...new Set(input.selectedInsightIds)];
    if (!selectedIds.length || selectedIds.length > 3) throw new AppError("ADAPTATION_INSIGHT_LIMIT", "请选择 1–3 条推荐洞察。", 400, true);
    const [radar, sections, state, analysisSha256] = await Promise.all([
      references.radar(referenceId, analysisId).catch(() => undefined), references.sections(referenceId, analysisId), novels.get(input.novelId), references.analysisHash(referenceId, analysisId),
    ]);
    if (!radar) throw new AppError("REFERENCE_RADAR_REQUIRED", "这份历史拆书结果没有结构雷达，请使用新的分析结果创建仿写提案。", 409, true, undefined, "reread");
    if (selectedIds.some((id) => !radar.recommendedInsightIds.includes(id))) throw new AppError("ADAPTATION_INSIGHT_INVALID", "只能选择这份分析推荐的洞察。", 400, true);
    const insightMap = new Map(sections.flatMap((section) => section.insights).map((insight) => [insight.id, insight]));
    const selected = selectedIds.map((id) => insightMap.get(id));
    if (selected.some((item) => !item)) throw new AppError("ADAPTATION_INSIGHT_MISSING", "所选洞察已经变化，请重新选择。", 409, true, undefined, "reread");
    const fromChapter = input.fromChapter ?? state.nextChapter;
    const toChapter = input.toChapter ?? fromChapter + 2;
    if (fromChapter < state.nextChapter || toChapter < fromChapter || toChapter > fromChapter + 19) throw new AppError("ADAPTATION_SCOPE_INVALID", `仿写范围必须从第 ${state.nextChapter} 章或之后开始，单份提案最多覆盖 20 章。`, 400, true);
    const [blueprint, ledger] = await Promise.all([
      novels.readProjectFile(input.novelId, "book/blueprint.md", 0, 40_000), novels.readProjectFile(input.novelId, "book/ledger.yaml", 0, 30_000),
    ]).catch(() => { throw new AppError("ADAPTATION_TARGET_NOT_READY", "目标作品需要先完成作品蓝图和连续性账本。", 409, true, undefined, "author_approval"); });
    const selectedInsights = selected.map((item) => { const { evidence: _evidence, ...safe } = item!; return safe; });
    const scope = { fromChapter, toChapter };
    const plan = await planner.plan({ novel: { title: state.title, nextChapter: state.nextChapter, blueprint: blueprint.content, ledger: ledger.content }, scope, insights: selectedInsights });
    const timestamp = now();
    const adaptation = referenceAdaptationSchema.parse({
      schemaVersion: 1, id: newId(), novelId: input.novelId, referenceId, analysisId, analysisSha256,
      targetStateSha256: novels.stateHash(state), authorityFiles: novels.adaptationAuthorityFiles(state), selectedInsightIds: selectedIds,
      selectedInsights, scope, ...plan, status: "proposed", staleReasons: [], createdAt: timestamp, updatedAt: timestamp,
    });
    return novels.saveAdaptation(adaptation);
  }

  async function action(novelId: string, adaptationId: string, action: "approve" | "reject") {
    await refresh(novelId);
    const current = (await novels.adaptations(novelId)).find((item) => item.adaptation.id === adaptationId)?.adaptation;
    if (!current) throw new AppError("ADAPTATION_NOT_FOUND", "没有找到这个仿写提案。", 404, false);
    if (current.status === "stale") throw new AppError("ADAPTATION_STALE", "作品规划或拆书结果已经变化，请重新创建仿写提案。", 409, true, undefined, "replan");
    return novels.updateAdaptation(novelId, adaptationId, action);
  }

  return { create, list: refresh, action };
}

export type ReferenceAdaptationService = ReturnType<typeof createReferenceAdaptationService>;
