import { artifactKey, bookStages, chapterStages, completionAuditKey, decideNextAction, isMultiVolumeProduction, volumeHandoffKey, volumeOutlineKey, type NovelState } from "../domain";
import type { RunView, WorkspaceFocus, WorkspacePhase, WorkspaceProjection } from "../shared/contracts";

const labels: Record<string, string> = {
  opening: "开书讨论",
  novel_brief: "小说简报",
  story_bible: "故事圣经",
  world_bible: "世界设定",
  character_cast: "角色阵容",
  volume_strategy: "卷战略",
  volume_outline: "卷骨架",
  volume_handoff: "卷间承接",
  chapter_plan: "章节计划",
  context_package: "章节上下文",
  chapter_draft: "正文草稿",
  humanization_revision: "正文定稿",
  chapter_review: "章节审查",
  continuity_update: "连续性更新",
  quality_repair: "质量修复",
  completion_audit: "完本验收",
};

function itemStatus(state: NovelState, key: string, unlocked: boolean): WorkspaceProjection["production"][number]["status"] {
  const status = state.artifacts[key]?.status;
  if (status === "ready") return "ready";
  if (status === "stale") return "stale";
  if (status === "blocked") return "blocked";
  if (status === "in_progress") return "running";
  return unlocked ? "pending" : "locked";
}

function phaseOf(state: NovelState, nextAction: WorkspaceProjection["nextAction"]): WorkspacePhase {
  if (!state.openingChoices) return "discovery";
  if (state.productionStatus !== "in_progress" || nextAction.type === "complete_novel" || nextAction.type === "completion_blocked" || nextAction.type === "produce_artifact" && nextAction.stage === "completion_audit") return "completion";
  if (nextAction.type === "approve_chapter_range" || nextAction.type === "produce_artifact" && nextAction.artifactKey.startsWith("chapter:") || nextAction.type === "refresh_artifact" && nextAction.artifactKey.startsWith("chapter:")) return "chapter";
  if (nextAction.type === "configure_volume" || nextAction.type === "produce_artifact" && (nextAction.stage === "volume_outline" || nextAction.stage === "volume_handoff") || nextAction.type === "refresh_artifact" && (nextAction.stage === "volume_outline" || nextAction.stage === "volume_handoff")) return "volume";
  return "planning";
}

function focusOf(state: NovelState, nextAction: WorkspaceProjection["nextAction"], run?: RunView): WorkspaceFocus {
  if (run?.status === "failed") return { kind: "blocked", title: "本次生成未完成", message: run.error?.message ?? "运行失败，可以安全地重新生成。" };
  if (nextAction.type === "completion_blocked") return { kind: "blocked", title: "完本验收待处理", message: nextAction.blockers.join("\n") };
  if (run?.status === "awaiting_review") {
    const key = run.artifactProposal?.artifactKey ?? ("artifactKey" in nextAction ? nextAction.artifactKey : "book:novel_brief");
    return { kind: "review", title: run.artifactProposal?.title ?? "小说简报", artifactKey: key };
  }
  if (run?.status === "running") return { kind: "generation", title: "Agent 正在推进创作" };
  if (!state.openingChoices) return { kind: "conversation", title: "说出你的故事" };
  if (nextAction.type === "complete_novel") {
    const key = Object.keys(state.artifacts).filter((candidate) => candidate.startsWith("export:") && state.artifacts[candidate]?.status === "ready").sort().at(-1)
      ?? Object.keys(state.artifacts).find((candidate) => candidate === completionAuditKey() && state.artifacts[candidate]?.status === "ready")
      ?? Object.keys(state.artifacts).filter((candidate) => candidate.includes(":humanization_revision") && state.artifacts[candidate]?.status === "ready").sort().at(-1);
    if (key) return { kind: "artifact", title: "作品已完成", artifactKey: key };
  }
  return { kind: "next_action", title: "推荐下一步" };
}

export function buildWorkspaceProjection(state: NovelState, run?: RunView): WorkspaceProjection {
  const nextAction = decideNextAction(state);
  const activeRun = run?.runId === state.activeRunId ? run : undefined;
  const production: WorkspaceProjection["production"] = [{ id: "opening", label: labels.opening!, status: state.openingChoices ? "ready" : "pending" }];
  let unlocked = Boolean(state.openingChoices);
  for (const stage of bookStages.filter((stage) => isMultiVolumeProduction(state) ? stage !== "volume_outline" : true)) {
    const key = artifactKey(stage);
    const status = itemStatus(state, key, unlocked);
    production.push({ id: key, label: labels[stage]!, status, artifactKey: key });
    unlocked = status === "ready";
  }
  if (isMultiVolumeProduction(state)) {
    const volume = state.volumes[String(state.currentVolume)];
    const outlineKey = volumeOutlineKey(state.currentVolume);
    production.push({ id: `volume:${state.currentVolume}`, label: `第 ${state.currentVolume} 卷`, status: volume ? volume.status === "completed" ? "ready" : "pending" : unlocked ? "pending" : "locked" });
    production.push({ id: outlineKey, label: labels.volume_outline!, status: itemStatus(state, outlineKey, Boolean(volume)), artifactKey: outlineKey });
    unlocked = Boolean(volume) && state.artifacts[outlineKey]?.status === "ready";
    if (volume?.status === "completed" && !volume.final) {
      const handoffKey = volumeHandoffKey(volume.number);
      production.push({ id: handoffKey, label: labels.volume_handoff!, status: itemStatus(state, handoffKey, true), artifactKey: handoffKey });
    }
  }
  const chapter = Math.max(1, state.currentChapter);
  for (const stage of chapterStages) {
    const key = artifactKey(stage, chapter);
    const status = itemStatus(state, key, unlocked);
    production.push({ id: key, label: `第 ${chapter} 章 · ${labels[stage]}`, status, artifactKey: key });
    unlocked = status === "ready";
  }
  if (state.productionStatus !== "in_progress") {
    const key = completionAuditKey();
    production.push({ id: key, label: labels.completion_audit!, status: itemStatus(state, key, true), artifactKey: key });
  }
  for (const key of Object.keys(state.artifacts).filter((candidate) => candidate.startsWith("export:")).sort()) {
    production.push({ id: key, label: "稳定章节导出", status: itemStatus(state, key, true), artifactKey: key });
  }
  if (activeRun) {
    const target = activeRun.artifactProposal?.artifactKey ?? ("artifactKey" in nextAction ? nextAction.artifactKey : undefined);
    const item = production.find((candidate) => candidate.artifactKey === target);
    if (item) item.status = activeRun.status === "awaiting_review" ? "review" : activeRun.status === "failed" ? "blocked" : activeRun.status === "running" ? "running" : item.status;
  }
  return {
    novel: state,
    phase: phaseOf(state, nextAction),
    focus: focusOf(state, nextAction, activeRun),
    production,
    ...(activeRun ? { run: { runId: activeRun.runId, workflowId: activeRun.workflowId, status: activeRun.status, currentStep: activeRun.currentStep, error: activeRun.error, attempt: activeRun.attempt, recovered: activeRun.recovered } } : {}),
    ...(activeRun?.status === "awaiting_review" && (activeRun.artifactProposal || activeRun.proposal) ? (() => {
      const proposal = activeRun.artifactProposal ?? { artifactKey: "book:novel_brief", title: "小说简报", format: "markdown" as const, content: "", files: [], metadata: { structured: activeRun.proposal } };
      return { review: { runId: activeRun.runId, artifactKey: proposal.artifactKey, proposal, editable: true } };
    })() : {}),
    nextAction,
  };
}
