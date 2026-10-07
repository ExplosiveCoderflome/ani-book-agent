import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Dpapi, isPlatformSupported } from "@primno/dpapi";
import { AppError } from "../application/errors";
import { CUSTOM_API_KEY, CUSTOM_PROVIDER_ID, customModelsInputSchema, modelProfileNameSchema, modelProfileSchema, modelSettingsInputSchema, type ModelProfileName } from "../shared/contracts";

interface StoredSettings {
  providerId: string;
  modelId: string;
  customProvider?: { baseURL: string; modelId: string };
  profiles?: Partial<Record<ModelProfileName, { providerId: string; modelId: string; parameters?: { temperature?: number; maxOutputTokens?: number; topP?: number } }>>;
}

interface LegacyStoredSettings extends Omit<StoredSettings, "profiles"> {
  profiles?: Record<string, { providerId: string; modelId: string; parameters?: { temperature?: number; maxOutputTokens?: number; topP?: number } }>;
}

interface StoredSecrets {
  version: 1;
  providers: Record<string, string>;
}

const sessionSecrets = new Map<string, Record<string, string>>();

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporaryPath, filePath);
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export class ModelSettingsStore {
  private readonly settingsPath: string;
  private readonly secretsPath: string;

  constructor(runtimeRoot = path.resolve(process.env.ANI_NOVEL_PROJECT_DIR ?? process.env.INIT_CWD ?? process.cwd(), ".runtime")) {
    this.settingsPath = path.join(runtimeRoot, "settings", "model.json");
    this.secretsPath = path.join(runtimeRoot, "secrets", "providers.json");
  }

  get canPersistSecrets(): boolean {
    return process.platform === "win32" && isPlatformSupported;
  }

  async status() {
    const selection = await this.selection();
    const configuredProviders = new Set(sessionSecrets.keys());
    if (this.canPersistSecrets) {
      const stored = await readJson<StoredSecrets>(this.secretsPath, { version: 1, providers: {} });
      Object.keys(stored.providers).forEach((provider) => configuredProviders.add(provider));
    }
    return {
      configured: Boolean(selection && configuredProviders.has(selection.providerId)),
      selection,
      configuredProviders: [...configuredProviders],
      secretPersistence: this.canPersistSecrets ? "windows-dpapi-current-user" : "session-only",
    };
  }

  async selection(): Promise<StoredSettings | undefined> {
    const value = await readJson<LegacyStoredSettings | undefined>(this.settingsPath, undefined);
    if (!value?.providerId || !value.modelId) return undefined;
    const profiles = value.profiles ?? {};
    return {
      providerId: value.providerId,
      modelId: value.modelId,
      customProvider: value.customProvider,
      profiles: {
        ...(profiles.chat ? { chat: profiles.chat } : {}),
        ...(profiles.writer ?? profiles.drafting ? { writer: profiles.writer ?? profiles.drafting } : {}),
        ...(profiles.critic ?? profiles.review ? { critic: profiles.critic ?? profiles.review } : {}),
        ...(profiles.analysis ? { analysis: profiles.analysis } : {}),
      },
    };
  }

  async save(providerId: string, modelId: string, credentials: Record<string, string>, baseURL?: string) {
    ({ providerId, modelId, credentials, baseURL } = modelSettingsInputSchema.parse({ providerId, modelId, credentials, baseURL }));
    const previous = await this.selection();
    const cleanCredentials = Object.fromEntries(
      Object.entries(credentials).filter(([key, value]) => key.trim() && value.trim()).map(([key, value]) => [key, value.trim()]),
    );
    if (providerId === CUSTOM_PROVIDER_ID && !cleanCredentials[CUSTOM_API_KEY]) {
      if (previous?.customProvider?.baseURL !== baseURL || !(await this.credentials(providerId))?.[CUSTOM_API_KEY]) {
        throw new AppError("MODEL_KEY_REQUIRED", "首次连接或更改 API 地址时，请填写第三方 API Key。", 400, true);
      }
    }
    if (Object.keys(cleanCredentials).length) {
      sessionSecrets.set(providerId, cleanCredentials);
      if (this.canPersistSecrets) {
        const stored = await readJson<StoredSecrets>(this.secretsPath, { version: 1, providers: {} });
        const plaintext = Buffer.from(JSON.stringify(cleanCredentials), "utf8");
        stored.providers[providerId] = Buffer.from(Dpapi.protectData(plaintext, null, "CurrentUser")).toString("base64");
        await atomicJson(this.secretsPath, stored);
      }
    }
    await atomicJson(this.settingsPath, { providerId, modelId, profiles: previous?.profiles, customProvider: providerId === CUSTOM_PROVIDER_ID ? { baseURL: baseURL!, modelId } : previous?.customProvider } satisfies StoredSettings);
    return this.status();
  }

  async fetchCustomModels(input: unknown): Promise<{ models: Array<{ id: string; name: string }> }> {
    const { baseURL, apiKey: suppliedKey } = customModelsInputSchema.parse(input);
    const saved = await this.selection();
    const apiKey = suppliedKey || (saved?.customProvider?.baseURL === baseURL ? (await this.credentials(CUSTOM_PROVIDER_ID))?.[CUSTOM_API_KEY] : undefined);
    if (!apiKey) throw new AppError("MODEL_KEY_REQUIRED", "请填写 API Key；更换地址时不能沿用已保存的密钥。", 400, true);
    try {
      const response = await fetch(`${baseURL}/models`, { headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" }, signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!response.ok) {
        const message = response.status === 401 || response.status === 403 ? "密钥无效或无权获取模型，请检查 API Key。" : response.status === 404 ? "未找到模型接口，请检查基础地址；厂商需支持 /models。" : `获取模型失败（HTTP ${response.status}），请稍后重试。`;
        throw new AppError("MODEL_LIST_FAILED", message, 502, true);
      }
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || !("data" in payload) || !Array.isArray(payload.data)) throw new AppError("MODEL_LIST_INVALID", "厂商返回的模型列表格式不兼容，需包含 data 数组。", 502, true);
      const ids = [...new Set(payload.data.flatMap((item: unknown) => item && typeof item === "object" && "id" in item && typeof item.id === "string" && item.id.trim() ? [item.id.trim()] : []))].sort();
      if (!ids.length) throw new AppError("MODEL_LIST_EMPTY", "厂商没有返回可用模型，请检查密钥权限或联系厂商。", 502, true);
      return { models: ids.map((id) => ({ id, name: id })) };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("MODEL_LIST_FAILED", "无法获取模型列表，请检查地址、网络和厂商接口后重试（最长等待 10 秒）。", 502, true);
    }
  }

  async profiles() {
    const selection = await this.selection();
    return {
      default: selection ? { providerId: selection.providerId, modelId: selection.modelId, parameters: {} } : undefined,
      profiles: selection?.profiles ?? {},
      customProvider: selection?.customProvider,
    };
  }

  async saveProfiles(input: unknown) {
    const current = await this.selection();
    if (!current) throw new AppError("MODEL_NOT_CONFIGURED", "请先配置默认模型。", 409, true);
    const record = input && typeof input === "object" && "profiles" in input ? (input as { profiles: Record<string, unknown> }).profiles : {};
    const profiles: StoredSettings["profiles"] = {};
    for (const [name, value] of Object.entries(record)) {
      const parsedName = modelProfileNameSchema.parse(name);
      if (value) profiles[parsedName] = modelProfileSchema.parse(value);
    }
    await atomicJson(this.settingsPath, { ...current, profiles });
    return this.profiles();
  }

  async runtimeSelection(profile?: ModelProfileName) {
    const selection = await this.selection();
    if (!selection) throw new AppError("MODEL_NOT_CONFIGURED", "请先选择并配置一个模型。", 409, true);
    const effective = profile ? selection.profiles?.[profile] ?? (profile === "analysis" ? selection.profiles?.critic : undefined) ?? selection : selection;
    const credentials = await this.credentials(effective.providerId);
    if (!credentials || !Object.keys(credentials).length) {
      throw new AppError("MODEL_NOT_CONFIGURED", "当前模型还没有可用的密钥。", 409, true);
    }
    const model = `${effective.providerId}/${effective.modelId}`;
    if (effective.providerId === CUSTOM_PROVIDER_ID) {
      if (!selection.customProvider?.baseURL || !credentials[CUSTOM_API_KEY]) throw new AppError("MODEL_NOT_CONFIGURED", "请先配置第三方 API 地址和密钥。", 409, true);
      return { providerId: effective.providerId, modelId: effective.modelId, model, modelConfig: { providerId: CUSTOM_PROVIDER_ID, modelId: effective.modelId, url: selection.customProvider.baseURL, apiKey: credentials[CUSTOM_API_KEY] }, parameters: "parameters" in effective ? effective.parameters ?? {} : {} };
    }
    for (const [name, value] of Object.entries(credentials)) process.env[name] = value;
    return { providerId: effective.providerId, modelId: effective.modelId, model, modelConfig: model, parameters: "parameters" in effective ? effective.parameters ?? {} : {} };
  }

  private async credentials(providerId: string): Promise<Record<string, string> | undefined> {
    const inSession = sessionSecrets.get(providerId);
    if (inSession) return inSession;
    if (!this.canPersistSecrets) return undefined;
    const stored = await readJson<StoredSecrets>(this.secretsPath, { version: 1, providers: {} });
    const ciphertext = stored.providers[providerId];
    if (!ciphertext) return undefined;
    try {
      const decrypted = Dpapi.unprotectData(Buffer.from(ciphertext, "base64"), null, "CurrentUser");
      const credentials = JSON.parse(Buffer.from(decrypted).toString("utf8")) as Record<string, string>;
      sessionSecrets.set(providerId, credentials);
      return credentials;
    } catch {
      throw new AppError("SECRET_DECRYPT_FAILED", "模型密钥无法由当前 Windows 用户解密，请重新保存。", 409, true);
    }
  }
}

export function sanitizeProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let sanitized = message;
  for (const credentials of sessionSecrets.values()) {
    for (const secret of Object.values(credentials)) if (secret) sanitized = sanitized.replaceAll(secret, "***");
  }
  return sanitized.replace(/(api[_-]?key|token|secret)\s*[=:]\s*[^\s,;]+/gi, "$1=***").slice(0, 500);
}
