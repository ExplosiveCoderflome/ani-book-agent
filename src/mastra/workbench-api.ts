import { registerApiRoute } from "@mastra/core/server";
import { z, ZodError, type ZodType } from "zod";
import { errorBody, AppError } from "../application/errors";
import {
  bootstrap,
  capabilities,
  chatSession,
  novelRepository,
  novelWorkspace,
  novelWorkspaceProjection,
  providers,
  proposeOpeningPreset,
  reviewRun,
  runView,
  startChapterRange,
  startAutoDirector,
  configureVolume,
  startNovelBriefRun,
  startWorkflowRun,
  testModelConnection,
} from "../application/workbench-service";
import {
  createNovelInputSchema,
  chapterRangeInputSchema,
  autoDirectorInputSchema,
  volumePlanInputSchema,
  editArtifactInputSchema,
  editNovelBriefInputSchema,
  genericReviewRunInputSchema,
  modelProfilesInputSchema,
  modelSettingsInputSchema,
  openingChoicesInputSchema,
  startRunInputSchema,
  workspaceFileEditInputSchema,
} from "../shared/contracts";
import { modelSettings } from "../infrastructure/model-settings";
import { readObservabilityStats } from "../application/observability-stats";
import { mastraStorage } from "./runtime-storage";
import { listPromptBlocks, promptBlock, previewPromptDraft, publishPromptDraft, restorePromptDefault, savePromptDraft } from "./prompts/prompt-blocks";

const cors = { origin: ["http://127.0.0.1:5175"], allowMethods: ["GET", "POST", "PUT", "OPTIONS"] };

async function input(c: any, schema: ZodType) {
  try {
    return schema.parse(await c.req.json());
  } catch (error) {
    if (error instanceof ZodError) {
      const fieldErrors = Object.fromEntries(Object.entries(error.flatten().fieldErrors).map(([key, value]) => [key, value ?? []]));
      throw new AppError("VALIDATION_ERROR", "请检查填写内容。", 400, true, fieldErrors as Record<string, string[]>);
    }
    throw error;
  }
}

function route(path: string, method: "GET" | "POST" | "PUT", handler: (c: any) => Promise<Response>) {
  return registerApiRoute(path, {
    method,
    cors,
    requiresAuth: false,
    handler: async (c) => {
      try {
        return await handler(c);
      } catch (error) {
        const result = error instanceof ZodError ? errorBody(new AppError("VALIDATION_ERROR", "请检查填写内容。", 400, true, Object.fromEntries(Object.entries(error.flatten().fieldErrors).map(([key, value]) => [key, (value ?? []) as string[]])))) : errorBody(error);
        return (c as any).json(result.body, result.status);
      }
    },
  });
}

export const workbenchApiRoutes = [
  route("/workbench-api/bootstrap", "GET", async (c) => c.json(await bootstrap())),
  route("/workbench-api/capabilities", "GET", async (c) => c.json(await capabilities())),
  route("/workbench-api/observability/prune", "POST", async (c) => c.json({ results: await mastraStorage.prune({ maxBatches: 20, maxRows: 20_000 }) })),
  route("/workbench-api/observability/stats", "GET", async (c) => c.json(await readObservabilityStats(c.req.query("novelId") || undefined))),
  route("/workbench-api/providers", "GET", async (c) => c.json({ providers: await providers() })),
  route("/workbench-api/model-settings", "PUT", async (c) => {
    const body = modelSettingsInputSchema.parse(await input(c, modelSettingsInputSchema));
    return c.json(await modelSettings.save(body.providerId, body.modelId, body.credentials));
  }),
  route("/workbench-api/model-settings/test", "POST", async (c) => c.json(await testModelConnection())),
  route("/workbench-api/model-profiles", "GET", async (c) => c.json(await modelSettings.profiles())),
  route("/workbench-api/model-profiles", "PUT", async (c) => c.json(await modelSettings.saveProfiles(modelProfilesInputSchema.parse(await input(c, modelProfilesInputSchema))))),
  route("/workbench-api/prompts", "GET", async (c) => c.json({ prompts: await listPromptBlocks() })),
  route("/workbench-api/prompts/:id", "GET", async (c) => c.json(await promptBlock(decodeURIComponent(c.req.param("id"))))),
  route("/workbench-api/prompts/:id/draft", "PUT", async (c) => { const body = z.object({ content: z.string() }).parse(await input(c, z.object({ content: z.string() }))); return c.json(await savePromptDraft(decodeURIComponent(c.req.param("id")), body.content)); }),
  route("/workbench-api/prompts/:id/preview", "POST", async (c) => { const body = z.object({ content: z.string() }).parse(await input(c, z.object({ content: z.string() }))); return c.json(await previewPromptDraft(decodeURIComponent(c.req.param("id")), body.content)); }),
  route("/workbench-api/prompts/:id/publish", "POST", async (c) => c.json(await publishPromptDraft(decodeURIComponent(c.req.param("id"))))),
  route("/workbench-api/prompts/:id/restore-default", "POST", async (c) => c.json(await restorePromptDefault(decodeURIComponent(c.req.param("id"))))),
  route("/workbench-api/novels", "GET", async (c) => c.json({ novels: await novelRepository.list() })),
  route("/workbench-api/novels", "POST", async (c) => {
    const body = createNovelInputSchema.parse(await input(c, createNovelInputSchema));
    return c.json(await novelRepository.create(body.title, body.approvalMode), 201);
  }),
  route("/workbench-api/novels/:id", "GET", async (c) => c.json(await novelWorkspace(c.req.param("id")))),
  route("/workbench-api/novels/:id/workspace", "GET", async (c) => c.json(await novelWorkspaceProjection(c.req.param("id")))),
  route("/workbench-api/novels/:id/chat", "GET", async (c) => c.json(await chatSession(c.req.param("id")))),
  route("/workbench-api/novels/:id/opening-preset/propose", "POST", async (c) => c.json(await proposeOpeningPreset(c.req.param("id")))),
  route("/workbench-api/novels/:id/opening-choices", "PUT", async (c) => {
    const body = openingChoicesInputSchema.parse(await input(c, openingChoicesInputSchema));
    return c.json(await novelRepository.saveOpeningChoices(c.req.param("id"), body));
  }),
  route("/workbench-api/novels/:id/advance", "POST", async (c) => c.json(await startNovelBriefRun(c.req.param("id")), 202)),
  route("/workbench-api/novels/:id/runs", "POST", async (c) => {
    const body = startRunInputSchema.parse(await c.req.json());
    return c.json(await startWorkflowRun(c.req.param("id"), body.workflowId, body.target, body.input), 202);
  }),
  route("/workbench-api/novels/:id/chapter-ranges", "POST", async (c) => {
    const body = chapterRangeInputSchema.parse(await input(c, chapterRangeInputSchema));
    return c.json(await startChapterRange(c.req.param("id"), body.start, body.end), 202);
  }),
  route("/workbench-api/novels/:id/volumes", "PUT", async (c) => {
    const body = volumePlanInputSchema.parse(await input(c, volumePlanInputSchema));
    return c.json(await configureVolume(c.req.param("id"), body));
  }),
  route("/workbench-api/novels/:id/auto-director", "POST", async (c) => {
    const body = autoDirectorInputSchema.parse(await input(c, autoDirectorInputSchema));
    return c.json(await startAutoDirector(c.req.param("id"), body), 202);
  }),
  route("/workbench-api/novels/:id/artifacts/novel-brief", "PUT", async (c) => {
    const body = editNovelBriefInputSchema.parse(await input(c, editNovelBriefInputSchema));
    return c.json(await novelRepository.editCommittedBrief(c.req.param("id"), body.brief, body.expectedSha256));
  }),
  route("/workbench-api/novels/:id/artifacts", "GET", async (c) => c.json({ artifacts: await novelRepository.listArtifacts(c.req.param("id")) })),
  route("/workbench-api/novels/:id/assets", "GET", async (c) => c.json({ assets: await novelRepository.listAssets(c.req.param("id")) })),
  route("/workbench-api/novels/:id/files", "GET", async (c) => c.json({ files: await novelRepository.listNovelFiles(c.req.param("id")) })),
  route("/workbench-api/novels/:id/files/content", "GET", async (c) => c.json(await novelRepository.readNovelFile(c.req.param("id"), c.req.query("path") ?? ""))),
  route("/workbench-api/novels/:id/workspace-files", "PUT", async (c) => {
    const body = workspaceFileEditInputSchema.parse(await input(c, workspaceFileEditInputSchema));
    return c.json(await novelRepository.writeWorkspaceFile(c.req.param("id"), body.path, body.content, body.expectedSha256));
  }),
  route("/workbench-api/novels/:id/artifacts/:key", "GET", async (c) => c.json(await novelRepository.readArtifact(c.req.param("id"), decodeURIComponent(c.req.param("key"))))),
  route("/workbench-api/novels/:id/artifacts/:key", "PUT", async (c) => {
    const body = editArtifactInputSchema.parse(await input(c, editArtifactInputSchema));
    return c.json(await novelRepository.editArtifact(c.req.param("id"), decodeURIComponent(c.req.param("key")), body.content, body.expectedSha256));
  }),
  route("/workbench-api/novels/:id/export", "POST", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    return c.json(await startWorkflowRun(c.req.param("id"), "novel-export", typeof body.fileName === "string" ? body.fileName : undefined), 202);
  }),
  route("/workbench-api/novels/:id/export", "GET", async (c) => {
    const result = await novelRepository.readExport(c.req.param("id"), c.req.query("path") ?? "");
    return new Response(result.content, { headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(result.fileName)}` } });
  }),
  route("/workbench-api/runs/:runId", "GET", async (c) => c.json(await runView(c.req.param("runId")))),
  route("/workbench-api/runs/:runId/review", "POST", async (c) => {
    const body = genericReviewRunInputSchema.parse(await input(c, genericReviewRunInputSchema));
    return c.json(await reviewRun(c.req.param("runId"), body), 202);
  }),
];
