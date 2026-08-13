import { useEffect, useLayoutEffect, useState } from "react";
import { Controller, useForm, type Control } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, ChevronDown, ChevronRight, CircleAlert, Columns3, Download, Eye, Feather, FileText, Flag, Lightbulb, LoaderCircle, Menu, Palette, PanelRightClose, Pencil, Plus, RefreshCw, Search, Settings2, ShieldCheck, Sparkles, X } from "lucide-react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import { untitledNovelTitle, type NextAction, type NovelState, type WorkflowId } from "../domain";
import { novelBriefSchema, openingPresetProposalSchema, type ArtifactProposal, type NovelBrief, type OpeningPresetProposal, type RunView } from "../shared/contracts";
import { workflowLabels } from "../shared/workflow-catalog";
import { api } from "./api";
import { Conversation } from "./Conversation";
import { persistTheme, readStoredTheme, THEMES, type ThemeId } from "./themes";
import { buildNovelProgress, type VolumeProgressPhase } from "./novel-progress";
import { ThinkingOrb } from "thinking-orbs";
import AnimatedContent from "./react-bits/AnimatedContent";
import ClickSpark from "./react-bits/ClickSpark";
import Magnet from "./react-bits/Magnet";
import ShinyText from "./react-bits/ShinyText";
import SpotlightCard from "./react-bits/SpotlightCard";
import WarpText from "./react-bits/WarpText";

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
      <AnimatedContent className="hero" delay={.04}><span className="eyebrow">你的长篇创作搭档</span><WarpText className="hero-warp-title" text="说出你的故事" color="#1f1915" fontFamily="Georgia, 'Noto Serif SC', serif" fontSize="clamp(3.3rem, 5.6vw, 5.4rem)" fontWeight={650} letterSpacing="-0.035em" warpStrength={0.18} warpScale={1.7} speed={0.55} pointerInfluence={0.85} pointerStrength={1.25} refraction={0.04} /><p>从故事方向、人物与世界，到逐章创作和完稿审阅，Agent 陪你一步步完成。</p><div className="hero-path" aria-label="创作流程"><span>聊出灵感</span><i /><span>搭好故事</span><i /><span>逐章写完</span></div></AnimatedContent>
      <AnimatedContent className="create-card" delay={.16}><div className="create-card-heading"><span className="create-step">从这里开始</span><h2>创建新作品</h2><p>标题可以稍后再定，先给故事留一个位置。</p></div><form onSubmit={handleSubmit((value) => create.mutate(value))}><label><span>作品名 <small>选填</small></span><input {...register("title", { maxLength: 80 })} placeholder="例如：雾海尽头" autoFocus /></label><label><span>创作推进方式</span><Magnet padding={26} magnetStrength={30} wrapperClassName="magnet-select"><SpotlightCard className="select-spotlight"><select {...register("approvalMode")}><option value="milestone_approval">关键节点由我确认（推荐）</option><option value="auto">普通节点自动推进</option></select></SpotlightCard></Magnet></label><ClickSpark sparkColor="#f5c46a" sparkRadius={22} sparkCount={10}><Magnet padding={36} magnetStrength={16} wrapperClassName="magnet-cta"><button className="primary-button create-button" disabled={create.isPending}>{create.isPending ? <LoaderCircle className="spin" /> : <Plus />}{create.isPending ? "正在创建…" : "开始这部小说"}<ChevronRight size={18} /></button></Magnet></ClickSpark></form><p className="create-assurance"><Sparkles size={15} />没有想法也没关系，创建后 Agent 会给你具体选项。</p><ErrorNotice error={create.error} /></AnimatedContent>
    </div>
    <AnimatedContent className="recent-section" delay={0.26}><div className="section-heading"><div><span className="eyebrow">你的书架</span><h2>继续创作</h2></div><span>{bootstrap.data?.novels.length ?? 0} 部作品</span></div>
      {bootstrap.isLoading ? <div className="loading"><LoaderCircle className="spin" />正在整理书架…</div> : bootstrap.data?.novels.length ? <div className="novel-grid">{bootstrap.data.novels.map((novel, index) => <AnimatedContent key={novel.id} delay={index * 0.07} distance={20}><Magnet padding={36} magnetStrength={42} wrapperClassName="novel-magnet"><SpotlightCard className="novel-spotlight"><ClickSpark sparkColor="#bd7a2d" sparkRadius={24} sparkCount={9}><Link className="novel-card" to={`/novels/${novel.id}`}><div className="book-cover"><span>{String(index + 1).padStart(2, "0")}</span><BookOpen /></div><div className="novel-card-copy"><span>长篇小说</span><h3>{novel.title}</h3><p>继续上次的创作对话</p></div><span className="novel-card-action">继续写<ChevronRight size={17} /></span></Link></ClickSpark></SpotlightCard></Magnet></AnimatedContent>)}</div> : <div className="empty-state story-empty">还没有作品。创建第一部小说后，它会出现在这里。</div>}<ErrorNotice error={bootstrap.error} />
    </AnimatedContent>
  </main></div>;
}

const starterMessages = [
  ["我完全没有想法", "我想写一本长篇小说，但现在完全没有想法。请先给我三个差异明显、容易产生继续创作欲望的故事方向，然后一次只问我一个问题。"],
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

function ReadyBrief({ onStart, pending }: { onStart: () => void; pending: boolean }) {
  return <section className="flow-card action-card"><div className="card-speaker"><Sparkles size={16} />创作搭档</div><h2>我已经可以整理第一版小说简报</h2><p>它会覆盖读者定位、主角、核心冲突、故事引擎和开篇钩子。生成后先交给你编辑与批准，不会直接写入作品。</p><ClickSpark sparkColor="#f5c46a"><Magnet padding={28} magnetStrength={18} wrapperClassName="magnet-action"><button className="primary-button" disabled={pending} onClick={onStart}>{pending ? <LoaderCircle className="spin" /> : <Sparkles />}生成小说简报</button></Magnet></ClickSpark></section>;
}

function GenerationProgress({ onCancel, label = "当前工件" }: { onCancel: () => void; label?: string }) {
  return <SpotlightCard className="flow-card progress-card"><div className="generation-orb"><ThinkingOrb state="composing" size={64} theme="light" aria-label="正在生成创作内容" /></div><div><div className="card-speaker"><Sparkles size={16} />正在生成</div><h2><ShinyText text={`正在推进${label}`} color="var(--ink)" shineColor="var(--amber)" speed={2} /></h2><div className="progress-steps"><span className="done"><Check />装配权威上下文</span><span className="active"><ThinkingOrb state="working" size={20} theme="light" />执行 Workflow</span><span>校验并提交结果</span></div><button className="text-button danger" onClick={onCancel}>取消本次运行</button></div></SpotlightCard>;
}

type BriefForm = Omit<NovelBrief, "risks"> & { risksText: string };
const briefFormSchema = novelBriefSchema.omit({ risks: true }).extend({ risksText: z.string().trim().min(1) });
const briefFields: Array<[keyof Omit<BriefForm, "risksText">, string]> = [["workingTitle", "工作书名"], ["oneSentencePremise", "一句话故事"], ["targetReaders", "目标读者"], ["primaryReaderReward", "主要阅读回报"], ["protagonist", "主角"], ["coreConflict", "核心冲突"], ["storyEngine", "故事引擎"], ["openingHook", "开篇钩子"], ["longTermPromise", "长线承诺"]];

function EditableBriefField({ control, name, label, rows = 3 }: { control: Control<BriefForm>; name: keyof BriefForm; label: string; rows?: number }) {
  const [editing, setEditing] = useState(false);
  return <Controller name={name} control={control} render={({ field }) => <div className="editable-field" data-field={name}><span className="editable-field-label">{label}</span>{editing ? <textarea {...field} className="editable-input" autoFocus rows={rows} onKeyDown={(event) => { if (event.key === "Escape") event.currentTarget.blur(); }} onBlur={() => { field.onBlur(); setEditing(false); }} /> : <button type="button" className="editable-display" aria-label={`编辑${label}`} onClick={() => setEditing(true)}><span className="editable-copy">{field.value || "点击添加内容"}</span><span className="editable-hint" aria-hidden="true"><Pencil size={13} />编辑</span></button>}</div>} />;
}

function BriefProposal({ run, onUpdated, onCanceled }: { run: RunView; onUpdated: () => void; onCanceled: () => void }) {
  const proposal = run.proposal!;
  const { control, handleSubmit } = useForm<BriefForm>({ resolver: zodResolver(briefFormSchema), defaultValues: { ...proposal, risksText: proposal.risks.join("\n") } });
  const [feedback, setFeedback] = useState("");
  const review = useMutation({ mutationFn: (body: Parameters<typeof api.review>[1]) => api.review(run.runId, body), onSuccess: (_value, body) => body.action === "cancel" ? onCanceled() : onUpdated() });
  const toBrief = (value: BriefForm): NovelBrief => ({ ...value, risks: value.risksText.split("\n").map((item) => item.trim()).filter(Boolean) });
  return <section className="flow-card brief-card"><div className="card-speaker"><Sparkles size={16} />创作搭档 · 等待你的决定</div><h2>小说简报提案</h2><p>这是提案，不是定稿。点击任意内容即可编辑，批准后才会保存。</p><form className="brief-form" onSubmit={handleSubmit((value) => review.mutate({ action: "approve", brief: toBrief(value) }))}>{briefFields.map(([name, label]) => <EditableBriefField key={name} control={control} name={name} label={label} rows={name === "workingTitle" ? 1 : 3} />)}<EditableBriefField control={control} name="risksText" label="风险与提醒" rows={4} /><div className="approval-box"><strong>批准后会发生什么？</strong><p>当前内容会写入小说简报 Markdown，并成为后续“故事圣经”的上游依据。</p></div><div className="review-actions"><button className="primary-button" type="submit" disabled={review.isPending}><Check />批准并保存</button><button className="secondary-button" type="button" disabled={!feedback.trim() || review.isPending} onClick={() => review.mutate({ action: "revise", feedback })}><RefreshCw />要求调整</button></div><label>给 AI 的调整意见<textarea value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="例如：主角目标还不够迫切，希望开篇三章内出现第一次明确胜利。" rows={3} /></label><button type="button" className="text-button danger" onClick={() => review.mutate({ action: "cancel" })}>取消本次生成</button><ErrorNotice error={review.error} /></form></section>;
}

function EditableMarkdown({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const [editing, setEditing] = useState(false);
  return <section className={editing ? "markdown-workspace editing" : "markdown-workspace"} aria-label="Markdown 工件内容">
    <header className="markdown-workspace-header"><span>{editing ? "Markdown 源码" : "排版预览"}</span><button type="button" className="markdown-edit-button" onClick={() => setEditing((current) => !current)}>{editing ? <><Check size={15} />完成编辑</> : <><Pencil size={15} />编辑源码</>}</button></header>
    {editing ? <textarea className="markdown-source-editor" rows={22} value={value} autoFocus onChange={(event) => onChange(event.target.value)} /> : <div className="message-markdown markdown-preview"><ReactMarkdown remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown></div>}
  </section>;
}

function ArtifactProposalCard({ run, onUpdated, onCanceled }: { run: RunView; onUpdated: () => void; onCanceled: () => void }) {
  const proposal = run.artifactProposal!;
  const [content, setContent] = useState(proposal.content);
  const [feedback, setFeedback] = useState("");
  const review = useMutation({ mutationFn: (body: Parameters<typeof api.review>[1]) => api.review(run.runId, body), onSuccess: (_value, body) => body.action === "cancel" ? onCanceled() : onUpdated() });
  const edited: ArtifactProposal = { ...proposal, content, files: proposal.files.map((file, index) => index === 0 ? { ...file, content } : file) };
  return <section className="flow-card brief-card"><div className="card-speaker"><Sparkles size={16} />创作搭档 · 等待你的决定</div><h2>{proposal.title}</h2><p>这是可编辑提案。默认显示排版效果，点击“编辑源码”后再修改；批准后才会写入权威工件。</p><EditableMarkdown value={content} onChange={setContent} /><div className="review-actions"><button className="primary-button" disabled={review.isPending} onClick={() => review.mutate({ action: "approve", proposal: edited })}><Check />批准并保存</button><button className="secondary-button" disabled={!feedback.trim() || review.isPending} onClick={() => review.mutate({ action: "revise", feedback, proposal: edited })}><RefreshCw />要求调整</button></div><label>调整意见<textarea rows={3} value={feedback} onChange={(event) => setFeedback(event.target.value)} /></label><button className="text-button danger" onClick={() => review.mutate({ action: "cancel" })}>取消本次生成</button><ErrorNotice error={review.error} /></section>;
}

function NextStepCard({ next, pending, onStart, onRange, onVolume }: { next: NextAction; pending: boolean; onStart: (workflowId: WorkflowId, target?: string) => void; onRange: (start: number, end: number, autoApproveMilestones: boolean) => void; onVolume: (plan: { number: number; startChapter: number; endChapter: number; final: boolean }) => void }) {
  const [rangeEnd, setRangeEnd] = useState(next.type === "approve_chapter_range" ? next.chapter : 1);
  const [volumeEnd, setVolumeEnd] = useState(next.type === "configure_volume" ? next.suggestedEndChapter : 10);
  const [isFinalVolume, setIsFinalVolume] = useState(false);
  const [autoApproveMilestones, setAutoApproveMilestones] = useState(false);
  if (next.type === "configure_volume") return <section className="flow-card action-card"><div className="card-speaker"><BookOpen size={16} />卷规划</div><h2>确定第 {next.volume} 卷的范围</h2><p>{next.reason} 先给这一卷一个明确的收束点，后续章节会围绕卷目标逐章推进。</p><label>本卷写到第几章<input type="number" min={next.startChapter} max={next.startChapter + 99} value={volumeEnd} onChange={(event) => setVolumeEnd(Number(event.target.value))} /></label><label className="volume-final-toggle"><input type="checkbox" checked={isFinalVolume} onChange={(event) => setIsFinalVolume(event.target.checked)} />这是最终卷，完成后标记整部小说完本</label><button className="primary-button" disabled={pending || volumeEnd < next.startChapter} onClick={() => onVolume({ number: next.volume, startChapter: next.startChapter, endChapter: volumeEnd, final: isFinalVolume })}><Check />确认第 {next.volume} 卷范围</button></section>;
  if (next.type === "complete_novel") return <section className="flow-card complete-card"><div className="complete-mark"><Check /></div><h2>这部小说已经写完</h2><p>{next.reason}</p><button className="primary-button" onClick={() => onStart("novel-export")}><Download size={17} />导出稳定章节 TXT</button></section>;
  if (next.type === "completion_blocked") return <section className="flow-card action-card"><div className="card-speaker"><CircleAlert size={16} />完本验收未通过</div><h2>还有 {next.blockers.length} 项需要处理</h2><p>{next.reason}</p><ul className="blocker-list">{next.blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul><button className="secondary-button" disabled={pending} onClick={() => onStart(next.workflowId)}><RefreshCw />修复后重新验收</button></section>;
  if (next.type === "approve_chapter_range") return <section className="flow-card action-card"><div className="card-speaker"><BookOpen size={16} />章节生产授权</div><h2>批准下一段章节范围</h2><p>{next.reason} 章节会严格串行：当前章定稿并回灌连续性后才进入下一章。</p><label>生产到第几章<input type="number" min={next.chapter} max={next.chapter + 99} value={rangeEnd} onChange={(event) => setRangeEnd(Number(event.target.value))} /></label><fieldset className="production-mode"><legend>创作方式</legend><label><input type="radio" name="production-mode" checked={!autoApproveMilestones} onChange={() => setAutoApproveMilestones(false)} />逐项确认（推荐）<small>关键规划完成后由你确认，再继续创作。</small></label><label><input type="radio" name="production-mode" checked={autoApproveMilestones} onChange={() => setAutoApproveMilestones(true)} />全自动推进<small>自动完成准备工件并连续生产至目标章节；你可随时停止。</small></label></fieldset><ClickSpark sparkColor="#f5c46a"><Magnet padding={28} magnetStrength={18} wrapperClassName="magnet-action"><button className="primary-button" disabled={pending || rangeEnd < next.chapter} onClick={() => onRange(next.chapter, rangeEnd, autoApproveMilestones)}><Check />{autoApproveMilestones ? `自动创作至第 ${rangeEnd} 章` : `批准第 ${next.chapter}–${rangeEnd} 章`}</button></Magnet></ClickSpark></section>;
  if (next.type === "collect_opening_choices") return null;
  const workflowId = next.workflowId;
  if (!workflowId) return <RecoveryCard error="当前步骤缺少 Workflow 映射。" pending={false} onRetry={() => undefined} />;
  const chapterTarget = next.artifactKey.startsWith("chapter:") ? next.artifactKey.split(":")[1] : undefined;
  const label = workflowLabels[workflowId];
  const refreshing = next.type === "refresh_artifact";
  return <section className="flow-card next-step-card"><header className="next-step-heading"><span className="next-step-icon"><Sparkles size={19} /></span><div><span>推荐下一步</span><h2>{label}</h2></div></header><p className="next-step-reason">{refreshing ? `${label}的上游内容已有变化，需要重新整理。` : `创作链已经准备好进入“${label}”。`}</p><div className="next-step-note"><Check size={17} /><div><strong>安全生成</strong><p>读取已确认的上游内容，完成校验后按需交给你批准；受保护内容不会被覆盖。</p></div></div><ClickSpark sparkColor="#f5c46a" sparkRadius={24} sparkCount={10}><Magnet padding={32} magnetStrength={16} wrapperClassName="magnet-cta"><button className="primary-button next-step-action" disabled={pending} onClick={() => onStart(workflowId, chapterTarget)}>{pending ? <><LoaderCircle className="spin" />正在启动…</> : <><Sparkles />{refreshing ? "重新生成" : "生成"}{label}</>}</button></Magnet></ClickSpark></section>;
}

function RecoveryCard({ error, onRetry, pending }: { error?: string; onRetry: () => void; pending: boolean }) {
  return <section className="flow-card action-card"><div className="card-speaker"><CircleAlert size={16} />本次生成未完成</div><h2>我们可以从这里重新开始</h2><p>{error ?? "这次生成已取消，没有修改作品文件。"}</p><button className="secondary-button" disabled={pending} onClick={onRetry}>{pending ? <LoaderCircle className="spin" /> : <RefreshCw />}{pending ? "正在重新生成…" : "重新生成"}</button></section>;
}

function NovelSidebar({ currentId, onSettings, onPrompts, theme, onThemeChange }: { currentId: string; onSettings: () => void; onPrompts: () => void; theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap });
  return <aside className="novel-sidebar"><Link to="/" className="brand"><span className="brand-mark"><Feather size={19} /></span><span>ANI 小说 Agent</span></Link><Link to="/" className="new-novel"><Plus size={17} />新建作品</Link><nav><span className="sidebar-label">作品与主对话</span>{bootstrap.data?.novels.map((novel) => <Link key={novel.id} to={`/novels/${novel.id}`} className={novel.id === currentId ? "sidebar-novel active" : "sidebar-novel"}><BookOpen size={17} /><span>{novel.title}</span></Link>)}</nav><div className="sidebar-footer"><ThemeSwitcher compact value={theme} onChange={onThemeChange} /><button className="sidebar-settings" onClick={onPrompts}><Pencil size={17} />提示词管理</button><button className="sidebar-settings" onClick={onSettings}><Settings2 size={17} />模型设置</button></div></aside>;
}

const volumePhaseLabels: Record<VolumeProgressPhase, string> = {
  active: "创作中",
  handoff_pending: "待整理承接",
  handoff_ready: "承接已就绪",
  audit_pending: "待完本验收",
  audit_blocked: "验收待修复",
  completed: "整部已完本",
  planning: "待规划",
};

function nextActionLabel(next: NextAction, run?: RunView) {
  if (run?.status === "running") return `正在${run.workflowId ? workflowLabels[run.workflowId] : "推进任务"}`;
  if (run?.status === "awaiting_review") return `等待确认${run.workflowId ? workflowLabels[run.workflowId] : "创作提案"}`;
  if (next.type === "collect_opening_choices") return "继续开书讨论";
  if (next.type === "configure_volume") return `规划第 ${next.volume} 卷`;
  if (next.type === "approve_chapter_range") return `批准第 ${next.chapter} 章起`;
  if (next.type === "complete_novel") return "已完成，可导出";
  if (next.type === "completion_blocked") return "处理完本问题";
  return `${next.type === "refresh_artifact" ? "刷新" : "生成"}${next.workflowId ? workflowLabels[next.workflowId] : "创作工件"}`;
}

function NovelProgressWorkbench({ novel, next, run }: { novel: NovelState; next: NextAction; run?: RunView }) {
  const [expanded, setExpanded] = useState(false);
  if (!novel.openingChoices) return null;
  const progress = buildNovelProgress(novel);
  const focus = progress.focusVolume;
  const range = focus.endChapter ? `第 ${focus.startChapter}–${focus.endChapter} 章` : `从第 ${focus.startChapter} 章开始`;
  const status = nextActionLabel(next, run);
  return <section className={expanded ? "novel-progress-workbench expanded" : "novel-progress-workbench"} aria-label="小说生产进度">
    <div className="novel-progress-summary">
      <div className="progress-volume-mark"><Flag size={17} /><span>{progress.mode === "legacy" ? "单卷" : `第 ${focus.number} 卷`}</span></div>
      <div className="progress-volume-copy"><strong>{volumePhaseLabels[focus.phase]}</strong><small>{progress.mode === "legacy" ? "旧版作品继续沿用原生产链" : range}</small></div>
      <div className="progress-meter" aria-label={focus.totalChapters ? `本卷已完成 ${focus.completedChapters} / ${focus.totalChapters} 章` : "本卷等待规划"}><span><i style={{ width: `${focus.percent}%` }} /></span><small>{focus.totalChapters ? `${focus.completedChapters}/${focus.totalChapters} 章稳定` : "范围待确定"}</small></div>
      <div className="progress-stat"><strong>{progress.stableChapters}</strong><small>稳定章节</small></div>
      <div className="progress-now"><small>当前阶段</small><strong>{status}</strong></div>
      <button type="button" className="progress-expand" aria-expanded={expanded} onClick={() => setExpanded((current) => !current)}>{expanded ? "收起" : "查看各卷"}<ChevronDown size={16} /></button>
    </div>
    {expanded && <div className="volume-progress-list">{progress.volumes.map((volume) => <article className={`volume-progress-item ${volume.phase}`} key={volume.number}>
      <header><span>第 {volume.number} 卷{volume.final ? " · 最终卷" : ""}</span><em>{volumePhaseLabels[volume.phase]}</em></header>
      <div className="volume-progress-range"><span>{volume.endChapter ? `第 ${volume.startChapter}–${volume.endChapter} 章` : `从第 ${volume.startChapter} 章开始`}</span><strong>{volume.totalChapters ? `${volume.completedChapters}/${volume.totalChapters}` : "待定"}</strong></div>
      <div className="volume-progress-track"><i style={{ width: `${volume.percent}%` }} /></div>
    </article>)}</div>}
  </section>;
}

function ArtifactPanel({ novelId, artifacts, open, onClose, onExport }: { novelId: string; artifacts: Record<string, { status: string; protected: boolean }>; open: boolean; onClose: () => void; onExport: () => void }) {
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | "pending" | "ready" | "protected">("all");
  const [expandedChapters, setExpandedChapters] = useState<number[]>([]);
  const artifact = useQuery({ queryKey: ["artifact", novelId, selectedKey], queryFn: () => api.artifact(novelId, selectedKey), enabled: Boolean(selectedKey) });
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (artifact.data) setContent(artifact.data.content); }, [artifact.data]);
  useEffect(() => { setEditing(false); }, [selectedKey]);
  const save = useMutation({ mutationFn: () => api.editArtifact(novelId, selectedKey, content, artifact.data?.artifact.sha256 ?? ""), onSuccess: async () => { setEditing(false); await Promise.all([queryClient.invalidateQueries({ queryKey: ["artifact", novelId, selectedKey] }), queryClient.invalidateQueries({ queryKey: ["novel", novelId] })]); } });
  if (!open) return null;
  const stages: Array<[string, string]> = [["book:novel_brief", "小说简报"], ["book:story_bible", "故事圣经"], ["book:world_bible", "世界圣经"], ["book:character_cast", "角色阵容"], ["book:volume_strategy", "卷战略"], ["book:volume_outline", "当前卷骨架"], ["book:completion_audit", "完本验收"]];
  const chapterNames: Record<string, string> = { chapter_draft: "正文草稿", chapter_plan: "章节计划", chapter_review: "审查报告", context_package: "上下文包", continuity_update: "连续性更新", humanization_revision: "人性化修订", quality_debt: "质量债务", quality_repair: "质量修复" };
  const labelFor = (key: string) => chapterNames[key.replace(/^chapter:\d+:/, "")] ?? key.replace(/^chapter:\d+:/, "").replaceAll("_", " ");
  const matches = (key: string, label: string) => { const item = artifacts[key]; const queryMatches = !search || `${label} ${key}`.toLowerCase().includes(search.toLowerCase()); return queryMatches && (filter === "all" || filter === "ready" && item?.status === "ready" || filter === "pending" && item?.status !== "ready" || filter === "protected" && item?.protected); };
  const volumeItems = Object.keys(artifacts).filter((key) => /^volume:\d+:(outline|handoff)$/.test(key)).sort();
  const bookItems = stages.filter(([key, label]) => matches(key, label));
  const chapters = Object.keys(artifacts).filter((key) => key.startsWith("chapter:")).reduce<Record<number, string[]>>((groups, key) => { const chapter = Number(/^chapter:(\d+):/.exec(key)?.[1]); if (chapter) (groups[chapter] ??= []).push(key); return groups; }, {});
  const chapterNumbers = Object.keys(chapters).map(Number).sort((a, b) => b - a);
  const latestChapter = chapterNumbers[0];
  const isExpanded = (chapter: number) => expandedChapters.includes(chapter) || expandedChapters.length === 0 && chapter === latestChapter;
  const toggleChapter = (chapter: number) => setExpandedChapters((current) => current.includes(chapter) ? current.filter((item) => item !== chapter) : [...current, chapter]);
  const statusText = (item: typeof artifacts[string] | undefined) => item?.protected ? "已保护" : item?.status === "ready" ? "已完成" : item?.status === "stale" ? "待刷新" : "等待上游";
  const itemNode = (key: string, label: string, compact = false) => { const item = artifacts[key]; return <button type="button" key={key} disabled={!item} onClick={() => setSelectedKey(key)} className={`artifact-item ${compact ? "compact" : ""} ${item?.status === "ready" ? "ready" : item?.status === "stale" ? "active" : "locked"}`}><span>{item?.status === "ready" ? <Check size={14} /> : ""}</span><div><strong>{label}</strong><small>{statusText(item)}</small></div></button>; };
  return <><aside className="artifact-panel"><div className="panel-heading"><div><span className="sidebar-label">作品上下文</span><h3>创作工件</h3><small>{Object.values(artifacts).filter((item) => item.status === "ready").length} 项已完成</small></div><button className="icon-button" aria-label="收起工件栏" onClick={onClose}><PanelRightClose size={19} /></button></div><div className="artifact-tools"><label><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索工件" /></label><div>{([ ["all", "全部"], ["pending", "待处理"], ["ready", "已完成"], ["protected", "已保护"] ] as const).map(([value, label]) => <button key={value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}</div></div><div className="artifact-scroll"><section className="artifact-section"><header><span>书级工件</span><small>稳定基础</small></header>{bookItems.length ? bookItems.map(([key, label]) => itemNode(key, label, true)) : <p className="artifact-empty">没有匹配的书级工件</p>}</section>{volumeItems.length > 0 && <section className="artifact-section"><header><span>卷级工件</span><small>{volumeItems.length} 项</small></header>{volumeItems.map((key) => itemNode(key, key.replace(/^volume:(\d+):/, "第 $1 卷 · ").replace("outline", "卷骨架").replace("handoff", "卷间承接"), true))}</section>}<section className="artifact-section chapter-section"><header><span>章节工件</span><small>{chapterNumbers.length} 章</small></header>{chapterNumbers.map((chapter) => { const all = chapters[chapter] ?? []; const items = all.filter((key) => matches(key, labelFor(key))); const completed = all.filter((key) => artifacts[key]?.status === "ready").length; if (!items.length) return null; const expanded = isExpanded(chapter); return <div className={expanded ? "chapter-group expanded" : "chapter-group"} key={chapter}><button className="chapter-toggle" onClick={() => toggleChapter(chapter)}><span className="chapter-index">{String(chapter).padStart(2, "0")}</span><span><strong>第 {chapter} 章</strong><small>{completed}/{all.length} 项已完成</small></span><ChevronRight size={16} /></button>{expanded && <AnimatedContent className="chapter-artifacts" distance={12} duration={.28}>{items.sort().map((key) => itemNode(key, labelFor(key), true))}</AnimatedContent>}</div>; })}{!chapterNumbers.length && <p className="artifact-empty">章节开始创作后，相关工件会按章节收纳在这里。</p>}</section></div><div className="artifact-footer"><button className="secondary-button wide" onClick={onExport}>导出稳定章节 TXT</button><div className="context-note"><strong>创作控制</strong><p>编辑已提交工件会自动保护作者内容，并标记下游需要刷新。</p></div></div></aside>{selectedKey && <div className="modal-backdrop"><section className="modal artifact-modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="eyebrow">权威工件</span><h2>{selectedKey}</h2><p>{artifact.data?.artifact.protected ? "作者已保护，Agent 不会覆盖。" : "保存编辑后将自动设为作者保护。"}</p></div><button className="icon-button" aria-label="关闭" onClick={() => setSelectedKey("")}><X /></button></div><div className="artifact-modal-body">{artifact.isLoading ? <div className="loading"><LoaderCircle className="spin" />正在读取…</div> : editing ? <textarea className="artifact-editor" rows={24} value={content} onChange={(event) => setContent(event.target.value)} /> : <div className="message-markdown artifact-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>}<ErrorNotice error={artifact.error ?? save.error} /></div><div className="modal-footer">{editing ? <><button className="secondary-button" onClick={() => { setContent(artifact.data?.content ?? content); setEditing(false); }}>取消编辑</button><button className="primary-button" disabled={!artifact.data || save.isPending || content === artifact.data.content} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" /> : <Check />}保存并保护</button></> : <button className="secondary-button" disabled={!artifact.data} onClick={() => setEditing(true)}><Pencil />编辑源码</button>}</div></section></div>}</>;
}

function ExportComplete({ novelId, run }: { novelId: string; run: RunView }) {
  return <section className="flow-card complete-card"><div className="complete-mark"><Check /></div><h2>稳定章节已导出</h2><p>已汇总 {run.chapterCount ?? 0} 章。你可以直接下载 TXT 文件。</p>{run.exportPath && <a className="primary-button" href={api.exportDownloadUrl(novelId, run.exportPath)}><Download size={17} />下载 TXT</a>}</section>;
}

function NovelPage({ onSettings, onPrompts, theme, onThemeChange }: { onSettings: () => void; onPrompts: () => void; theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap });
  const novel = useQuery({ queryKey: ["novel", id], queryFn: () => api.novel(id), enabled: Boolean(id) });
  const chat = useQuery({ queryKey: ["chat", id], queryFn: () => api.chat(id), enabled: Boolean(id) && Boolean(bootstrap.data?.models.configured), retry: false });
  const storageKey = `ani-novel-run:${id}`;
  const [runId, setRunId] = useState(() => localStorage.getItem(storageKey) ?? "");
  const [artifactsOpen, setArtifactsOpen] = useState(true);
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.run(runId), enabled: Boolean(runId), refetchInterval: (query) => query.state.data?.status === "running" ? 2_000 : false, retry: false });
  const start = useMutation({ mutationFn: ({ workflowId, target }: { workflowId: WorkflowId; target?: string }) => api.startRun(id, workflowId, target), onSuccess: (value) => { setRunId(value.runId); localStorage.setItem(storageKey, value.runId); } });
  const range = useMutation({ mutationFn: ({ start, end, autoApproveMilestones }: { start: number; end: number; autoApproveMilestones: boolean }) => api.autoDirector(id, start, end, autoApproveMilestones), onSuccess: async (value) => { setRunId(value.runId); localStorage.setItem(storageKey, value.runId); await queryClient.invalidateQueries({ queryKey: ["novel", id] }); } });
  const volume = useMutation({ mutationFn: (plan: { number: number; startChapter: number; endChapter: number; final: boolean }) => api.configureVolume(id, plan), onSuccess: async () => { await queryClient.invalidateQueries({ queryKey: ["novel", id] }); } });
  const exportRun = useMutation({ mutationFn: () => api.exportNovel(id), onSuccess: (value) => { setRunId(value.runId); localStorage.setItem(storageKey, value.runId); } });
  const openingProposal = useMutation({ mutationFn: () => api.proposePreset(id) });

  useEffect(() => { openingProposal.reset(); }, [id]);

  useEffect(() => {
    const authoritativeRunId = novel.data?.novel.activeRunId;
    if (authoritativeRunId && authoritativeRunId !== runId) { setRunId(authoritativeRunId); localStorage.setItem(storageKey, authoritativeRunId); }
  }, [novel.data?.novel.activeRunId, runId, storageKey]);

  useEffect(() => {
    if (!runId) return;
    const events = new EventSource(`/workbench-api/runs/${runId}/events`);
    const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["run", runId] }); void queryClient.invalidateQueries({ queryKey: ["novel", id] }); };
    ["artifact.proposed", "approval.required", "artifact.committed", "run.failed", "run.completed"].forEach((name) => events.addEventListener(name, refresh));
    return () => events.close();
  }, [id, queryClient, runId]);

  const resetRun = () => { setRunId(""); localStorage.removeItem(storageKey); };
  const refresh = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["run", runId] }), queryClient.invalidateQueries({ queryKey: ["novel", id] })]); };
  const saveChoices = async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["novel", id] }), queryClient.invalidateQueries({ queryKey: ["chat", id] }), queryClient.invalidateQueries({ queryKey: ["bootstrap"] })]); };
  const cancel = async () => { if (runId) { await api.review(runId, { action: "cancel" }); resetRun(); } };
  const retryFailedRun = (failed: RunView) => {
    if (!failed.workflowId || failed.workflowId === "auto-director" || failed.workflowId === "chapter-range") { resetRun(); return; }
    start.mutate({ workflowId: failed.workflowId, target: failed.target });
  };
  const currentRun = run.data;
  const flow = (sendMessage: (text: string) => Promise<void>, isRunning: boolean, messageCount: number) => !novel.data?.novel.openingChoices
    ? openingProposal.data ? <PresetProposalCard novelId={id} proposal={openingProposal.data} onSaved={saveChoices} onReset={() => openingProposal.reset()} /> : messageCount === 0 ? <DiscoveryCard isRunning={isRunning} onSend={sendMessage} /> : null
    : currentRun?.status === "awaiting_review" && currentRun.proposal ? <BriefProposal key={`${runId}-${currentRun.proposal.openingHook}`} run={currentRun} onUpdated={refresh} onCanceled={resetRun} />
      : currentRun?.status === "awaiting_review" && currentRun.artifactProposal ? <ArtifactProposalCard key={`${runId}-${currentRun.artifactProposal.content.length}`} run={currentRun} onUpdated={refresh} onCanceled={resetRun} />
          : currentRun?.status === "running" ? <GenerationProgress label={currentRun.workflowId ? workflowLabels[currentRun.workflowId] : undefined} onCancel={cancel} />
            : currentRun?.status === "committed" && currentRun.workflowId === "novel-export" ? <ExportComplete novelId={id} run={currentRun} />
          : currentRun?.status === "failed" || currentRun?.status === "canceled" ? <RecoveryCard error={currentRun.error?.message} pending={start.isPending} onRetry={() => retryFailedRun(currentRun)} />
          : novel.data?.nextAction ? <NextStepCard next={novel.data.nextAction} pending={start.isPending || range.isPending || volume.isPending} onStart={(workflowId, target) => start.mutate({ workflowId, target })} onRange={(startChapter, endChapter, autoApproveMilestones) => range.mutate({ start: startChapter, end: endChapter, autoApproveMilestones })} onVolume={(plan) => volume.mutate(plan)} /> : null;

  return <div className={artifactsOpen ? "novel-layout" : "novel-layout panel-closed"}><NovelSidebar currentId={id} onSettings={onSettings} onPrompts={onPrompts} theme={theme} onThemeChange={onThemeChange} /><main className="conversation-column"><header className="conversation-header"><Link to="/" className="mobile-menu" aria-label="返回书架"><Menu size={20} /></Link><div><small>当前作品</small><h1>{novel.data?.novel.title ?? "正在打开…"}</h1></div><div className="header-actions"><div className="mobile-theme-switcher"><ThemeSwitcher value={theme} onChange={onThemeChange} /></div><span className="agent-status"><i />Agent 已就绪</span>{!artifactsOpen && <button className="quiet-button" onClick={() => setArtifactsOpen(true)}>查看工件</button>}</div></header>{novel.data?.novel && novel.data.nextAction && <NovelProgressWorkbench novel={novel.data.novel} next={novel.data.nextAction} run={currentRun} />}
    {novel.isLoading || chat.isLoading ? <div className="loading conversation-loading"><LoaderCircle className="spin" />正在恢复这部作品的对话…</div> : chat.data ? <Conversation novelId={id} initialMessages={chat.data.messages} discoveryAction={!novel.data?.novel.openingChoices && !openingProposal.data ? { pending: openingProposal.isPending, error: openingProposal.error, onConfirm: () => openingProposal.mutate() } : undefined}>{({ sendMessage, isRunning, messageCount }) => { const node = flow(sendMessage, isRunning, messageCount); const flowError = novel.error ?? run.error ?? start.error ?? range.error ?? volume.error ?? exportRun.error; return node || flowError ? <>{node}<ErrorNotice error={flowError} /></> : null; }}</Conversation> : <div className="loading conversation-loading"><ErrorNotice error={chat.error ?? novel.error} /></div>}
  </main><ArtifactPanel novelId={id} artifacts={novel.data?.novel.artifacts ?? {}} open={artifactsOpen} onClose={() => setArtifactsOpen(false)} onExport={() => exportRun.mutate()} /></div>;
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
