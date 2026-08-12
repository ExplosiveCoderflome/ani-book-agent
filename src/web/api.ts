import type { ArtifactProposal, NovelBrief, NovelSummary, OpeningPresetProposal, ProviderCatalogItem, RunView } from "../shared/contracts";
import type { NovelState, NextAction, WorkflowId } from "../domain";
import type { WorkflowApproval } from "../shared/workflow-catalog";
import type { MastraDBMessage } from "@mastra/core/agent";

export class WorkbenchApiError extends Error {
  constructor(public readonly code: string, message: string, public readonly recoverable: boolean) {
    super(message);
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body?.error;
    throw new WorkbenchApiError(error?.code ?? "REQUEST_FAILED", error?.message ?? "操作失败，请重试。", error?.recoverable ?? true);
  }
  return body as T;
}

export interface Bootstrap {
  models: {
    configured: boolean;
    selection?: { providerId: string; modelId: string };
    configuredProviders: string[];
    secretPersistence: "windows-dpapi-current-user" | "session-only";
  };
  novels: NovelSummary[];
}
export interface PromptBlockView { id: string; name: string; description: string; defaultContent: string; draftContent?: string; publishedContent?: string; draftVersion?: string; publishedVersion?: string; activeSource: "official" | "custom"; draftSource?: "official" | "custom"; group: "对话引导" | "书级策划" | "章节生产" | "审查修复"; usage: string; order: number }

export const api = {
  bootstrap: () => request<Bootstrap>("/workbench-api/bootstrap"),
  providers: () => request<{ providers: ProviderCatalogItem[] }>("/workbench-api/providers"),
  saveModel: (body: { providerId: string; modelId: string; credentials: Record<string, string> }) =>
    request<Bootstrap["models"]>("/workbench-api/model-settings", { method: "PUT", body: JSON.stringify(body) }),
  testModel: () => request<{ ok: true; latencyMs: number; model: string }>("/workbench-api/model-settings/test", { method: "POST" }),
  modelProfiles: () => request<{ default?: { providerId: string; modelId: string }; profiles: Record<string, { providerId: string; modelId: string; parameters?: Record<string, number> }> }>("/workbench-api/model-profiles"),
  saveModelProfiles: (profiles: Record<string, { providerId: string; modelId: string; parameters?: Record<string, number> }>) => request("/workbench-api/model-profiles", { method: "PUT", body: JSON.stringify({ profiles }) }),
  prompts: () => request<{ prompts: PromptBlockView[] }>("/workbench-api/prompts"),
  prompt: (id: string) => request<PromptBlockView>(`/workbench-api/prompts/${encodeURIComponent(id)}`),
  savePromptDraft: (id: string, content: string) => request<PromptBlockView>(`/workbench-api/prompts/${encodeURIComponent(id)}/draft`, { method: "PUT", body: JSON.stringify({ content }) }),
  previewPrompt: (id: string, content: string) => request<{ id: string; content: string }>(`/workbench-api/prompts/${encodeURIComponent(id)}/preview`, { method: "POST", body: JSON.stringify({ content }) }),
  publishPrompt: (id: string) => request<PromptBlockView>(`/workbench-api/prompts/${encodeURIComponent(id)}/publish`, { method: "POST" }),
  restorePrompt: (id: string) => request<PromptBlockView>(`/workbench-api/prompts/${encodeURIComponent(id)}/restore-default`, { method: "POST" }),
  capabilities: () => request<{ workflows: Array<{ id: WorkflowId; name: string; description: string; target: string; approval: WorkflowApproval; stages: string[] }>; prompts: Array<{ id: string; name: string; description: string }>; agent: { tools: string[]; processors: string[] } }>("/workbench-api/capabilities"),
  createNovel: (title: string, approvalMode: "milestone_approval" | "auto" = "milestone_approval") => request<NovelState>("/workbench-api/novels", { method: "POST", body: JSON.stringify({ title, approvalMode }) }),
  novel: (id: string) => request<{ novel: NovelState; nextAction: NextAction; milestone: string }>(`/workbench-api/novels/${id}`),
  chat: (id: string) => request<{ messages: MastraDBMessage[] }>(`/workbench-api/novels/${id}/chat`),
  proposePreset: (id: string) => request<OpeningPresetProposal>(`/workbench-api/novels/${id}/opening-preset/propose`, { method: "POST" }),
  saveChoices: (id: string, body: { workingTitle?: string; storyDirection?: string; genre?: string; tone?: string; channel: string; format: string; primaryReward: string }) =>
    request<NovelState>(`/workbench-api/novels/${id}/opening-choices`, { method: "PUT", body: JSON.stringify(body) }),
  advance: (id: string) => request<RunView>(`/workbench-api/novels/${id}/advance`, { method: "POST" }),
  startRun: (id: string, workflowId: WorkflowId, target?: string) => request<RunView>(`/workbench-api/novels/${id}/runs`, { method: "POST", body: JSON.stringify({ workflowId, target, input: {} }) }),
  artifacts: (id: string) => request<{ artifacts: NovelState["artifacts"][string][] }>(`/workbench-api/novels/${id}/artifacts`),
  artifact: (id: string, key: string) => request<{ artifact: NovelState["artifacts"][string]; content: string }>(`/workbench-api/novels/${id}/artifacts/${encodeURIComponent(key)}`),
  editArtifact: (id: string, key: string, content: string, expectedSha256: string) => request<{ state: NovelState; sha256: string }>(`/workbench-api/novels/${id}/artifacts/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ content, expectedSha256 }) }),
  chapterRange: (id: string, start: number, end: number) => request<RunView>(`/workbench-api/novels/${id}/chapter-ranges`, { method: "POST", body: JSON.stringify({ start, end }) }),
  autoDirector: (id: string, startChapter: number | undefined, endChapter: number, autoApproveMilestones = false) => request<RunView>(`/workbench-api/novels/${id}/auto-director`, { method: "POST", body: JSON.stringify({ startChapter, endChapter, autoApproveMilestones }) }),
  exportNovel: (id: string, fileName?: string) => request<RunView>(`/workbench-api/novels/${id}/export`, { method: "POST", body: JSON.stringify({ fileName }) }),
  exportDownloadUrl: (id: string, path: string) => `/workbench-api/novels/${id}/export?path=${encodeURIComponent(path)}`,
  run: (id: string) => request<RunView>(`/workbench-api/runs/${id}`),
  review: (id: string, body: { action: "approve"; brief?: NovelBrief; proposal?: ArtifactProposal } | { action: "revise"; feedback: string; proposal?: ArtifactProposal } | { action: "cancel" }) =>
    request<RunView>(`/workbench-api/runs/${id}/review`, { method: "POST", body: JSON.stringify(body) }),
};
