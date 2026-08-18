import { z } from "zod";
import { errorBody } from "../application/errors";
import {
  approveProposal, bootstrap, chatSession, createNovel, jobView, listFiles, listNovels, projectSnapshot, providers,
  readFile, rejectProposal, resumeJob, saveAuthorFile, startProductionJob, testModelConnection, testSkillDraft,
} from "../application/workbench-service";
import { modelSettings } from "../infrastructure/model-settings";
import { productionJobRequestSchema, skillBindingsSchema, skillFileSchema, skillNameSchema } from "../domain";
import { modelProfilesInputSchema, modelSettingsInputSchema } from "../shared/contracts";
import { skillRegistry } from "../application/skill-service";
import { confirmReferenceManifest, deleteReference, estimateReference, importReference, listReferences, referenceAnalysis, referenceChapter, referenceDetail, referenceJobAction, referenceJobView, referenceSegment, referenceSource, startReferenceJob } from "../application/reference-service";
import { deconstructionFocusSchema, deconstructionModeSchema, referenceJobRequestSchema } from "../domain";

type Handler = (c: any) => Promise<Response>;
function route(path: string, method: "GET" | "POST" | "PUT" | "DELETE", handler: Handler) {
  return { path, method, handler: async (c: any) => { try { return await handler(c); } catch (error) { const result = errorBody(error); return c.json(result.body, result.status); } } };
}
async function body<T extends z.ZodType>(c: any, schema: T): Promise<z.output<T>> { return schema.parse(await c.req.json()); }

const resumeInput = z.object({ action: z.enum(["continue", "revise", "cancel"]), feedback: z.string().max(2_000).optional() });
const skillDraftInput = z.object({
  expectedVersionId: z.string().optional(), name: skillNameSchema, description: z.string().trim().min(1).max(1_024),
  files: z.array(skillFileSchema).min(1).max(500), compatibleAgents: z.array(z.string().min(1)).max(20), taskTypes: z.array(z.string().min(1)).max(30), requiresSandbox: z.boolean(), changeMessage: z.string().max(500).optional(),
});
const skillImportInput = z.union([skillDraftInput, z.object({ source: z.literal("git"), url: z.string().url(), ref: z.string().max(200).optional(), subdir: z.string().max(240).optional() }), z.object({ source: z.literal("zip"), base64: z.string().min(1).max(70_000_000) })]);

export const workbenchApiRoutes = [
  route("/workbench-api/bootstrap", "GET", async (c) => c.json(await bootstrap())),
  route("/workbench-api/providers", "GET", async (c) => c.json({ providers: await providers() })),
  route("/workbench-api/model-settings", "PUT", async (c) => { const value = await body(c, modelSettingsInputSchema); return c.json(await modelSettings.save(value.providerId, value.modelId, value.credentials)); }),
  route("/workbench-api/model-settings/test", "POST", async (c) => c.json(await testModelConnection())),
  route("/workbench-api/model-profiles", "GET", async (c) => c.json(await modelSettings.profiles())),
  route("/workbench-api/model-profiles", "PUT", async (c) => c.json(await modelSettings.saveProfiles(await body(c, modelProfilesInputSchema)))),
  route("/workbench-api/novels", "GET", async (c) => c.json({ novels: await listNovels() })),
  route("/workbench-api/novels", "POST", async (c) => c.json(await createNovel((await body(c, z.object({ title: z.string().max(80).default("未命名作品") }))).title), 201)),
  route("/workbench-api/references/import", "POST", async (c) => { const form = await c.req.formData(); const file = form.get("file"); if (!(file instanceof File)) throw new Error("请选择 TXT 或 Markdown 文件。"); return c.json(await importReference({ fileName: file.name, title: String(form.get("title") ?? "") || undefined, bytes: Buffer.from(await file.arrayBuffer()), rightsConfirmed: form.get("rightsConfirmed") === "true" }), 201); }),
  route("/workbench-api/references", "GET", async (c) => c.json({ references: await listReferences() })),
  route("/workbench-api/references/:id", "GET", async (c) => c.json(await referenceDetail(c.req.param("id")))),
  route("/workbench-api/references/:id", "DELETE", async (c) => c.json(await deleteReference(c.req.param("id")))),
  route("/workbench-api/references/:id/manifest", "PUT", async (c) => c.json(await confirmReferenceManifest(c.req.param("id"), (await body(c, z.object({ manifestHash: z.string().length(64) }))).manifestHash))),
  route("/workbench-api/references/:id/estimate", "POST", async (c) => { const input = await body(c, z.object({ mode: deconstructionModeSchema, focuses: z.array(deconstructionFocusSchema).max(3).default([]) })); return c.json(await estimateReference(c.req.param("id"), input.mode, input.focuses)); }),
  route("/workbench-api/references/:id/jobs", "POST", async (c) => c.json(await startReferenceJob(c.req.param("id"), await body(c, referenceJobRequestSchema)), 202)),
  route("/workbench-api/references/:id/jobs/:jobId", "GET", async (c) => c.json(await referenceJobView(c.req.param("id"), c.req.param("jobId")))),
  route("/workbench-api/references/:id/jobs/:jobId/actions", "POST", async (c) => c.json(await referenceJobAction(c.req.param("id"), c.req.param("jobId"), await body(c, z.object({ action: z.enum(["continue", "add_budget", "cancel"]), additionalTokens: z.number().int().positive().optional() }))))),
  route("/workbench-api/references/:id/analyses/:analysisId", "GET", async (c) => c.json(await referenceAnalysis(c.req.param("id"), c.req.param("analysisId")))),
  route("/workbench-api/references/:id/analyses/:analysisId/segments/:segmentId", "GET", async (c) => c.json(await referenceSegment(c.req.param("id"), c.req.param("analysisId"), c.req.param("segmentId")))),
  route("/workbench-api/references/:id/analyses/:analysisId/chapters/:chapterId", "GET", async (c) => c.json(await referenceChapter(c.req.param("id"), c.req.param("analysisId"), c.req.param("chapterId")))),
  route("/workbench-api/references/:id/source", "GET", async (c) => c.json(await referenceSource(c.req.param("id"), Number(c.req.query("start")), Number(c.req.query("end"))))),
  route("/workbench-api/novels/:id/snapshot", "GET", async (c) => c.json(await projectSnapshot(c.req.param("id")))),
  route("/workbench-api/novels/:id/chat", "GET", async (c) => c.json(await chatSession(c.req.param("id")))),
  route("/workbench-api/novels/:id/files", "GET", async (c) => c.json({ files: await listFiles(c.req.param("id")) })),
  route("/workbench-api/novels/:id/files/content", "GET", async (c) => c.json(await readFile(c.req.param("id"), c.req.query("path") ?? ""))),
  route("/workbench-api/novels/:id/files", "PUT", async (c) => c.json(await saveAuthorFile(c.req.param("id"), await body(c, z.object({ path: z.string(), content: z.string().max(500_000), expectedSha256: z.string().length(64) }))))),
  route("/workbench-api/skills", "GET", async (c) => c.json({ skills: await skillRegistry.list(c.req.query("status") as "draft" | "published" | "archived" | undefined) })),
  route("/workbench-api/skills", "POST", async (c) => c.json(await skillRegistry.create(await body(c, skillDraftInput)), 201)),
  route("/workbench-api/skills/reload-builtins", "POST", async (c) => c.json(await skillRegistry.reloadBuiltins())),
  route("/workbench-api/skills/import", "POST", async (c) => { const parsed = skillImportInput.parse(await c.req.json()); if ("source" in parsed) return c.json(parsed.source === "git" ? await skillRegistry.importGit(parsed) : await skillRegistry.importArchive(parsed.base64), 201); return c.json(await skillRegistry.create(parsed, "imported"), 201); }),
  route("/workbench-api/skills/:skillId", "GET", async (c) => c.json(await skillRegistry.get(c.req.param("skillId")))),
  route("/workbench-api/skills/:skillId/versions", "GET", async (c) => c.json({ versions: await skillRegistry.versions(c.req.param("skillId")) })),
  route("/workbench-api/skills/:skillId/derive", "POST", async (c) => c.json(await skillRegistry.derive(c.req.param("skillId")), 201)),
  route("/workbench-api/skills/:skillId/draft", "PUT", async (c) => c.json(await skillRegistry.saveDraft(c.req.param("skillId"), await body(c, skillDraftInput)))),
  route("/workbench-api/skills/:skillId/validate", "POST", async (c) => c.json(await skillRegistry.validate(c.req.param("skillId")))),
  route("/workbench-api/skills/:skillId/test", "POST", async (c) => c.json(await testSkillDraft(c.req.param("skillId"), (await body(c, z.object({ prompt: z.string().trim().min(1).max(4_000) }))).prompt))),
  route("/workbench-api/skills/:skillId/publish", "POST", async (c) => { const input = await c.req.json().catch(() => ({})); return c.json(await skillRegistry.publish(c.req.param("skillId"), input.expectedVersionId)); }),
  route("/workbench-api/skills/:skillId/rollback", "POST", async (c) => c.json(await skillRegistry.rollback(c.req.param("skillId"), (await body(c, z.object({ versionId: z.string() }))).versionId))),
  route("/workbench-api/skills/:skillId/archive", "POST", async (c) => c.json(await skillRegistry.archive(c.req.param("skillId")))),
  route("/workbench-api/skills/sandbox/capabilities", "GET", async (c) => c.json(skillRegistry.sandboxCapabilities())),
  route("/workbench-api/novels/:id/skills", "GET", async (c) => { const novelId = c.req.param("id"); const bindings = await skillRegistry.bindings(novelId); return c.json({ bindings, file: await readFile(novelId, "workspace/skill-bindings.yaml") }); }),
  route("/workbench-api/novels/:id/skills", "PUT", async (c) => { const novelId = c.req.param("id"); const input = await body(c, z.object({ bindings: skillBindingsSchema, expectedSha256: z.string().length(64) })); return c.json({ bindings: input.bindings, file: await skillRegistry.saveBindings(novelId, input.bindings, input.expectedSha256) }); }),
  route("/workbench-api/novels/:id/skills/resolve", "POST", async (c) => { const input = await body(c, z.object({ agentId: z.string().default("novel-agent"), taskType: z.string().optional() })); return c.json({ skills: await skillRegistry.resolveForAgent(c.req.param("id"), input.agentId, input.taskType) }); }),
  route("/workbench-api/novels/:id/proposals/approve", "POST", async (c) => c.json(await approveProposal(c.req.param("id"), await c.req.json()))),
  route("/workbench-api/novels/:id/proposals/reject", "POST", async (c) => c.json(rejectProposal(c.req.param("id"), await c.req.json()))),
  route("/workbench-api/novels/:id/jobs", "POST", async (c) => c.json(await startProductionJob(c.req.param("id"), await body(c, productionJobRequestSchema)), 202)),
  route("/workbench-api/novels/:id/jobs/:jobId", "GET", async (c) => c.json(await jobView(c.req.param("id"), c.req.param("jobId")))),
  route("/workbench-api/novels/:id/jobs/:jobId/actions", "POST", async (c) => c.json(await resumeJob(c.req.param("id"), c.req.param("jobId"), await body(c, resumeInput)))),
];
