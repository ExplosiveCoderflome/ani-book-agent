import type { MastraDBMessage } from "@mastra/core/agent";

function visibleText(message: MastraDBMessage): string {
  return message.content.parts
    .filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

export function renderOpeningPresetPrompt(title: string, messages: MastraDBMessage[]): string {
  const transcript = messages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role === "user" ? "作者" : "创作搭档"}：${visibleText(message)}`)
    .filter((line) => !line.endsWith("："))
    .join("\n\n");
  return `任务：根据作者与创作搭档的真实讨论，整理一份可编辑、能直接驱动小说简报的开书预设提案。\n` +
    `当前作品名：${title}\n\n` +
    `对话记录：\n${transcript}\n\n` +
    `要求：\n` +
    `1. 忠实收敛作者已经表达、选择或认可的内容；不得把创作搭档提出但作者未接受的选项当成决定。\n` +
    `2. 作者没有明确决定的字段，给出与已知偏好最匹配的单一推荐，不要写“待定”“均可”。\n` +
    `3. workingTitle 要像可用的临时书名，不是策划口号；storyDirection 必须写清“谁、处于什么独特困境、想做什么、主要阻力或代价是什么”。\n` +
    `4. genre 要具体到读者能识别的题材组合；tone 描述持续叙事气质；channel 和 format 必须给出明确值。\n` +
    `5. primaryReward 只锁定最主要的持续阅读回报，不要平均罗列爽点、悬疑、感情、成长等全部方向。\n` +
    `6. rationale 用 2-4 句说明这组预设如何承接作者原话、最关键取舍是什么、为什么适合继续写成长篇。\n` +
    `7. 不要声称已经保存，不要输出 Schema 之外字段。`;
}
