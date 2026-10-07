import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import { authorPreferenceProfileSchema, preferenceSignalInputSchema, type AuthorPreferenceProfile, type PreferenceSignalInput } from "../domain";

const emptyProfile = (): AuthorPreferenceProfile => ({ schemaVersion: 1, version: 0, signals: [], updatedAt: new Date(0).toISOString() });

export class AuthorPreferenceRepository {
  private readonly filePath: string;
  private writing: Promise<AuthorPreferenceProfile> = Promise.resolve(emptyProfile());

  constructor(root = path.resolve(process.env.ANI_NOVEL_PROJECT_DIR ?? process.env.INIT_CWD ?? process.cwd(), "profiles")) {
    this.filePath = path.join(root, "default", "author-preferences.yaml");
  }

  async get(): Promise<AuthorPreferenceProfile> {
    try { return authorPreferenceProfileSchema.parse(parse(await readFile(this.filePath, "utf8"))); }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return emptyProfile(); throw error; }
  }

  record(raw: PreferenceSignalInput): Promise<AuthorPreferenceProfile> {
    const input = preferenceSignalInputSchema.parse(raw);
    this.writing = this.writing.catch(() => emptyProfile()).then(async () => {
      const profile = await this.get();
      const now = new Date().toISOString();
      const signals = profile.signals.filter((item) => !input.messageId || item.messageId !== input.messageId || item.kind === input.kind);
      const duplicate = signals.find((item) => item.kind === input.kind && item.scope === input.scope && item.novelId === input.novelId && item.value === input.value);
      const next = authorPreferenceProfileSchema.parse({
        ...profile,
        version: profile.version + 1,
        signals: [...signals.filter((item) => item.id !== duplicate?.id), { ...input, id: duplicate?.id ?? randomUUID(), createdAt: now }].slice(-200),
        updatedAt: now,
      });
      await mkdir(path.dirname(this.filePath), { recursive: true });
      const temporary = `${this.filePath}.${randomUUID()}.tmp`;
      await writeFile(temporary, stringify(next, { lineWidth: 0 }), { encoding: "utf8", flag: "wx" });
      await rename(temporary, this.filePath);
      return next;
    });
    return this.writing;
  }

  async prompt(novelId: string): Promise<string> {
    const relevant = (await this.get().catch(() => emptyProfile())).signals.filter((item) => item.scope === "global" || item.novelId === novelId).slice(-20);
    if (!relevant.length) return "";
    const kind = { choice: "选择", like: "喜欢", dislike: "不喜欢" } as const;
    return relevant.map((item) => `- [${item.scope === "global" ? "长期" : "本书"}·${kind[item.kind]}] ${item.value}${item.excerpt ? `；相关内容：${item.excerpt}` : ""}`).join("\n").slice(0, 6_000);
  }
}
