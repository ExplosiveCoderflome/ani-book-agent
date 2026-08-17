import { z } from "zod";

export const skillSourceSchema = z.enum(["builtin", "derived", "custom", "imported"]);
export const skillStatusSchema = z.enum(["draft", "published", "archived"]);
export const skillVisibilitySchema = z.enum(["private", "public"]);
export const skillFileKindSchema = z.enum(["text", "binary"]);

export const skillFileSchema = z.object({
  path: z.string().trim().min(1).max(240),
  kind: skillFileKindSchema,
  content: z.string().optional(),
  base64: z.string().optional(),
  size: z.number().int().nonnegative(),
  sha256: z.string().length(64),
  mimeType: z.string().max(120).optional(),
}).superRefine((file, ctx) => {
  if (file.kind === "text" && file.content === undefined) ctx.addIssue({ code: "custom", message: "文本文件必须提供 content。", path: ["content"] });
  if (file.kind === "binary" && file.base64 === undefined) ctx.addIssue({ code: "custom", message: "二进制文件必须提供 base64。", path: ["base64"] });
});
export type SkillFile = z.infer<typeof skillFileSchema>;

export const skillBindingSchema = z.object({
  skillId: z.string().min(1).max(120),
  enabled: z.boolean(),
  version: z.union([z.literal("latest"), z.string().min(1).max(120)]),
  agents: z.array(z.string().min(1).max(120)).max(20).default([]),
  tasks: z.array(z.string().min(1).max(120)).max(30).default([]),
});
export const skillBindingsSchema = z.object({ version: z.literal(1), skills: z.array(skillBindingSchema).max(200) });
export type SkillBinding = z.infer<typeof skillBindingSchema>;
export type SkillBindings = z.infer<typeof skillBindingsSchema>;

export const skillRecordSchema = z.object({
  id: z.string().min(1), name: z.string().min(1).max(64), description: z.string().min(1).max(1024),
  source: skillSourceSchema, status: skillStatusSchema, visibility: skillVisibilitySchema,
  official: z.boolean(), activeVersionId: z.string().optional(),
  derivedFrom: z.object({ skillId: z.string(), versionId: z.string() }).optional(),
  compatibleAgents: z.array(z.string()), taskTypes: z.array(z.string()), requiresSandbox: z.boolean(),
  createdAt: z.string(), updatedAt: z.string(),
});
export type SkillRecord = z.infer<typeof skillRecordSchema>;

export const skillVersionSchema = z.object({
  id: z.string(), skillId: z.string(), versionNumber: z.number().int().positive(),
  files: z.array(skillFileSchema), contentHash: z.string().length(64),
  changedFields: z.array(z.string()), changeMessage: z.string().optional(), createdAt: z.string(),
});
export type SkillVersion = z.infer<typeof skillVersionSchema>;

/** Skill 的目录名和 frontmatter name 共用这一套稳定命名规则。 */
export const skillNameSchema = z.string().trim().min(1).max(63).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Skill 名称只能使用小写字母、数字和短横线。" );

export const skillValidationResultSchema = z.object({
  valid: z.boolean(),
  errors: z.array(z.object({ path: z.string().optional(), code: z.string(), message: z.string() })),
  warnings: z.array(z.object({ path: z.string().optional(), code: z.string(), message: z.string() })),
  capabilities: z.object({ hasReferences: z.boolean(), hasScripts: z.boolean(), hasAssets: z.boolean(), requiresSandbox: z.boolean() }),
});
export type SkillValidationResult = z.infer<typeof skillValidationResultSchema>;

export const skillSandboxCapabilitiesSchema = z.object({
  configured: z.boolean(), provider: z.string().optional(), isolated: z.boolean(),
  network: z.enum(["disabled", "restricted", "enabled"]), approvalRequired: z.boolean(), reason: z.string().optional(),
});
export type SkillSandboxCapabilities = z.infer<typeof skillSandboxCapabilitiesSchema>;

export function normalizeSkillPath(value: string): string {
  const normalized = value.replaceAll("\\", "/");
  const parts = normalized.split("/");
  if (normalized.startsWith("/") || /^[a-z]:/i.test(normalized) || parts.some((part) => !part || part === "." || part === "..")) throw new Error("INVALID_SKILL_PATH");
  if (normalized !== "SKILL.md" && (!new Set(["references", "scripts", "assets", "agents"]).has(parts[0]!) || parts.length < 2 || parts.slice(1).some((part) => /[<>:"|?*\x00-\x1f]/.test(part)))) throw new Error("INVALID_SKILL_PATH");
  return normalized;
}

export function assertSkillName(value: string): string {
  return skillNameSchema.parse(value);
}
