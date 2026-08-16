import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CodeBlock, CodeCopyButton, Entity, EntityCaret, EntityContent, EntityTrigger, Entry, EntryTitle } from "@mastra/react/ui";
import { Activity, ArrowLeft, BarChart3, Bot, Boxes, Check, ChevronLeft, ChevronRight, CircleAlert, Download, FileCode2, FileText, FolderKanban, LoaderCircle, Menu, MessageCircle, Pencil, Search, ShieldCheck, Sparkles, Square, Workflow, Wrench, X } from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentProfile, AssetRecord, NovelFileRecord, ProjectRecipe, SkillDefinition, WorkspaceProjection } from "../../shared/contracts";
import { api } from "../api";
import { Allotment } from "allotment";
import "allotment/dist/style.css";

const statusLabels: Record<WorkspaceProjection["production"][number]["status"], string> = {
  locked: "等待上游", pending: "待处理", running: "生成中", review: "待确认", ready: "已完成", stale: "待刷新", blocked: "已阻断",
};

export function NovelWorkbench({ navigation, main, agent, dock, agentOpen }: { navigation: ReactNode; main: ReactNode; agent: ReactNode; dock?: ReactNode; agentOpen: boolean }) {
  const [resizing, setResizing] = useState(false);
  return <div className={`novel-workbench ${agentOpen ? "agent-open" : "agent-closed"} ${resizing ? "workbench-resizing" : ""}`}>
    {navigation}<div className="workbench-content-split"><Allotment defaultSizes={[1000, 380]} proportionalLayout={false} onDragStart={() => setResizing(true)} onDragEnd={() => setResizing(false)}><Allotment.Pane minSize={460}>{main}</Allotment.Pane>{agentOpen ? <Allotment.Pane minSize={280} maxSize={760}>{agent}</Allotment.Pane> : null}</Allotment></div>{dock}
  </div>;
}

export type WorkspaceSection = "production" | "assets" | "files" | "capabilities" | "observability";
export type ConversationContextTarget = { kind: "artifact" | "file"; value: string; label: string };

const phaseLabels: Record<WorkspaceProjection["phase"], string> = { discovery: "灵感发现", planning: "全书规划", volume: "分卷推进", chapter: "章节生产", completion: "完本收束" };
const sectionItems: Array<{ id: WorkspaceSection; label: string; description: string; icon: typeof Sparkles }> = [
  { id: "production", label: "当前任务", description: "继续自动成书", icon: Sparkles },
  { id: "assets", label: "作品资产", description: "查看设定与正文", icon: FolderKanban },
  { id: "files", label: "文件管理", description: "浏览当前小说目录", icon: FileCode2 },
  { id: "capabilities", label: "创作能力", description: "Skills 与生产链", icon: Boxes },
  { id: "observability", label: "运行统计", description: "运行、模型与工具", icon: BarChart3 },
];

export function PlatformNavigator({ projection, section, selectedArtifact, onSelectSection, onSelectArtifact, mobileOpen, onCloseMobile }: { projection: WorkspaceProjection; section: WorkspaceSection; selectedArtifact?: string; onSelectSection: (section: WorkspaceSection) => void; onSelectArtifact: (key: string) => void; mobileOpen: boolean; onCloseMobile: () => void }) {
  const currentId = "artifactKey" in projection.nextAction ? projection.nextAction.artifactKey
    : projection.nextAction.type === "configure_volume" ? `volume:${projection.nextAction.volume}`
      : projection.nextAction.type === "approve_chapter_range" ? `chapter:${projection.nextAction.chapter}:chapter_plan` : undefined;
  const selectSection = (next: WorkspaceSection) => { onSelectSection(next); onCloseMobile(); };
  return <aside className={`production-navigator platform-navigator ${mobileOpen ? "mobile-open" : ""}`} aria-label="作品导航">
    <header><div><span>创作阶段</span><strong>{phaseLabels[projection.phase]}</strong></div><button className="icon-button navigator-close" onClick={onCloseMobile} aria-label="关闭作品导航"><X size={18} /></button></header>
    <nav className="platform-sections">{sectionItems.map((item) => { const Icon = item.icon; return <button key={item.id} type="button" className={`platform-section ${section === item.id ? "active" : ""}`} onClick={() => selectSection(item.id)}><Icon size={17} /><span><strong>{item.label}</strong><small>{item.description}</small></span></button>; })}</nav>
    <Entity variant="workflow" initialExpanded className="navigator-entity"><EntityTrigger><Workflow size={15} /><span>生产链</span><EntityCaret /></EntityTrigger><EntityContent><Entry><EntryTitle>从想法到成书</EntryTitle><nav className="production-chain">{projection.production.map((item) => { const current = item.id === currentId; return <button type="button" key={item.id} className={`production-item ${item.status} ${current ? "current" : ""} ${selectedArtifact === item.artifactKey ? "active" : ""}`} disabled={!current && (!item.artifactKey || item.status === "locked" || item.status === "pending")} onClick={() => { onSelectSection("production"); onSelectArtifact(current ? "" : item.artifactKey ?? ""); onCloseMobile(); }}><i>{item.status === "ready" ? <Check size={13} /> : item.status === "blocked" ? <CircleAlert size={13} /> : <span />}</i><span><strong>{item.label}</strong><small>{current ? "下一步" : statusLabels[item.status]}</small></span>{current || item.artifactKey && item.status !== "locked" && item.status !== "pending" ? <ChevronRight size={15} /> : null}</button>; })}</nav></Entry></EntityContent></Entity>
  </aside>;
}

const assetTypeLabels: Record<AssetRecord["type"], string> = { brief: "简报", story: "故事", world: "世界", character: "角色", volume: "分卷", chapter: "章节", continuity: "连续性", promise: "伏笔", relationship: "关系", reference: "资料", style: "风格", workspace: "工作文件" };
const assetStatusLabels: Record<AssetRecord["status"], string> = { missing: "缺失", in_progress: "生成中", ready: "可用", stale: "待刷新", blocked: "已阻断" };

const isMarkdownPath = (path: string) => /\.md$/i.test(path);
const isReadablePath = (path: string) => !/\.(?:sqlite|sqlite3|db|png|jpe?g|gif|webp|pdf|zip)$/i.test(path);

export function AssetCenter({ novelId, selectedAsset, onSelectAsset, onOpenArtifact, onOpenFile, onUseAsContext }: { novelId: string; selectedAsset: string; onSelectAsset: (id: string) => void; onOpenArtifact: (key: string, startEditing?: boolean) => void; onOpenFile: (path: string, startEditing?: boolean) => void; onUseAsContext: (target: ConversationContextTarget) => void }) {
  const assetsQuery = useQuery({ queryKey: ["assets", novelId], queryFn: () => api.assets(novelId) });
  const [search, setSearch] = useState("");
  const [type, setType] = useState<AssetRecord["type"] | "all">("all");
  const assets = assetsQuery.data?.assets ?? [];
  const types = useMemo(() => Array.from(new Set(assets.map((asset) => asset.type))), [assets]);
  const visible = useMemo(() => { const query = search.trim().toLocaleLowerCase(); return assets.filter((asset) => (type === "all" || asset.type === type) && (!query || `${asset.title} ${asset.path} ${asset.tags.join(" ")}`.toLocaleLowerCase().includes(query))); }, [assets, search, type]);
  const active = assets.find((asset) => asset.id === selectedAsset) ?? visible[0];
  useEffect(() => { if (!selectedAsset && visible[0]) onSelectAsset(visible[0].id); }, [selectedAsset, visible, onSelectAsset]);
  if (assetsQuery.isLoading) return <div className="workspace-loading"><LoaderCircle className="spin" />正在整理作品资产…</div>;
  if (assetsQuery.error) return <div className="workspace-error"><CircleAlert />{assetsQuery.error instanceof Error ? assetsQuery.error.message : "无法读取作品资产。"}</div>;
  return <section className="asset-center">
    <header className="workspace-section-heading"><div><span>作品资产</span><h2>{assets.length} 项创作事实与工作文件</h2><p>这里展示小说生产链已经确认或正在使用的内容，引用关系会随工件提交自动更新。</p></div><div className="asset-summary"><strong>{assets.filter((asset) => asset.status === "ready").length}</strong><small>可用资产</small></div></header>
    <div className="asset-toolbar"><label><Search size={16} /><input aria-label="搜索作品资产" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索标题、路径或标签" /></label><select aria-label="按资产类型筛选" value={type} onChange={(event) => setType(event.target.value as typeof type)}><option value="all">全部类型</option>{types.map((value) => <option key={value} value={value}>{assetTypeLabels[value]}</option>)}</select></div>
    <div className="asset-workspace"><div className="asset-list" role="list">{visible.length ? visible.map((asset) => <button role="listitem" type="button" key={asset.id} className={active?.id === asset.id ? "active" : ""} onClick={() => onSelectAsset(asset.id)}><FileText size={17} /><span><strong>{asset.title}</strong><small>{assetTypeLabels[asset.type]} · {assetStatusLabels[asset.status]}</small></span>{asset.protected ? <ShieldCheck size={15} aria-label="作者保护" /> : null}</button>) : <div className="asset-empty">没有符合筛选条件的资产。</div>}</div>
      <AssetInspector asset={active} onOpenArtifact={onOpenArtifact} onOpenFile={onOpenFile} onUseAsContext={onUseAsContext} />
    </div>
  </section>;
}

function AssetInspector({ asset, onOpenArtifact, onOpenFile, onUseAsContext }: { asset?: AssetRecord; onOpenArtifact: (key: string, startEditing?: boolean) => void; onOpenFile: (path: string, startEditing?: boolean) => void; onUseAsContext: (target: ConversationContextTarget) => void }) {
  if (!asset) return <aside className="asset-inspector"><FolderKanban size={26} /><h3>还没有作品资产</h3><p>完成当前创作任务后，故事设定、人物、章节和连续性资料会自动汇总到这里。</p></aside>;
  const authoritative = !asset.id.startsWith("workspace:");
  const readable = asset.status !== "missing" && asset.status !== "in_progress" && isReadablePath(asset.path);
  const contextTarget: ConversationContextTarget = authoritative ? { kind: "artifact", value: asset.id, label: asset.title } : { kind: "file", value: asset.path, label: asset.title };
  return <aside className="asset-inspector"><header><span>{assetTypeLabels[asset.type]}</span><h3>{asset.title}</h3><p>{asset.path}</p></header><dl><div><dt>状态</dt><dd>{assetStatusLabels[asset.status]}</dd></div><div><dt>来源</dt><dd>{asset.source === "user_edited" ? "作者编辑" : asset.source === "imported" ? "导入" : asset.source === "derived" ? "派生" : "AI 生成"}</dd></div><div><dt>保护</dt><dd>{asset.protected ? "已保护" : "未保护"}</dd></div><div><dt>依赖</dt><dd>{asset.dependsOn.length}</dd></div><div><dt>被引用</dt><dd>{asset.referencedBy.length}</dd></div></dl>{asset.tags.length ? <div className="asset-tags">{asset.tags.map((tag) => <span key={tag}>{tag}</span>)}</div> : null}{asset.dependsOn.length ? <Entity variant="memory" initialExpanded><EntityTrigger><Boxes size={14} /><span>上游依赖</span><EntityCaret /></EntityTrigger><EntityContent><Entry><EntryTitle>{asset.dependsOn.join("\n")}</EntryTitle></Entry></EntityContent></Entity> : null}{readable ? <div className="asset-inspector-actions"><button className="primary-button" onClick={() => authoritative ? onOpenArtifact(asset.id) : onOpenFile(asset.path)}><FileCode2 size={16} />打开内容</button>{isMarkdownPath(asset.path) ? <button className="secondary-button" onClick={() => authoritative ? onOpenArtifact(asset.id, true) : onOpenFile(asset.path, true)}><Pencil size={16} />编辑 Markdown</button> : null}<button className="quiet-button" onClick={() => onUseAsContext(contextTarget)}><MessageCircle size={16} />加入对话上下文</button></div> : <p className="asset-inspector-note">此资产尚无可读取的文本内容，生成完成后即可打开并加入上下文。</p>}</aside>;
}

const syntaxLanguage = (kind: NovelFileRecord["kind"]) => kind === "json" ? "json" : "yaml";

export function NovelFileManager({ novelId, onOpenArtifact, onOpenFile, onUseAsContext }: { novelId: string; onOpenArtifact: (key: string, startEditing?: boolean) => void; onOpenFile: (path: string, startEditing?: boolean) => void; onUseAsContext: (target: ConversationContextTarget) => void }) {
  const filesQuery = useQuery({ queryKey: ["files", novelId], queryFn: () => api.files(novelId) });
  const [selected, setSelected] = useState("");
  const files = filesQuery.data?.files ?? [];
  const active = files.find((file) => file.path === selected) ?? files[0];
  useEffect(() => { if (!selected && files[0]) setSelected(files[0].path); }, [files, selected]);
  if (filesQuery.isLoading) return <div className="workspace-loading"><LoaderCircle className="spin" />正在读取当前小说目录…</div>;
  if (filesQuery.error) return <div className="workspace-error"><CircleAlert />{filesQuery.error instanceof Error ? filesQuery.error.message : "无法读取当前小说目录。"}</div>;
  return <section className="asset-center"><header className="workspace-section-heading"><div><span>文件管理</span><h2>当前小说的完整工作目录</h2><p>这里只展示本作品目录。文本文件可阅读，二进制索引和附件会保留在树中但不会被当作文本打开。</p></div><div className="asset-summary"><strong>{files.length}</strong><small>文件</small></div></header><div className="asset-workspace"><div className="asset-list" role="list">{files.map((file) => <button role="listitem" type="button" key={file.path} className={active?.path === file.path ? "active" : ""} onClick={() => setSelected(file.path)} style={{ paddingInlineStart: `${9 + (file.path.split("/").length - 1) * 14}px` }}><FileText size={17} /><span><strong>{file.path.split("/").at(-1)}</strong><small>{file.path}</small></span>{file.kind === "binary" ? <small>二进制</small> : null}</button>)}</div><FileInspector file={active} onOpenArtifact={onOpenArtifact} onOpenFile={onOpenFile} onUseAsContext={onUseAsContext} /></div></section>;
}

function FileInspector({ file, onOpenArtifact, onOpenFile, onUseAsContext }: { file?: NovelFileRecord; onOpenArtifact: (key: string, startEditing?: boolean) => void; onOpenFile: (path: string, startEditing?: boolean) => void; onUseAsContext: (target: ConversationContextTarget) => void }) {
  if (!file) return <aside className="asset-inspector"><FolderKanban size={26} /><h3>目录为空</h3></aside>;
  const readable = file.kind !== "binary";
  const workspaceMarkdown = file.path.startsWith("workspace/") && file.kind === "markdown";
  return <aside className="asset-inspector"><header><span>{file.kind}</span><h3>{file.path.split("/").at(-1)}</h3><p>{file.path}</p></header><dl><div><dt>大小</dt><dd>{file.size.toLocaleString()} B</dd></div><div><dt>更新时间</dt><dd>{new Date(file.modifiedAt).toLocaleString()}</dd></div><div><dt>关联工件</dt><dd>{file.artifactKey ?? "无"}</dd></div></dl>{readable ? <div className="asset-inspector-actions"><button className="primary-button" onClick={() => file.artifactKey ? onOpenArtifact(file.artifactKey) : onOpenFile(file.path)}><FileCode2 size={16} />打开内容</button>{file.artifactKey && isMarkdownPath(file.path) ? <button className="secondary-button" onClick={() => onOpenArtifact(file.artifactKey!, true)}><Pencil size={16} />编辑 Markdown</button> : workspaceMarkdown ? <button className="secondary-button" onClick={() => onOpenFile(file.path, true)}><Pencil size={16} />编辑 Markdown</button> : null}<button className="quiet-button" onClick={() => onUseAsContext(file.artifactKey ? { kind: "artifact", value: file.artifactKey, label: file.path } : { kind: "file", value: file.path, label: file.path })}><MessageCircle size={16} />加入对话上下文</button></div> : <p className="asset-inspector-note">二进制文件不会作为文本预览或对话上下文。</p>}</aside>;
}

function SkillEntity({ skill }: { skill: SkillDefinition }) { return <Entity variant="tool"><EntityTrigger><Sparkles size={15} /><span>{skill.name}</span><small>{skill.scope} · v{skill.version}</small><EntityCaret /></EntityTrigger><EntityContent><Entry><EntryTitle>用途</EntryTitle><p>{skill.description}</p><EntryTitle>输入合同</EntryTitle><p>{skill.inputContract.join(" · ")}</p><EntryTitle>输出合同</EntryTitle><p>{skill.outputContract}</p><EntryTitle>允许工具</EntryTitle><p>{skill.allowedTools.join(" · ") || "不调用工具"}</p></Entry></EntityContent></Entity>; }
function AgentEntity({ profile }: { profile: AgentProfile }) { return <Entity variant="agent"><EntityTrigger><Bot size={15} /><span>{profile.name}</span><small>{profile.modelProfile}</small><EntityCaret /></EntityTrigger><EntityContent><Entry><EntryTitle>启用 Skills</EntryTitle><p>{profile.skillIds.join(" · ") || "无"}</p><EntryTitle>工具边界</EntryTitle><p>{profile.toolIds.join(" · ") || "无"}</p></Entry></EntityContent></Entity>; }
function ToolEntity({ tool }: { tool: { id: string; name: string; description: string; kind: string; approval: string; inputContract: string[]; outputContract: string } }) { return <Entity variant="tool"><EntityTrigger><Wrench size={15} /><span>{tool.name}</span><small>{tool.kind}</small><EntityCaret /></EntityTrigger><EntityContent><Entry><EntryTitle>能力标识</EntryTitle><p>{tool.id}</p><EntryTitle>输入</EntryTitle><p>{tool.inputContract.join(" · ") || "无额外输入"}</p><EntryTitle>输出</EntryTitle><p>{tool.outputContract}</p><EntryTitle>授权</EntryTitle><p>{tool.approval === "author" ? "作者确认" : tool.approval === "workflow" ? "Workflow 控制" : "无需确认"}</p></Entry></EntityContent></Entity>; }

export function CapabilityCenter() {
  const query = useQuery({ queryKey: ["capabilities"], queryFn: api.capabilities });
  if (query.isLoading) return <div className="workspace-loading"><LoaderCircle className="spin" />正在读取创作能力…</div>;
  if (query.error || !query.data) return <div className="workspace-error"><CircleAlert />{query.error instanceof Error ? query.error.message : "无法读取创作能力。"}</div>;
  const data = query.data; const recipe: ProjectRecipe = data.defaultProjectRecipe;
  return <section className="capability-center"><header className="workspace-section-heading"><div><span>创作能力</span><h2>为自动成书组织的 Agent 能力</h2><p>Skills 定义创作方法，Agent Profile 组合模型与工具，Workflow 负责可靠执行。所有执行仍由 Mastra 统一管理。</p></div><div className="asset-summary"><strong>{data.skills.length}</strong><small>启用 Skills</small></div></header><div className="capability-grid"><section><h3><Sparkles size={17} />Skills</h3><p>可复用的创作判断与结构化输出合同。</p><div className="capability-entities">{data.skills.map((skill) => <SkillEntity key={skill.id} skill={skill} />)}</div></section><section><h3><Bot size={17} />Agent Profiles</h3><p>面向具体阶段组合 Skills、工具和模型档位。</p><div className="capability-entities">{data.agentProfiles.map((profile) => <AgentEntity key={profile.id} profile={profile} />)}</div></section><section><h3><Workflow size={17} />生产 Workflow</h3><p>负责重试、暂停、审批、恢复和运行追踪。</p><div className="capability-entities">{data.workflows.map((workflow) => <Entity variant="workflow" key={workflow.id}><EntityTrigger><Workflow size={15} /><span>{workflow.name}</span><small>{workflow.approval}</small><EntityCaret /></EntityTrigger><EntityContent><Entry><p>{workflow.description}</p><EntryTitle>执行阶段</EntryTitle><p>{workflow.stages.join(" → ")}</p></Entry></EntityContent></Entity>)}</div></section><section><h3><Wrench size={17} />项目配方</h3><p>当前默认采用一条串行章节生产链。</p><dl className="recipe-summary"><div><dt>审批方式</dt><dd>{recipe.approvalMode === "auto" ? "自动推进" : "里程碑确认"}</dd></div><div><dt>章节批次</dt><dd>{recipe.chapterBatchSize} 章</dd></div><div><dt>活动 Agent</dt><dd>{recipe.activeAgentProfileIds.length}</dd></div><div><dt>可用工具</dt><dd>{data.agent.tools.length}</dd></div></dl></section><section className="capability-tools"><h3><Wrench size={17} />Tool Manifest</h3><p>每个工具都有明确的输入、输出和授权边界；工具执行由 Mastra Agent 完成。</p><div className="capability-entities">{data.tools.map((tool) => <ToolEntity key={tool.id} tool={tool} />)}</div></section></div></section>;
}

const durationLabel = (ms: number) => ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
const tokenLabel = (tokens: number) => tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);

export function ObservabilityCenter({ novelId }: { novelId?: string }) {
  const [scope, setScope] = useState<"novel" | "all">(novelId ? "novel" : "all");
  const scopedNovelId = scope === "novel" ? novelId : undefined;
  const query = useQuery({ queryKey: ["observability-stats", scopedNovelId ?? "all"], queryFn: () => api.observabilityStats(scopedNovelId) });
  if (query.isLoading) return <div className="workspace-loading"><LoaderCircle className="spin" />正在读取运行统计…</div>;
  if (query.error || !query.data) return <div className="workspace-error"><CircleAlert />{query.error instanceof Error ? query.error.message : "无法读取运行统计。"}</div>;
  const stats = query.data; const total = stats.totals.total || 1; const refreshedAt = new Date(stats.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return <section className="observability-center"><header className="workspace-section-heading"><div><span>运行统计</span><h2>{stats.scope === "novel" ? "当前作品的运行与模型表现" : "全局 Agent 运行与模型表现"}</h2><p>数据来自 Mastra Observability Storage，统计的是实际 Trace、Span 和 Token，不是前端本地推测。最近刷新：{refreshedAt}</p><div className="observability-scope"><button className={scope === "novel" ? "active" : ""} disabled={!novelId} onClick={() => setScope("novel")}>当前作品</button><button className={scope === "all" ? "active" : ""} onClick={() => setScope("all")}>全部运行</button></div></div><div className="asset-summary"><Activity size={20} /><small>实时投影</small></div></header><div className="observability-metrics"><MetricTile label="运行总数" value={String(stats.totals.total)} hint={`${stats.totals.running} 个运行中`} /><MetricTile label="成功率" value={`${Math.round((stats.totals.success / total) * 100)}%`} hint={`${stats.totals.error} 次失败`} tone={stats.totals.error ? "danger" : "good"} /><MetricTile label="平均耗时" value={durationLabel(stats.totals.averageDurationMs)} hint="已结束运行" /><MetricTile label="Token" value={tokenLabel(stats.totals.totalTokens)} hint={`输入 ${tokenLabel(stats.totals.inputTokens)} · 输出 ${tokenLabel(stats.totals.outputTokens)}`} /></div><div className="observability-grid"><section className="observability-card"><header><div><h3>运行状态</h3><p>根 Trace 的最终状态</p></div><BarChart3 size={18} /></header><div className="status-bars"><StatusBar label="成功" count={stats.totals.success} total={total} className="success" /><StatusBar label="失败" count={stats.totals.error} total={total} className="error" /><StatusBar label="运行中" count={stats.totals.running} total={total} className="running" /></div></section><section className="observability-card"><header><div><h3>Span 分布</h3><p>Agent、Workflow、模型和工具执行</p></div><Activity size={18} /></header><div className="span-list">{stats.spans.length ? stats.spans.slice(0, 8).map((item) => <div key={item.type}><span>{item.type}</span><strong>{item.count}</strong></div>) : <p className="observability-empty">还没有可展示的 Trace。</p>}</div></section><section className="observability-card"><header><div><h3>工具调用</h3><p>真实 Tool Span 汇总</p></div><Wrench size={18} /></header><div className="span-list">{stats.tools.length ? stats.tools.map((item) => <div key={item.name}><span>{item.name}</span><strong>{item.count}{item.errors ? <em> · {item.errors} 失败</em> : null}</strong></div>) : <p className="observability-empty">还没有工具调用记录。</p>}</div></section><section className="observability-card observability-recent"><header><div><h3>最近运行</h3><p>与 Studio Trace 列表一致的只读摘要</p></div><FileText size={18} /></header><div className="recent-runs">{stats.recent.length ? stats.recent.map((run) => <div key={`${run.traceId}-${run.startedAt}`}><span className={`run-status-dot ${run.status}`} /><div><strong>{run.name}</strong><small>{run.spanType} · {run.startedAt ? new Date(run.startedAt).toLocaleString() : "时间未知"}</small></div><em>{run.durationMs === undefined ? run.status === "running" ? "运行中" : "—" : durationLabel(run.durationMs)}</em></div>) : <p className="observability-empty">还没有运行记录。</p>}</div></section></div></section>;
}

function MetricTile({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "good" | "danger" }) { return <div className={`observability-metric ${tone ?? ""}`}><span>{label}</span><strong>{value}</strong><small>{hint}</small></div>; }
function StatusBar({ label, count, total, className }: { label: string; count: number; total: number; className: string }) { return <div className="status-bar"><div><span>{label}</span><strong>{count}</strong></div><i><b className={className} style={{ width: `${Math.min(100, (count / total) * 100)}%` }} /></i></div>; }

export function WorkspaceMain({ title, onOpenNavigation, onToggleAgent, onReturnToTask, agentOpen, children }: { title: string; onOpenNavigation: () => void; onToggleAgent: () => void; onReturnToTask?: () => void; agentOpen: boolean; children: ReactNode }) {
  return <section className="workspace-main"><header className="workspace-main-header"><button className="icon-button navigator-trigger" onClick={onOpenNavigation} aria-label="打开生产导航"><Menu size={19} /></button><div><span>当前工作</span><h2>{title}</h2></div><div className="workspace-header-actions">{onReturnToTask && <button className="quiet-button return-task" aria-label="返回当前任务" onClick={onReturnToTask}><ArrowLeft size={17} />返回当前任务</button>}<button className="quiet-button agent-toggle" onClick={onToggleAgent}><MessageCircle size={17} />{agentOpen ? "收起对话" : "对话"}</button></div></header><div className="workspace-main-scroll">{children}</div></section>;
}

export function AgentSidebar({ open, onClose, children, contextLabel, revisionMode, onExitRevision }: { open: boolean; onClose: () => void; children: ReactNode; contextLabel?: string; revisionMode?: boolean; onExitRevision?: () => void }) {
  return <aside className={`agent-sidebar ${open ? "open" : ""}`} aria-label="对话"><header><div><MessageCircle size={18} /><small>{contextLabel ? `当前上下文：${contextLabel}` : "围绕当前工作继续讨论"}</small>{revisionMode && <strong>修改要求模式</strong>}</div><div className="agent-sidebar-actions">{revisionMode && onExitRevision && <button className="quiet-button" onClick={onExitRevision}>退出修改</button>}<button className="icon-button" onClick={onClose} aria-label="收起对话"><X size={18} /></button></div></header><div className="agent-sidebar-body">{children}</div></aside>;
}

export function RunDock({ run, onCancel, onRecover, pending }: { run?: WorkspaceProjection["run"]; onCancel: () => void; onRecover: () => void; pending: boolean }) {
  if (!run) return null;
  const failed = run.status === "failed";
  return <footer className={`run-dock ${failed ? "failed" : ""}`}><span className="run-dock-state">{failed ? <CircleAlert size={17} /> : run.status === "awaiting_review" ? <FileText size={17} /> : <LoaderCircle className={run.status === "running" ? "spin" : ""} size={17} />}</span><div><strong>{failed ? "运行中断" : run.status === "awaiting_review" ? "等待你的确认" : run.status === "running" ? "Workflow 正在运行" : "本次运行已结束"}</strong><small>{run.error?.message ?? run.currentStep ?? (run.recovered ? `已恢复，第 ${run.attempt ?? 1} 次执行` : "状态由服务端投影恢复")}</small></div>{failed ? <button className="secondary-button" disabled={pending} onClick={onRecover}><ChevronLeft size={15} />重新生成</button> : run.status === "running" ? <button className="text-button danger" onClick={onCancel}><Square size={14} />停止</button> : null}</footer>;
}

export function ArtifactReviewWorkspace({ novelId, artifactKey, onSaved, startEditing = false }: { novelId: string; artifactKey: string; onSaved: () => void; startEditing?: boolean }) {
  const queryClient = useQueryClient();
  const artifact = useQuery({ queryKey: ["artifact", novelId, artifactKey], queryFn: () => api.artifact(novelId, artifactKey), enabled: Boolean(artifactKey) });
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [loadedKey, setLoadedKey] = useState("");
  useEffect(() => { if (artifact.data) { setContent(artifact.data.content); if (loadedKey !== artifactKey) { setLoadedKey(artifactKey); setEditing(startEditing); } } }, [artifact.data, artifactKey, loadedKey, startEditing]);
  const save = useMutation({ mutationFn: () => api.editArtifact(novelId, artifactKey, content, artifact.data?.artifact.sha256 ?? ""), onSuccess: async () => { setEditing(false); await Promise.all([queryClient.invalidateQueries({ queryKey: ["artifact", novelId, artifactKey] }), onSaved()]); } });
  if (artifact.isLoading) return <div className="workspace-loading"><LoaderCircle className="spin" />正在读取权威工件…</div>;
  if (artifact.error || !artifact.data) return <div className="workspace-error"><CircleAlert />{artifact.error instanceof Error ? artifact.error.message : "无法读取这个工件。"}</div>;
  return <article className="artifact-review-workspace"><header><div><span>权威工件</span><h2>{artifactKey}</h2><small>{artifact.data.artifact.protected ? "作者已保护，Agent 不会覆盖" : "编辑保存后自动设为作者保护"}</small></div>{!artifactKey.startsWith("export:") && <button className="secondary-button" onClick={() => setEditing((value) => !value)}>{editing ? <Check size={16} /> : <Pencil size={16} />}{editing ? "完成编辑" : "编辑源码"}</button>}</header>{editing ? <textarea className="artifact-editor" rows={28} value={content} onChange={(event) => setContent(event.target.value)} /> : <div className="message-markdown artifact-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>}<footer>{save.error && <span className="workspace-error-inline">{save.error instanceof Error ? save.error.message : "保存失败"}</span>}{artifactKey.startsWith("export:") ? <a className="primary-button" href={api.exportDownloadUrl(novelId, artifact.data.artifact.path)}><Download size={16} />下载 TXT</a> : <button className="primary-button" disabled={!editing || save.isPending || content === artifact.data.content} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" /> : <Check />}保存并保护</button>}</footer></article>;
}

export function NovelFileWorkspace({ novelId, path, startEditing = false, onClose, onSaved }: { novelId: string; path: string; startEditing?: boolean; onClose: () => void; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const file = useQuery({ queryKey: ["file", novelId, path], queryFn: () => api.file(novelId, path), enabled: Boolean(path) });
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [loadedPath, setLoadedPath] = useState("");
  useEffect(() => { if (file.data) { setContent(file.data.content); if (loadedPath !== path) { setLoadedPath(path); setEditing(startEditing); } } }, [file.data, loadedPath, path, startEditing]);
  const canEdit = Boolean(file.data?.path.startsWith("workspace/") && file.data.kind === "markdown");
  const save = useMutation({ mutationFn: () => api.editWorkspaceFile(novelId, path.slice("workspace/".length), content, file.data?.sha256), onSuccess: async () => { setEditing(false); await Promise.all([queryClient.invalidateQueries({ queryKey: ["file", novelId, path] }), queryClient.invalidateQueries({ queryKey: ["files", novelId] }), queryClient.invalidateQueries({ queryKey: ["assets", novelId] }), onSaved()]); } });
  if (file.isLoading) return <div className="workspace-loading"><LoaderCircle className="spin" />正在读取作品文件…</div>;
  if (file.error || !file.data) return <div className="workspace-error"><CircleAlert />{file.error instanceof Error ? file.error.message : "无法读取这个作品文件。"}</div>;
  return <article className="artifact-review-workspace"><header><div><span>作品文件 · 只读目录</span><h2>{file.data.path}</h2><small>{canEdit ? "工作文件可编辑；保存时仍进行内容冲突检查" : "该文件只能阅读，权威内容请通过资产编辑入口修改"}</small></div><div className="asset-inspector-actions"><button className="secondary-button" onClick={onClose}><ChevronLeft size={16} />返回文件</button>{canEdit ? <button className="secondary-button" onClick={() => setEditing((value) => !value)}>{editing ? <Check size={16} /> : <Pencil size={16} />}{editing ? "完成编辑" : "编辑 Markdown"}</button> : null}</div></header>{editing ? <textarea className="artifact-editor" rows={28} value={content} onChange={(event) => setContent(event.target.value)} /> : file.data.kind === "markdown" ? <div className="message-markdown artifact-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div> : <div className="message-markdown artifact-markdown">{file.data.kind === "json" || file.data.kind === "yaml" ? <CodeBlock code={content} language={syntaxLanguage(file.data.kind)} cta={<CodeCopyButton code={content} />} /> : <pre>{content}</pre>}</div>}<footer>{save.error && <span className="workspace-error-inline">{save.error instanceof Error ? save.error.message : "保存失败"}</span>}{canEdit && <button className="primary-button" disabled={!editing || save.isPending || content === file.data.content} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" /> : <Check />}保存工作文件</button>}</footer></article>;
}
