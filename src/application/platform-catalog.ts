import { agentProfileSchema, projectRecipeSchema, skillDefinitionSchema, toolCapabilitySchema, type AgentProfile, type ProjectRecipe, type SkillDefinition, type ToolCapability } from "../shared/contracts";

export const builtinTools: ToolCapability[] = [
  ["get_novel_status", "读取作品状态", "读取阶段、下一步和作者保护状态。", "read", "none", [], "作品状态"],
  ["list_novel_artifacts", "列出作品工件", "读取工件状态、版本、依赖和哈希。", "read", "none", [], "工件列表"],
  ["read_novel_artifact", "读取权威工件", "分段读取已提交的 Markdown/YAML。", "read", "none", ["artifactKey"], "工件内容与元数据"],
  ["search_novel_artifacts", "搜索作品工件", "在已提交工件中定位相关内容。", "read", "none", ["query"], "有界匹配片段"],
  ["get_chapter_context", "读取章节上下文", "组合书级资产、章节计划和上一章承接。", "read", "none", ["chapter"], "章节上下文来源"],
  ["inspect_continuity", "检查连续性", "读取人物、规则、关系和伏笔的连续性资料。", "read", "none", [], "连续性摘要"],
  ["list_workflow_capabilities", "读取生产能力", "读取可启动的 Mastra Workflow。", "workflow", "none", [], "Workflow 能力目录"],
  ["prepare_opening_preset", "整理开书预设", "根据真实对话生成可编辑、待作者确认的开书预设。", "workflow", "author", [], "开书预设提案"],
  ["start_current_next_action", "启动当前步骤", "只在作者明确确认后启动服务端判定的唯一合法 Workflow。", "workflow", "author", [], "运行标识与状态"],
  ["read_workspace_file", "读取工作文件", "读取非权威 workspace 文件。", "read", "none", ["path"], "文件内容与哈希"],
  ["write_workspace_file", "写入工作文件", "创建或更新非权威工作文件。", "write_workspace", "author", ["path", "content", "expectedSha256"], "文件路径与新哈希"],
  ["present_chat_choices", "提供快捷选择", "把有限选项作为真实消息部件呈现。", "present", "none", ["choices"], "可点击选项"],
].map(([id, name, description, kind, approval, inputContract, outputContract]) => toolCapabilitySchema.parse({ id, name, description, kind, approval, inputContract, outputContract }));

export const builtinSkills: SkillDefinition[] = [
  skillDefinitionSchema.parse({ id: "novel.discovery.seeds", version: "1", name: "开书种子", description: "从空白状态生成五条差异明显的一句话开书种子。", scope: "book", purpose: "discovery", inputContract: ["作者当前输入"], outputContract: "五条可比较种子", contextBudget: 8_000, allowedTools: ["present_chat_choices"], stopConditions: ["种子未形成实质差异"], prompt: "优先给出五条一句话种子，分别覆盖钩子、成长、设定、关系和悬念。", source: "builtin" }),
  skillDefinitionSchema.parse({ id: "novel.serial.hook", version: "1", name: "连载钩子", description: "检查章节目标、读者回报和章末牵引。", scope: "chapter", purpose: "review", inputContract: ["章节合同", "稳定正文"], outputContract: "结构化钩子审查", contextBudget: 16_000, allowedTools: ["read_novel_artifact"], stopConditions: ["章末没有有效拉力"], prompt: "检查本章是否产生可见变化，并在章末留下新的问题、选择、威胁或揭示。", source: "builtin" }),
  skillDefinitionSchema.parse({ id: "novel.continuity.asset-ledger", version: "1", name: "资产连续性", description: "维护人物、规则、关系、资源和伏笔的可追踪资产。", scope: "book", purpose: "continuity", inputContract: ["章节正文", "历史连续性"], outputContract: "带来源的资产变化", contextBudget: 20_000, allowedTools: ["inspect_continuity", "read_novel_artifact"], stopConditions: ["来源不明确"], prompt: "只记录正文已经发生的事实，给每条变化绑定章节和来源资产。", source: "builtin" }),
];

export const builtinAgentProfiles: AgentProfile[] = [
  agentProfileSchema.parse({ id: "novel.creator", version: "1", name: "小说创作助手", purpose: "discovery", skillIds: ["novel.discovery.seeds", "novel.continuity.asset-ledger"], toolIds: ["present_chat_choices", "read_workspace_file", "write_workspace_file"], modelProfile: "chat" }),
  agentProfileSchema.parse({ id: "novel.chapter-reviewer", version: "1", name: "章节审查助手", purpose: "review", skillIds: ["novel.serial.hook", "novel.continuity.asset-ledger"], toolIds: ["read_novel_artifact", "inspect_continuity"], modelProfile: "review" }),
];

export const defaultProjectRecipe = (approvalMode: ProjectRecipe["approvalMode"] = "milestone_approval"): ProjectRecipe => projectRecipeSchema.parse({ version: "1", activeSkillIds: builtinSkills.map((skill) => skill.id), activeAgentProfileIds: ["novel.creator", "novel.chapter-reviewer"], approvalMode, chapterBatchSize: 5, settings: {} });

export function resolvePlatformCatalog(recipe: ProjectRecipe) {
  const skillIds = new Set(recipe.activeSkillIds);
  const profileIds = new Set(recipe.activeAgentProfileIds);
  return {
    skills: builtinSkills.filter((skill) => skillIds.has(skill.id) && skill.enabled),
    agents: builtinAgentProfiles.filter((profile) => profileIds.has(profile.id) && profile.enabled),
  };
}
