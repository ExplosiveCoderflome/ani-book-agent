import { RequestContext } from "@mastra/core/request-context";
import type { CoreUserMessage } from "@mastra/core/llm";
import type { MastraDBMessage } from "@mastra/core/agent";
import { useChat } from "@mastra/react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, CircleAlert, FileText, LoaderCircle, Paperclip, Send, Square, X } from "lucide-react";
import { StudioMessage, hasRenderableMessage, messageForDisplay, messageText, openingPresetFromMessage, type ToolActions } from "./studio/MessageParts";
import type { OpeningPresetProposal } from "../shared/contracts";

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;
type Attachment = { name: string; mimeType: string; data: string; size: number };

async function readAttachment(file: File): Promise<Attachment> {
  if (file.size > MAX_ATTACHMENT_BYTES) throw new Error(`${file.name} 超过 5 MB，暂时无法发送。`);
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(`无法读取 ${file.name}`));
    reader.readAsDataURL(file);
  });
  return { name: file.name, mimeType: file.type || "application/octet-stream", data: dataUrl.slice(dataUrl.indexOf(",") + 1), size: file.size };
}

export type ConversationRevisionMode = { label: string; onSubmit: (text: string) => Promise<void>; onExit: () => void };

export function Conversation({ novelId, initialMessages, discoveryAction, emptyState, revisionMode, contextLabel, currentArtifactKey, currentFilePath, onConversationChange, onOpeningPresetReady }: {
  novelId: string;
  initialMessages: MastraDBMessage[];
  discoveryAction?: { pending: boolean; error: unknown; onConfirm: () => void };
  emptyState?: (actions: { sendMessage: (text: string) => Promise<void>; isRunning: boolean }) => ReactNode;
  revisionMode?: ConversationRevisionMode;
  contextLabel?: string;
  currentArtifactKey?: string;
  currentFilePath?: string;
  onConversationChange?: () => void | Promise<void>;
  onOpeningPresetReady?: (proposal: OpeningPresetProposal) => void;
}) {
  const [revisionNotice, setRevisionNotice] = useState("");
  const [chatError, setChatError] = useState("");
  const [compatibilityStream, setCompatibilityStream] = useState(false);
  const [showPending, setShowPending] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const followOutputRef = useRef(true);
  const openingPresetMessageRef = useRef("");
  const requestContext = useMemo(() => new RequestContext<any>([
    ["novelId", novelId], ["taskType", revisionMode ? "review" : "chat"], ["modelProfile", revisionMode ? "review" : "chat"],
    ["currentArtifactKey", currentArtifactKey ?? ""], ["currentFilePath", currentFilePath ?? ""], ["novelContext", contextLabel ?? ""],
  ]), [currentArtifactKey, currentFilePath, contextLabel, novelId, revisionMode]);
  const { messages, tasks, isRunning, isAwaitingToolApproval, sendMessage, cancelRun, approveToolCall, declineToolCall, toolCallApprovals } = useChat({
    agentId: "novel-production-agent", resourceId: novelId, threadId: novelId, initialMessages, requestContext,
    enableThreadSignals: true, onThreadSignalsUnsupported: () => setCompatibilityStream(true),
  });
  const running = isRunning || isAwaitingToolApproval;
  const renderableMessages = useMemo(() => messages.filter(hasRenderableMessage).map(messageForDisplay), [messages]);
  const lastHasOutput = renderableMessages.at(-1)?.role === "assistant";

  const sendText = useCallback(async (raw: string, attachments: Attachment[] = []) => {
    const text = raw.trim();
    if ((!text && !attachments.length) || running) return;
    setChatError(""); followOutputRef.current = true;
    try {
      if (revisionMode) { setRevisionNotice(""); await revisionMode.onSubmit(text); setRevisionNotice("修改要求已提交，正在重新生成。"); return; }
      const coreUserMessages: CoreUserMessage[] = attachments.length ? [{ role: "user", content: attachments.map((file) => ({ type: "file" as const, data: file.data, filename: file.name, mimeType: file.mimeType })) }] : [];
      await sendMessage({ message: text, coreUserMessages, threadId: novelId, requestContext });
      await onConversationChange?.();
    } catch (error) { setChatError(error instanceof Error ? error.message : "消息发送失败，请重试。"); }
  }, [novelId, onConversationChange, requestContext, revisionMode, running, sendMessage]);

  useEffect(() => { setRevisionNotice(""); setChatError(""); setCompatibilityStream(false); }, [novelId, revisionMode]);
  useEffect(() => {
    const message = [...messages].reverse().find((item) => openingPresetFromMessage(item));
    const proposal = message && openingPresetFromMessage(message);
    if (!proposal || message.id === openingPresetMessageRef.current) return;
    openingPresetMessageRef.current = message.id;
    onOpeningPresetReady?.(proposal);
  }, [messages, onOpeningPresetReady]);
  useEffect(() => {
    if (!running || lastHasOutput) { setShowPending(false); return; }
    const timer = window.setTimeout(() => setShowPending(true), 280);
    return () => window.clearTimeout(timer);
  }, [lastHasOutput, running]);
  useEffect(() => { if (followOutputRef.current && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight; }, [messages, showPending, tasks]);

  const actions = useMemo<ToolActions>(() => ({
    approve: async (id, resumeData) => { await approveToolCall(id, resumeData); await onConversationChange?.(); },
    decline: async (id) => { await declineToolCall(id); await onConversationChange?.(); },
    approvals: toolCallApprovals,
  }), [approveToolCall, declineToolCall, onConversationChange, toolCallApprovals]);

  return <div className="studio-conversation">
    <div className="studio-conversation-head"><div><span className="eyebrow">{contextLabel ? `当前上下文 · ${contextLabel}` : "创作线程"}</span><strong>Agent</strong></div>{running && <span className="studio-running"><LoaderCircle className="spin" size={14} />{isAwaitingToolApproval ? "等待确认" : "正在运行"}</span>}</div>
    <div className="studio-message-list" ref={listRef} onScroll={(event) => { const element = event.currentTarget; followOutputRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 96; }}>
      {renderableMessages.map((message) => <article className={`studio-message ${message.role}`} key={message.id} data-message-id={message.id}><StudioMessage message={message} actions={actions} onChoice={(choice) => void sendText(choice)} streamActive={running && message.id === renderableMessages.at(-1)?.id} />{message.role === "assistant" && messageText(message).trim() && <div className="studio-message-actions"><button type="button" onClick={() => void navigator.clipboard?.writeText(messageText(message))}>复制</button></div>}</article>)}
      {!renderableMessages.length && emptyState?.({ sendMessage: (text) => sendText(text), isRunning: running })}
      {tasks.length > 0 && <section className="studio-task-list" aria-label="Agent 任务"><header>任务进度</header>{tasks.map((task) => <div className={task.status} key={task.id}><span /><strong>{task.status === "in_progress" ? task.activeForm : task.content}</strong><small>{task.status === "completed" ? "完成" : task.status === "in_progress" ? "进行中" : "等待"}</small></div>)}</section>}
      {showPending && <div className="studio-pending"><LoaderCircle className="spin" size={16} />正在连接创作服务…</div>}
    </div>
    <div className="studio-composer-wrap">
      {discoveryAction && renderableMessages.some((message) => message.role === "user") && <div className="studio-discovery-action"><div><strong>开书讨论中</strong><span>等你把想法说完整后，再整理成开书方案。</span></div><button type="button" disabled={running || discoveryAction.pending} onClick={discoveryAction.onConfirm}>{discoveryAction.pending ? <LoaderCircle className="spin" size={15} /> : <Check size={15} />}{discoveryAction.pending ? "正在整理…" : "我说完了，整理方案"}</button></div>}
      {Boolean(discoveryAction?.error) && <div className="studio-error"><CircleAlert size={16} />{discoveryAction?.error instanceof Error ? discoveryAction.error.message : "整理失败，请重试。"}</div>}
      {compatibilityStream && <div className="studio-stream-notice">当前服务使用兼容流模式，消息内容不受影响。</div>}
      {chatError && <div className="studio-error"><CircleAlert size={16} />{chatError}</div>}
      {revisionNotice && <div className="studio-notice">{revisionNotice}</div>}
      <Composer onSend={sendText} onCancel={cancelRun} running={running} revisionMode={revisionMode} onError={setChatError} />
      <small className="studio-disclaimer">AI 可能犯错，重要创作决定以你批准的工件为准。</small>
    </div>
  </div>;
}

function Composer({ onSend, onCancel, onError, running, revisionMode }: { onSend: (text: string, attachments?: Attachment[]) => Promise<void>; onCancel: () => void; onError: (message: string) => void; running: boolean; revisionMode?: ConversationRevisionMode }) {
  const [value, setValue] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const submit = () => { const text = value.trim(); if ((!text && !attachments.length) || running || readingFiles) return; const pendingAttachments = attachments; setValue(""); setAttachments([]); void onSend(text, pendingAttachments); };
  const chooseFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    setReadingFiles(true); onError("");
    try { const added = await Promise.all(Array.from(files).map(readAttachment)); setAttachments((current) => [...current, ...added]); }
    catch (error) { onError(error instanceof Error ? error.message : "附件读取失败。"); }
    finally { setReadingFiles(false); if (inputRef.current) inputRef.current.value = ""; }
  };
  return <div className="studio-composer-shell">
    {attachments.length > 0 && <div className="studio-attachment-list">{attachments.map((file, index) => <span key={`${file.name}-${index}`}><FileText size={14} /><span><strong>{file.name}</strong><small>{Math.ceil(file.size / 1024)} KB</small></span><button type="button" aria-label={`移除 ${file.name}`} onClick={() => setAttachments((current) => current.filter((_, itemIndex) => itemIndex !== index))}><X size={13} /></button></span>)}</div>}
    <div className="studio-composer"><input ref={inputRef} type="file" hidden multiple disabled={running || Boolean(revisionMode)} onChange={(event) => void chooseFiles(event.target.files)} /><button type="button" className="studio-attach-button" aria-label="添加附件" title={revisionMode ? "修改模式暂不支持附件" : "添加附件（单个不超过 5 MB）"} disabled={running || readingFiles || Boolean(revisionMode)} onClick={() => inputRef.current?.click()}>{readingFiles ? <LoaderCircle className="spin" size={17} /> : <Paperclip size={17} />}</button><textarea value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder={revisionMode ? `说明希望如何调整${revisionMode.label}……` : "聊聊这本书……"} aria-label={revisionMode ? "说明修改要求" : "发送对话消息"} rows={1} /><button type="button" className="studio-composer-button" aria-label={running ? "停止回答" : "发送消息"} onClick={running ? onCancel : submit}>{running ? <Square size={17} /> : <Send size={17} />}</button></div>
  </div>;
}
