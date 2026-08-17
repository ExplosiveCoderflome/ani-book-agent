import type { MastraDBMessage } from "@mastra/core/agent";
import { MessageFactory } from "@mastra/react/ui";
import type { DynamicToolPart, MessageRenderers, TextPart, ToolInvocationPart } from "@mastra/react/ui";
import { Check, ChevronDown, CircleAlert, LoaderCircle, Wrench } from "lucide-react";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { patchProposalSchema, presentChoicesSchema, type PatchProposal } from "../../shared/contracts";

export type AgentActivity = { title: string; detail: string };
type ChoiceHandler = (message: string, activity?: AgentActivity) => void;

const labels: Record<string, string> = { read_project: "读取作品", search_project: "搜索作品", read_skill: "加载创作方法", present_choices: "展示创作方向", propose_patch: "提交作品提案", start_job: "启动生产任务" };
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
function ChoiceList({ output, onChoice }: { output: unknown; onChoice: ChoiceHandler }) {
  const parsed = presentChoicesSchema.safeParse(output);
  if (!parsed.success) return null;
  const activity = parsed.data.kind === "blueprint"
    ? { title: "正在落实你选择的蓝图", detail: "Agent 会整理正式蓝图与连续性账本，完成后请你确认，尚不会自动开写。" }
    : parsed.data.kind === "seed"
      ? { title: "正在沿这个方向继续构思", detail: "Agent 会展开这个创作种子，并在需要你判断时给出下一组选项。" }
      : { title: "正在落实你的选择", detail: "Agent 会结合已有讨论继续推进，结果会直接显示在这里。" };
  return <div className={`choice-grid ${parsed.data.kind}`}>{parsed.data.choices.map((choice) => <button key={choice.id} onClick={() => onChoice(choice.message, activity)}><strong>{choice.label}</strong><span>{choice.description}</span>{choice.details && <dl>{Object.entries(choice.details).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}</button>)}</div>;
}
function ToolCard({ name, input, output, state, onChoice }: { name: string; input: unknown; output: unknown; state?: string; onChoice: ChoiceHandler }) {
  const failed = state === "output-error" || record(output) && output.ok === false;
  const running = !output && !failed && state !== "output-available" && state !== "result";
  return <><ChoiceList output={output} onChoice={onChoice} /><details className={`tool-card ${failed ? "failed" : running ? "running" : "done"}`} open={failed || running}><summary><Wrench size={14} /><span><strong>{labels[name] ?? name}</strong><small>{name}</small></span><em>{failed ? "失败" : running ? "执行中" : "完成"}</em><ChevronDown size={14} /></summary><div>{input !== undefined && <pre>{text(input)}</pre>}{failed ? <p className="tool-error"><CircleAlert size={14} />{errorText(output)}</p> : output !== undefined && name !== "present_choices" ? <pre>{text(output)}</pre> : null}</div></details></>;
}
function ToolInvocation({ part, onChoice }: { part: ToolInvocationPart; onChoice: ChoiceHandler }) { const value = part.toolInvocation; return <ToolCard name={value.toolName} input={value.args} output={value.result ?? value.errorText} state={value.state} onChoice={onChoice} />; }
function DynamicTool({ part, onChoice }: { part: DynamicToolPart; onChoice: ChoiceHandler }) { return <ToolCard name={part.toolName ?? part.type.replace(/^tool-/, "")} input={part.input} output={part.output} state={part.state} onChoice={onChoice} />; }

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

export function StudioMessage({ message, onChoice }: { message: MastraDBMessage; onChoice: ChoiceHandler }) {
  const renderers = useMemo<MessageRenderers>(() => ({
    Text: (part) => <TextView part={part} />,
    Reasoning: (part) => <details className="reasoning"><summary><LoaderCircle size={13} />思考过程</summary><p>{text("text" in part ? part.text : "reasoning" in part ? part.reasoning : "")}</p></details>,
    ToolInvocation: (part) => <ToolInvocation part={part} onChoice={onChoice} />,
    DynamicTool: (part) => <DynamicTool part={part} onChoice={onChoice} />,
    File: (part) => <div className="file-part">{text("filename" in part ? part.filename : "附件")}</div>,
    Data: (part) => <pre>{text("data" in part ? part.data : part)}</pre>,
    SourceUrl: (part) => <a href={part.url} target="_blank" rel="noreferrer">{part.title ?? part.url}</a>,
    SourceDocument: (part) => <div>{part.title ?? part.filename ?? "参考资料"}</div>,
  }), [onChoice]);
  return <MessageFactory message={message} {...renderers} status={{ Error: ({ text: value }) => <div className="message-error"><CircleAlert />{errorText(value)}</div>, Warning: ({ text: value }) => <div className="message-warning">{text(value)}</div>, Pending: ({ children }) => <div><LoaderCircle className="spin" />{children}</div>, Task: ({ passed, text: value }) => <div>{passed && <Check size={14} />}{text(value)}</div>, Tripwire: ({ text: value }) => <div>{text(value)}</div> }} />;
}
