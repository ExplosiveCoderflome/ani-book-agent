import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { Dpapi, isPlatformSupported } from "@primno/dpapi";
import { AppError } from "../application/errors";
import { modelProfileNameSchema, modelProfileSchema, type ModelProfileName } from "../shared/contracts";

interface StoredSettings {
  providerId: string;
  modelId: string;
  profiles?: Partial<Record<ModelProfileName, { providerId: string; modelId: string; parameters?: { temperature?: number; maxOutputTokens?: number; topP?: number } }>>;
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
    const value = await readJson<StoredSettings | undefined>(this.settingsPath, undefined);
    return value?.providerId && value.modelId ? value : undefined;
  }

  async save(providerId: string, modelId: string, credentials: Record<string, string>) {
    const cleanCredentials = Object.fromEntries(
      Object.entries(credentials).filter(([key, value]) => key.trim() && value.trim()).map(([key, value]) => [key, value.trim()]),
    );
    if (Object.keys(cleanCredentials).length) {
      sessionSecrets.set(providerId, cleanCredentials);
      if (this.canPersistSecrets) {
        const stored = await readJson<StoredSecrets>(this.secretsPath, { version: 1, providers: {} });
        const plaintext = Buffer.from(JSON.stringify(cleanCredentials), "utf8");
        stored.providers[providerId] = Buffer.from(Dpapi.protectData(plaintext, null, "CurrentUser")).toString("base64");
        await atomicJson(this.secretsPath, stored);
      }
    }
    const previous = await this.selection();
    await atomicJson(this.settingsPath, { providerId, modelId, profiles: previous?.profiles } satisfies StoredSettings);
    return this.status();
  }

  async profiles() {
    const selection = await this.selection();
    return {
      default: selection ? { providerId: selection.providerId, modelId: selection.modelId, parameters: {} } : undefined,
      profiles: selection?.profiles ?? {},
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

  async runtimeSelection(profile?: ModelProfileName): Promise<{ providerId: string; modelId: string; model: string; parameters: { temperature?: number; maxOutputTokens?: number; topP?: number } }> {
    const selection = await this.selection();
    if (!selection) throw new AppError("MODEL_NOT_CONFIGURED", "请先选择并配置一个模型。", 409, true);
    const effective = profile ? selection.profiles?.[profile] ?? selection : selection;
    const credentials = await this.credentials(effective.providerId);
    if (!credentials || !Object.keys(credentials).length) {
      throw new AppError("MODEL_NOT_CONFIGURED", "当前模型还没有可用的密钥。", 409, true);
    }
    for (const [name, value] of Object.entries(credentials)) process.env[name] = value;
    return { providerId: effective.providerId, modelId: effective.modelId, model: `${effective.providerId}/${effective.modelId}`, parameters: "parameters" in effective ? effective.parameters ?? {} : {} };
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

export const modelSettings = new ModelSettingsStore();
