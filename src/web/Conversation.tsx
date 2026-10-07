import { RequestContext } from "@mastra/core/request-context";
import type { MastraDBMessage } from "@mastra/core/agent";
import { useChat } from "@mastra/react";
import { useQuery } from "@tanstack/react-query";
import { CircleAlert, LoaderCircle, Send, Square } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PatchProposal, ProductionJob } from "../shared/contracts";
import { api } from "./api";
import { autonomousOpeningRecoveryGoal } from "./market-quick-start";
import { errorText, hasRenderableMessage, messageForDisplay, messageText, patchProposalFromMessage, recoveryPrompt, StudioMessage, type AgentActivity, type MessageAction } from "./studio/MessageParts";

const initialTastes = [
  ["升级爽感", "我现在没有完整想法，但更想看主角持续升级、不断突破困局的故事。"],
  ["赚钱经营", "我现在没有完整想法，但更喜欢经营、赚钱、建设和积累成果的故事。"],
  ["智斗破局", "我现在没有完整想法，但更喜欢主角依靠信息、专业能力和判断破局。"],
  ["关系拉扯", "我现在没有完整想法，但更想看两个强势人物持续合作、对抗并改变关系。"],
  ["悬疑闯关", "我现在没有完整想法，但更喜欢规则、案件、谜团和逐步揭晓真相。"],
  ["给我惊喜", "我完全没有想法，也没有明确偏好。请大胆推荐三个差异明显、能够长期连载的方向。"],
] as const;

export function mergeConversationMessages(initial: MastraDBMessage[], live: MastraDBMessage[]) {
  const merged = new Map(initial.map((message) => [message.id, message]));
  for (const message of live) merged.set(message.id, message);
  return [...merged.values()];
}

export function Conversation({ novelId, initialMessages, initialDraft = "", command, onCommandConsumed, centered = false, autonomousOpening = false, job, externalActivity, appliedProposalIds = [], onProposal, onChange }: { novelId: string; initialMessages: MastraDBMessage[]; initialDraft?: string; command?: { id: number; text: string; activity: AgentActivity; autoStart?: boolean }; onCommandConsumed?: () => void; centered?: boolean; autonomousOpening?: boolean; job?: ProductionJob; externalActivity?: AgentActivity; appliedProposalIds?: string[]; onProposal: (proposal?: PatchProposal) => void; onChange: () => void | Promise<void> }) {
  const [value, setValue] = useState(""); const [error, setError] = useState(""); const [activity, setActivity] = useState<AgentActivity>(); const list = useRef<HTMLDivElement>(null); const handledCommand = useRef(0); const lastGoal = useRef("");
  const market = useQuery({ queryKey: ["market-radar", ""], queryFn: () => api.marketRadar(), enabled: centered });
  const context = useMemo(() => new RequestContext<any>([["novelId", novelId], ["taskType", "chat"], ["modelProfile", "chat"]]), [novelId]);
  const { messages, isRunning, sendMessage, cancelRun } = useChat({ agentId: "novel-agent", resourceId: novelId, threadId: novelId, initialMessages, requestContext: context, enableThreadSignals: true });
  useEffect(() => { if (initialDraft) setValue((current) => current || initialDraft); }, [initialDraft]);
  const allMessages = useMemo(() => mergeConversationMessages(initialMessages, messages), [initialMessages, messages]);
  const visible = useMemo(() => allMessages.filter(hasRenderableMessage).map(messageForDisplay), [allMessages]);
  const latestAssistantId = [...visible].reverse().find((message) => message.role === "assistant")?.id;
  const send = useCallback(async (raw: string, nextActivity: AgentActivity = { title: "正在处理你的消息", detail: "Agent 正在读取作品上下文并决定下一步；模型服务瞬时失败时会自动重试三次。" }, rememberGoal = true) => { const message = raw.trim(); if (!message || isRunning) return false; if (rememberGoal) lastGoal.current = message; setError(""); setValue(""); setActivity(nextActivity); try { await sendMessage({ message, threadId: novelId, requestContext: context }); } catch (reason) { setError(errorText(reason instanceof Error ? reason.message : reason)); return false; } try { await onChange(); } catch { /* The command was sent; normal query recovery can refresh the view. */ } return true; }, [context, isRunning, novelId, onChange, sendMessage]);
  const retry = useCallback(async () => { const previousUserGoal = [...visible].reverse().find((message) => message.role === "user"); const sent = await send(recoveryPrompt(lastGoal.current || (previousUserGoal ? messageText(previousUserGoal) : "")), { title: "正在重试本次操作", detail: "重新读取当前作品状态 → 跳过已完成工具调用 → 继续尚未完成的目标；瞬时故障最多自动重试三次。" }, false); if (sent && autonomousOpening) onCommandConsumed?.(); }, [autonomousOpening, onCommandConsumed, send, visible]);
  const stop = useCallback(async () => { cancelRun(); if (!autonomousOpening) return; try { await api.autoOpeningAction(novelId, "cancel"); onCommandConsumed?.(); await onChange(); } catch (reason) { setError(errorText(reason instanceof Error ? reason.message : reason)); } }, [autonomousOpening, cancelRun, novelId, onChange, onCommandConsumed]);
  const chooseInitialTaste = useCallback(async (label: string, message: string) => { try { const remembered = api.recordPreference(novelId, { kind: "choice", value: label, scope: label === "给我惊喜" ? "novel" : "global", messageId: `initial-taste:${label}` }); await send(message, { title: "正在匹配创作方向", detail: `已选择“${label}”，Agent 正在结合偏好生成三个开书种子。` }); await remembered; } catch { setError("方向已经提交，但偏好没有保存；你可以稍后再试。"); } }, [novelId, send]);
  const handleMessageAction = useCallback(async (messageId: string, action: MessageAction) => {
    const remembered = api.recordPreference(novelId, { ...action, messageId, scope: "novel" });
    if (action.kind === "choice") await send(`我选择${action.value}。请沿这个选项继续，并结合已经记录的偏好推进。`, { title: "正在沿选中方向继续", detail: `${action.value} → 读取已有偏好 → 给出下一步方案。` });
    await remembered;
  }, [novelId, send]);
  const resumeAutonomousOpening = useCallback(async () => { const sent = await send(recoveryPrompt(command?.text ?? autonomousOpeningRecoveryGoal), { title: "正在继续全自动开书", detail: "重新读取权威状态 → 跳过已完成资产与任务 → 从最近稳定进度继续到第 3 章。" }, false); if (sent) onCommandConsumed?.(); }, [command, onCommandConsumed, send]);
  useEffect(() => { if (!command || command.autoStart === false || command.id === handledCommand.current || isRunning) return; handledCommand.current = command.id; void send(command.text, command.activity).then((sent) => { if (sent) onCommandConsumed?.(); }); }, [command, isRunning, onCommandConsumed, send]);
  useEffect(() => { const proposal = [...allMessages].reverse().map(patchProposalFromMessage).find((item) => item && !appliedProposalIds.includes(item.id)); onProposal(proposal); }, [allMessages, appliedProposalIds, onProposal]);
  useEffect(() => {
    if (!isRunning) return;
    void onChange();
    const timer = window.setInterval(() => void onChange(), 1_500);
    return () => window.clearInterval(timer);
  }, [isRunning, onChange]);
  useEffect(() => { if (list.current) list.current.scrollTop = list.current.scrollHeight; }, [allMessages, isRunning]);
  const chapterProgress = job?.goal === "write_chapters" && job.cursor ? `正在处理第 ${job.cursor} 章 / 目标至第 ${job.scope.toChapter ?? "?"} 章。` : undefined;
  const modelRetryProgress = job?.modelRetry ? `${job.modelRetry.label}：模型服务暂时不可用，正在第 ${job.modelRetry.attempt}/${job.modelRetry.maxRetries} 次自动重试…` : undefined;
  const jobActivity: AgentActivity | undefined = job && ["queued", "running", "awaiting_author", "failed"].includes(job.status) ? job.status === "failed"
    ? { title: "章节生产未完成", detail: job.error?.message ?? "任务已经停止，可以修正问题后重新开始。" }
    : job.status === "awaiting_author"
    ? job.checkpoint === "curve_confirmation" ? { title: "等待确认本卷张力曲线", detail: "卷计划与逐章目标已经生成。你可以在左侧拖动曲线并保存，确认后才开始写正文。" } : { title: "章节生产已暂停", detail: `第 ${job.cursor ?? job.scope.fromChapter ?? "当前"} 章需要你的判断。处理下方提示后会从当前进度继续。` }
    : { title: job.goal === "write_chapters" ? "正在连续生成章节" : job.goal === "review_project" ? "正在审查作品" : job.goal === "export" ? "正在导出作品" : "正在处理文件修订", detail: modelRetryProgress ?? (job.goal === "write_chapters" ? `${chapterProgress ?? `目标：第 ${job.scope.fromChapter ?? "?"}–${job.scope.toChapter ?? "?"} 章。`} 规划、写作和审查会依次完成，你可以留在当前页面。` : job.goal === "review_project" ? job.brief ?? "Critic 正在按你的目标读取证据并生成审查报告。" : "任务仍在后台运行，完成后文件列表会自动更新。") }
    : undefined;
  const currentActivity = externalActivity ?? jobActivity ?? (isRunning ? activity : undefined);
  const activityRunning = isRunning || Boolean(externalActivity) || job?.status === "running" || job?.status === "queued";
  const commandPending = Boolean(command?.autoStart !== false && command && command.id !== handledCommand.current);
  const dynamicTastes = market.data?.summaryCurrent ? market.data.summary?.feelCards ?? [] : [];
  return <section className={`conversation ${centered ? "centered" : ""}`}><header><div><small>ANI AGENT</small><strong>{autonomousOpening ? "全自动开书" : "创作搭档"}</strong></div>{currentActivity && <span><LoaderCircle className={activityRunning ? "spin" : ""} size={14} />{job?.status === "awaiting_author" && !isRunning && !externalActivity ? "等待你处理" : job?.status === "failed" && !externalActivity ? "未完成" : "进行中"}</span>}</header><div className="message-list" ref={list}>{visible.map((message) => <article className={`message ${message.role}`} key={message.id}><StudioMessage message={message} onRetry={message.role === "assistant" && message.id === latestAssistantId && !isRunning ? retry : undefined} retrying={isRunning} onAction={message.role === "assistant" && message.id === latestAssistantId && !isRunning && !autonomousOpening ? (action) => handleMessageAction(message.id, action) : undefined} /></article>)}{currentActivity && <div className="agent-activity" role="status" aria-live="polite"><LoaderCircle className={activityRunning ? "spin" : ""} /><div><strong>{currentActivity.title}</strong><span>{currentActivity.detail}</span></div></div>}{!visible.length && !currentActivity && !autonomousOpening && <div className="conversation-empty"><h2>你更想看哪种感觉？</h2><p>凭直觉选一个就行，选项会立即提交，不需要等待 Agent 先生成卡片。</p><div className="initial-taste-grid">{initialTastes.map(([label, message]) => <button key={label} onClick={() => void chooseInitialTaste(label, message)}>{label}</button>)}{dynamicTastes.map((card) => <button key={card.id} className="dynamic-taste" title={card.reason} onClick={() => void chooseInitialTaste(card.label, card.prompt)}>{card.label}</button>)}</div>{dynamicTastes.length > 0 && <small className="dynamic-taste-note">以下卡片来自你已查看的最新公开榜单 AI 题材总结，点击后才会记录偏好。</small>}</div>}{!visible.length && !currentActivity && autonomousOpening && <div className="conversation-empty autonomous"><LoaderCircle className={isRunning ? "spin" : ""} /><h2>{isRunning ? "正在准备全自动开书" : "全自动开书尚未进入章节任务"}</h2><p>{isRunning ? "将自动选择原创方向、创建完整开书资产并完成前三章，中途无需确认。" : "可以从当前权威状态继续；不会在后台无限重试。"}</p></div>}</div>{visible.length > 0 && centered && !autonomousOpening && <button className="finish-discovery" disabled={isRunning} onClick={() => void send("我说完了，请在对话中整理两份差异明显、可以直接开写的作品蓝图，我会用自然语言选择或调整。", { title: "正在生成两份作品蓝图", detail: "读取已有构思 → 在对话中给出两个完整方案 → 等待你的自然语言回复；现在不会自动开写。" })}>生成两份蓝图</button>}{autonomousOpening && !job && !commandPending && <div className="composer-error"><span><CircleAlert size={15} />全自动开书尚未进入章节任务，可从当前状态继续或停止。</span><button disabled={isRunning} onClick={() => void resumeAutonomousOpening()}><LoaderCircle className={isRunning ? "spin" : ""} />继续全自动开书</button><button onClick={() => void stop()}>停止</button></div>}{error && <div className="composer-error"><span><CircleAlert size={15} />{error}</span><button disabled={isRunning} onClick={() => void retry()}>重试本次操作</button></div>}<div className="composer"><textarea value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(value); } }} placeholder={autonomousOpening ? "全自动开书进行中，也可以补充要求……" : "描述想法，或让 Agent 继续……"} rows={2} /><button aria-label={isRunning ? autonomousOpening ? "停止全自动开书" : "停止" : "发送"} onClick={isRunning ? () => void stop() : () => void send(value)}>{isRunning ? <Square /> : <Send />}</button></div></section>;
}
