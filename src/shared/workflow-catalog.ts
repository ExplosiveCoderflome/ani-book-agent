import type { WorkflowId } from "../domain";

export type WorkflowApproval = "milestone" | "automatic" | "conditional";

export interface WorkflowDescriptor {
  name: string;
  description: string;
  target: string;
  approval: WorkflowApproval;
  stages: readonly string[];
}

export const workflowCatalog = {
  "novel-brief": {
    name: "小说简报",
    description: "把开书选择收束为读者定位、主角、核心冲突、故事引擎与长线承诺；结构化生成后按里程碑审批并原子提交。",
    target: "当前作品",
    approval: "milestone",
    stages: ["生成结构化提案", "等待作者审阅", "原子提交简报"],
  },
  "story-bible": {
    name: "故事圣经",
    description: "把小说简报扩展为长期对立、成长阶梯、揭示顺序、回报节奏与结局方向，形成全书后续规划的稳定约束。",
    target: "当前作品",
    approval: "milestone",
    stages: ["生成故事圣经", "等待作者审阅", "提交权威工件"],
  },
  "world-bible": {
    name: "世界圣经",
    description: "建立会真实限制角色选择和剧情代价的世界规则、势力、资源、信息边界与主要舞台。",
    target: "当前作品",
    approval: "automatic",
    stages: ["生成世界约束", "自动校验", "提交权威工件"],
  },
  "character-cast": {
    name: "角色阵容",
    description: "依据故事职责与世界约束设计可持续碰撞的角色网络、动机、关系、秘密和变化空间。",
    target: "当前作品",
    approval: "automatic",
    stages: ["生成角色网络", "自动校验", "提交权威工件"],
  },
  "volume-strategy": {
    name: "卷战略",
    description: "把全书承诺拆成职责不同、回报递增的分卷路线，明确每卷目标、升级、转折与保留弹性。",
    target: "当前作品",
    approval: "milestone",
    stages: ["生成分卷战略", "等待作者审阅", "提交权威工件"],
  },
  "volume-outline": {
    name: "当前卷骨架",
    description: "把当前卷战略落成可执行的事件骨架与节奏板，为逐章规划提供阶段目标、转折、回报和悬念位置。",
    target: "当前作品",
    approval: "automatic",
    stages: ["生成卷骨架与节奏板", "自动校验", "提交权威工件"],
  },
  "volume-handoff": {
    name: "卷间承接包",
    description: "把已完成卷的稳定变化、未解决冲突、角色状态和下一卷必须承接的事项整理成权威交接资产，避免换卷后丢失主线。",
    target: "已完成卷号",
    approval: "automatic",
    stages: ["读取卷末稳定资产", "生成承接清单", "提交权威工件"],
  },
  "completion-audit": {
    name: "完本验收",
    description: "在最终卷完成后检查稳定章节、质量债、未兑现承诺与连续性异常，只有验收通过才能标记整部小说完本。",
    target: "最终卷",
    approval: "automatic",
    stages: ["汇总完本证据", "结构化验收", "提交验收报告"],
  },
  "chapter-planning": {
    name: "章节计划",
    description: "结合书级工件、当前卷与上一章连续性，生成单章义务、读者回报、关键转折、净变化和结尾钩子合同。",
    target: "章节号",
    approval: "automatic",
    stages: ["装配章节上下文", "生成章节合同", "提交章节计划"],
  },
  "quality-repair": {
    name: "质量修复",
    description: "读取章节合同、稳定正文、审查证据与质量债，提出并提交范围受控的修复方案，避免问题带入后续章节。",
    target: "章节号",
    approval: "automatic",
    stages: ["读取质量债", "生成修复提案", "提交修复工件"],
  },
  "chapter-production": {
    name: "章节正文生产",
    description: "按章节合同串行完成初稿、反模板化修订、结构化审查、有限修复、连续性抽取与原子提交。",
    target: "章节号",
    approval: "conditional",
    stages: ["生成整章初稿", "反模板化二稿", "结构化审查", "有限修复", "连续性回灌", "原子提交"],
  },
  "chapter-range": {
    name: "章节范围生产",
    description: "在作者批准范围内严格按章节号串行执行章节计划与正文生产；前一章稳定提交后才启动下一章。",
    target: "章节范围",
    approval: "conditional",
    stages: ["登记授权范围", "逐章串行生产", "汇总完成范围"],
  },
  "novel-export": {
    name: "TXT 导出",
    description: "只汇总已经稳定提交的章节正文，生成带登记记录和内容哈希的 TXT 导出工件。",
    target: "可选文件名",
    approval: "automatic",
    stages: ["汇总稳定章节", "生成并登记导出文件"],
  },
  "auto-director": {
    name: "自动导演",
    description: "从已确认的开书选择出发，按依赖补齐书级工件并串行推进章节全文生产；在里程碑或结构性风险处暂停，恢复后沿同一条 Mastra 工作流继续。",
    target: "书级目标章节范围",
    approval: "conditional",
    stages: ["检查书级工件", "推进依赖工作流", "串行生产章节", "暂停或完成"],
  },
} as const satisfies Record<WorkflowId, WorkflowDescriptor>;

export const workflowLabels = Object.fromEntries(
  Object.entries(workflowCatalog).map(([id, descriptor]) => [id, descriptor.name]),
) as Record<WorkflowId, string>;
