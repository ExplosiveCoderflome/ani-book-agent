import type { FileContent, NovelFileView, NovelSummary, PatchProposal, ProductionJob, ProductionJobRequest, ProjectSnapshot, ProviderCatalogItem, SkillBindingsView, SkillDraftView, SkillRecordView, SkillSandboxView, SkillValidationView, SkillVersionView } from "../shared/contracts";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const value = payload?.error;
    throw new Error(typeof value?.message === "string" ? value.message : typeof payload?.message === "string" ? payload.message : `请求失败（${response.status}）`);
  }
  return payload as T;
}
const json = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });

export const api = {
  bootstrap: () => request<{ models: { configured: boolean; selection?: { providerId: string; modelId: string }; configuredProviders: string[] }; novels: NovelSummary[] }>("/workbench-api/bootstrap"),
  providers: () => request<{ providers: ProviderCatalogItem[] }>("/workbench-api/providers"),
  saveModel: (value: { providerId: string; modelId: string; credentials: Record<string, string> }) => request("/workbench-api/model-settings", { method: "PUT", body: JSON.stringify(value) }),
  testModel: () => request<{ ok: true; latencyMs: number; model: string }>("/workbench-api/model-settings/test", { method: "POST" }),
  createNovel: (title: string) => request<{ novelId: string }>("/workbench-api/novels", json({ title })),
  snapshot: (id: string) => request<ProjectSnapshot>(`/workbench-api/novels/${id}/snapshot`),
  chat: (id: string) => request<{ messages: any[] }>(`/workbench-api/novels/${id}/chat`),
  files: (id: string) => request<{ files: NovelFileView[] }>(`/workbench-api/novels/${id}/files`),
  file: (id: string, path: string) => request<FileContent>(`/workbench-api/novels/${id}/files/content?path=${encodeURIComponent(path)}`),
  saveFile: (id: string, value: { path: string; content: string; expectedSha256: string }) => request<FileContent>(`/workbench-api/novels/${id}/files`, { method: "PUT", body: JSON.stringify(value) }),
  approveProposal: (id: string, proposal: PatchProposal) => request<{ proposal: PatchProposal; job?: ProductionJob }>(`/workbench-api/novels/${id}/proposals/approve`, json(proposal)),
  rejectProposal: (id: string, proposal: PatchProposal) => request<PatchProposal>(`/workbench-api/novels/${id}/proposals/reject`, json(proposal)),
  startJob: (id: string, value: ProductionJobRequest) => request<ProductionJob>(`/workbench-api/novels/${id}/jobs`, json(value)),
  jobAction: (id: string, jobId: string, value: { action: "continue" | "revise" | "cancel"; feedback?: string }) => request<ProductionJob>(`/workbench-api/novels/${id}/jobs/${jobId}/actions`, json(value)),
  skills: () => request<{ skills: SkillRecordView[] }>("/workbench-api/skills"),
  skill: (id: string) => request<{ record: SkillRecordView; version: SkillVersionView }>(`/workbench-api/skills/${id}`),
  skillVersions: (id: string) => request<{ versions: SkillVersionView[] }>(`/workbench-api/skills/${id}/versions`),
  createSkill: (value: SkillDraftView) => request<{ record: SkillRecordView; version: SkillVersionView }>("/workbench-api/skills", json(value)),
  importSkill: (value: SkillDraftView) => request<{ record: SkillRecordView; version: SkillVersionView }>("/workbench-api/skills/import", json(value)),
  importGitSkill: (value: { url: string; ref?: string; subdir?: string }) => request<{ record: SkillRecordView; version: SkillVersionView }>("/workbench-api/skills/import", json({ source: "git", ...value })),
  importZipSkill: (base64: string) => request<{ record: SkillRecordView; version: SkillVersionView }>("/workbench-api/skills/import", json({ source: "zip", base64 })),
  deriveSkill: (id: string) => request<{ record: SkillRecordView; version: SkillVersionView }>(`/workbench-api/skills/${id}/derive`, json({})),
  saveSkill: (id: string, value: SkillDraftView) => request<{ record: SkillRecordView; version: SkillVersionView }>(`/workbench-api/skills/${id}/draft`, { method: "PUT", body: JSON.stringify(value) }),
  validateSkill: (id: string) => request<SkillValidationView>(`/workbench-api/skills/${id}/validate`, json({})),
  testSkill: (id: string, prompt: string) => request<{ skillId: string; versionId: string; output: string; elapsedMs: number; usedFiles: string[]; scriptExecution: "disabled" | "not_required"; traceId?: string }>(`/workbench-api/skills/${id}/test`, json({ prompt })),
  publishSkill: (id: string, expectedVersionId: string) => request<{ record: SkillRecordView; version: SkillVersionView }>(`/workbench-api/skills/${id}/publish`, json({ expectedVersionId })),
  rollbackSkill: (id: string, versionId: string) => request<{ record: SkillRecordView; version: SkillVersionView }>(`/workbench-api/skills/${id}/rollback`, json({ versionId })),
  archiveSkill: (id: string) => request<{ record: SkillRecordView; version: SkillVersionView }>(`/workbench-api/skills/${id}/archive`, json({})),
  sandboxCapabilities: () => request<SkillSandboxView>("/workbench-api/skills/sandbox/capabilities"),
  novelSkills: (id: string) => request<{ bindings: SkillBindingsView; file: FileContent }>(`/workbench-api/novels/${id}/skills`),
  saveNovelSkills: (id: string, bindings: SkillBindingsView, expectedSha256: string) => request<{ bindings: SkillBindingsView; file: FileContent }>(`/workbench-api/novels/${id}/skills`, { method: "PUT", body: JSON.stringify({ bindings, expectedSha256 }) }),
};
