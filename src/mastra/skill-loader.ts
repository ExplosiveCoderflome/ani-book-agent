import { readFile } from "node:fs/promises";
import path from "node:path";
import { AppError } from "../application/errors";
import { skillRegistry } from "../application/skill-service";

export const skillIds = ["discovery", "blueprint", "volume-planning", "chapter-writing", "critique", "project-review"] as const;
export type SkillId = typeof skillIds[number];

const root = () => path.resolve(process.env.INIT_CWD ?? process.cwd(), "src", "mastra");
export async function loadCorePrompt() { return stripFrontmatter(await readFile(path.join(root(), "prompts", "core.md"), "utf8")); }
export async function readSkill(id: string, versionId?: string) {
  const version = await skillRegistry.version(id, versionId).catch(() => { throw new AppError("SKILL_NOT_FOUND", "没有找到这个创作方法。", 404, true, undefined, "reread"); });
  const entry = version.files.find((file) => file.path === "SKILL.md" && file.kind === "text");
  if (!entry?.content) throw new AppError("SKILL_NOT_FOUND", "这个创作方法没有可读取的 SKILL.md。", 404, true, undefined, "reread");
  return stripFrontmatter(entry.content);
}
function stripFrontmatter(content: string) {
  if (!content.startsWith("---\n")) return content.trim();
  const end = content.indexOf("\n---\n", 4);
  return (end >= 0 ? content.slice(end + 5) : content).trim();
}
