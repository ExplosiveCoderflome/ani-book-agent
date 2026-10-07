import { z } from "zod";
import { productionGoalSchema } from "./project";

export const executionStageSchema = z.enum(["planning", "writing", "reviewing", "exporting"]);
export const executionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  runId: z.string().min(1),
  traceId: z.string().min(1),
  novelId: z.string().uuid(),
  taskType: productionGoalSchema,
  stage: executionStageSchema,
  novelStateHash: z.string().length(64),
  preferenceVersion: z.number().int().nonnegative(),
  skillVersions: z.record(z.string(), z.string()).default({}),
  adaptationVersions: z.record(z.string(), z.string().length(64)).default({}),
  adaptationsSha256: z.string().length(64).optional(),
  allowedTools: z.array(z.string()).default([]),
  requiresApproval: z.boolean(),
  contextBudget: z.number().int().min(1_000).max(100_000),
});

export type ExecutionEnvelope = z.infer<typeof executionEnvelopeSchema>;

export function executionStage(goal: z.infer<typeof productionGoalSchema>): z.infer<typeof executionStageSchema> {
  return goal === "review_project" ? "reviewing" : goal === "export" ? "exporting" : goal === "write_chapters" ? "planning" : "writing";
}
