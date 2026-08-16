import { isMultiVolumeProduction, volumeHandoffKey, type NovelState } from "../domain";

export type VolumeProgressPhase = "active" | "handoff_pending" | "handoff_ready" | "audit_pending" | "audit_blocked" | "completed" | "planning";

export interface VolumeProgressItem {
  number: number;
  startChapter: number;
  endChapter?: number;
  completedChapters: number;
  totalChapters?: number;
  percent: number;
  final: boolean;
  phase: VolumeProgressPhase;
}

export interface NovelProgress {
  mode: "legacy" | "multi_volume";
  stableChapters: number;
  focusVolume: VolumeProgressItem;
  volumes: VolumeProgressItem[];
}

function completedChapterCount(state: NovelState) {
  return Math.max(0, state.continuity?.lastCommittedChapter ?? state.currentChapter - 1);
}

function phaseOf(state: NovelState, number: number, final: boolean, status: "active" | "completed"): VolumeProgressPhase {
  if (status === "active") return "active";
  if (!final) return state.artifacts[volumeHandoffKey(number)]?.status === "ready" ? "handoff_ready" : "handoff_pending";
  if (state.productionStatus === "completed") return "completed";
  return state.completionAudit?.verdict === "block" ? "audit_blocked" : "audit_pending";
}

export function buildNovelProgress(state: NovelState): NovelProgress {
  const stableChapters = completedChapterCount(state);
  if (!isMultiVolumeProduction(state)) {
    const focusVolume: VolumeProgressItem = { number: 1, startChapter: 1, completedChapters: stableChapters, percent: 0, final: true, phase: state.productionStatus === "completed" ? "completed" : "active" };
    return { mode: "legacy", stableChapters, focusVolume, volumes: [focusVolume] };
  }

  const volumes = Object.values(state.volumes).sort((left, right) => left.number - right.number).map((volume): VolumeProgressItem => {
    const totalChapters = volume.endChapter - volume.startChapter + 1;
    const completedChapters = Math.max(0, Math.min(totalChapters, stableChapters - volume.startChapter + 1));
    return {
      number: volume.number,
      startChapter: volume.startChapter,
      endChapter: volume.endChapter,
      completedChapters,
      totalChapters,
      percent: Math.round(completedChapters / totalChapters * 100),
      final: volume.final,
      phase: phaseOf(state, volume.number, volume.final, volume.status),
    };
  });
  const planningVolume: VolumeProgressItem = { number: state.currentVolume, startChapter: state.currentChapter, completedChapters: 0, percent: 0, final: false, phase: "planning" };
  if (!volumes.some((volume) => volume.number === state.currentVolume)) volumes.push(planningVolume);
  const focusVolume = volumes.find((volume) => volume.number === state.currentVolume) ?? volumes.find((volume) => volume.phase === "active") ?? volumes.at(-1) ?? planningVolume;
  return { mode: "multi_volume", stableChapters, focusVolume, volumes };
}
