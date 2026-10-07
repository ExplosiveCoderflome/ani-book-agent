import type { MastraDBMessage } from "@mastra/core/agent";
import { MessageFactory } from "@mastra/react/ui";
import type { DynamicToolPart, MessageRenderers, ReasoningPart, TextPart, ToolInvocationPart } from "@mastra/react/ui";
import { Check, ChevronDown, CircleAlert, LoaderCircle, RotateCcw, ThumbsDown, ThumbsUp, Wrench } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { patchProposalSchema, type PatchProposal } from "../../shared/contracts";
import { quickChoices } from "./quick-choices";

export type AgentActivity = { title: string; detail: string };
export type MessageAction = { kind: "choice" | "like" | "dislike"; value: string; excerpt?: string };

const labels: Record<string, string> = { read_project: "读取作品", search_project: "搜索作品", read_skill: "加载创作方法", read_reference: "读取拆书报告", propose_patch: "提交作品提案", start_job: "启动生产任务" };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => { if (typeof value === "string") return value; try { return JSON.stringify(value, null, 2); } catch { return "工具返回了无法显示的结果。"; } };
export const errorText = (value: unknown): string => {
  if (typeof value === "string") {
    const message = value.trim();
    if (!message || message === "[object Object]") return "工具执行失败，请重试。";
    if (message.length > 500 || message.includes("APICallError") || message.includes("requestBodyValues") || message.includes("responseHeaders")) return "模型服务调用失败，自动重试仍未恢复；你可以重试本次操作，若持续失败请检查模型设置。";
    return message;
  }
  if (record(value)) { const nested = record(value.error) ? value.error : value; if (typeof nested.message === "string") return errorText(nested.message); }
  return "工具执行失败，请重试。";
};

export function recoveryPrompt(goal: string) {
  const originalGoal = goal.trim().slice(0, 2_000);
  if (originalGoal.startsWith("请先调用 read_project 重新读取当前作品的最新权威状态。")) return originalGoal;
  return [
    "请先调用 read_project 重新读取当前作品的最新权威状态。上一轮模型服务失败，请只继续尚未完成的目标，不要重复已经成功的工具调用、已经应用的提案或已经启动的生产任务。",
    originalGoal ? `尚未完成的原始目标（仅用于判断目标，不要机械复放上一轮步骤）：\n${originalGoal}` : "请结合最近对话判断尚未完成的目标；如果目标已经完成，只需说明当前结果。",
  ].join("\n\n");
}

export function modelRetryText(value: unknown) {
  if (!record(value) || value.type !== "data-model-retry" || !record(value.data)) return undefined;
  const attempt = Number(value.data.attempt); const maxRetries = Number(value.data.maxRetries);
  if (!Number.isInteger(attempt) || !Number.isInteger(maxRetries) || attempt < 1 || maxRetries < 1) return undefined;
  return `模型服务暂时不可用，正在第 ${Math.min(attempt, maxRetries)}/${maxRetries} 次自动重试…`;
}

function TextView({ part }: { part: TextPart }) { return <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown></div>; }
function ReasoningView({ part }: { part: ReasoningPart }) { const streaming = part.state === "streaming"; return <details className={`reasoning ${streaming ? "streaming" : ""}`} open><summary><LoaderCircle className={streaming ? "spin" : ""} size={13} />{streaming ? "思考中" : "思考过程"}</summary><pre>{part.reasoning}</pre></details>; }
function ToolCard({ name, input, output, state }: { name: string; input: unknown; output: unknown; state?: string }) {
  if (name === "present_choices" || name === "presentChoicesTool") return null;
  const error = record(output) && output.ok === false && record(output.error) ? output.error : undefined;
  const failed = state === "output-error" || record(output) && output.ok === false;
  const running = !output && !failed && state !== "output-available" && state !== "result";
  return <details className={`tool-card ${failed ? "failed" : running ? "running" : "done"}`} open={failed || running}><summary><Wrench size={14} /><span><strong>{labels[name] ?? name}</strong><small>{name}</small></span><em>{failed ? "失败" : running ? "执行中" : "完成"}</em><ChevronDown size={14} /></summary><div>{input !== undefined && <pre>{text(input)}</pre>}{failed ? <p className="tool-error"><CircleAlert size={14} />{errorText(output)}</p> : output !== undefined ? <pre>{text(output)}</pre> : null}</div></details>;
}
function ToolInvocation({ part }: { part: ToolInvocationPart }) { const value = part.toolInvocation; return <ToolCard name={value.toolName} input={value.args} output={value.result ?? value.errorText} state={value.state} />; }
function DynamicTool({ part }: { part: DynamicToolPart }) { return <ToolCard name={part.toolName ?? part.type.replace(/^tool-/, "")} input={part.input} output={part.output} state={part.state} />; }

export function patchProposalFromMessage(message: MastraDBMessage): PatchProposal | undefined {
  for (const part of [...message.content.parts].reverse()) {
    const output = part.type === "tool-invocation" ? part.toolInvocation.result : part.type.startsWith("tool-") && "output" in part ? part.output : undefined;
    const candidate = record(output) && output.ok === true ? output.proposal : undefined;
    const parsed = patchProposalSchema.safeParse(candidate);
    if (parsed.success && parsed.data.status === "pending") return parsed.data;
  }
}
export function messageForDisplay(message: MastraDBMessage): MastraDBMessage { const signal = record(message.content.metadata?.signal) ? message.content.metadata?.signal : undefined; return message.role === "signal" && signal?.type === "user" ? { ...message, role: "user" } as MastraDBMessage : message; }
export function hasRenderableMessage(message: MastraDBMessage) { return message.content.parts.some((part) => part.type === "text" ? Boolean(part.text.trim()) : part.type !== "step-start"); }
export function messageText(message: MastraDBMessage) { return message.content.parts.flatMap((part) => part.type === "text" && "text" in part ? [String(part.text)] : []).join("\n\n"); }

function MessageActions({ markdown, onAction }: { markdown: string; onAction: (action: MessageAction) => Promise<void> }) {
  const choices = useMemo(() => quickChoices(markdown), [markdown]);
  const [selected, setSelected] = useState<string>();
  const [failed, setFailed] = useState(false);
  const act = async (action: MessageAction) => {
    const key = `${action.kind}:${action.value}`; setSelected(key); setFailed(false);
    try { await onAction(action); } catch { setSelected(undefined); setFailed(true); }
  };
  return <div className="message-actions">
    {choices.length > 0 && <div className="quick-choice-grid" role="group" aria-label="快捷选择">{choices.map((choice) => <button key={choice.number} disabled={Boolean(selected)} onClick={() => void act({ kind: "choice", value: `第 ${choice.number} 项：${choice.label}` })}><b>{choice.number}</b><span>{choice.label}</span></button>)}</div>}
    <div className="message-feedback" aria-label="评价这次回复"><span>{selected?.startsWith("like:") || selected?.startsWith("dislike:") ? "已记住" : "这次回复符合你的想法吗？"}</span><button className={selected?.startsWith("like:") ? "active" : ""} disabled={Boolean(selected)} aria-label="喜欢这次回复" title="喜欢" onClick={() => void act({ kind: "like", value: "喜欢这次回复", excerpt: markdown.slice(0, 1_000) })}><ThumbsUp /></button><button className={selected?.startsWith("dislike:") ? "active" : ""} disabled={Boolean(selected)} aria-label="不喜欢这次回复" title="不喜欢" onClick={() => void act({ kind: "dislike", value: "不喜欢这次回复", excerpt: markdown.slice(0, 1_000) })}><ThumbsDown /></button></div>
    {failed && <small className="message-action-error" role="alert">偏好没有保存，请重试。</small>}
  </div>;
}

export function StudioMessage({ message, onAction, onRetry, retrying = false }: { message: MastraDBMessage; onAction?: (action: MessageAction) => Promise<void>; onRetry?: () => void | Promise<void>; retrying?: boolean }) {
  const markdown = messageText(message);
  const renderers = useMemo<MessageRenderers>(() => ({
    Text: (part) => <TextView part={part} />,
    Reasoning: (part) => <ReasoningView part={part} />,
    ToolInvocation: (part) => <ToolInvocation part={part} />,
    DynamicTool: (part) => <DynamicTool part={part} />,
    File: (part) => <div className="file-part">{text("filename" in part ? part.filename : "附件")}</div>,
    Data: (part) => { const retry = modelRetryText(part); return retry ? <div className="model-retry" role="status" aria-live="polite"><LoaderCircle className="spin" />{retry}</div> : <pre>{text("data" in part ? part.data : part)}</pre>; },
    SourceUrl: (part) => <a href={part.url} target="_blank" rel="noreferrer">{part.title ?? part.url}</a>,
    SourceDocument: (part) => <div>{part.title ?? part.filename ?? "参考资料"}</div>,
  }), []);
  return <><MessageFactory message={message} {...renderers} status={{ Error: ({ text: value }) => <div className="message-error"><span><CircleAlert />{errorText(value)}</span>{onRetry && <button disabled={retrying} onClick={() => void onRetry()}>{retrying ? <LoaderCircle className="spin" /> : <RotateCcw />}重试本次操作</button>}</div>, Warning: ({ text: value }) => <div className="message-warning">{text(value)}</div>, Pending: ({ children }) => <div><LoaderCircle className="spin" />{children}</div>, Task: ({ passed, text: value }) => <div>{passed && <Check size={14} />}{text(value)}</div>, Tripwire: ({ text: value }) => <div>{text(value)}</div> }} />{onAction && markdown.trim() && <MessageActions markdown={markdown} onAction={onAction} />}</>;
}
