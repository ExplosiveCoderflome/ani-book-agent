import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MastraDBMessage } from "@mastra/core/agent";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type DataMessagePartProps,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import "@assistant-ui/react-markdown/styles/dot.css";
import { Feather, Send, Square } from "lucide-react";
import remarkGfm from "remark-gfm";

function fromDatabase(message: MastraDBMessage): ThreadMessageLike {
  const text = message.content.parts.filter((part): part is Extract<typeof part, { type: "text" }> => part.type === "text").map((part) => part.text).join("\n");
  return { id: message.id, role: message.role === "signal" ? "assistant" : message.role, content: [{ type: "text", text: text || "正在整理方案…" }], createdAt: new Date(message.createdAt) };
}

type ConversationMessage = { kind: "message"; message: ThreadMessageLike } | { kind: "workflow"; id: string; node: ReactNode };
function convertMessage(source: ConversationMessage): ThreadMessageLike {
  return source.kind === "message" ? source.message : { id: source.id, role: "assistant", content: [{ type: "data", name: "workflow", data: { node: source.node } }], createdAt: new Date(0) };
}

function PlainTextPart() { return <MessagePartPrimitive.Text component="p" className="message-text" />; }
function MarkdownTextPart() { return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} className="message-markdown" />; }
function WorkflowDataPart({ data }: DataMessagePartProps<{ node: ReactNode }>) { return <div className="workflow-data-part">{data.node}</div>; }

function ChatMessage() {
  return <MessagePrimitive.Root className="message-row">
    <MessagePrimitive.If assistant><article className="message assistant-message"><span className="assistant-avatar"><Feather size={16} /></span><div><strong>创作搭档</strong><MessagePrimitive.Parts components={{ Text: MarkdownTextPart, data: { by_name: { workflow: WorkflowDataPart } } }} /></div></article></MessagePrimitive.If>
    <MessagePrimitive.If user><article className="message user-message"><MessagePrimitive.Parts components={{ Text: PlainTextPart }} /></article></MessagePrimitive.If>
    <MessagePrimitive.If system><article className="message system-message"><MessagePrimitive.Parts components={{ Text: PlainTextPart }} /></article></MessagePrimitive.If>
  </MessagePrimitive.Root>;
}

export function Conversation({ novelId, initialMessages, children }: {
  novelId: string;
  initialMessages: MastraDBMessage[];
  children: ReactNode | ((actions: { sendMessage: (text: string) => Promise<void>; isRunning: boolean; messageCount: number }) => ReactNode);
}) {
  const hydrated = useMemo(() => initialMessages.filter((message) => message.role !== "signal").map(fromDatabase), [initialMessages]);
  const [messages, setMessages] = useState<ThreadMessageLike[]>(hydrated);
  const [isRunning, setRunning] = useState(false);
  const [error, setError] = useState("");
  const abortRef = useRef<AbortController | undefined>(undefined);

  useEffect(() => { setMessages(hydrated); setError(""); abortRef.current?.abort(); setRunning(false); }, [hydrated, novelId]);

  const sendMessage = async (raw: string) => {
    const text = raw.trim();
    if (!text || isRunning) return;
    const userId = crypto.randomUUID();
    const assistantId = crypto.randomUUID();
    setError(""); setRunning(true);
    setMessages((current) => [...current, { id: userId, role: "user", content: [{ type: "text", text }], createdAt: new Date() }, { id: assistantId, role: "assistant", content: [{ type: "text", text: "" }], createdAt: new Date() }]);
    const controller = new AbortController(); abortRef.current = controller;
    let accumulated = "";
    try {
      const response = await fetch(`/workbench-api/novels/${novelId}/chat`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }), signal: controller.signal });
      if (!response.ok || !response.body) { const body = await response.json().catch(() => ({})); throw new Error(body?.error?.message ?? "消息发送失败，请重试。"); }
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const blocks = buffer.split("\n\n"); buffer = blocks.pop() ?? "";
        for (const block of blocks) {
          const event = block.match(/^event:\s*(.+)$/m)?.[1]; const dataText = block.match(/^data:\s*(.+)$/m)?.[1]; if (!event || !dataText) continue;
          const data = JSON.parse(dataText) as { text?: string; message?: string };
          if (event === "text-delta" && data.text) { accumulated += data.text; setMessages((current) => current.map((message) => message.id === assistantId ? { ...message, content: [{ type: "text", text: accumulated }] } : message)); }
          if (event === "error") throw new Error(data.message ?? "生成失败，请重试。");
        }
      }
      if (!accumulated) throw new Error("模型没有返回可展示的文本。");
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "消息发送失败，请重试。");
      setMessages((current) => current.filter((message) => message.id !== assistantId || accumulated.length > 0));
    } finally { if (abortRef.current === controller) abortRef.current = undefined; setRunning(false); }
  };

  const messageCount = messages.filter((message) => message.role === "user" || message.role === "assistant").length;
  const flowNode = typeof children === "function" ? children({ sendMessage, isRunning, messageCount }) : children;
  const externalMessages: ConversationMessage[] = [...messages.map((message) => ({ kind: "message" as const, message })), { kind: "workflow", id: `workflow-${novelId}`, node: flowNode }];
  const runtime = useExternalStoreRuntime({
    isRunning, messages: externalMessages, convertMessage,
    onNew: async (message: AppendMessage) => sendMessage(message.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")),
    onCancel: async () => abortRef.current?.abort(),
  });

  return <AssistantRuntimeProvider runtime={runtime}><ThreadPrimitive.Root className="conversation-thread"><ThreadPrimitive.Viewport className="conversation-viewport"><ThreadPrimitive.Messages components={{ Message: ChatMessage }} /><ThreadPrimitive.ViewportFooter className="composer-footer">{error && <div className="chat-error">{error}</div>}<ComposerPrimitive.Root className="composer"><ComposerPrimitive.Input aria-label="给创作搭档发消息" placeholder="和创作搭档聊聊这本书……" rows={1} /><ThreadPrimitive.If running><ComposerPrimitive.Cancel className="composer-button" aria-label="停止回答"><Square size={17} /></ComposerPrimitive.Cancel></ThreadPrimitive.If><ThreadPrimitive.If running={false}><ComposerPrimitive.Send className="composer-button" aria-label="发送消息"><Send size={18} /></ComposerPrimitive.Send></ThreadPrimitive.If></ComposerPrimitive.Root><small>AI 可能犯错，重要创作决定以你批准的工件为准。</small></ThreadPrimitive.ViewportFooter></ThreadPrimitive.Viewport></ThreadPrimitive.Root></AssistantRuntimeProvider>;
}
