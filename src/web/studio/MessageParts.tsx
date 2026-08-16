import type { MastraDBMessage } from "@mastra/core/agent";
import { MessageFactory } from "@mastra/react/ui";
import type { DataPart, DynamicToolPart, FilePart, MessageRenderers, MessageStatusRenderers, ReasoningPart, SourceDocumentPart, SourceUrlPart, TextPart, ToolInvocationPart } from "@mastra/react/ui";
import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, ChevronDown, CircleAlert, FileText, Link2, LoaderCircle, ShieldCheck, TriangleAlert, Wrench, X } from "lucide-react";
import { chatChoicesSchema, openingPresetProposalSchema, type OpeningPresetProposal } from "../../shared/contracts";

export type ToolActions = {
  approve: (toolCallId: string, resumeData?: unknown) => Promise<void>;
  decline: (toolCallId: string) => Promise<void>;
  approvals: Record<string, { status: "approved" | "declined" }>;
};

const toolLabels: Record<string, string> = {
  get_novel_status: "读取作品状态",
  list_novel_artifacts: "列出小说工件",
  read_novel_artifact: "读取小说工件",
  search_novel_artifacts: "检索小说工件",
  read_workspace_file: "读取工作文件",
  write_workspace_file: "写入工作文件",
  get_chapter_context: "读取章节上下文",
  inspect_continuity: "检查连续性",
  list_workflow_capabilities: "读取生产能力",
  prepare_opening_preset: "整理开书预设",
  prepareOpeningPresetTool: "整理开书预设",
  start_current_next_action: "启动当前步骤",
  present_chat_choices: "提供快捷选择",
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: unknown, key: string) => isRecord(value) ? value[key] : undefined;

const stringify = (value: unknown) => {
  if (value === undefined) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
};

function TextPartView({ part }: { part: TextPart }) {
  return <div className="studio-message-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown></div>;
}

function ReasoningPartView({ part, streamActive }: { part: ReasoningPart; streamActive: boolean }) {
  const value = "text" in part && typeof part.text === "string" ? part.text : "reasoning" in part && typeof part.reasoning === "string" ? part.reasoning : "";
  const streaming = streamActive && (!('state' in part) || part.state === "streaming");
  if (!value && streaming) return <div className="studio-reasoning-pending"><LoaderCircle className="spin" size={14} />正在生成</div>;
  if (!value) return null;
  return <details className="studio-reasoning" open={streaming}><summary><span>生成过程</span><ChevronDown size={14} /></summary><div>{value}</div></details>;
}

function FilePartView({ part }: { part: FilePart }) {
  const filename = "filename" in part && typeof part.filename === "string" ? part.filename : "附件";
  const mediaType = "mediaType" in part && typeof part.mediaType === "string" ? part.mediaType : undefined;
  return <div className="studio-file-part"><FileText size={15} /><span>{filename}</span>{mediaType && <small>{mediaType}</small>}</div>;
}

type ToolMetadata = { pending: boolean; suspendPayload?: unknown };

export type ToolLifecycle = "running" | "finished" | "awaiting" | "interrupted" | "failed";
export function resolveToolLifecycle({ state, output, errorText, awaitingApproval, streamActive }: { state?: string; output?: unknown; errorText?: string; awaitingApproval: boolean; streamActive: boolean }): ToolLifecycle {
  if (state === "output-error" || Boolean(errorText)) return "failed";
  if (state === "result" || state === "output-available" || state === "output-denied" || output !== undefined) return "finished";
  if (awaitingApproval) return "awaiting";
  return streamActive ? "running" : "interrupted";
}

function toolMetadata(message: MastraDBMessage, toolName: string, toolCallId: string): ToolMetadata {
  const metadata = message.content.metadata;
  for (const key of ["requireApprovalMetadata", "pendingToolApprovals", "suspendedTools"] as const) {
    const source = field(metadata, key);
    const entry = field(source, toolCallId) ?? field(source, toolName);
    if (entry !== undefined) return { pending: true, suspendPayload: field(entry, "suspendPayload") };
  }
  return { pending: false };
}

function ToolCard({ toolName, toolCallId, input, output, errorText, state, actions, metadata, streamActive }: { toolName: string; toolCallId: string; input: unknown; output: unknown; errorText?: string; state?: string; actions: ToolActions; metadata: ToolMetadata; streamActive: boolean }) {
  const failed = state === "output-error" || Boolean(errorText);
  const approval = actions.approvals[toolCallId];
  const lifecycle = resolveToolLifecycle({ state, output, errorText, awaitingApproval: !approval && (metadata.pending || state === "approval-requested"), streamActive });
  const finished = lifecycle === "finished";
  const awaiting = lifecycle === "awaiting";
  const interrupted = lifecycle === "interrupted";
  const label = toolLabels[toolName] ?? toolName;
  return <details className={`studio-tool-card ${failed ? "failed" : interrupted ? "interrupted" : finished ? "finished" : "running"}`} open={!finished && !interrupted || awaiting || failed}>
    <summary><span className="studio-tool-icon"><Wrench size={14} /></span><span><strong>{label}</strong>{label !== toolName && <small>{toolName}</small>}</span><span className="studio-tool-state">{approval ? approval.status === "approved" ? "已批准" : "已拒绝" : failed ? "失败" : finished ? "完成" : awaiting ? "等待确认" : interrupted ? "未完成" : "执行中"}</span><ChevronDown size={14} /></summary>
    <div className="studio-tool-body">
      {input !== undefined && <section><h4>工具参数</h4><pre>{stringify(input)}</pre></section>}
      {metadata.suspendPayload !== undefined && <section><h4>暂停数据</h4><pre>{stringify(metadata.suspendPayload)}</pre></section>}
      {output !== undefined && <section><h4>工具结果</h4><pre>{stringify(output)}</pre></section>}
      {errorText && <div className="studio-tool-error"><CircleAlert size={15} />{errorText}</div>}
      {interrupted && <div className="studio-tool-interrupted"><CircleAlert size={15} /><span>本次运行在工具返回结果前结束，没有写入权威内容。可以重新发送或继续当前任务。</span></div>}
      {awaiting && <div className="studio-tool-approval"><ShieldCheck size={16} /><span>该工具请求需要你的确认</span><div><button type="button" className="primary-button compact" onClick={() => void actions.approve(toolCallId)}><Check size={14} />批准</button><button type="button" className="quiet-button compact" onClick={() => void actions.decline(toolCallId)}><X size={14} />拒绝</button></div></div>}
    </div>
  </details>;
}

function ToolInvocationView({ part, actions, message, streamActive }: { part: ToolInvocationPart; actions: ToolActions; message: MastraDBMessage; streamActive: boolean }) {
  const invocation = part.toolInvocation;
  return <ToolCard toolName={invocation.toolName} toolCallId={invocation.toolCallId} input={invocation.args} output={invocation.result} errorText={invocation.errorText} state={invocation.state} actions={actions} metadata={toolMetadata(message, invocation.toolName, invocation.toolCallId)} streamActive={streamActive} />;
}

function ChoiceList({ choices, onChoice }: { choices: Array<{ label: string; description: string; message: string }>; onChoice: (message: string) => void }) {
  return <div className="studio-choice-list">{choices.map((choice) => <button type="button" key={choice.message} onClick={() => onChoice(choice.message)}><strong>{choice.label}</strong><small>{choice.description}</small></button>)}</div>;
}

function DynamicToolView({ part, actions, message, onChoice, streamActive }: { part: DynamicToolPart; actions: ToolActions; message: MastraDBMessage; onChoice: (message: string) => void; streamActive: boolean }) {
  const toolName = part.toolName ?? part.type.replace(/^tool-/, "");
  const toolCallId = part.toolCallId ?? `${part.type}-unknown`;
  const errorText = part.state === "output-error" ? stringify(part.output) || "工具执行失败" : undefined;
  const choices = toolName === "present_chat_choices" ? chatChoicesSchema.safeParse(part.output) : undefined;
  return <>{choices?.success && choices.data.choices.length ? <ChoiceList choices={choices.data.choices} onChoice={onChoice} /> : null}<ToolCard toolName={toolName} toolCallId={toolCallId} input={part.input} output={part.output} errorText={errorText} state={part.state} actions={actions} metadata={toolMetadata(message, toolName, toolCallId)} streamActive={streamActive} /></>;
}

function DataPartView({ part, onChoice }: { part: DataPart; onChoice: (message: string) => void }) {
  const data = "data" in part ? part.data : undefined;
  if (data === undefined || data === null) return null;
  if (isRecord(data) && typeof data.message === "string") return <div className="studio-data-status"><LoaderCircle className="spin" size={14} />{data.message}</div>;
  if (part.type === "data-choices") {
    const parsed = chatChoicesSchema.safeParse(data);
    if (parsed.success && parsed.data.choices.length) return <div className="studio-choice-list">{parsed.data.choices.map((choice) => <button type="button" key={choice.message} onClick={() => onChoice(choice.message)}><strong>{choice.label}</strong><small>{choice.description}</small></button>)}</div>;
  }
  return <details className="studio-data-part"><summary>{part.type.replace(/^data-/, "")}</summary><pre>{stringify(data)}</pre></details>;
}

function SourceUrlView({ part }: { part: SourceUrlPart }) {
  return <a className="studio-source-part" href={part.url} target="_blank" rel="noreferrer"><Link2 size={14} /><span>{part.title ?? part.url}</span></a>;
}

function SourceDocumentView({ part }: { part: SourceDocumentPart }) {
  return <div className="studio-source-part"><FileText size={14} /><span>{part.title || part.filename || "参考资料"}</span><small>{part.mediaType}</small></div>;
}

const statusRenderers: MessageStatusRenderers = {
  Error: ({ text }) => <div className="studio-status-message error"><CircleAlert size={16} /><div><strong>运行失败</strong><span>{text || "Agent 没有完成这次请求。"}</span></div></div>,
  Warning: ({ text }) => <div className="studio-status-message warning"><TriangleAlert size={16} /><div><strong>需要注意</strong><span>{text}</span></div></div>,
  Tripwire: ({ text }) => <div className="studio-status-message warning"><ShieldCheck size={16} /><div><strong>已停止输出</strong><span>{text}</span></div></div>,
  Pending: ({ children }) => <div className="studio-message-pending">{children}</div>,
  Task: ({ passed, text, suppressFeedback }) => suppressFeedback ? null : <div className={`studio-status-message ${passed ? "success" : "warning"}`}>{passed ? <Check size={16} /> : <TriangleAlert size={16} />}<span>{text || (passed ? "任务已完成" : "任务仍需继续")}</span></div>,
};

export function hasRenderableMessage(message: MastraDBMessage) {
  const status = field(message.content.metadata, "status");
  if (status === "error" || status === "warning" || status === "tripwire") return true;
  return message.content.parts.some((part) => {
    if (part.type === "text") return typeof part.text === "string" && part.text.trim().length > 0;
    if (part.type === "reasoning") {
      const value = "text" in part && typeof part.text === "string" ? part.text : "reasoning" in part && typeof part.reasoning === "string" ? part.reasoning : "";
      return Boolean(value.trim() || ("state" in part && part.state === "streaming"));
    }
    if (part.type === "step-start") return false;
    if (part.type.startsWith("data-")) return field(part, "data") != null;
    return true;
  });
}

export function messageForDisplay(message: MastraDBMessage): MastraDBMessage {
  const signal = field(message.content.metadata, "signal");
  return message.role === "signal" && field(signal, "type") === "user" ? { ...message, role: "user" } as MastraDBMessage : message;
}

export function openingPresetFromMessage(message: MastraDBMessage): OpeningPresetProposal | undefined {
  for (const part of [...message.content.parts].reverse()) {
    const invocation = part.type === "tool-invocation" ? part.toolInvocation : undefined;
    if (invocation && (invocation.toolName === "prepare_opening_preset" || invocation.toolName === "prepareOpeningPresetTool")) {
      const parsed = openingPresetProposalSchema.safeParse(invocation.result);
      if (parsed.success) return parsed.data;
    }
  }
  return undefined;
}

export const messageText = (message: MastraDBMessage) => message.content.parts.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n");

export function StudioMessage({ message, actions, onChoice, streamActive = false }: { message: MastraDBMessage; actions: ToolActions; onChoice: (message: string) => void; streamActive?: boolean }) {
  const renderers = useMemo<MessageRenderers>(() => ({
    Text: (part) => <TextPartView part={part} />,
    Reasoning: (part) => <ReasoningPartView part={part} streamActive={streamActive} />,
    File: (part) => <FilePartView part={part} />,
    Data: (part) => <DataPartView part={part} onChoice={onChoice} />,
    ToolInvocation: (part) => <ToolInvocationView part={part} actions={actions} message={message} streamActive={streamActive} />,
    DynamicTool: (part) => <DynamicToolView part={part} actions={actions} message={message} onChoice={onChoice} streamActive={streamActive} />,
    SourceUrl: (part) => <SourceUrlView part={part} />,
    SourceDocument: (part) => <SourceDocumentView part={part} />,
  }), [actions, message, onChoice, streamActive]);
  return <MessageFactory message={message} {...renderers} status={statusRenderers} />;
}
