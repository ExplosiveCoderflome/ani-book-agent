import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Controller, useForm, type Control } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useStreamWorkflow } from "@mastra/react";
import { BookOpen, Check, ChevronRight, CircleAlert, Columns3, Download, Eye, Feather, FileText, Lightbulb, LoaderCircle, MessageCircle, Palette, Pencil, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, X } from "lucide-react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import { untitledNovelTitle, type NextAction, type WorkflowId } from "../domain";
import { novelBriefSchema, openingPresetProposalSchema, type ArtifactProposal, type NovelBrief, type OpeningPresetProposal, type RunView, type WorkspaceProjection } from "../shared/contracts";
import { workflowLabels } from "../shared/workflow-catalog";
import { api } from "./api";
import { Conversation, type ConversationRevisionMode } from "./Conversation";
import { persistTheme, readStoredTheme, THEMES, type ThemeId } from "./themes";
import { ThinkingOrb } from "thinking-orbs";
import AnimatedContent from "./react-bits/AnimatedContent";
import ClickSpark from "./react-bits/ClickSpark";
import Magnet from "./react-bits/Magnet";
import ShinyText from "./react-bits/ShinyText";
import SpotlightCard from "./react-bits/SpotlightCard";
import WarpText from "./react-bits/WarpText";
import { AgentSidebar, ArtifactReviewWorkspace, AssetCenter, CapabilityCenter, NovelFileManager, NovelFileWorkspace, NovelWorkbench, ObservabilityCenter, PlatformNavigator, RunDock, WorkspaceMain, type ConversationContextTarget, type WorkspaceSection } from "./workbench/NovelWorkbench";

function ThemeSwitcher({ value, onChange, compact = false }: { value: ThemeId; onChange: (theme: ThemeId) => void; compact?: boolean }) {
  const selected = THEMES.find((theme) => theme.id === value);
  return <label className={compact ? "theme-switcher compact" : "theme-switcher"}><Palette size={16} /><span>主题</span><select aria-label="选择主题" title={selected?.description} value={value} onChange={(event) => onChange(event.target.value as ThemeId)}>{THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.label}</option>)}</select></label>;
}

function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="notice error"><CircleAlert size={18} />{error instanceof Error ? error.message : "操作失败，请重试。"}</div>;
}

function BackendStarting({ onRetry }: { onRetry: () => void }) {
  return <div className="startup-shell"><header className="home-topbar"><div className="brand"><span className="brand-mark"><Feather size={20} /></span><span>ANI 小说 Agent</span></div></header><main className="startup-card"><ThinkingOrb state="connecting" size={64} theme="light" aria-label="正在连接创作服务" /><div><span className="eyebrow">正在准备</span><h1>正在连接创作服务</h1><p>后端服务启动后会自动继续，通常只需要几秒钟。</p></div><button className="secondary-button" onClick={onRetry}><RefreshCw size={16} />立即重试</button></main></div>;
}

const promptGroups = ["对话引导", "书级策划", "章节生产", "审查修复"] as const;
type PromptView = "draft" | "official" | "compare";
function PromptManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient(); const prompts = useQuery({ queryKey: ["prompts"], queryFn: api.prompts, enabled: open });
  const [selectedId, setSelectedId] = useState(""); const detail = useQuery({ queryKey: ["prompt", selectedId], queryFn: () => api.prompt(selectedId), enabled: open && Boolean(selectedId) });
  const [content, setContent] = useState(""); const [view, setView] = useState<PromptView>("draft"); const [filter, setFilter] = useState<"all" | "official" | "custom" | "draft">("all"); const [search, setSearch] = useState(""); const [preview, setPreview] = useState(""); const [previewOpen, setPreviewOpen] = useState(false);
  useEffect(() => { if (!selectedId && prompts.data?.prompts[0]) setSelectedId(prompts.data.prompts[0].id); }, [prompts.data, selectedId]);
  useEffect(() => { if (detail.data) { setContent(detail.data.draftContent ?? detail.data.publishedContent ?? detail.data.defaultContent); setPreview(""); } }, [detail.data]);
  const refresh = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["prompts"] }), queryClient.invalidateQueries({ queryKey: ["prompt", selectedId] })]); };
  const save = useMutation({ mutationFn: () => api.savePromptDraft(selectedId, content), onSuccess: refresh }); const publish = useMutation({ mutationFn: () => api.publishPrompt(selectedId), onSuccess: refresh }); const restore = useMutation({ mutationFn: () => api.restorePrompt(selectedId), onSuccess: refresh }); const render = useMutation({ mutationFn: () => api.previewPrompt(selectedId, content), onSuccess: (result) => { setPreview(result.content); setPreviewOpen(true); } });
  const items = (prompts.data?.prompts ?? []).filter((item) => (`${item.name} ${item.description} ${item.usage}`.toLowerCase().includes(search.toLowerCase())) && (filter === "all" || filter === "draft" ? filter !== "draft" || Boolean(item.draftContent) : item.activeSource === filter)).sort((a, b) => a.order - b.order);
  const changed = detail.data ? content !== (detail.data.draftContent ?? detail.data.publishedContent ?? detail.data.defaultContent) : false;
  const activeContent = detail.data?.publishedContent ?? detail.data?.defaultContent ?? ""; const lines = (value: string) => value.split("\n");
  if (!open) return null;
  return <section className="prompt-workbench" role="dialog" aria-modal="true" aria-labelledby="prompt-manager-title"><header className="prompt-workbench-header"><div><span className="eyebrow">全局配置 · 高级创作控制</span><h1 id="prompt-manager-title">创作提示词工作台</h1><p>官方模板负责稳定边界；用户草稿可在发布前安全调整。</p></div><div className="prompt-header-actions"><span className={detail.data?.activeSource === "custom" ? "source-badge custom" : "source-badge"}>{detail.data?.activeSource === "custom" ? "正在使用自定义版本" : "正在使用官方版本"}</span><button className="icon-button" aria-label="关闭提示词管理" onClick={onClose}><X /></button></div></header><div className="prompt-workbench-body"><aside className="prompt-navigation"><label className="prompt-search"><Search size={16} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索模板或用途" /></label><div className="prompt-filters">{([ ["all", "全部"], ["official", "官方"], ["custom", "自定义"], ["draft", "有草稿"] ] as const).map(([id, label]) => <button key={id} className={filter === id ? "active" : ""} onClick={() => setFilter(id)}>{label}</button>)}</div>{promptGroups.map((group) => { const groupItems = items.filter((item) => item.group === group); return groupItems.length ? <section className="prompt-group" key={group}><h2>{group}</h2>{groupItems.map((item) => <button key={item.id} className={selectedId === item.id ? "prompt-nav-item active" : "prompt-nav-item"} onClick={() => setSelectedId(item.id)}><i className={item.activeSource === "custom" ? "custom" : ""} /><span><strong>{item.name}</strong><small>{item.usage}</small></span>{item.draftSource === "custom" && <em>草稿</em>}</button>)}</section> : null; })}</aside><main className="prompt-editor">{detail.data ? <><div className="prompt-editor-heading"><div><span>{detail.data.group} / {detail.data.usage}</span><h2>{detail.data.name}</h2><p>{detail.data.description}</p></div><div className="prompt-metrics"><span>{content.length.toLocaleString()} 字符</span><span>{lines(content).length} 行</span></div></div><div className="prompt-tabs"><button className={view === "draft" ? "active" : ""} onClick={() => setView("draft")}><Pencil size={15} />用户草稿</button><button className={view === "official" ? "active" : ""} onClick={() => setView("official")}><FileText size={15} />官方模板</button><button className={view === "compare" ? "active" : ""} onClick={() => setView("compare")}><Columns3 size={15} />差异对比</button></div>{view === "draft" ? <textarea className="prompt-editor-textarea" aria-label="用户自定义提示词" value={content} onChange={(event) => setContent(event.target.value)} /> : view === "official" ? <textarea className="prompt-editor-textarea readonly" aria-label="官方提示词" readOnly value={detail.data.defaultContent} /> : content === detail.data.defaultContent ? <div className="prompt-empty"><Columns3 size={24} /><h3>尚未产生自定义差异</h3><p>编辑用户草稿后，这里会对比官方模板与自定义内容。</p></div> : <div className="prompt-compare"><section><h3>官方提示词 <span>只读</span></h3><pre>{lines(detail.data.defaultContent).map((line, index) => <code className={line === lines(content)[index] ? "" : "removed"} key={index}>{line || " "}</code>)}</pre></section><section><h3>用户草稿 <span>可发布</span></h3><pre>{lines(content).map((line, index) => <code className={line === lines(detail.data.defaultContent)[index] ? "" : "added"} key={index}>{line || " "}</code>)}</pre></section></div>}</> : <div className="loading"><LoaderCircle className="spin" />正在读取模板…</div>}</main><aside className="prompt-inspector">{detail.data && <><section><h2>当前状态</h2><dl><div><dt>生效来源</dt><dd>{detail.data.activeSource === "custom" ? "用户已发布" : "官方模板"}</dd></div><div><dt>发布版本</dt><dd>{detail.data.publishedVersion ?? "内置默认"}</dd></div><div><dt>草稿状态</dt><dd>{changed ? "未保存修改" : detail.data.draftSource === "custom" ? "已保存草稿" : "与官方一致"}</dd></div></dl></section><section className="impact-note"><ShieldCheck size={18} /><div><strong>发布影响</strong><p>只影响之后启动的新任务；运行中的任务继续使用启动时版本。</p></div></section><section><h2>系统保护</h2><p>工具策略、结构化 Schema、工件提交和安全边界均由系统固定执行。</p></section><button className="secondary-button preview-trigger" disabled={render.isPending} onClick={() => render.mutate()}><Eye size={16} />{render.isPending ? "正在准备预览…" : "预览实际提示词"}</button></>}</aside></div>{detail.data && <footer className="prompt-actionbar"><span className={changed ? "unsaved" : "saved"}>{changed ? "有未保存修改" : detail.data.draftSource === "custom" ? "草稿已保存" : "当前使用官方模板"}</span><div><button className="quiet-button" disabled={restore.isPending} onClick={() => { if (window.confirm("将立即切回官方提示词，并覆盖当前草稿。确定继续吗？")) restore.mutate(); }}>恢复并使用官方提示词</button><button className="secondary-button" disabled={!changed || save.isPending} onClick={() => save.mutate()}>{save.isPending ? "正在保存…" : "保存草稿"}</button><button className="primary-button" disabled={changed || publish.isPending} onClick={() => publish.mutate()}>{publish.isPending ? "正在发布…" : "发布用户草稿"}</button></div></footer>}{previewOpen && <aside className="prompt-preview-drawer"><header><div><span className="eyebrow">实际发送内容</span><h2>提示词预览</h2></div><button className="icon-button" onClick={() => setPreviewOpen(false)} aria-label="关闭预览"><X /></button></header><p>{detail.data?.activeSource === "custom" ? "用户发布版本" : "官方版本"} · {preview.length.toLocaleString()} 字符</p><pre>{preview}</pre></aside>}<ErrorNotice error={prompts.error ?? detail.error ?? save.error ?? publish.error ?? restore.error ?? render.error} /></section>;
}

function ModelSetup({ open, onClose, required = false }: { open: boolean; onClose: () => void; required?: boolean }) {
  const queryClient = useQueryClient();
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap });
  const catalog = useQuery({ queryKey: ["providers"], queryFn: api.providers, enabled: open });
  const [providerSearch, setProviderSearch] = useState("");
  const [modelSearch, setModelSearch] = useState("");
  const [providerId, setProviderId] = useState("");
  const [modelId, setModelId] = useState("");
  const [credentials, setCredentials] = useState<Record<string, string>>({});
  const [profileModels, setProfileModels] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const providers = catalog.data?.providers ?? [];
  const selected = providers.find((item) => item.id === providerId);
  const filteredProviders = providers.filter((item) => `${item.label} ${item.id}`.toLowerCase().includes(providerSearch.toLowerCase()));
  const models = (selected?.models ?? []).filter((item) => `${item.name} ${item.id}`.toLowerCase().includes(modelSearch.toLowerCase()));

  useEffect(() => {
    const selection = bootstrap.data?.models.selection;
    if (selection && !providerId) { setProviderId(selection.providerId); setModelId(selection.modelId); }
  }, [bootstrap.data, providerId]);

  const save = useMutation({
    mutationFn: () => api.saveModel({ providerId, modelId, credentials }),
    onSuccess: async () => {
      setSaved(true);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bootstrap"] }),
        queryClient.invalidateQueries({ queryKey: ["chat"] }),
      ]);
    },
  });
  const test = useMutation({ mutationFn: api.testModel });
  const saveProfiles = useMutation({ mutationFn: () => api.saveModelProfiles(Object.fromEntries(Object.entries(profileModels).filter(([, value]) => value).map(([name, value]) => [name, { providerId, modelId: value, parameters: {} }]))) });
  if (!open) return null;

  return <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-labelledby="model-title">
    <div className="modal-heading"><div><span className="eyebrow">模型连接</span><h2 id="model-title">连接你的创作模型</h2><p>密钥不会出现在页面、日志或运行记录中。</p></div>{!required && <button className="icon-button" aria-label="关闭" onClick={onClose}><X /></button>}</div>
    <div className="model-grid">
      <div className="provider-pane"><label>搜索服务商<input value={providerSearch} onChange={(event) => setProviderSearch(event.target.value)} placeholder="例如 OpenAI、DeepSeek" /></label><div className="provider-list">
        {filteredProviders.map((provider) => <button type="button" key={provider.id} className={provider.id === providerId ? "provider active" : "provider"} onClick={() => { setProviderId(provider.id); setModelId(""); setCredentials({}); }}><span><strong>{provider.label}</strong><small>{provider.models.length} 个模型</small></span>{provider.connected && <Check size={16} />}</button>)}
      </div></div>
      <div className="model-pane">{!selected ? <div className="empty-compact">从左侧选择一个模型服务商</div> : <>
        <label>选择模型<input value={modelSearch} onChange={(event) => setModelSearch(event.target.value)} placeholder="搜索模型" /></label>
        <select value={modelId} onChange={(event) => setModelId(event.target.value)}><option value="">请选择</option>{models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select>
        {selected.envVar.map((envName) => <label key={envName}>{envName}<input type="password" autoComplete="off" value={credentials[envName] ?? ""} onChange={(event) => setCredentials((current) => ({ ...current, [envName]: event.target.value }))} placeholder={selected.connected ? "留空则继续使用已保存密钥" : "请输入密钥"} /></label>)}
        <p className="security-note">{bootstrap.data?.models.secretPersistence === "session-only" ? "当前系统只在本次运行中保留密钥。" : "密钥由 Windows 当前用户凭据加密保存（DPAPI）。"}</p>
        <div className="button-row"><button className="primary-button" disabled={!providerId || !modelId || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" /> : <Check />}保存设置</button><button className="secondary-button" disabled={!saved || test.isPending} onClick={() => test.mutate()}>{test.isPending ? <LoaderCircle className="spin" /> : <RefreshCw />}测试连接</button></div>
        {saved && <details className="profile-settings"><summary>按任务覆盖模型（可选）</summary><p>留空时继承上面的默认模型。</p>{([ ["chat", "对话"], ["planning", "规划"], ["drafting", "正文"], ["review", "审查"] ] as const).map(([key, label]) => <label key={key}>{label}<select value={profileModels[key] ?? ""} onChange={(event) => setProfileModels((current) => ({ ...current, [key]: event.target.value }))}><option value="">继承默认模型</option>{selected.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}</select></label>)}<button className="secondary-button" disabled={saveProfiles.isPending} onClick={() => saveProfiles.mutate()}>保存任务模型</button><ErrorNotice error={saveProfiles.error} /></details>}
        <p className="cost-note">连接测试会产生一次极小的模型请求，可能产生少量费用。</p>{test.data && <div className="notice success">连接成功 · {test.data.latencyMs} ms</div>}<ErrorNotice error={save.error ?? test.error} />
      </>}</div>
    </div>
    {saved && <div className="modal-footer"><button className="primary-button" onClick={onClose}>开始创作<ChevronRight /></button></div>}
  </section></div>;
}

function HomePage({ onSettings, onPrompts, theme, onThemeChange }: { onSettings: () => void; onPrompts: () => void; theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap });
  const { register, handleSubmit, reset } = useForm<{ title: string; approvalMode: "milestone_approval" | "auto" }>({ defaultValues: { title: "", approvalMode: "milestone_approval" } });
  const create = useMutation({ mutationFn: ({ title, approvalMode }: { title: string; approvalMode: "milestone_approval" | "auto" }) => api.createNovel(title.trim() || untitledNovelTitle, approvalMode), onSuccess: async (novel) => { reset(); await queryClient.invalidateQueries({ queryKey: ["bootstrap"] }); navigate(`/novels/${novel.novelId}`); } });
  return <div className="home-shell"><header className="home-topbar"><div className="brand"><span className="brand-mark"><Feather size={20} /></span><span>ANI 小说 Agent</span></div><div className="topbar-actions"><ThemeSwitcher value={theme} onChange={onThemeChange} /><button className="quiet-button" onClick={onPrompts}><Pencil size={18} />提示词管理</button><button className="quiet-button" onClick={onSettings}><Settings2 size={18} />模型设置</button></div></header><main className="home-page">
    <div className="home-intro">
      <AnimatedContent className="hero" delay={.04}><span className="eyebrow">从灵感到完稿</span><WarpText className="hero-warp-title" text="说出你的故事" color="#1f1915" fontFamily="Georgia, 'Noto Serif SC', serif" fontSize="clamp(3.3rem, 5.6vw, 5.4rem)" fontWeight={650} letterSpacing="-0.035em" warpStrength={0.18} warpScale={1.7} speed={0.55} pointerInfluence={0.85} pointerStrength={1.25} refraction={0.04} /><p>从故事方向、人物与世界，到逐章创作和完稿审阅，Agent 陪你一步步完成。</p><div className="hero-path" aria-label="创作流程"><span>聊出灵感</span><i /><span>搭好故事</span><i /><span>逐章写完</span></div></AnimatedContent>
      <AnimatedContent className="create-card" delay={.16}><div className="create-card-heading"><span className="create-step">从这里开始</span><h2>创建新作品</h2><p>标题可以稍后再定，先给故事留一个位置。</p></div><form onSubmit={handleSubmit((value) => create.mutate(value))}><label><span>作品名 <small>选填</small></span><input {...register("title", { maxLength: 80 })} placeholder="例如：雾海尽头" autoFocus /></label><label><span>创作推进方式</span><Magnet padding={26} magnetStrength={30} wrapperClassName="magnet-select"><SpotlightCard className="select-spotlight"><select {...register("approvalMode")}><option value="milestone_approval">关键节点由我确认（推荐）</option><option value="auto">普通节点自动推进</option></select></SpotlightCard></Magnet></label><ClickSpark sparkColor="#f5c46a" sparkRadius={22} sparkCount={10}><Magnet padding={36} magnetStrength={16} wrapperClassName="magnet-cta"><button className="primary-button create-button" disabled={create.isPending}>{create.isPending ? <LoaderCircle className="spin" /> : <Plus />}{create.isPending ? "正在创建…" : "开始这部小说"}<ChevronRight size={18} /></button></Magnet></ClickSpark></form><p className="create-assurance"><Sparkles size={15} />没有想法也没关系，创建后 Agent 会给你具体选项。</p><ErrorNotice error={create.error} /></AnimatedContent>
    </div>
    <AnimatedContent className="recent-section" delay={0.26}><div className="section-heading"><div><span className="eyebrow">你的书架</span><h2>继续创作</h2></div><span>{bootstrap.data?.novels.length ?? 0} 部作品</span></div>
      {bootstrap.isLoading ? <div className="loading"><LoaderCircle className="spin" />正在整理书架…</div> : bootstrap.data?.novels.length ? <div className="novel-grid">{bootstrap.data.novels.map((novel, index) => <AnimatedContent key={novel.id} delay={index * 0.07} distance={20}><Magnet padding={36} magnetStrength={42} wrapperClassName="novel-magnet"><SpotlightCard className="novel-spotlight"><ClickSpark sparkColor="#bd7a2d" sparkRadius={24} sparkCount={9}><Link className="novel-card" to={`/novels/${novel.id}`}><div className="book-cover"><span>{String(index + 1).padStart(2, "0")}</span><BookOpen /></div><div className="novel-card-copy"><span>长篇小说</span><h3>{novel.title}</h3><p>继续上次的创作对话</p></div><span className="novel-card-action">继续写<ChevronRight size={17} /></span></Link></ClickSpark></SpotlightCard></Magnet></AnimatedContent>)}</div> : <div className="empty-state story-empty">还没有作品。创建第一部小说后，它会出现在这里。</div>}<ErrorNotice error={bootstrap.error} />
    </AnimatedContent>
  </main></div>;
}

const starterMessages = [
  ["我完全没有想法", "我想写一本长篇小说，但现在完全没有想法。请先用可点击选项给我恰好五条差异明显、容易产生继续创作欲望的一句话开书种子，然后再一次只问我一个问题。"],
  ["我有一个模糊点子", "我有一点模糊想法，但还没整理好。请用一次一个问题的方式帮我说清楚，并且每次给我几个具体备选。"],
  ["我只知道想要的感觉", "我还不知道写什么，只知道想从阅读感觉开始。请先给我几个明显不同的感觉方向让我选。"],
] as const;

function PresetProposalCard({ novelId, proposal, onSaved, onReset }: { novelId: string; proposal: OpeningPresetProposal; onSaved: () => void; onReset: () => void }) {
  const { register, handleSubmit } = useForm<OpeningPresetProposal>({ resolver: zodResolver(openingPresetProposalSchema), defaultValues: proposal });
  const save = useMutation({ mutationFn: (value: OpeningPresetProposal) => { const { rationale: _rationale, ...preset } = value; return api.saveChoices(novelId, preset); }, onSuccess: onSaved });
  return <section className="flow-card preset-card"><div className="card-speaker"><Sparkles size={16} />根据对话整理的提案</div><h2>确认这份开书预设</h2><p>{proposal.rationale}</p><form className="preset-form" onSubmit={handleSubmit((value) => save.mutate(value))}><label>暂定书名<input {...register("workingTitle")} /></label><label>故事方向<textarea rows={4} {...register("storyDirection")} /></label><div className="preset-grid"><label>类型定位<input {...register("genre")} /></label><label>整体气质<input {...register("tone")} /></label><label>主要读者频道<input {...register("channel")} /></label><label>发布形态<input {...register("format")} /></label></div><label>主要阅读回报<textarea rows={2} {...register("primaryReward")} /></label><div className="approval-box"><strong>确认后会发生什么？</strong><p>这份预设会成为小说简报的生成依据；普通聊天内容不会直接写入作品。</p></div><div className="review-actions"><button className="primary-button" type="submit" disabled={save.isPending}>{save.isPending ? <LoaderCircle className="spin" /> : <Check />}确认预设并继续</button><button className="secondary-button" type="button" onClick={onReset}>继续聊，再整理一次</button></div><ErrorNotice error={save.error} /></form></section>;
}

function DiscoveryCard({ isRunning, onSend }: { isRunning: boolean; onSend: (text: string) => Promise<void> }) {
  return <section className="flow-card discovery-card"><div className="card-speaker"><Lightbulb size={16} />聊天式开书</div><h2>我们先聊，不用先填任何设置</h2><p>选择最接近你现在状态的一句话，或者直接在下面输入。之后我每次只问一个问题，并给你几个备选方案。</p><div className="starter-options">{starterMessages.map(([label, message]) => <button className="secondary-button" key={label} disabled={isRunning} onClick={() => onSend(message)}>{label}<ChevronRight size={17} /></button>)}</div></section>;
}

function GenerationProgress({ onCancel, run, label = "当前工件" }: { onCancel: () => void; run: NonNullable<WorkspaceProjection["run"]>; label?: string }) {
  const heading = run.recovered ? `正在恢复并继续${label}` : `正在推进${label}`;
  const stage = run.currentStep ?? (run.recovered ? `恢复执行，第 ${run.attempt ?? 1} 次尝试` : "执行 Workflow");
  return <SpotlightCard className="flow-card progress-card"><div className="generation-orb"><ThinkingOrb state="composing" size={64} theme="light" aria-label="正在生成创作内容" /></div><div><div className="card-speaker"><Sparkles size={16} />{run.recovered ? "恢复运行" : "正在生成"}</div><h2><ShinyText text={heading} color="var(--ink)" shineColor="var(--amber)" speed={2} /></h2><div className="progress-steps"><span className="done"><Check />装配权威上下文</span><span className="active"><ThinkingOrb state="working" size={20} theme="light" />{stage}</span><span>校验并提交结果</span></div><button className="text-button danger" onClick={onCancel}>取消本次运行</button></div></SpotlightCard>;
}

type BriefForm = Omit<NovelBrief, "risks"> & { risksText: string };
const briefFormSchema = novelBriefSchema.omit({ risks: true }).extend({ risksText: z.string().trim().min(1) });
const briefFields: Array<[keyof Omit<BriefForm, "risksText">, string]> = [["workingTitle", "工作书名"], ["oneSentencePremise", "一句话故事"], ["targetReaders", "目标读者"], ["primaryReaderReward", "主要阅读回报"], ["protagonist", "主角"], ["coreConflict", "核心冲突"], ["storyEngine", "故事引擎"], ["openingHook", "开篇钩子"], ["longTermPromise", "长线承诺"]];

function EditableBriefField({ control, name, label, rows = 3 }: { control: Control<BriefForm>; name: keyof BriefForm; label: string; rows?: number }) {
  const [editing, setEditing] = useState(false);
  return <Controller name={name} control={control} render={({ field }) => <div className="editable-field" data-field={name}><span className="editable-field-label">{label}</span>{editing ? <textarea {...field} className="editable-input" autoFocus rows={rows} onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.blur(); }} onBlur={() => { field.onBlur(); setEditing(false); }} /> : <button type="button" className="editable-display" aria-label={`编辑${label}`} onClick={() => setEditing(true)}><span className="editable-copy">{field.value || "点击添加内容"}</span><span className="editable-hint" aria-hidden="true"><Pencil size={13} />编辑</span></button>}</div>} />;
}

function BriefProposal({ run, onUpdated, onCanceled, onRequestRevision }: { run: RunView; onUpdated: () => void; onCanceled: () => void; onRequestRevision: () => void }) {
  const proposal = run.proposal!;
  const { control, handleSubmit } = useForm<BriefForm>({ resolver: zodResolver(briefFormSchema), defaultValues: { ...proposal, risksText: proposal.risks.join("\n") } });
  const review = useMutation({ mutationFn: (body: Parameters<typeof api.review>[1]) => api.review(run.runId, body), onSuccess: (_value, body) => body.action === "cancel" ? onCanceled() : onUpdated() });
  const toBrief = (value: BriefForm): NovelBrief => ({ ...value, risks: value.risksText.split("\n").map((item) => item.trim()).filter(Boolean) });
  return <section className="flow-card brief-card"><div className="card-speaker"><Sparkles size={16} />待确认提案</div><h2>小说简报提案</h2><p>这是提案，不是定稿。点击任意内容即可编辑，批准后才会保存。</p><form className="brief-form" onSubmit={handleSubmit((value) => review.mutate({ action: "approve", brief: toBrief(value) }))}>{briefFields.map(([name, label]) => <EditableBriefField key={name} control={control} name={name} label={label} rows={name === "workingTitle" ? 1 : 3} />)}<EditableBriefField control={control} name="risksText" label="风险与提醒" rows={4} /><div className="approval-box"><strong>批准后会发生什么？</strong><p>当前内容会写入小说简报 Markdown，并成为后续“故事圣经”的上游依据。</p></div><div className="review-actions"><button className="primary-button" type="submit" disabled={review.isPending}><Check />批准并保存</button><button className="secondary-button" type="button" disabled={review.isPending} onClick={onRequestRevision}><RefreshCw />要求调整</button></div><button type="button" className="text-button danger" onClick={() => review.mutate({ action: "cancel" })}>取消本次生成</button><ErrorNotice error={review.error} /></form></section>;
}

function EditableMarkdown({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  return <section className={editing ? "markdown-workspace editing" : "markdown-workspace"} aria-label="Markdown 工件内容">
    <header className="markdown-workspace-header"><span>{editing ? "Markdown 源码" : "排版预览"}</span><button type="button" className="markdown-edit-button" onClick={() => setEditing((current) => !current)}>{editing ? <><Check size={15} />完成编辑</> : <><Pencil size={15} />编辑源码</>}</button></header>
    {editing ? <textarea className="markdown-source-editor" rows={22} value={value} autoFocus onChange={(event) => onChange(event.target.value)} /> : <div className="message-markdown markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown></div>}
  </section>;
}

function ArtifactProposalCard({ run, onUpdated, onCanceled, onRequestRevision }: { run: RunView; onUpdated: () => void; onCanceled: () => void; onRequestRevision: (proposal: ArtifactProposal) => void }) {
  const proposal = run.artifactProposal!;
  const [content, setContent] = useState(proposal.content);
  const review = useMutation({ mutationFn: (body: Parameters<typeof api.review>[1]) => api.review(run.runId, body), onSuccess: (_value, body) => body.action === "cancel" ? onCanceled() : onUpdated() });
  const edited: ArtifactProposal = { ...proposal, content, files: proposal.files.map((file, index) => index === 0 ? { ...file, content } : file) };
  return <section className="flow-card brief-card"><div className="card-speaker"><Sparkles size={16} />待确认提案</div><h2>{proposal.title}</h2><p>这是可编辑提案。默认显示排版效果，点击“编辑源码”后再修改；批准后才会写入权威工件。</p><EditableMarkdown value={content} onChange={setContent} /><div className="review-actions"><button className="primary-button" disabled={review.isPending} onClick={() => review.mutate({ action: "approve", proposal: edited })}><Check />批准并保存</button><button className="secondary-button" disabled={review.isPending} onClick={() => onRequestRevision(edited)}><RefreshCw />要求调整</button></div><button className="text-button danger" onClick={() => review.mutate({ action: "cancel" })}>取消本次生成</button><ErrorNotice error={review.error} /></section>;
}

function NextStepCard({ next, pending, onStart, onRange, onVolume }: { next: NextAction; pending: boolean; onStart: (workflowId: WorkflowId, target?: string) => void; onRange: (start: number, end: number, autoApproveMilestones: boolean) => void; onVolume: (plan: { number: number; startChapter: number; endChapter: number; final: boolean }) => void }) {
  const [rangeEnd, setRangeEnd] = useState(next.type === "approve_chapter_range" ? next.chapter : 1);
  const [volumeEnd, setVolumeEnd] = useState(next.type === "configure_volume" ? next.suggestedEndChapter : 10);
  const [isFinalVolume, setIsFinalVolume] = useState(false);
  const [autoApproveMilestones, setAutoApproveMilestones] = useState(false);
  if (next.type === "configure_volume") return <section className="flow-card action-card"><div className="card-speaker"><BookOpen size={16} />卷规划</div><h2>确定第 {next.volume} 卷的范围</h2><p>{next.reason} 先给这一卷一个明确的收束点，后续章节会围绕卷目标逐章推进。</p><label>本卷写到第几章<input type="number" min={next.startChapter} max={next.startChapter + 99} value={volumeEnd} onChange={(event) => setVolumeEnd(Number(event.target.value))} /></label><label className="volume-final-toggle"><input type="checkbox" checked={isFinalVolume} onChange={(event) => setIsFinalVolume(event.target.checked)} />这是最终卷，完成后标记整部小说完本</label><button className="primary-button" disabled={pending || volumeEnd < next.startChapter} onClick={() => onVolume({ number: next.volume, startChapter: next.startChapter, endChapter: volumeEnd, final: isFinalVolume })}><Check />确认第 {next.volume} 卷范围</button></section>;
  if (next.type === "complete_novel") return <section className="flow-card complete-card"><div className="complete-mark"><Check /></div><h2>这部小说已经写完</h2><p>{next.reason}</p><button className="primary-button" onClick={() => onStart("novel-export")}><Download size={17} />导出稳定章节 TXT</button></section>;
  if (next.type === "completion_blocked") return <section className="flow-card action-card"><div className="card-speaker"><CircleAlert size={16} />完本验收未通过</div><h2>还有 {next.blockers.length} 项需要处理</h2><p>{next.reason}</p><ul className="blocker-list">{next.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul><button className="secondary-button" disabled={pending} onClick={() => onStart(next.workflowId)}><RefreshCw />修复后重新验收</button></section>;
  if (next.type === "approve_chapter_range") return <section className="flow-card action-card"><div className="card-speaker"><BookOpen size={16} />章节生产授权</div><h2>批准下一段章节范围</h2><p>{next.reason} 章节会严格串行：当前章定稿并回灌连续性后才进入下一章。</p><label>生产到第几章<input type="number" min={next.chapter} max={next.chapter + 99} value={rangeEnd} onChange={(event) => setRangeEnd(Number(event.target.value))} /></label><fieldset className="production-mode"><legend>创作方式</legend><label><input type="radio" name="production-mode" checked={!autoApproveMilestones} onChange={() => setAutoApproveMilestones(false)} />逐项确认（推荐）<small>关键规划完成后由你确认，再继续创作。</small></label><label><input type="radio" name="production-mode" checked={autoApproveMilestones} onChange={() => setAutoApproveMilestones(true)} />全自动推进<small>自动完成准备工件并连续生产至目标章节；你可随时停止。</small></label></fieldset><button className="primary-button" disabled={pending || rangeEnd < next.chapter} onClick={() => onRange(next.chapter, rangeEnd, autoApproveMilestones)}><Check />{autoApproveMilestones ? `自动创作至第 ${rangeEnd} 章` : `批准第 ${next.chapter}–${rangeEnd} 章`}</button></section>;
  if (next.type === "collect_opening_choices") return null;
  const workflowId = next.workflowId;
  if (!workflowId) return <RecoveryCard error="当前步骤缺少 Workflow 映射。" pending={false} onRetry={() => undefined} />;
  const chapterTarget = next.artifactKey.startsWith("chapter:") ? next.artifactKey.split(":")[1] : undefined;
  const label = workflowLabels[workflowId];
  const refreshing = next.type === "refresh_artifact";
  return <section className="flow-card next-step-card"><header className="next-step-heading"><span className="next-step-icon"><Sparkles size={19} /></span><div><span>推荐下一步</span><h2>{label}</h2></div></header><p className="next-step-reason">{refreshing ? `${label}的上游内容已有变化，需要重新整理。` : `创作链已经准备好进入“${label}”。`}</p><div className="next-step-note"><Check size={17} /><div><strong>安全生成</strong><p>读取已确认的上游内容，完成校验后按需交给你批准；受保护内容不会被覆盖。</p></div></div><button className="primary-button next-step-action" disabled={pending} onClick={() => onStart(workflowId, chapterTarget)}>{pending ? <><LoaderCircle className="spin" />正在启动…</> : <><Sparkles />{refreshing ? "重新生成" : "生成"}{label}</>}</button></section>;
}

function RecoveryCard({ error, onRetry, pending }: { error?: string; onRetry: () => void; pending: boolean }) {
  return <section className="flow-card action-card"><div className="card-speaker"><CircleAlert size={16} />本次生成未完成</div><h2>我们可以从这里重新开始</h2><p>{error ?? "这次生成已取消，没有修改作品文件。"}</p><button className="secondary-button" disabled={pending} onClick={onRetry}>{pending ? <LoaderCircle className="spin" /> : <RefreshCw />}{pending ? "正在重新生成…" : "重新生成"}</button></section>;
}

function NovelPage({ onSettings, onPrompts, theme, onThemeChange }: { onSettings: () => void; onPrompts: () => void; theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap });
  const workspace = useQuery({ queryKey: ["workspace", id], queryFn: () => api.workspace(id), enabled: Boolean(id), retry: false, refetchInterval: (query) => query.state.data?.run?.status === "running" ? 4_000 : false });
  const chat = useQuery({ queryKey: ["chat", id], queryFn: () => api.chat(id), enabled: Boolean(id) && Boolean(bootstrap.data?.models.configured), retry: false });
  const [workspaceSection, setWorkspaceSection] = useState<WorkspaceSection>("production");
  const [selectedArtifact, setSelectedArtifact] = useState("");
  const [selectedAsset, setSelectedAsset] = useState("");
  const [openedFile, setOpenedFile] = useState("");
  const [artifactEditing, setArtifactEditing] = useState(false);
  const [fileEditing, setFileEditing] = useState(false);
  const [conversationContext, setConversationContext] = useState<ConversationContextTarget>();
  const [revisionMode, setRevisionMode] = useState<ConversationRevisionMode | undefined>();
  const [agentOpeningProposal, setAgentOpeningProposal] = useState<OpeningPresetProposal | undefined>();
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [agentOpen, setAgentOpen] = useState(() => { try { return !window.matchMedia("(max-width: 760px)").matches && window.localStorage.getItem("ani-novel-agent-sidebar") !== "closed"; } catch { return true; } });
  const workflowStream = useStreamWorkflow({ debugMode: false, onError: () => undefined });
  const observedRunRef = useRef("");
  const refreshWorkspace = async () => { await queryClient.invalidateQueries({ queryKey: ["workspace", id] }); };
  const start = useMutation({ mutationFn: ({ workflowId, target }: { workflowId: WorkflowId; target?: string }) => api.startRun(id, workflowId, target), onSuccess: refreshWorkspace });
  const range = useMutation({ mutationFn: ({ start, end, autoApproveMilestones }: { start: number; end: number; autoApproveMilestones: boolean }) => api.autoDirector(id, start, end, autoApproveMilestones), onSuccess: refreshWorkspace });
  const volume = useMutation({ mutationFn: (plan: { number: number; startChapter: number; endChapter: number; final: boolean }) => api.configureVolume(id, plan), onSuccess: refreshWorkspace });
  const exportRun = useMutation({ mutationFn: () => api.exportNovel(id), onSuccess: refreshWorkspace });
  const openingProposal = useMutation({ mutationFn: () => api.proposePreset(id) });

  useEffect(() => { openingProposal.reset(); setAgentOpeningProposal(undefined); setWorkspaceSection("production"); setSelectedArtifact(""); setSelectedAsset(""); setOpenedFile(""); setArtifactEditing(false); setFileEditing(false); setConversationContext(undefined); setRevisionMode(undefined); setNavigationOpen(false); }, [id]);
  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 760px)");
    const closeDrawer = (event: MediaQueryListEvent | MediaQueryList) => { if (event.matches) setAgentOpen(false); };
    closeDrawer(mobile); mobile.addEventListener("change", closeDrawer);
    return () => mobile.removeEventListener("change", closeDrawer);
  }, []);
  useEffect(() => { try { if (!window.matchMedia("(max-width: 760px)").matches) window.localStorage.setItem("ani-novel-agent-sidebar", agentOpen ? "open" : "closed"); } catch { /* current session still works */ } }, [agentOpen]);
  useEffect(() => {
    const focus = workspace.data?.focus;
    if (workspaceSection !== "production") return;
    if (focus?.kind === "generation" || focus?.kind === "review" || focus?.kind === "blocked") { setSelectedArtifact(""); setArtifactEditing(false); }
    else if (focus?.kind === "artifact") { setSelectedArtifact(focus.artifactKey); setArtifactEditing(false); }
  }, [workspace.data?.focus, workspaceSection]);
  useEffect(() => { if (workspace.data?.focus.kind !== "review") setRevisionMode(undefined); }, [workspace.data?.focus.kind]);
  useEffect(() => {
    const run = workspace.data?.run;
    const key = run?.status === "running" && run.workflowId ? `${run.workflowId}:${run.runId}` : "";
    if (!key) {
      if (observedRunRef.current) workflowStream.closeStreamsAndReset();
      observedRunRef.current = "";
      return;
    }
    if (observedRunRef.current === key) return;
    workflowStream.closeStreamsAndReset();
    observedRunRef.current = key;
    void workflowStream.observeWorkflowStream.mutateAsync({ workflowId: run!.workflowId!, runId: run!.runId, storeRunResult: null }).then(refreshWorkspace).catch(() => undefined);
  }, [workspace.data?.run?.runId, workspace.data?.run?.status, workspace.data?.run?.workflowId]);
  useEffect(() => {
    if (!observedRunRef.current) return;
    const timer = window.setTimeout(() => { void refreshWorkspace(); }, 350);
    return () => window.clearTimeout(timer);
  }, [workflowStream.streamResult]);
  useEffect(() => () => workflowStream.closeStreamsAndReset(), []);

  const activeOpeningProposal = openingProposal.data ?? agentOpeningProposal;
  const resetOpeningProposal = useCallback(() => { openingProposal.reset(); setAgentOpeningProposal(undefined); }, [openingProposal]);
  const saveChoices = async () => { resetOpeningProposal(); await Promise.all([refreshWorkspace(), queryClient.invalidateQueries({ queryKey: ["chat", id] }), queryClient.invalidateQueries({ queryKey: ["bootstrap"] })]); };
  const cancel = async () => { const runId = workspace.data?.run?.runId; if (runId) { await api.review(runId, { action: "cancel" }); await refreshWorkspace(); } };
  const retryRun = () => {
    const projection = workspace.data;
    const workflowId = projection?.run?.workflowId;
    if (workflowId && workflowId !== "auto-director" && workflowId !== "chapter-range") {
      const next = projection.nextAction;
      const target = "artifactKey" in next && next.artifactKey.startsWith("chapter:") ? next.artifactKey.split(":")[1] : undefined;
      start.mutate({ workflowId, target });
      return;
    }
    const next = projection?.nextAction;
    if (next?.type === "produce_artifact" || next?.type === "refresh_artifact") {
      if (next.workflowId) start.mutate({ workflowId: next.workflowId, target: next.artifactKey.startsWith("chapter:") ? next.artifactKey.split(":")[1] : undefined });
    } else if (next?.type === "approve_chapter_range") range.mutate({ start: next.chapter, end: next.chapter, autoApproveMilestones: false });
    else if (next?.type === "completion_blocked") start.mutate({ workflowId: next.workflowId });
  };
  const projection = workspace.data;
  const reviewRun: RunView | undefined = projection?.review && projection.run ? (() => {
    const structured = novelBriefSchema.safeParse(projection.review!.proposal.metadata.structured);
    return { ...projection.run!, novelId: id, executionStatus: "suspended", artifactProposal: projection.review!.proposal, ...(structured.success ? { proposal: structured.data } : {}) };
  })() : undefined;
  const requestRevision = (proposal?: ArtifactProposal) => {
    if (!reviewRun) return;
    setRevisionMode({ label: projection?.review?.artifactKey === "novel-brief" ? "小说简报" : (projection?.focus.title ?? "当前工件"), onSubmit: async (feedback) => { await api.review(reviewRun.runId, { action: "revise", feedback, ...(proposal ? { proposal } : {}) }); setRevisionMode(undefined); await refreshWorkspace(); }, onExit: () => setRevisionMode(undefined) });
    setAgentOpen(true);
  };
  const contextLabel = projection?.focus.kind === "review" ? (projection.review?.artifactKey === "novel-brief" ? "小说简报提案" : projection.focus.title) : conversationContext?.label ?? (selectedArtifact || (workspaceSection === "assets" ? "作品资产" : workspaceSection === "files" ? "文件管理" : workspaceSection === "capabilities" ? "创作能力" : workspaceSection === "observability" ? "运行统计" : projection?.focus.title));
  const currentArtifactKey = conversationContext?.kind === "artifact" ? conversationContext.value : selectedArtifact || projection?.review?.artifactKey;
  const currentFilePath = conversationContext?.kind === "file" ? conversationContext.value : undefined;
  const openArtifact = (key: string, startEditing = false) => { setSelectedArtifact(key); setArtifactEditing(startEditing); setOpenedFile(""); setFileEditing(false); };
  const openFile = (path: string, startEditing = false) => { setOpenedFile(path); setFileEditing(startEditing); setSelectedArtifact(""); setArtifactEditing(false); };
  const conversation = chat.data ? <Conversation novelId={id} initialMessages={chat.data.messages} revisionMode={revisionMode} contextLabel={contextLabel} currentArtifactKey={currentArtifactKey} currentFilePath={currentFilePath} onOpeningPresetReady={setAgentOpeningProposal} onConversationChange={() => Promise.all([refreshWorkspace(), queryClient.invalidateQueries({ queryKey: ["chat", id] })]).then(() => undefined)} discoveryAction={projection?.phase === "discovery" && !activeOpeningProposal ? { pending: openingProposal.isPending, error: openingProposal.error, onConfirm: () => openingProposal.mutate() } : undefined} emptyState={({ sendMessage, isRunning }) => <DiscoveryCard isRunning={isRunning} onSend={sendMessage} />} /> : <div className="workspace-loading"><LoaderCircle className="spin" />正在恢复创作对话…</div>;
  const busy = start.isPending || range.isPending || volume.isPending || exportRun.isPending;
  const productionContent = !projection ? <div className="workspace-loading"><LoaderCircle className="spin" />正在恢复作品工作台…</div>
    : activeOpeningProposal ? <PresetProposalCard novelId={id} proposal={activeOpeningProposal} onSaved={saveChoices} onReset={resetOpeningProposal} />
    : projection.focus.kind === "conversation" ? <section className="flow-card action-card conversation-handoff"><div className="card-speaker"><Sparkles size={16} />灵感发现</div><h2>先把想法说完整</h2><p>所有对话和快捷选择都在右侧。你可以随时补充设定，准备好后再整理成开书方案。</p><button type="button" className="secondary-button" onClick={() => setAgentOpen(true)}><MessageCircle size={16} />打开右侧对话</button></section>
    : projection.focus.kind === "review" && reviewRun?.proposal ? <BriefProposal key={`${reviewRun.runId}-${reviewRun.proposal.openingHook}`} run={reviewRun} onUpdated={refreshWorkspace} onCanceled={refreshWorkspace} onRequestRevision={() => requestRevision()} />
    : projection.focus.kind === "review" && reviewRun?.artifactProposal ? <ArtifactProposalCard key={`${reviewRun.runId}-${reviewRun.artifactProposal.content.length}`} run={reviewRun} onUpdated={refreshWorkspace} onCanceled={refreshWorkspace} onRequestRevision={requestRevision} />
    : projection.focus.kind === "generation" && projection.run ? <GenerationProgress run={projection.run} label={projection.run.workflowId ? workflowLabels[projection.run.workflowId] : undefined} onCancel={cancel} />
    : projection.focus.kind === "blocked" ? <RecoveryCard error={projection.focus.message} pending={start.isPending} onRetry={retryRun} />
    : selectedArtifact ? <ArtifactReviewWorkspace novelId={id} artifactKey={selectedArtifact} startEditing={artifactEditing} onSaved={refreshWorkspace} />
    : <NextStepCard next={projection.nextAction} pending={busy} onStart={(workflowId, target) => workflowId === "novel-export" ? exportRun.mutate() : start.mutate({ workflowId, target })} onRange={(startChapter, endChapter, autoApproveMilestones) => range.mutate({ start: startChapter, end: endChapter, autoApproveMilestones })} onVolume={(plan) => volume.mutate(plan)} />;
  const focusContent = workspaceSection === "assets"
    ? selectedArtifact ? <ArtifactReviewWorkspace novelId={id} artifactKey={selectedArtifact} startEditing={artifactEditing} onSaved={async () => { await Promise.all([refreshWorkspace(), queryClient.invalidateQueries({ queryKey: ["assets", id] })]); }} /> : openedFile ? <NovelFileWorkspace novelId={id} path={openedFile} startEditing={fileEditing} onClose={() => { setOpenedFile(""); setFileEditing(false); }} onSaved={refreshWorkspace} /> : <AssetCenter novelId={id} selectedAsset={selectedAsset} onSelectAsset={setSelectedAsset} onOpenArtifact={openArtifact} onOpenFile={openFile} onUseAsContext={setConversationContext} />
    : workspaceSection === "files" ? openedFile ? <NovelFileWorkspace novelId={id} path={openedFile} startEditing={fileEditing} onClose={() => { setOpenedFile(""); setFileEditing(false); }} onSaved={refreshWorkspace} /> : <NovelFileManager novelId={id} onOpenArtifact={openArtifact} onOpenFile={openFile} onUseAsContext={setConversationContext} />
    : workspaceSection === "capabilities" ? <CapabilityCenter />
      : workspaceSection === "observability" ? <ObservabilityCenter novelId={id} />
      : productionContent;
  const showAgent = Boolean(projection && (agentOpen || revisionMode));
  const focusTitle = selectedArtifact || openedFile || (workspaceSection === "assets" ? "作品资产" : workspaceSection === "files" ? "文件管理" : workspaceSection === "capabilities" ? "创作能力" : workspaceSection === "observability" ? "运行统计" : projection?.focus.title) || "作品工作台";
  const returnToTask = workspaceSection !== "production" || selectedArtifact ? () => { setWorkspaceSection("production"); setSelectedArtifact(""); } : undefined;

  return <div className="novel-workbench-page"><header className="workbench-topbar"><Link to="/" className="brand"><span className="brand-mark"><Feather size={18} /></span><span>ANI 小说 Agent</span></Link><div className="workbench-title"><small>当前作品</small><h1>{projection?.novel.title ?? "正在打开…"}</h1></div><div className="workbench-global-actions"><ThemeSwitcher compact value={theme} onChange={onThemeChange} /><button className="quiet-button" onClick={onPrompts}><Pencil size={16} />提示词</button><button className="quiet-button" onClick={onSettings}><Settings2 size={16} />模型</button></div></header>
    {projection ? <NovelWorkbench agentOpen={showAgent} navigation={<PlatformNavigator projection={projection} section={workspaceSection} selectedArtifact={selectedArtifact} onSelectSection={(section) => { setWorkspaceSection(section); setSelectedArtifact(""); setOpenedFile(""); setArtifactEditing(false); setFileEditing(false); }} onSelectArtifact={(key) => { setWorkspaceSection("production"); setSelectedArtifact(key); setOpenedFile(""); setArtifactEditing(false); setFileEditing(false); setNavigationOpen(false); }} mobileOpen={navigationOpen} onCloseMobile={() => setNavigationOpen(false)} />} main={<WorkspaceMain title={focusTitle} agentOpen={showAgent} onOpenNavigation={() => setNavigationOpen(true)} onToggleAgent={() => setAgentOpen((value) => !value)} onReturnToTask={returnToTask}>{focusContent}<ErrorNotice error={workspace.error ?? chat.error ?? start.error ?? range.error ?? volume.error ?? exportRun.error} /></WorkspaceMain>} agent={<AgentSidebar open={showAgent} onClose={() => { setAgentOpen(false); revisionMode?.onExit(); }} contextLabel={contextLabel} revisionMode={Boolean(revisionMode)} onExitRevision={() => revisionMode?.onExit()}>{conversation}</AgentSidebar>} dock={<RunDock run={projection.run} pending={start.isPending} onCancel={cancel} onRecover={retryRun} />} /> : focusContent}
  </div>;
}

export function App() {
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap, retry: true, retryDelay: 1_500 });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(readStoredTheme);
  const required = bootstrap.isSuccess && !bootstrap.data.models.configured;
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; persistTheme(theme); }, [theme]);
  if (!bootstrap.isSuccess) return <BackendStarting onRetry={() => { void bootstrap.refetch(); }} />;
  return <><Routes><Route path="/" element={<HomePage onSettings={() => setSettingsOpen(true)} onPrompts={() => setPromptsOpen(true)} theme={theme} onThemeChange={setTheme} />} /><Route path="/novels/:id" element={<NovelPage onSettings={() => setSettingsOpen(true)} onPrompts={() => setPromptsOpen(true)} theme={theme} onThemeChange={setTheme} />} /></Routes><ModelSetup open={settingsOpen || required} required={required} onClose={() => setSettingsOpen(false)} /><PromptManager open={promptsOpen} onClose={() => setPromptsOpen(false)} /></>;
}
