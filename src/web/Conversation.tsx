import { RequestContext } from "@mastra/core/request-context";
import type { MastraDBMessage } from "@mastra/core/agent";
import { useChat } from "@mastra/react";
import { CircleAlert, LoaderCircle, Send, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PatchProposal, ProductionJob } from "../shared/contracts";
import { errorText, hasRenderableMessage, messageForDisplay, patchProposalFromMessage, StudioMessage, type AgentActivity } from "./studio/MessageParts";

export function mergeConversationMessages(initial: MastraDBMessage[], live: MastraDBMessage[]) {
  const merged = new Map(initial.map((message) => [message.id, message]));
  for (const message of live) merged.set(message.id, message);
  return [...merged.values()];
}

export function Conversation({ novelId, initialMessages, centered = false, job, externalActivity, appliedProposalIds = [], onProposal, onChange }: { novelId: string; initialMessages: MastraDBMessage[]; centered?: boolean; job?: ProductionJob; externalActivity?: AgentActivity; appliedProposalIds?: string[]; onProposal: (proposal?: PatchProposal) => void; onChange: () => void | Promise<void> }) {
  const [value, setValue] = useState(""); const [error, setError] = useState(""); const [activity, setActivity] = useState<AgentActivity>(); const list = useRef<HTMLDivElement>(null);
  const context = useMemo(() => new RequestContext<any>([["novelId", novelId], ["taskType", "chat"], ["modelProfile", "chat"]]), [novelId]);
  const { messages, isRunning, sendMessage, cancelRun } = useChat({ agentId: "novel-agent", resourceId: novelId, threadId: novelId, initialMessages, requestContext: context, enableThreadSignals: true });
  const allMessages = useMemo(() => mergeConversationMessages(initialMessages, messages), [initialMessages, messages]);
  const visible = useMemo(() => allMessages.filter(hasRenderableMessage).map(messageForDisplay), [allMessages]);
  const send = useCallback(async (raw: string, nextActivity: AgentActivity = { title: "正在处理你的消息", detail: "Agent 正在读取作品上下文并决定下一步，完成后会直接在这里回复。" }) => { const message = raw.trim(); if (!message || isRunning) return; setError(""); setValue(""); setActivity(nextActivity); try { await sendMessage({ message, threadId: novelId, requestContext: context }); await onChange(); } catch (reason) { setError(errorText(reason instanceof Error ? reason.message : reason)); } }, [context, isRunning, novelId, onChange, sendMessage]);
  useEffect(() => { const proposal = [...allMessages].reverse().map(patchProposalFromMessage).find((item) => item && !appliedProposalIds.includes(item.id)); onProposal(proposal); }, [allMessages, appliedProposalIds, onProposal]);
  useEffect(() => {
    if (!isRunning) return;
    void onChange();
    const timer = window.setInterval(() => void onChange(), 1_500);
    return () => window.clearInterval(timer);
  }, [isRunning, onChange]);
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; }, [allMessages, isRunning]);
  const jobActivity: AgentActivity | undefined = job && ["queued", "running", "awaiting_author", "failed"].includes(job.status) ? job.status === "failed"
    ? { title: "章节生产未完成", detail: job.error?.message ?? "任务已经停止，可以修正问题后重新开始。" }
    : job.status === "awaiting_author"
    ? { title: "章节生产已暂停", detail: `第 ${job.cursor ?? job.scope.fromChapter ?? "当前"} 章需要你的判断。处理下方提示后会从当前进度继续。` }
    : { title: job.goal === "write_chapters" ? "正在连续生成章节" : job.goal === "review_project" ? "正在审查作品" : job.goal === "export" ? "正在导出作品" : "正在处理文件修订", detail: job.goal === "write_chapters" ? `目标：第 ${job.scope.fromChapter ?? "?"}–${job.scope.toChapter ?? "?"} 章。规划、写作和审查会依次完成，你可以留在当前页面。` : job.goal === "review_project" ? job.brief ?? "Critic 正在按你的目标读取证据并生成审查报告。" : "任务仍在后台运行，完成后文件列表会自动更新。" }
    : undefined;
  const currentActivity = externalActivity ?? jobActivity ?? (isRunning ? activity : undefined);
  const activityRunning = isRunning || Boolean(externalActivity) || job?.status === "running" || job?.status === "queued";
  return <section className={`conversation ${centered ? "centered" : ""}`}><header><div><small>ANI AGENT</small><strong>创作搭档</strong></div>{currentActivity && <span><LoaderCircle className={activityRunning ? "spin" : ""} size={14} />{job?.status === "awaiting_author" && !isRunning && !externalActivity ? "等待你处理" : job?.status === "failed" && !externalActivity ? "未完成" : "进行中"}</span>}</header><div className="message-list" ref={list}>{visible.map((message) => <article className={`message ${message.role}`} key={message.id}><StudioMessage message={message} onChoice={(choice, nextActivity) => void send(choice, nextActivity)} /></article>)}{currentActivity && <div className="agent-activity" role="status" aria-live="polite"><LoaderCircle className={activityRunning ? "spin" : ""} /><div><strong>{currentActivity.title}</strong><span>{currentActivity.detail}</span></div></div>}{!visible.length && !currentActivity && <div className="conversation-empty"><h2>从一个真正想写的念头开始。</h2><p>可以说题材、某种阅读感觉，甚至只说一句“我还没想好”。</p><button onClick={() => void send("我完全没有想法，请给我五个差异明显的开书种子。", { title: "正在寻找创作方向", detail: "Agent 会生成五个差异明显的开书种子，完成后请你选择一个。" })}>帮我找一个方向</button></div>}</div>{visible.length > 0 && centered && <button className="finish-discovery" disabled={isRunning} onClick={() => void send("我说完了，请整理两份差异明显、可以直接开写的作品蓝图。", { title: "正在生成两份作品蓝图", detail: "读取已有构思 → 形成两个差异方案 → 完成后等待你选择；现在不会自动开写。" })}>生成两份蓝图</button>}{error && <div className="composer-error"><CircleAlert size={15} />{error}</div>}<div className="composer"><textarea value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(value); } }} placeholder="描述想法，或让 Agent 继续……" rows={2} /><button aria-label={isRunning ? "停止" : "发送"} onClick={isRunning ? cancelRun : () => void send(value)}>{isRunning ? <Square /> : <Send />}</button></div></section>;
}
