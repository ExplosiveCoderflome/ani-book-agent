export type ProductionModelRetryProgress = {
  label: string;
  attempt: number;
  maxRetries: number;
  delayMs: number;
  updatedAt: string;
};

const modelRetries = new Map<string, ProductionModelRetryProgress>();

export function recordProductionModelRetry(jobId: string, progress: Omit<ProductionModelRetryProgress, "updatedAt">) {
  if (!jobId) return;
  modelRetries.set(jobId, { ...progress, updatedAt: new Date().toISOString() });
}

export function productionModelRetry(jobId: string) {
  return modelRetries.get(jobId);
}

export function clearProductionModelRetry(jobId: string) {
  if (jobId) modelRetries.delete(jobId);
}
