import { z } from "zod";

export const marketPlatformSchema = z.enum(["fanqie", "qidian", "jinjiang"]);
export type MarketPlatform = z.infer<typeof marketPlatformSchema>;
export const marketRankingItemSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  rank: z.number().int().positive(),
  title: z.string().trim().min(1).max(240),
  author: z.string().trim().max(120).optional(),
  category: z.string().trim().max(120).optional(),
  heatLabel: z.string().trim().max(120).optional(),
  sourceUrl: z.string().url(),
});
export const marketSourceStatusSchema = z.object({
  id: z.string().min(1),
  platform: marketPlatformSchema,
  label: z.string().trim().min(1),
  sourceUrl: z.string().url(),
  status: z.enum(["succeeded", "failed"]),
  itemCount: z.number().int().nonnegative(),
  error: z.string().max(500).optional(),
});
export const marketRadarSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  capturedAt: z.string().datetime(),
  sources: z.array(marketSourceStatusSchema).min(1),
  items: z.array(marketRankingItemSchema).max(240),
});
export type MarketRadarSnapshot = z.infer<typeof marketRadarSnapshotSchema>;
export const marketGenreInsightSchema = z.object({
  name: z.string().trim().min(2).max(40),
  observation: z.string().trim().min(8).max(240),
  evidence: z.array(z.string().trim().min(1).max(120)).min(1).max(5),
});
export const marketFeelCardSchema = z.object({
  id: z.string().trim().min(1).max(80),
  label: z.string().trim().min(2).max(24),
  prompt: z.string().trim().min(16).max(400),
  reason: z.string().trim().min(8).max(160),
});
export const marketRadarSummarySchema = z.object({
  schemaVersion: z.literal(1),
  snapshotCapturedAt: z.string().datetime(),
  sourceIds: z.array(z.string().min(1)).min(1).max(8).default(["all"]),
  generatedAt: z.string().datetime(),
  overview: z.string().trim().min(20).max(800),
  genres: z.array(marketGenreInsightSchema).min(2).max(8),
  feelCards: z.array(marketFeelCardSchema).min(4).max(8),
});
export type MarketRadarSummary = z.infer<typeof marketRadarSummarySchema>;
export const marketRadarRunSchema = z.object({ id: z.string(), status: z.enum(["running", "completed", "failed"]), error: z.string().optional() });
export type MarketRadarRun = z.infer<typeof marketRadarRunSchema>;
