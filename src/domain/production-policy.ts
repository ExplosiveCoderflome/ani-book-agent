import { artifactKey, bookStages, chapterStages, stageWorkflow, type NextAction, type NovelState } from "./novel-state";

export function decideNextAction(state: NovelState): NextAction {
  if (!state.openingChoices) return { type: "collect_opening_choices", reason: "先通过对话确认开书方向，或把选择交给 AI。" };

  for (const stage of bookStages) {
    const key = artifactKey(stage);
    const artifact = state.artifacts[key];
    if (!artifact || artifact.status === "missing" || artifact.status === "blocked") {
      return { type: "produce_artifact", stage, artifactKey: key, workflowId: stageWorkflow[stage], reason: `生成 ${stage}。` };
    }
    if (artifact.status === "stale") {
      return { type: "refresh_artifact", stage, artifactKey: key, workflowId: stageWorkflow[stage], reason: `${stage} 的上游已经变化。` };
    }
  }

  const lastChapter = state.continuity?.lastCommittedChapter ?? 0;
  if (lastChapter > 0) {
    const debt = state.artifacts[`chapter:${lastChapter}:quality_debt`];
    const repair = state.artifacts[`chapter:${lastChapter}:quality_repair`];
    if (debt?.status === "ready" && (!repair || repair.status === "missing" || repair.status === "blocked" || repair.status === "stale")) {
      return { type: repair?.status === "stale" ? "refresh_artifact" : "produce_artifact", stage: "quality_repair", artifactKey: `chapter:${lastChapter}:quality_repair`, workflowId: "quality-repair", reason: `先处理第 ${lastChapter} 章尚未关闭的质量债。` };
    }
  }

  if (state.currentChapter > state.approvedChapterEnd) {
    return { type: "approve_chapter_range", chapter: state.currentChapter, reason: `第 ${state.currentChapter} 章尚未获得生产授权。` };
  }

  for (const stage of chapterStages) {
    const key = artifactKey(stage, state.currentChapter);
    const artifact = state.artifacts[key];
    if (!artifact || artifact.status === "missing" || artifact.status === "blocked") {
      return { type: "produce_artifact", stage, artifactKey: key, workflowId: stageWorkflow[stage], reason: `推进第 ${state.currentChapter} 章的 ${stage}。` };
    }
    if (artifact.status === "stale") {
      return { type: "refresh_artifact", stage, artifactKey: key, workflowId: stageWorkflow[stage], reason: `第 ${state.currentChapter} 章的 ${stage} 需要刷新。` };
    }
  }

  return { type: "approve_chapter_range", chapter: state.currentChapter + 1, reason: "当前批准范围已完成。" };
}
