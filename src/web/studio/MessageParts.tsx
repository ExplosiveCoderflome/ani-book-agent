import type { MastraDBMessage } from "@mastra/core/agent";
import { MessageFactory } from "@mastra/react/ui";
import type { DynamicToolPart, MessageRenderers, TextPart, ToolInvocationPart } from "@mastra/react/ui";
import { Check, ChevronDown, CircleAlert, LoaderCircle, Wrench } from "lucide-react";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { patchProposalSchema, type PatchProposal } from "../../shared/contracts";

export type AgentActivity = { title: string; detail: string };

const labels: Record<string, string> = { read_project: "读取作品", search_project: "搜索作品", read_skill: "加载创作方法", read_reference: "读取拆书报告", propose_patch: "提交作品提案", start_job: "启动生产任务" };
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => { if (typeof value === "string") return value; try { return JSON.stringify(value, null, 2); } catch { return "工具返回了无法显示的结果。"; } };
export const errorText = (value: unknown): string => {
  if (typeof value === "string") {
    const message = value.trim();
    if (!message || message === "[object Object]") return "工具执行失败，请重试。";
    if (message.length > 500 || message.includes("APICallError") || message.includes("requestBodyValues") || message.includes("responseHeaders")) return "模型服务调用失败，请重试；若持续失败，请检查模型设置。";
    return message;
  }
  if (record(value)) { const nested = record(value.error) ? value.error : value; if (typeof nested.message === "string") return errorText(nested.message); }
  return "工具执行失败，请重试。";
};

function TextView({ part }: { part: TextPart }) { return <div className="message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown></div>; }
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

export function StudioMessage({ message }: { message: MastraDBMessage }) {
  const renderers = useMemo<MessageRenderers>(() => ({
    Text: (part) => <TextView part={part} />,
    Reasoning: (part) => <details className="reasoning"><summary><LoaderCircle size={13} />思考过程</summary><p>{text("text" in part ? part.text : "reasoning" in part ? part.reasoning : "")}</p></details>,
    ToolInvocation: (part) => <ToolInvocation part={part} />,
    DynamicTool: (part) => <DynamicTool part={part} />,
    File: (part) => <div className="file-part">{text("filename" in part ? part.filename : "附件")}</div>,
    Data: (part) => <pre>{text("data" in part ? part.data : part)}</pre>,
    SourceUrl: (part) => <a href={part.url} target="_blank" rel="noreferrer">{part.title ?? part.url}</a>,
    SourceDocument: (part) => <div>{part.title ?? part.filename ?? "参考资料"}</div>,
  }), []);
  return <MessageFactory message={message} {...renderers} status={{ Error: ({ text: value }) => <div className="message-error"><CircleAlert />{errorText(value)}</div>, Warning: ({ text: value }) => <div className="message-warning">{text(value)}</div>, Pending: ({ children }) => <div><LoaderCircle className="spin" />{children}</div>, Task: ({ passed, text: value }) => <div>{passed && <Check size={14} />}{text(value)}</div>, Tripwire: ({ text: value }) => <div>{text(value)}</div> }} />;
}
