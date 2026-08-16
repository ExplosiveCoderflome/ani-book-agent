import type { AgentProfile, ArtifactProposal, AssetRecord, NovelBrief, NovelFileRecord, NovelSummary, OpeningPresetProposal, ProjectRecipe, ProviderCatalogItem, RunView, SkillDefinition, ToolCapability, WorkspaceProjection } from "../shared/contracts";
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
export interface ObservabilityStats { generatedAt: string; scope: "novel" | "all"; totals: { total: number; success: number; error: number; running: number; averageDurationMs: number; inputTokens: number; outputTokens: number; totalTokens: number }; spans: Array<{ type: string; count: number }>; tools: Array<{ name: string; count: number; errors: number }>; recent: Array<{ traceId: string; name: string; spanType: string; status: "success" | "error" | "running"; startedAt: string; durationMs?: number; error?: string }> }

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
  capabilities: () => request<{
    agent: { id: string; tools: string[]; processors: string[] };
    agents: Array<{ id: string; name: string; tools: string[] }>;
    tools: ToolCapability[];
    skills: SkillDefinition[];
    agentProfiles: AgentProfile[];
    defaultProjectRecipe: ProjectRecipe;
    workflows: Array<{ id: WorkflowId; name: string; description: string; target: string; approval: WorkflowApproval; stages: string[] }>;
    prompts: Array<{ id: string; name: string; description: string }>;
  }>("/workbench-api/capabilities"),
  observabilityStats: (novelId?: string) => request<ObservabilityStats>(`/workbench-api/observability/stats${novelId ? `?novelId=${encodeURIComponent(novelId)}` : ""}`),
  createNovel: (title: string, approvalMode: "milestone_approval" | "auto" = "milestone_approval") => request<NovelState>("/workbench-api/novels", { method: "POST", body: JSON.stringify({ title, approvalMode }) }),
  novel: (id: string) => request<{ novel: NovelState; nextAction: NextAction; milestone: string }>(`/workbench-api/novels/${id}`),
  workspace: (id: string) => request<WorkspaceProjection>(`/workbench-api/novels/${id}/workspace`),
  chat: (id: string) => request<{ messages: MastraDBMessage[] }>(`/workbench-api/novels/${id}/chat`),
  proposePreset: (id: string) => request<OpeningPresetProposal>(`/workbench-api/novels/${id}/opening-preset/propose`, { method: "POST" }),
  saveChoices: (id: string, body: { workingTitle?: string; storyDirection?: string; genre?: string; tone?: string; channel: string; format: string; primaryReward: string }) =>
    request<NovelState>(`/workbench-api/novels/${id}/opening-choices`, { method: "PUT", body: JSON.stringify(body) }),
  advance: (id: string) => request<RunView>(`/workbench-api/novels/${id}/advance`, { method: "POST" }),
  startRun: (id: string, workflowId: WorkflowId, target?: string) => request<RunView>(`/workbench-api/novels/${id}/runs`, { method: "POST", body: JSON.stringify({ workflowId, target, input: {} }) }),
  artifacts: (id: string) => request<{ artifacts: NovelState["artifacts"][string][] }>(`/workbench-api/novels/${id}/artifacts`),
  assets: (id: string) => request<{ assets: AssetRecord[] }>(`/workbench-api/novels/${id}/assets`),
  files: (id: string) => request<{ files: NovelFileRecord[] }>(`/workbench-api/novels/${id}/files`),
  file: (id: string, path: string) => request<{ path: string; kind: NovelFileRecord["kind"]; size: number; modifiedAt: string; sha256: string; content: string }>(`/workbench-api/novels/${id}/files/content?path=${encodeURIComponent(path)}`),
  editWorkspaceFile: (id: string, path: string, content: string, expectedSha256?: string) => request<{ path: string; sha256: string; created: boolean }>(`/workbench-api/novels/${id}/workspace-files`, { method: "PUT", body: JSON.stringify({ path, content, expectedSha256 }) }),
  artifact: (id: string, key: string) => request<{ artifact: NovelState["artifacts"][string]; content: string }>(`/workbench-api/novels/${id}/artifacts/${encodeURIComponent(key)}`),
  editArtifact: (id: string, key: string, content: string, expectedSha256: string) => request<{ state: NovelState; sha256: string }>(`/workbench-api/novels/${id}/artifacts/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ content, expectedSha256 }) }),
  chapterRange: (id: string, start: number, end: number) => request<RunView>(`/workbench-api/novels/${id}/chapter-ranges`, { method: "POST", body: JSON.stringify({ start, end }) }),
  configureVolume: (id: string, plan: { number: number; startChapter: number; endChapter: number; final: boolean }) => request<{ novel: NovelState; nextAction: NextAction }>(`/workbench-api/novels/${id}/volumes`, { method: "PUT", body: JSON.stringify(plan) }),
  autoDirector: (id: string, startChapter: number | undefined, endChapter: number, autoApproveMilestones = false) => request<RunView>(`/workbench-api/novels/${id}/auto-director`, { method: "POST", body: JSON.stringify({ startChapter, endChapter, autoApproveMilestones }) }),
  exportNovel: (id: string, fileName?: string) => request<RunView>(`/workbench-api/novels/${id}/export`, { method: "POST", body: JSON.stringify({ fileName }) }),
  exportDownloadUrl: (id: string, path: string) => `/workbench-api/novels/${id}/export?path=${encodeURIComponent(path)}`,
  run: (id: string) => request<RunView>(`/workbench-api/runs/${id}`),
  review: (id: string, body: { action: "approve"; brief?: NovelBrief; proposal?: ArtifactProposal } | { action: "revise"; feedback: string; proposal?: ArtifactProposal } | { action: "cancel" }) =>
    request<RunView>(`/workbench-api/runs/${id}/review`, { method: "POST", body: JSON.stringify(body) }),
};
