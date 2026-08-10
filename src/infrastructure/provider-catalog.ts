import type { ProviderCatalogItem } from "../shared/contracts";
import { AppError } from "../application/errors";

const featuredProviders = ["openai", "anthropic", "google", "deepseek", "openrouter", "groq"];

function modelsFrom(value: unknown): Array<{ id: string; name: string }> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((model) => {
    if (typeof model === "string") return [{ id: model, name: model }];
    if (!model || typeof model !== "object") return [];
    const item = model as Record<string, unknown>;
    const id = String(item.id ?? item.name ?? "");
    return id ? [{ id, name: String(item.name ?? item.label ?? id) }] : [];
  });
}

export function normalizeProviderCatalog(payload: unknown, configuredProviders: Set<string>): ProviderCatalogItem[] {
  const root = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
  const list = Array.isArray(payload) ? payload : Array.isArray(root.providers) ? root.providers : [];
  return list.flatMap((provider) => {
    if (!provider || typeof provider !== "object") return [];
    const item = provider as Record<string, unknown>;
    const id = String(item.id ?? item.name ?? "");
    if (!id) return [];
    const rawEnv = item.envVar;
    const envVar = (Array.isArray(rawEnv) ? rawEnv : rawEnv ? [rawEnv] : []).map(String);
    return [{
      id,
      name: String(item.name ?? item.label ?? id),
      label: String(item.label ?? item.name ?? id),
      description: item.description ? String(item.description) : undefined,
      envVar,
      connected: Boolean(item.connected) || configuredProviders.has(id),
      docUrl: item.docUrl ? String(item.docUrl) : undefined,
      models: modelsFrom(item.models),
    }];
  }).sort((a, b) => {
    const aRank = featuredProviders.indexOf(a.id);
    const bRank = featuredProviders.indexOf(b.id);
    if (aRank !== -1 || bRank !== -1) return (aRank === -1 ? 999 : aRank) - (bRank === -1 ? 999 : bRank);
    return a.label.localeCompare(b.label, "zh-CN");
  });
}

export async function loadProviderCatalog(configuredProviders: Set<string>): Promise<ProviderCatalogItem[]> {
  try {
    const port = process.env.MASTRA_PORT ?? "4111";
    const response = await fetch(`http://127.0.0.1:${port}/api/agents/providers`, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return normalizeProviderCatalog(await response.json(), configuredProviders);
  } catch {
    throw new AppError("PROVIDER_CATALOG_UNAVAILABLE", "暂时无法读取 Mastra 模型目录，请确认 Studio 已启动。", 503, true);
  }
}
