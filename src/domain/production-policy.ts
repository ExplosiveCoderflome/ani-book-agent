import { artifactKey, bookStages, chapterStages, completionAuditBlockers, completionAuditKey, completionAuditReportBlockers, isMultiVolumeProduction, stageWorkflow, volumeHandoffKey, volumeOutlineKey, type NextAction, type NovelState } from "./novel-state";

export function decideNextAction(state: NovelState): NextAction {
  if (state.productionStatus === "completed") return { type: "complete_novel", volume: state.currentVolume, chapter: Math.max(1, state.continuity?.lastCommittedChapter ?? 1), reason: "整部小说已完成，可以导出稳定章节。" };
  if (state.productionStatus === "awaiting_completion_review") {
    const audit = state.artifacts[completionAuditKey()];
    if (!audit || audit.status === "missing" || audit.status === "stale" || audit.status === "blocked") return { type: "produce_artifact", stage: "completion_audit", artifactKey: completionAuditKey(), workflowId: "completion-audit", reason: "最终卷已完成，先做完本验收，确认章节完整、质量债和连续性都已收束。" };
    if (!state.completionAudit) return { type: "completion_blocked", volume: state.currentVolume, chapter: Math.max(1, state.continuity?.lastCommittedChapter ?? 1), blockers: ["验收工件缺少结构化判定，请重新生成完本验收。"], workflowId: "completion-audit", reason: "完本验收报告不完整，不能直接标记完本。" };
    const blockers = [...completionAuditBlockers(state), ...completionAuditReportBlockers(state.completionAudit)];
    if (blockers.length) return { type: "completion_blocked", volume: state.currentVolume, chapter: Math.max(1, state.continuity?.lastCommittedChapter ?? 1), blockers, workflowId: "completion-audit", reason: "完本验收发现仍有事项需要处理，修复后可重新验收。" };
    return { type: "complete_novel", volume: state.currentVolume, chapter: Math.max(1, state.continuity?.lastCommittedChapter ?? 1), reason: "完本验收通过，可以导出稳定章节。" };
  }
  if (!state.openingChoices) return { type: "collect_opening_choices", reason: "先通过对话确认开书方向，或把选择交给 AI。" };

  // schema v1 remains readable through the original fixed volume outline chain.
  const stableBookStages = isMultiVolumeProduction(state) ? bookStages.filter((stage) => stage !== "volume_outline") : bookStages;
  for (const stage of stableBookStages) {
    const key = artifactKey(stage);
    const artifact = state.artifacts[key];
    if (!artifact || artifact.status === "missing" || artifact.status === "blocked") {
      return { type: "produce_artifact", stage, artifactKey: key, workflowId: stageWorkflow[stage], reason: `生成 ${stage}。` };
    }
    if (artifact.status === "stale") {
      return { type: "refresh_artifact", stage, artifactKey: key, workflowId: stageWorkflow[stage], reason: `${stage} 的上游已经变化。` };
    }
  }

  if (!isMultiVolumeProduction(state)) return legacyChapterAction(state);

  const lastChapter = state.continuity?.lastCommittedChapter ?? 0;
  if (lastChapter > 0) {
    const debt = state.artifacts[`chapter:${lastChapter}:quality_debt`];
    const repair = state.artifacts[`chapter:${lastChapter}:quality_repair`];
    if (debt?.status === "ready" && (!repair || repair.status === "missing" || repair.status === "blocked" || repair.status === "stale")) {
      return { type: repair?.status === "stale" ? "refresh_artifact" : "produce_artifact", stage: "quality_repair", artifactKey: `chapter:${lastChapter}:quality_repair`, workflowId: "quality-repair", reason: `先处理第 ${lastChapter} 章尚未关闭的质量债。` };
    }
  }

  const volume = state.volumes[String(state.currentVolume)];
  if (!volume) {
    const previous = state.volumes[String(state.currentVolume - 1)];
    if (previous?.status === "completed" && !previous.final) {
      const handoffKey = volumeHandoffKey(previous.number);
      const handoff = state.artifacts[handoffKey];
      if (!handoff || handoff.status === "missing" || handoff.status === "blocked") return { type: "produce_artifact", stage: "volume_handoff", artifactKey: handoffKey, workflowId: "volume-handoff", reason: `第 ${previous.number} 卷已完成，先整理卷间承接包，再开始下一卷。` };
      if (handoff.status === "stale") return { type: "refresh_artifact", stage: "volume_handoff", artifactKey: handoffKey, workflowId: "volume-handoff", reason: `第 ${previous.number} 卷的承接事项已有变化，需要刷新承接包。` };
    }
    return { type: "configure_volume", volume: state.currentVolume, startChapter: state.currentChapter, suggestedEndChapter: state.currentChapter + 9, reason: `先确定第 ${state.currentVolume} 卷写到哪一章，Agent 才能按卷目标安排节奏。` };
  }
  if (volume.status === "completed") {
    if (volume.final) return { type: "produce_artifact", stage: "completion_audit", artifactKey: completionAuditKey(), workflowId: "completion-audit", reason: "最终卷已完成，先进行完本验收。" };
    const handoffKey = volumeHandoffKey(volume.number);
    const handoff = state.artifacts[handoffKey];
    if (!handoff || handoff.status === "missing" || handoff.status === "blocked") return { type: "produce_artifact", stage: "volume_handoff", artifactKey: handoffKey, workflowId: "volume-handoff", reason: `第 ${volume.number} 卷已完成，先整理卷间承接包，再开始下一卷。` };
    if (handoff.status === "stale") return { type: "refresh_artifact", stage: "volume_handoff", artifactKey: handoffKey, workflowId: "volume-handoff", reason: `第 ${volume.number} 卷的承接事项已有变化，需要刷新承接包。` };
    return { type: "configure_volume", volume: state.currentVolume + 1, startChapter: state.currentChapter, suggestedEndChapter: state.currentChapter + 9, reason: `第 ${state.currentVolume} 卷已完成，先确定第 ${state.currentVolume + 1} 卷的章节范围。` };
  }

  const outlineKey = volumeOutlineKey(state.currentVolume);
  const outline = state.artifacts[outlineKey] ?? (state.currentVolume === 1 ? state.artifacts["book:volume_outline"] : undefined);
  if (!outline || outline.status === "missing" || outline.status === "blocked") return { type: "produce_artifact", stage: "volume_outline", artifactKey: outlineKey, workflowId: "volume-outline", reason: `生成第 ${state.currentVolume} 卷骨架与节奏板。` };
  if (outline.status === "stale") return { type: "refresh_artifact", stage: "volume_outline", artifactKey: outlineKey, workflowId: "volume-outline", reason: `第 ${state.currentVolume} 卷的上游已经变化，需要刷新骨架。` };

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

  if (state.currentChapter > volume.endChapter) return volume.final
    ? { type: "produce_artifact", stage: "completion_audit", artifactKey: completionAuditKey(), workflowId: "completion-audit", reason: `第 ${volume.number} 卷已完成，先进行完本验收。` }
    : { type: "configure_volume", volume: volume.number + 1, startChapter: state.currentChapter, suggestedEndChapter: state.currentChapter + 9, reason: `第 ${volume.number} 卷已完成，先确定下一卷的章节范围。` };
  return { type: "approve_chapter_range", chapter: state.currentChapter + 1, reason: "当前批准范围已完成。" };
}

function legacyChapterAction(state: NovelState): NextAction {
  const lastChapter = state.continuity?.lastCommittedChapter ?? 0;
  if (lastChapter > 0) {
    const debt = state.artifacts[`chapter:${lastChapter}:quality_debt`];
    const repair = state.artifacts[`chapter:${lastChapter}:quality_repair`];
    if (debt?.status === "ready" && (!repair || repair.status === "missing" || repair.status === "blocked" || repair.status === "stale")) {
      return { type: repair?.status === "stale" ? "refresh_artifact" : "produce_artifact", stage: "quality_repair", artifactKey: `chapter:${lastChapter}:quality_repair`, workflowId: "quality-repair", reason: `先处理第 ${lastChapter} 章尚未关闭的质量债。` };
    }
  }
  if (state.currentChapter > state.approvedChapterEnd) return { type: "approve_chapter_range", chapter: state.currentChapter, reason: `第 ${state.currentChapter} 章尚未获得生产授权。` };
  for (const stage of chapterStages) {
    const key = artifactKey(stage, state.currentChapter);
    const artifact = state.artifacts[key];
    if (!artifact || artifact.status === "missing" || artifact.status === "blocked") return { type: "produce_artifact", stage, artifactKey: key, workflowId: stageWorkflow[stage], reason: `推进第 ${state.currentChapter} 章的 ${stage}。` };
    if (artifact.status === "stale") return { type: "refresh_artifact", stage, artifactKey: key, workflowId: stageWorkflow[stage], reason: `第 ${state.currentChapter} 章的 ${stage} 需要刷新。` };
  }
  return { type: "approve_chapter_range", chapter: state.currentChapter + 1, reason: "当前批准范围已完成。" };
}
