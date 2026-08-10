import type { NovelState } from "../../domain";
import { promptVersion, type NovelBrief } from "../../shared/contracts";

export interface BriefPromptInput {
  state: Pick<NovelState, "title" | "openingChoices">;
  feedback?: string;
  priorProposal?: NovelBrief;
}

export function renderNovelBriefPrompt(input: BriefPromptInput): string {
  const choices = input.state.openingChoices;
  return `Prompt 合同：${promptVersion}\n` +
    `任务：为一部中文长篇网文生成可供作者审批的小说简报。\n` +
    `暂定书名：${input.state.title}\n` +
    `读者频道：${choices?.channel ?? "未填写"}\n` +
    `发布形态：${choices?.format ?? "未填写"}\n` +
    `主要阅读回报：${choices?.primaryReward ?? "未填写"}\n` +
    `故事方向：${choices?.storyDirection ?? "未填写"}\n` +
    `类型定位：${choices?.genre ?? "未填写"}\n` +
    `整体气质：${choices?.tone ?? "未填写"}\n` +
    `执行要求：\n` +
    `1. 优先服从作者已确认的故事方向、类型、气质和主要回报；不要另起炉灶。\n` +
    `2. 所有字段必须互相支持：主角欲望能撞上核心冲突，故事发动机能重复升级，开篇钩子能在前三章产生第一次明确兑现，长线承诺能支撑中期扩展。\n` +
    `3. 使用具体的人、行动、阻力、代价和阶段回报，避免“命运齿轮、巨大阴谋、不断成长、揭开真相”等空泛占位表达。\n` +
    `4. risks 输出 2-5 条，每条指出具体失败模式及要守住的边界。\n` +
    `5. 只返回调用方 Schema，不输出解释、Markdown 或隐藏推理。\n` +
    (input.priorProposal ? `上一版提案：${JSON.stringify(input.priorProposal)}\n` : "") +
    (input.feedback ? `作者调整意见：${input.feedback}\n` : "");
}
