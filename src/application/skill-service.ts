import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { mastraStorage } from "../mastra/runtime-storage";
import { AppError } from "./errors";
import { NovelRepository } from "../infrastructure/novel-repository";
import {
  assertSkillName, normalizeSkillPath, skillBindingsSchema, skillFileSchema, skillRecordSchema, skillSandboxCapabilitiesSchema,
  skillValidationResultSchema, skillVersionSchema, type SkillBindings, type SkillFile, type SkillRecord,
  type SkillSandboxCapabilities, type SkillValidationResult, type SkillVersion,
} from "../domain";

const builtinIds = ["discovery", "blueprint", "volume-planning", "chapter-writing", "critique", "project-review"] as const;
const maxFileBytes = 5 * 1024 * 1024;
const maxTotalBytes = 50 * 1024 * 1024;
const repository = new NovelRepository();
const skills = mastraStorage.stores!.skills!;
const blobs = mastraStorage.stores!.blobs!;
let seeded: Promise<void> | undefined;
const execFile = promisify(execFileCallback);

export type SkillDraftInput = {
  expectedVersionId?: string;
  name: string;
  description: string;
  files: SkillFile[];
  compatibleAgents: string[];
  taskTypes: string[];
  requiresSandbox: boolean;
  changeMessage?: string;
};

function sha256(value: string | Buffer) { return createHash("sha256").update(value).digest("hex"); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function filesHash(files: SkillFile[]) { return sha256(JSON.stringify(canonical(files.map(({ path: filePath, kind, size, sha256: digest, mimeType }) => ({ path: filePath, kind, size, sha256: digest, mimeType }))))); }
function stripFrontmatter(content: string) {
  if (!content.startsWith("---\n")) return { metadata: {} as Record<string, unknown>, body: content.trim() };
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) throw new AppError("SKILL_FRONTMATTER_INVALID", "SKILL.md 的 frontmatter 没有闭合。", 400, true);
  try { return { metadata: (parse(content.slice(4, end)) ?? {}) as Record<string, unknown>, body: content.slice(end + 5).trim() }; }
  catch { throw new AppError("SKILL_FRONTMATTER_INVALID", "SKILL.md 的 frontmatter 无法解析。", 400, true); }
}
function fileBytes(file: SkillFile) { return file.kind === "text" ? Buffer.byteLength(file.content ?? "", "utf8") : Buffer.from(file.base64 ?? "", "base64").byteLength; }
function normalizeFiles(raw: SkillFile[], allowMissing = false): SkillFile[] {
  const seen = new Set<string>(); let total = 0;
  const files = raw.map((input) => {
    const filePath = normalizeSkillPath(input.path);
    if (seen.has(filePath)) throw new AppError("SKILL_DUPLICATE_FILE", filePath + " 重复。", 400, false);
    seen.add(filePath);
    const file = skillFileSchema.parse({ ...input, path: filePath });
    const actualSize = fileBytes(file);
    if (actualSize > maxFileBytes) throw new AppError("SKILL_FILE_TOO_LARGE", filePath + " 超过单文件大小限制。", 413, true);
    const actualHash = sha256(file.kind === "text" ? file.content ?? "" : Buffer.from(file.base64 ?? "", "base64"));
    if (actualHash !== file.sha256) throw new AppError("SKILL_FILE_HASH_MISMATCH", filePath + " 内容哈希不匹配。", 409, true);
    total += actualSize;
    return { ...file, size: actualSize };
  }).sort((a, b) => a.path.localeCompare(b.path));
  if (total > maxTotalBytes) throw new AppError("SKILL_TOO_LARGE", "Skill 总大小超过限制。", 413, true);
  if (!allowMissing && !files.some((file) => file.path === "SKILL.md")) throw new AppError("SKILL_ENTRY_MISSING", "Skill 必须包含 SKILL.md。", 400, false);
  return files;
}
function fileMetadata(files: SkillFile[], fallback: { name: string; description: string }) {
  const entry = files.find((file) => file.path === "SKILL.md");
  if (!entry || entry.kind !== "text") return { name: fallback.name, description: fallback.description, instructions: entry?.content ?? "" };
  const parsed = stripFrontmatter(entry.content ?? "");
  return {
    name: typeof parsed.metadata.name === "string" ? parsed.metadata.name : fallback.name,
    description: typeof parsed.metadata.description === "string" ? parsed.metadata.description : fallback.description,
    instructions: parsed.body,
  };
}
function treeFromFiles(files: SkillFile[]) {
  const root: any[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let children = root;
    parts.forEach((part, index) => {
      const last = index === parts.length - 1;
      if (last) children.push({ name: part, type: "file", content: file.kind === "text" ? file.content : file.base64 });
      else {
        let folder = children.find((item) => item.type === "folder" && item.name === part);
        if (!folder) { folder = { name: part, type: "folder", children: [] }; children.push(folder); }
        children = folder.children;
      }
    });
  }
  return root;
}
function treeEntries(files: SkillFile[]) {
  return Object.fromEntries(files.map((file) => [file.path, {
    blobHash: file.sha256, size: file.size, ...(file.mimeType ? { mimeType: file.mimeType } : {}),
    ...(file.kind === "binary" ? { encoding: "base64" as const } : {}),
  }]));
}
function appMetadata(input: { source: string; official: boolean; compatibleAgents: string[]; taskTypes: string[]; requiresSandbox: boolean; derivedFrom?: { skillId: string; versionId: string }; contentHash: string }) {
  return { app: input };
}
function isPublishedVersion(record: any, version: any) {
  return Boolean(version && (version.id === record.activeVersionId || version.metadata?.app?.published === true || version.metadata?.app?.official === true));
}
async function putBlobs(files: SkillFile[]) {
  await blobs.putMany(files.map((file) => ({
    hash: file.sha256, content: file.kind === "text" ? file.content ?? "" : file.base64 ?? "", size: file.size,
    ...(file.mimeType ? { mimeType: file.mimeType } : {}), createdAt: new Date(),
  })));
}
async function collectFilesFromDirectory(root: string, current = ""): Promise<SkillFile[]> {
  const entries = await readdir(path.join(root, current), { withFileTypes: true });
  const result: SkillFile[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") continue;
    const relative = current ? current + "/" + entry.name : entry.name;
    const full = path.join(root, relative);
    if (entry.isSymbolicLink()) throw new AppError("SKILL_SYMLINK_UNSUPPORTED", "Skill 导入不允许符号链接：" + relative, 400, false);
    if (entry.isDirectory()) result.push(...await collectFilesFromDirectory(root, relative));
    else if (entry.isFile()) {
      let normalized: string;
      try { normalized = normalizeSkillPath(relative); }
      catch { continue; }
      const buffer = await readFile(full);
      const text = /(?:^|\/)(?:SKILL\.md|[^/]+\.(?:md|txt|json|ya?ml|js|mjs|cjs|ts|tsx|py|sh|ps1|css|html))$/i.test(normalized);
      result.push(text
        ? { path: normalized, kind: "text", content: buffer.toString("utf8"), size: buffer.byteLength, sha256: sha256(buffer), mimeType: "text/plain" }
        : { path: normalized, kind: "binary", base64: buffer.toString("base64"), size: buffer.byteLength, sha256: sha256(buffer) });
    }
  }
  return result;
}

function snapshot(input: { id: string; files: SkillFile[]; name: string; description: string; source: "builtin" | "derived" | "custom" | "imported"; official: boolean; compatibleAgents: string[]; taskTypes: string[]; requiresSandbox: boolean; derivedFrom?: { skillId: string; versionId: string } }) {
  const files = normalizeFiles(input.files);
  const meta = fileMetadata(files, input);
  const digest = filesHash(files);
  return {
    // Registry 元数据来自表单/导入合同；SKILL.md frontmatter 在 validate 阶段严格校验，
    // 不能让一段未校验的 frontmatter 悄悄改写 Registry 的名称。
    name: input.name.trim(), description: input.description.trim(), instructions: meta.instructions,
    source: { type: "managed" as const, mastraPath: "skills/" + input.id },
    references: files.filter((file) => file.path.startsWith("references/")).map((file) => file.path.slice(11)),
    scripts: files.filter((file) => file.path.startsWith("scripts/")).map((file) => file.path.slice(8)),
    assets: files.filter((file) => file.path.startsWith("assets/")).map((file) => file.path.slice(7)),
    files: treeFromFiles(files), tree: { entries: treeEntries(files) },
    metadata: appMetadata({ source: input.source, official: input.official, compatibleAgents: input.compatibleAgents, taskTypes: input.taskTypes, requiresSandbox: input.requiresSandbox, derivedFrom: input.derivedFrom, contentHash: digest }),
    _files: files,
  };
}
function toRecord(raw: any): SkillRecord {
  const app = (raw.metadata?.app ?? {}) as Record<string, any>;
  return skillRecordSchema.parse({
    id: raw.id, name: raw.name, description: raw.description, source: app.source ?? "custom", status: raw.status,
    visibility: raw.visibility ?? "private", official: Boolean(app.official), activeVersionId: raw.activeVersionId ?? undefined,
    derivedFrom: app.derivedFrom, compatibleAgents: app.compatibleAgents ?? [], taskTypes: app.taskTypes ?? [],
    requiresSandbox: Boolean(app.requiresSandbox), createdAt: new Date(raw.createdAt).toISOString(), updatedAt: new Date(raw.updatedAt).toISOString(),
  });
}
function toVersion(raw: any): SkillVersion {
  const tree = raw.tree?.entries ?? {};
  const flatten = (nodes: any[], prefix = ""): SkillFile[] => nodes.flatMap((node) => node.type === "folder"
    ? flatten(node.children ?? [], prefix + node.name + "/")
    : (() => {
      const filePath = prefix + node.name; const entry = tree[filePath]; const binary = entry?.encoding === "base64";
      const draft = binary
        ? { path: filePath, kind: "binary" as const, base64: node.content ?? "", size: entry?.size ?? 0, sha256: entry?.blobHash ?? "" }
        : { path: filePath, kind: "text" as const, content: node.content ?? "", size: entry?.size ?? 0, sha256: entry?.blobHash ?? "" };
      return [skillFileSchema.parse({ ...draft, ...(entry?.mimeType ? { mimeType: entry.mimeType } : {}) })];
    })());
  const files = flatten(raw.files ?? []);
  const app = (raw.metadata?.app ?? {}) as Record<string, any>;
  return skillVersionSchema.parse({ id: raw.id, skillId: raw.skillId, versionNumber: raw.versionNumber, files, contentHash: app.contentHash ?? sha256(JSON.stringify(files)), changedFields: raw.changedFields ?? [], changeMessage: raw.changeMessage ?? undefined, createdAt: new Date(raw.createdAt).toISOString() });
}
function makeYaml(bindings: SkillBindings) {
  return ["version: 1", "skills:", ...bindings.skills.flatMap((item) => [
    "  - skillId: " + item.skillId,
    "    enabled: " + item.enabled,
    "    version: " + item.version,
    "    agents: [" + item.agents.join(", ") + "]",
    "    tasks: [" + item.tasks.join(", ") + "]",
  ]), ""].join("\n");
}

export class SkillRegistryService {
  private async init() { await Promise.all([skills.init(), blobs.init()]); }
  private async ensureSeeded() {
    if (!seeded) seeded = this.seedBuiltins();
    await seeded;
  }
  private async seedBuiltins() {
    await this.init();
    const root = path.resolve(process.env.INIT_CWD ?? process.cwd(), "src", "mastra", "skills");
    for (const id of builtinIds) {
      const source = await readFile(path.join(root, id, "SKILL.md"), "utf8");
      const parsed = stripFrontmatter(source);
      const description = typeof parsed.metadata.description === "string" ? parsed.metadata.description : "小说创作阶段：" + id;
      const content = ["---", "name: " + id, "description: " + JSON.stringify(description), "---", "", parsed.body, ""].join("\n");
      const fileDigest = sha256(content);
      const files: SkillFile[] = [{ path: "SKILL.md", kind: "text", content, size: Buffer.byteLength(content), sha256: fileDigest, mimeType: "text/markdown" }];
      const digest = filesHash(files);
      const meta = fileMetadata(files, { name: id, description });
      const current = await skills.getById(id);
      if (!current) {
        await putBlobs(files);
        const data = snapshot({ id, files, name: meta.name, description: meta.description, source: "builtin", official: true, compatibleAgents: ["novel-agent", "novel-critic"], taskTypes: [id], requiresSandbox: false });
        await skills.create({ skill: { id, ...data } as any });
        const latest = await skills.getLatestVersion(id);
        if (latest) await skills.update({ id, activeVersionId: latest.id, status: "published" });
      } else {
        const latest = await skills.getLatestVersion(id);
        if ((latest?.metadata as any)?.app?.contentHash !== digest) {
          await putBlobs(files);
          const data = snapshot({ id, files, name: meta.name, description: meta.description, source: "builtin", official: true, compatibleAgents: ["novel-agent", "novel-critic"], taskTypes: [id], requiresSandbox: false });
          await skills.createVersion({ id: randomUUID(), skillId: id, versionNumber: (latest?.versionNumber ?? 0) + 1, ...data, changedFields: ["instructions", "files"], changeMessage: "官方 Skill 更新" } as any);
          const next = await skills.getLatestVersion(id);
          if (next) await skills.update({ id, activeVersionId: next.id, status: "published" });
        }
      }
    }
  }
  async list(status?: "draft" | "published" | "archived") {
    await this.ensureSeeded();
    const rows = await skills.list({ perPage: false, ...(status ? { status } : {}) });
    return Promise.all(rows.skills.map(async (row: any) => {
      const version = await skills.getLatestVersion(row.id);
      return toRecord({ ...row, ...version, id: row.id });
    }));
  }
  async get(id: string, draft = true) {
    await this.ensureSeeded();
    const record = await skills.getById(id);
    if (!record) throw new AppError("SKILL_NOT_FOUND", "没有找到这个 Skill。", 404, true, undefined, "reread");
    const version = draft ? await skills.getLatestVersion(id) : record.activeVersionId ? await skills.getVersion(record.activeVersionId) : await skills.getLatestVersion(id);
    if (!version) throw new AppError("SKILL_VERSION_NOT_FOUND", "这个 Skill 没有可读取版本。", 404, true, undefined, "reread");
    return { record: toRecord({ ...record, ...version, id: record.id }), version: toVersion(version) };
  }
  async versions(id: string) {
    await this.ensureSeeded();
    if (!await skills.getById(id)) throw new AppError("SKILL_NOT_FOUND", "没有找到这个 Skill。", 404, true, undefined, "reread");
    const rows = await skills.listVersions({ skillId: id, perPage: false, orderBy: { field: "versionNumber", direction: "DESC" } });
    return rows.versions.map(toVersion);
  }
  async version(id: string, versionId?: string) {
    await this.ensureSeeded();
    const record = await skills.getById(id);
    if (!record) throw new AppError("SKILL_NOT_FOUND", "没有找到这个 Skill。", 404, true, undefined, "reread");
    const raw = versionId ? await skills.getVersion(versionId) : record.activeVersionId ? await skills.getVersion(record.activeVersionId) : await skills.getLatestVersion(id);
    if (!raw || raw.skillId !== id) throw new AppError("SKILL_VERSION_NOT_FOUND", "没有找到这个 Skill 版本。", 404, true, undefined, "reread");
    return toVersion(raw);
  }
  async create(input: SkillDraftInput, source: "custom" | "imported" | "derived" = "custom", derivedFrom?: { skillId: string; versionId: string }) {
    await this.ensureSeeded();
    let name: string;
    try { name = assertSkillName(input.name); }
    catch { throw new AppError("SKILL_NAME_INVALID", "Skill 名称只能使用小写字母、数字和短横线。", 400, false); }
    if ((await this.list()).some((item) => item.name === name)) throw new AppError("SKILL_NAME_DUPLICATE", "Skill 名称已存在，请换一个名称。", 409, true);
    const files = normalizeFiles(input.files);
    const id = randomUUID();
    const data = snapshot({ id, files, name, description: input.description.trim(), source, official: false, compatibleAgents: input.compatibleAgents, taskTypes: input.taskTypes, requiresSandbox: input.requiresSandbox || files.some((file) => file.path.startsWith("scripts/")), derivedFrom });
    await putBlobs(files);
    const created = await skills.create({ skill: { id, ...data } as any });
    return this.get(created.id);
  }
  async importGit(input: { url: string; ref?: string; subdir?: string }) {
    if (!/^https:\/\//i.test(input.url)) throw new AppError("SKILL_GIT_URL_INVALID", "只允许导入 HTTPS Git 地址。", 400, false);
    const temp = await mkdtemp(path.join(process.env.TEMP ?? process.cwd(), "ani-skill-import-"));
    const repo = path.join(temp, "repo");
    try {
      const args = ["-c", "core.hooksPath=" + path.join(temp, "hooks"), "clone", "--depth", "1", "--no-tags"];
      if (input.ref) args.push("--branch", input.ref);
      args.push(input.url, repo);
      await execFile("git", args, { timeout: 120_000, windowsHide: true, maxBuffer: 2_000_000 });
      const relative = (input.subdir ?? "").replaceAll("\\", "/").replace(/^\/+|\/+$/g, "");
      if (relative.split("/").some((part) => !part || part === "." || part === "..") || /^[a-z]:/i.test(relative)) throw new AppError("SKILL_IMPORT_PATH_INVALID", "Git Skill 子目录无效。", 400, false);
      const root = path.resolve(repo, relative);
      if (relative && !root.startsWith(path.resolve(repo) + path.sep)) throw new AppError("SKILL_IMPORT_PATH_INVALID", "Git Skill 子目录无效。", 400, false);
      const files = await collectFilesFromDirectory(root);
      const entry = files.find((file) => file.path === "SKILL.md" && file.kind === "text");
      if (!entry) throw new AppError("SKILL_ENTRY_MISSING", "Git 目录根部没有 SKILL.md。", 400, false);
      const metadata = stripFrontmatter(entry.content ?? "").metadata;
      return this.create({ name: typeof metadata.name === "string" ? metadata.name : path.basename(root), description: typeof metadata.description === "string" ? metadata.description : "从 Git 导入的创作 Skill", files, compatibleAgents: ["novel-agent"], taskTypes: [], requiresSandbox: files.some((file) => file.path.startsWith("scripts/")) }, "imported");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("SKILL_GIT_IMPORT_FAILED", "Git Skill 导入失败，请检查地址、分支和 Git 环境。", 400, true);
    } finally { await rm(temp, { recursive: true, force: true }).catch(() => undefined); }
  }
  async importArchive(base64: string) {
    const archive = Buffer.from(base64, "base64");
    if (!archive.byteLength || archive.byteLength > maxTotalBytes) throw new AppError("SKILL_ARCHIVE_INVALID", "ZIP 文件为空或超过大小限制。", 413, true);
    const temp = await mkdtemp(path.join(process.env.TEMP ?? process.cwd(), "ani-skill-zip-"));
    const archivePath = path.join(temp, "skill.zip"); const extracted = path.join(temp, "files");
    try {
      await writeFile(archivePath, archive);
      const listing = await execFile("tar", ["-tf", archivePath], { timeout: 30_000, windowsHide: true, maxBuffer: 2_000_000 });
      const paths = listing.stdout.split(/\r?\n/).filter(Boolean).map((item) => item.replaceAll("\\", "/"));
      if (paths.some((item) => item.startsWith("/") || /^[a-z]:/i.test(item) || item.split("/").includes(".."))) throw new AppError("SKILL_ARCHIVE_PATH_INVALID", "ZIP 中包含越界路径。", 400, false);
      // 先检查条目类型再解包，避免恶意符号链接在临时目录外写入文件。
      const verbose = await execFile("tar", ["-tvf", archivePath], { timeout: 30_000, windowsHide: true, maxBuffer: 2_000_000 });
      if (verbose.stdout.split(/\r?\n/).some((line) => /^[lLhH]/.test(line.trimStart()))) throw new AppError("SKILL_ARCHIVE_SYMLINK_UNSUPPORTED", "ZIP 中不允许符号链接或硬链接。", 400, false);
      await mkdir(extracted);
      await execFile("tar", ["-xf", archivePath, "-C", extracted], { timeout: 60_000, windowsHide: true, maxBuffer: 2_000_000 });
      const candidates = [extracted, ...((await readdir(extracted, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => path.join(extracted, item.name)))];
      const root = (await Promise.all(candidates.map(async (candidate) => readFile(path.join(candidate, "SKILL.md")).then(() => candidate).catch(() => undefined)))).find(Boolean);
      if (!root) throw new AppError("SKILL_ENTRY_MISSING", "ZIP 根目录或唯一顶层目录中没有 SKILL.md。", 400, false);
      const files = await collectFilesFromDirectory(root);
      const entry = files.find((file) => file.path === "SKILL.md" && file.kind === "text")!;
      const metadata = stripFrontmatter(entry.content ?? "").metadata;
      return this.create({ name: typeof metadata.name === "string" ? metadata.name : "imported-skill", description: typeof metadata.description === "string" ? metadata.description : "从 ZIP 导入的创作 Skill", files, compatibleAgents: ["novel-agent"], taskTypes: [], requiresSandbox: files.some((file) => file.path.startsWith("scripts/")) }, "imported");
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError("SKILL_ARCHIVE_IMPORT_FAILED", "ZIP Skill 导入失败，请检查压缩包结构。", 400, true);
    } finally { await rm(temp, { recursive: true, force: true }).catch(() => undefined); }
  }
  async derive(id: string) {
    const source = await this.get(id, false);
    const used = new Set((await this.list()).map((item) => item.name));
    const base = (source.record.name + "-custom").slice(0, 64); let name = base; let suffix = 2;
    while (used.has(name)) { const tail = "-" + suffix++; name = base.slice(0, 64 - tail.length) + tail; }
    const files = await Promise.all(source.version.files.map(async (file) => {
      if (file.path !== "SKILL.md" || file.kind !== "text") return file;
      const content = (file.content ?? "").replace(/^name:\s*.*$/m, "name: " + name);
      return { ...file, content, size: Buffer.byteLength(content), sha256: sha256(content) };
    }));
    return this.create({ name, description: source.record.description, files, compatibleAgents: source.record.compatibleAgents, taskTypes: source.record.taskTypes, requiresSandbox: source.record.requiresSandbox, changeMessage: "派生自 " + source.record.name }, "derived", { skillId: id, versionId: source.version.id });
  }
  async saveDraft(id: string, input: SkillDraftInput) {
    await this.ensureSeeded();
    const current = await this.get(id, true);
    if (current.record.official) throw new AppError("OFFICIAL_SKILL_READONLY", "官方 Skill 不能直接编辑，请先派生。", 403, false);
    if (input.expectedVersionId && input.expectedVersionId !== current.version.id) throw new AppError("SKILL_STALE", "Skill 已被其他操作更新，请重新读取。", 409, true, undefined, "reread");
    let name: string;
    try { name = assertSkillName(input.name); }
    catch { throw new AppError("SKILL_NAME_INVALID", "Skill 名称只能使用小写字母、数字和短横线。", 400, false); }
    if ((await this.list()).some((item) => item.id !== id && item.name === name)) throw new AppError("SKILL_NAME_DUPLICATE", "Skill 名称已被其他 Skill 使用，请换一个名称。", 409, true);
    const files = normalizeFiles(input.files);
    await putBlobs(files);
    const data = snapshot({ id, files, name, description: input.description.trim(), source: current.record.source, official: false, compatibleAgents: input.compatibleAgents, taskTypes: input.taskTypes, requiresSandbox: input.requiresSandbox || files.some((file) => file.path.startsWith("scripts/")), derivedFrom: current.record.derivedFrom });
    await skills.createVersion({ id: randomUUID(), skillId: id, versionNumber: current.version.versionNumber + 1, ...data, changedFields: ["files", "instructions", "metadata"], changeMessage: input.changeMessage ?? "编辑草稿" } as any);
    await skills.update({ id, status: "draft" });
    return this.get(id, true);
  }
  async validate(id: string): Promise<SkillValidationResult> {
    const { record, version } = await this.get(id, true);
    const errors: SkillValidationResult["errors"] = [], warnings: SkillValidationResult["warnings"] = [];
    const entry = version.files.find((file) => file.path === "SKILL.md");
    if (!entry || entry.kind !== "text") errors.push({ path: "SKILL.md", code: "SKILL_ENTRY_MISSING", message: "必须存在文本格式的 SKILL.md。" });
    else {
      try {
        const metadata = stripFrontmatter(entry.content ?? "").metadata;
        if (typeof metadata.name !== "string" || !metadata.name.trim()) errors.push({ path: "SKILL.md", code: "NAME_MISSING", message: "frontmatter 必须包含 name。" });
        else {
          try { assertSkillName(metadata.name); }
          catch { errors.push({ path: "SKILL.md", code: "NAME_INVALID", message: "frontmatter name 只能使用小写字母、数字和短横线。" }); }
          if (metadata.name !== record.name) errors.push({ path: "SKILL.md", code: "NAME_MISMATCH", message: "frontmatter name 必须与 Skill 名称一致。" });
        }
        if (typeof metadata.description !== "string" || !metadata.description.trim()) errors.push({ path: "SKILL.md", code: "DESCRIPTION_MISSING", message: "frontmatter 必须包含 description。" });
      } catch (error) { errors.push({ path: "SKILL.md", code: "FRONTMATTER_INVALID", message: error instanceof Error ? error.message : "frontmatter 无法解析。" }); }
    }
    const capabilities = { hasReferences: version.files.some((file) => file.path.startsWith("references/")), hasScripts: version.files.some((file) => file.path.startsWith("scripts/")), hasAssets: version.files.some((file) => file.path.startsWith("assets/")), requiresSandbox: record.requiresSandbox || version.files.some((file) => file.path.startsWith("scripts/")) };
    if ((await this.list()).some((item) => item.id !== id && item.name === record.name)) errors.push({ code: "SKILL_NAME_DUPLICATE", message: "Skill 名称已被其他版本使用，请换一个名称。" });
    if (capabilities.requiresSandbox && !this.sandboxCapabilities().configured) warnings.push({ code: "SANDBOX_UNAVAILABLE", message: "当前环境未配置隔离 Sandbox，脚本不能试运行。" });
    return skillValidationResultSchema.parse({ valid: errors.length === 0, errors, warnings, capabilities });
  }
  async publish(id: string, expectedVersionId?: string) {
    const current = await this.get(id, true);
    if (current.record.official) throw new AppError("OFFICIAL_SKILL_READONLY", "官方 Skill 不能直接发布修改。", 403, false);
    if (expectedVersionId && expectedVersionId !== current.version.id) throw new AppError("SKILL_STALE", "Skill 已被其他操作更新，请重新读取。", 409, true, undefined, "reread");
    const result = await this.validate(id);
    if (!result.valid) throw new AppError("SKILL_INVALID", "Skill 校验未通过，请先修复错误。", 400, true, Object.fromEntries(result.errors.map((item) => [item.path ?? item.code, [item.message]])));
    const raw = await skills.getVersion(current.version.id);
    if (!raw) throw new AppError("SKILL_VERSION_NOT_FOUND", "没有找到待发布版本。", 409, true);
    const metadata = { ...(raw.metadata ?? {}), app: { ...(raw.metadata?.app ?? {}), published: true } };
    const publishedId = randomUUID();
    await skills.createVersion({ ...raw, id: publishedId, versionNumber: raw.versionNumber + 1, metadata, changedFields: ["published"], changeMessage: "发布 Skill 版本" } as any);
    await skills.update({ id, activeVersionId: publishedId, status: "published" });
    return this.get(id, false);
  }
  async rollback(id: string, versionId: string) {
    const current = await this.get(id, true);
    if (current.record.official) throw new AppError("OFFICIAL_SKILL_READONLY", "官方 Skill 不能回滚。", 403, false);
    const version = await skills.getVersion(versionId);
    const rawRecord = await skills.getById(id);
    if (!version || version.skillId !== id || !rawRecord || !isPublishedVersion(rawRecord, version)) throw new AppError("SKILL_VERSION_NOT_PUBLISHED", "只能回滚到已经发布过的 Skill 版本。", 409, true);
    await skills.update({ id, activeVersionId: versionId, status: "published" });
    return this.get(id, false);
  }
  async archive(id: string) {
    const current = await this.get(id, true);
    if (current.record.official) throw new AppError("OFFICIAL_SKILL_READONLY", "官方 Skill 不能归档。", 403, false);
    await skills.update({ id, status: "archived" });
    return this.get(id, true);
  }
  async bindings(novelId: string): Promise<SkillBindings> {
    await this.ensureSeeded();
    const state = await repository.get(novelId);
    const fileRecord = state.files["workspace/skill-bindings.yaml"];
    if (!fileRecord) {
      const defaults = skillBindingsSchema.parse({ version: 1, skills: builtinIds.map((skillId) => ({ skillId, enabled: true, version: "latest", agents: ["novel-agent", "novel-critic"], tasks: [] })) });
      const content = makeYaml(defaults);
      const changes = [{ operation: "create" as const, path: "workspace/skill-bindings.yaml", content }];
      const proposal = await repository.prepareProposal(novelId, { intent: "初始化 Skill 绑定", summary: "启用官方小说创作 Skill", changes });
      const applied = await repository.applyProposal(proposal, true);
      await repository.saveAuthorFile(novelId, "workspace/skill-bindings.yaml", content, applied.state.files["workspace/skill-bindings.yaml"]!.sha256);
      return defaults;
    }
    try { return skillBindingsSchema.parse(parse((await repository.readProjectFile(novelId, "workspace/skill-bindings.yaml", 0, 100_000)).content)); }
    catch { throw new AppError("SKILL_BINDINGS_INVALID", "作品的 Skill 绑定文件无法解析，请修复后再继续。", 409, true, undefined, "reread"); }
  }
  async saveBindings(novelId: string, bindings: SkillBindings, expectedSha256: string) {
    const parsed = skillBindingsSchema.parse(bindings);
    for (const binding of parsed.skills) {
      if (!binding.enabled) continue;
      const skill = await skills.getById(binding.skillId);
      if (!skill || skill.status === "archived") throw new AppError("SKILL_NOT_FOUND", "没有找到可用 Skill：" + binding.skillId + "。", 404, true);
      const record = await skills.getById(binding.skillId);
      if (!record || record.status !== "published") throw new AppError("SKILL_VERSION_NOT_PUBLISHED", "只能绑定已发布的 Skill 版本：" + binding.skillId + "。", 409, true);
      const version = binding.version === "latest" ? await skills.getVersion(record.activeVersionId ?? "") : await skills.getVersion(binding.version);
      if (!version || version.skillId !== binding.skillId || !isPublishedVersion(record, version)) throw new AppError("SKILL_VERSION_NOT_PUBLISHED", "只能绑定已发布的 Skill 版本：" + binding.skillId + "。", 409, true);
    }
    return repository.saveAuthorFile(novelId, "workspace/skill-bindings.yaml", makeYaml(parsed), expectedSha256);
  }
  async resolveForAgent(novelId: string, agentId: string, taskType?: string) {
    const bindings = await this.bindings(novelId);
    const resolved: Array<{ skillId: string; versionId: string; name: string; description: string }> = [];
    for (const binding of bindings.skills.filter((item) => item.enabled && (!item.agents.length || item.agents.includes(agentId)) && (!taskType || !item.tasks.length || item.tasks.includes(taskType)))) {
      const record = await skills.getById(binding.skillId); if (!record || record.status !== "published") continue;
      const version = binding.version === "latest" ? await skills.getVersion(record.activeVersionId ?? "") : await skills.getVersion(binding.version);
      if (version && version.skillId === binding.skillId && isPublishedVersion(record, version)) resolved.push({ skillId: binding.skillId, versionId: version.id, name: version.name, description: version.description });
    }
    return resolved;
  }
  async workspaceEntries(novelId: string, agentId: string, taskType?: string) {
    const resolved = await this.resolveForAgent(novelId, agentId, taskType);
    const entries = await Promise.all(resolved.map(async (item) => {
      const version = await skills.getVersion(item.versionId);
      return version?.tree ? { dirName: item.skillId, tree: version.tree, versionCreatedAt: version.createdAt } : undefined;
    }));
    return entries.filter((item): item is NonNullable<typeof item> => Boolean(item));
  }
  sandboxCapabilities(): SkillSandboxCapabilities {
    const configured = process.env.ANI_SKILL_SANDBOX_PROVIDER === "remote";
    return skillSandboxCapabilitiesSchema.parse(configured
      ? { configured: true, provider: "remote", isolated: true, network: "disabled", approvalRequired: true }
      : { configured: false, isolated: false, network: "disabled", approvalRequired: true, reason: "当前 Windows 环境未配置隔离 Sandbox。" });
  }
}

export const skillRegistry = new SkillRegistryService();
