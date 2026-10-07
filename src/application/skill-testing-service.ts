import { AppError } from "./errors";
import type { WorkbenchDependencies } from "./workbench-dependencies";

export function createSkillTestingService(deps: Pick<WorkbenchDependencies, "skills" | "interactive">) {
  async function testSkillDraft(skillId: string, prompt: string) {
    const { record, version } = await deps.skills.get(skillId, true);
    const readableFiles = version.files.filter((file: any) => file.kind === "text" && (file.path === "SKILL.md" || file.path.startsWith("references/")));
    if (!readableFiles.some((file: any) => file.path === "SKILL.md" && file.content)) throw new AppError("SKILL_ENTRY_MISSING", "Skill 没有可测试的 SKILL.md。", 400, true);
    const resourceContext = readableFiles.map((file: any) => `\n\n--- ${file.path} ---\n${file.content ?? ""}`).join("").slice(0, 120_000);
    const result = await deps.interactive.testSkill(`${resourceContext}\n\n测试任务：\n${prompt}\n\n这是隔离试运行，不读取或修改任何真实作品，只展示这个 Skill 会如何处理任务。不得调用工具、写入文件或提交提案。`);
    return {
      skillId,
      versionId: version.id,
      output: result.output,
      elapsedMs: result.elapsedMs,
      usedFiles: readableFiles.map((file: any) => file.path),
      scriptExecution: record.requiresSandbox ? "disabled" as const : "not_required" as const,
      traceId: result.traceId,
    };
  }
  return { testSkillDraft };
}
