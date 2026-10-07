import { z } from "zod";

export const preferenceSignalInputSchema = z.object({
  novelId: z.string().uuid(),
  kind: z.enum(["choice", "like", "dislike"]),
  value: z.string().trim().min(1).max(500),
  excerpt: z.string().trim().max(1_000).optional(),
  messageId: z.string().max(200).optional(),
  scope: z.enum(["global", "novel"]).default("novel"),
});

export const preferenceSignalSchema = preferenceSignalInputSchema.extend({
  id: z.string().uuid(),
  createdAt: z.string().datetime(),
});

export const authorPreferenceProfileSchema = z.object({
  schemaVersion: z.literal(1),
  version: z.number().int().nonnegative(),
  signals: z.array(preferenceSignalSchema).max(200),
  updatedAt: z.string().datetime(),
});

export type PreferenceSignalInput = z.input<typeof preferenceSignalInputSchema>;
export type AuthorPreferenceProfile = z.infer<typeof authorPreferenceProfileSchema>;
