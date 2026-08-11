import { useEffect, useLayoutEffect, useState } from "react";
import { Controller, useForm, type Control } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, ChevronRight, CircleAlert, Download, Feather, Lightbulb, LoaderCircle, Menu, Palette, PanelRightClose, Pencil, Plus, RefreshCw, Settings2, Sparkles, X } from "lucide-react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { z } from "zod";
import { untitledNovelTitle, type NextAction, type WorkflowId } from "../domain";
import { novelBriefSchema, openingPresetProposalSchema, type ArtifactProposal, type NovelBrief, type OpeningPresetProposal, type RunView } from "../shared/contracts";
import { workflowLabels } from "../shared/workflow-catalog";
import { api } from "./api";
import { Conversation } from "./Conversation";
import { persistTheme, readStoredTheme, THEMES, type ThemeId } from "./themes";

function ThemeSwitcher({ value, onChange, compact = false }: { value: ThemeId; onChange: (theme: ThemeId) => void; compact?: boolean }) {
  const selected = THEMES.find((theme) => theme.id === value);
  return <label className={compact ? "theme-switcher compact" : "theme-switcher"}><Palette size={16} /><span>主题</span><select aria-label="选择主题" title={selected?.description} value={value} onChange={(event) => onChange(event.target.value as ThemeId)}>{THEMES.map((theme) => <option key={theme.id} value={theme.id}>{theme.label}</option>)}</select></label>;
}

function ErrorNotice({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="notice error"><CircleAlert size={18} />{error instanceof Error ? error.message : "操作失败，请重试。"}</div>;
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

function HomePage({ onSettings, theme, onThemeChange }: { onSettings: () => void; theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap });
  const { register, handleSubmit, reset } = useForm<{ title: string; approvalMode: "milestone_approval" | "auto" }>({ defaultValues: { title: "", approvalMode: "milestone_approval" } });
  const create = useMutation({ mutationFn: ({ title, approvalMode }: { title: string; approvalMode: "milestone_approval" | "auto" }) => api.createNovel(title.trim() || untitledNovelTitle, approvalMode), onSuccess: async (novel) => { reset(); await queryClient.invalidateQueries({ queryKey: ["bootstrap"] }); navigate(`/novels/${novel.novelId}`); } });
  return <div className="home-shell"><header className="home-topbar"><div className="brand"><span className="brand-mark"><Feather size={20} /></span><span>ANI 小说 Agent</span></div><div className="topbar-actions"><ThemeSwitcher value={theme} onChange={onThemeChange} /><button className="quiet-button" onClick={onSettings}><Settings2 size={18} />模型设置</button></div></header><main className="home-page">
    <div className="home-intro">
      <section className="hero"><span className="eyebrow">你的长篇创作搭档</span><h1>说出你的故事</h1><p>从故事方向、人物与世界，到逐章创作和完稿审阅，Agent 陪你一步步完成。</p><div className="hero-path" aria-label="创作流程"><span>聊出灵感</span><i /><span>搭好故事</span><i /><span>逐章写完</span></div></section>
      <section className="create-card"><div className="create-card-heading"><span className="create-step">从这里开始</span><h2>创建新作品</h2><p>标题可以稍后再定，先给故事留一个位置。</p></div><form onSubmit={handleSubmit((value) => create.mutate(value))}><label><span>作品名 <small>选填</small></span><input {...register("title", { maxLength: 80 })} placeholder="例如：雾海尽头" autoFocus /></label><label><span>创作推进方式</span><select {...register("approvalMode")}><option value="milestone_approval">关键节点由我确认（推荐）</option><option value="auto">普通节点自动推进</option></select></label><button className="primary-button create-button" disabled={create.isPending}>{create.isPending ? <LoaderCircle className="spin" /> : <Plus />}{create.isPending ? "正在创建…" : "开始这部小说"}<ChevronRight size={18} /></button></form><p className="create-assurance"><Sparkles size={15} />没有想法也没关系，创建后 Agent 会给你具体选项。</p><ErrorNotice error={create.error} /></section>
    </div>
    <section className="recent-section"><div className="section-heading"><div><span className="eyebrow">你的书架</span><h2>继续创作</h2></div><span>{bootstrap.data?.novels.length ?? 0} 部作品</span></div>
      {bootstrap.isLoading ? <div className="loading"><LoaderCircle className="spin" />正在整理书架…</div> : bootstrap.data?.novels.length ? <div className="novel-grid">{bootstrap.data.novels.map((novel, index) => <Link className="novel-card" key={novel.id} to={`/novels/${novel.id}`}><div className="book-cover"><span>{String(index + 1).padStart(2, "0")}</span><BookOpen /></div><div className="novel-card-copy"><span>长篇小说</span><h3>{novel.title}</h3><p>继续上次的创作对话</p></div><span className="novel-card-action">继续写<ChevronRight size={17} /></span></Link>)}</div> : <div className="empty-state">还没有作品。创建第一部小说后，它会出现在这里。</div>}<ErrorNotice error={bootstrap.error} />
    </section>
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
  return <section className="flow-card action-card"><div className="card-speaker"><Sparkles size={16} />创作搭档</div><h2>我已经可以整理第一版小说简报</h2><p>它会覆盖读者定位、主角、核心冲突、故事引擎和开篇钩子。生成后先交给你编辑与批准，不会直接写入作品。</p><button className="primary-button" disabled={pending} onClick={onStart}>{pending ? <LoaderCircle className="spin" /> : <Sparkles />}生成小说简报</button></section>;
}

function GenerationProgress({ onCancel, label = "当前工件" }: { onCancel: () => void; label?: string }) {
  return <section className="flow-card progress-card"><div className="card-speaker"><Sparkles size={16} />正在生成</div><h2>正在推进{label}</h2><div className="progress-steps"><span className="done"><Check />装配权威上下文</span><span className="active"><LoaderCircle className="spin" />执行 Workflow</span><span>校验并提交结果</span></div><button className="text-button danger" onClick={onCancel}>取消本次运行</button></section>;
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

function NextStepCard({ next, pending, onStart, onRange }: { next: NextAction; pending: boolean; onStart: (workflowId: WorkflowId, target?: string) => void; onRange: (start: number, end: number, autoApproveMilestones: boolean) => void }) {
  const [rangeEnd, setRangeEnd] = useState(next.type === "approve_chapter_range" ? next.chapter : 1);
  const [autoApproveMilestones, setAutoApproveMilestones] = useState(false);
  if (next.type === "approve_chapter_range") return <section className="flow-card action-card"><div className="card-speaker"><BookOpen size={16} />章节生产授权</div><h2>批准下一段章节范围</h2><p>{next.reason} 章节会严格串行：当前章定稿并回灌连续性后才进入下一章。</p><label>生产到第几章<input type="number" min={next.chapter} max={next.chapter + 99} value={rangeEnd} onChange={(event) => setRangeEnd(Number(event.target.value))} /></label><fieldset className="production-mode"><legend>创作方式</legend><label><input type="radio" name="production-mode" checked={!autoApproveMilestones} onChange={() => setAutoApproveMilestones(false)} />逐项确认（推荐）<small>关键规划完成后由你确认，再继续创作。</small></label><label><input type="radio" name="production-mode" checked={autoApproveMilestones} onChange={() => setAutoApproveMilestones(true)} />全自动推进<small>自动完成准备工件并连续生产至目标章节；你可随时停止。</small></label></fieldset><button className="primary-button" disabled={pending || rangeEnd < next.chapter} onClick={() => onRange(next.chapter, rangeEnd, autoApproveMilestones)}><Check />{autoApproveMilestones ? `自动创作至第 ${rangeEnd} 章` : `批准第 ${next.chapter}–${rangeEnd} 章`}</button></section>;
  if (next.type === "collect_opening_choices") return null;
  const workflowId = next.workflowId;
  if (!workflowId) return <RecoveryCard error="当前步骤缺少 Workflow 映射。" onReset={() => undefined} />;
  const chapterTarget = next.artifactKey.startsWith("chapter:") ? next.artifactKey.split(":")[1] : undefined;
  const label = workflowLabels[workflowId];
  const refreshing = next.type === "refresh_artifact";
  return <section className="flow-card next-step-card"><header className="next-step-heading"><span className="next-step-icon"><Sparkles size={19} /></span><div><span>推荐下一步</span><h2>{label}</h2></div></header><p className="next-step-reason">{refreshing ? `${label}的上游内容已有变化，需要重新整理。` : `创作链已经准备好进入“${label}”。`}</p><div className="next-step-note"><Check size={17} /><div><strong>安全生成</strong><p>读取已确认的上游内容，完成校验后按需交给你批准；受保护内容不会被覆盖。</p></div></div><button className="primary-button next-step-action" disabled={pending} onClick={() => onStart(workflowId, chapterTarget)}>{pending ? <><LoaderCircle className="spin" />正在启动…</> : <><Sparkles />{refreshing ? "重新生成" : "生成"}{label}</>}</button></section>;
}

function RecoveryCard({ error, onReset }: { error?: string; onReset: () => void }) {
  return <section className="flow-card action-card"><div className="card-speaker"><CircleAlert size={16} />本次生成未完成</div><h2>我们可以从这里重新开始</h2><p>{error ?? "这次生成已取消，没有修改作品文件。"}</p><button className="secondary-button" onClick={onReset}><RefreshCw />重新生成</button></section>;
}

function NovelSidebar({ currentId, onSettings, theme, onThemeChange }: { currentId: string; onSettings: () => void; theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap });
  return <aside className="novel-sidebar"><Link to="/" className="brand"><span className="brand-mark"><Feather size={19} /></span><span>ANI 小说 Agent</span></Link><Link to="/" className="new-novel"><Plus size={17} />新建作品</Link><nav><span className="sidebar-label">作品与主对话</span>{bootstrap.data?.novels.map((novel) => <Link key={novel.id} to={`/novels/${novel.id}`} className={novel.id === currentId ? "sidebar-novel active" : "sidebar-novel"}><BookOpen size={17} /><span>{novel.title}</span></Link>)}</nav><div className="sidebar-footer"><ThemeSwitcher compact value={theme} onChange={onThemeChange} /><button className="sidebar-settings" onClick={onSettings}><Settings2 size={17} />模型设置</button></div></aside>;
}

function ArtifactPanel({ novelId, artifacts, open, onClose, onExport }: { novelId: string; artifacts: Record<string, { status: string; protected: boolean }>; open: boolean; onClose: () => void; onExport: () => void }) {
  const queryClient = useQueryClient();
  const [selectedKey, setSelectedKey] = useState("");
  const artifact = useQuery({ queryKey: ["artifact", novelId, selectedKey], queryFn: () => api.artifact(novelId, selectedKey), enabled: Boolean(selectedKey) });
  const [content, setContent] = useState("");
  const [editing, setEditing] = useState(false);
  useEffect(() => { if (artifact.data) setContent(artifact.data.content); }, [artifact.data]);
  useEffect(() => { setEditing(false); }, [selectedKey]);
  const save = useMutation({ mutationFn: () => api.editArtifact(novelId, selectedKey, content, artifact.data?.artifact.sha256 ?? ""), onSuccess: async () => { setEditing(false); await Promise.all([queryClient.invalidateQueries({ queryKey: ["artifact", novelId, selectedKey] }), queryClient.invalidateQueries({ queryKey: ["novel", novelId] })]); } });
  if (!open) return null;
  const stages: Array<[string, string]> = [["book:novel_brief", "小说简报"], ["book:story_bible", "故事圣经"], ["book:world_bible", "世界圣经"], ["book:character_cast", "角色阵容"], ["book:volume_strategy", "卷战略"], ["book:volume_outline", "当前卷骨架"]];
  const visible = [...stages, ...Object.keys(artifacts).filter((key) => key.startsWith("chapter:")).sort().map((key) => [key, key.replace(/^chapter:(\d+):/, "第 $1 章 · ").replaceAll("_", " ")] as [string, string])];
  return <><aside className="artifact-panel"><div className="panel-heading"><div><span className="sidebar-label">作品上下文</span><h3>创作工件</h3></div><button className="icon-button" aria-label="收起工件栏" onClick={onClose}><PanelRightClose size={19} /></button></div>{visible.map(([key, label], index) => { const item = artifacts[key]; return <button type="button" key={key} disabled={!item} onClick={() => setSelectedKey(key)} className={item?.status === "ready" ? "artifact-item ready" : item?.status === "stale" ? "artifact-item active" : "artifact-item locked"}><span>{item?.status === "ready" ? <Check size={16} /> : index + 1}</span><div><strong>{label}</strong><small>{item?.protected ? "作者已保护" : item?.status === "ready" ? "已就绪" : item?.status === "stale" ? "需要刷新" : "等待上游"}</small></div></button>; })}<button className="secondary-button wide" onClick={onExport}>导出稳定章节 TXT</button><div className="context-note"><strong>创作控制</strong><p>编辑已提交工件会自动保护作者内容，并将依赖它的下游标记为需要刷新。</p></div></aside>{selectedKey && <div className="modal-backdrop"><section className="modal artifact-modal" role="dialog" aria-modal="true"><div className="modal-heading"><div><span className="eyebrow">权威工件</span><h2>{selectedKey}</h2><p>{artifact.data?.artifact.protected ? "作者已保护，Agent 不会覆盖。" : "保存编辑后将自动设为作者保护。"}</p></div><button className="icon-button" aria-label="关闭" onClick={() => setSelectedKey("")}><X /></button></div><div className="artifact-modal-body">{artifact.isLoading ? <div className="loading"><LoaderCircle className="spin" />正在读取…</div> : editing ? <textarea className="artifact-editor" rows={24} value={content} onChange={(event) => setContent(event.target.value)} /> : <div className="message-markdown artifact-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown></div>}<ErrorNotice error={artifact.error ?? save.error} /></div><div className="modal-footer">{editing ? <><button className="secondary-button" onClick={() => { setContent(artifact.data?.content ?? content); setEditing(false); }}>取消编辑</button><button className="primary-button" disabled={!artifact.data || save.isPending || content === artifact.data.content} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" /> : <Check />}保存并保护</button></> : <button className="secondary-button" disabled={!artifact.data} onClick={() => setEditing(true)}><Pencil />编辑源码</button>}</div></section></div>}</>;
}

function ExportComplete({ novelId, run }: { novelId: string; run: RunView }) {
  return <section className="flow-card complete-card"><div className="complete-mark"><Check /></div><h2>稳定章节已导出</h2><p>已汇总 {run.chapterCount ?? 0} 章。你可以直接下载 TXT 文件。</p>{run.exportPath && <a className="primary-button" href={api.exportDownloadUrl(novelId, run.exportPath)}><Download size={17} />下载 TXT</a>}</section>;
}

function NovelPage({ onSettings, theme, onThemeChange }: { onSettings: () => void; theme: ThemeId; onThemeChange: (theme: ThemeId) => void }) {
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
  const currentRun = run.data;
  const flow = (sendMessage: (text: string) => Promise<void>, isRunning: boolean, messageCount: number) => !novel.data?.novel.openingChoices
    ? openingProposal.data ? <PresetProposalCard novelId={id} proposal={openingProposal.data} onSaved={saveChoices} onReset={() => openingProposal.reset()} /> : messageCount === 0 ? <DiscoveryCard isRunning={isRunning} onSend={sendMessage} /> : null
    : currentRun?.status === "awaiting_review" && currentRun.proposal ? <BriefProposal key={`${runId}-${currentRun.proposal.openingHook}`} run={currentRun} onUpdated={refresh} onCanceled={resetRun} />
      : currentRun?.status === "awaiting_review" && currentRun.artifactProposal ? <ArtifactProposalCard key={`${runId}-${currentRun.artifactProposal.content.length}`} run={currentRun} onUpdated={refresh} onCanceled={resetRun} />
          : currentRun?.status === "running" ? <GenerationProgress label={currentRun.workflowId ? workflowLabels[currentRun.workflowId] : undefined} onCancel={cancel} />
            : currentRun?.status === "committed" && currentRun.workflowId === "novel-export" ? <ExportComplete novelId={id} run={currentRun} />
          : currentRun?.status === "failed" || currentRun?.status === "canceled" ? <RecoveryCard error={currentRun.error?.message} onReset={resetRun} />
            : novel.data?.nextAction ? <NextStepCard next={novel.data.nextAction} pending={start.isPending || range.isPending} onStart={(workflowId, target) => start.mutate({ workflowId, target })} onRange={(startChapter, endChapter, autoApproveMilestones) => range.mutate({ start: startChapter, end: endChapter, autoApproveMilestones })} /> : null;

  return <div className={artifactsOpen ? "novel-layout" : "novel-layout panel-closed"}><NovelSidebar currentId={id} onSettings={onSettings} theme={theme} onThemeChange={onThemeChange} /><main className="conversation-column"><header className="conversation-header"><Link to="/" className="mobile-menu" aria-label="返回书架"><Menu size={20} /></Link><div><small>当前作品</small><h1>{novel.data?.novel.title ?? "正在打开…"}</h1></div><div className="header-actions"><div className="mobile-theme-switcher"><ThemeSwitcher value={theme} onChange={onThemeChange} /></div><span className="agent-status"><i />Agent 已就绪</span>{!artifactsOpen && <button className="quiet-button" onClick={() => setArtifactsOpen(true)}>查看工件</button>}</div></header>
    {novel.isLoading || chat.isLoading ? <div className="loading conversation-loading"><LoaderCircle className="spin" />正在恢复这部作品的对话…</div> : chat.data ? <Conversation novelId={id} initialMessages={chat.data.messages} discoveryAction={!novel.data?.novel.openingChoices && !openingProposal.data ? { pending: openingProposal.isPending, error: openingProposal.error, onConfirm: () => openingProposal.mutate() } : undefined}>{({ sendMessage, isRunning, messageCount }) => { const node = flow(sendMessage, isRunning, messageCount); const flowError = novel.error ?? run.error ?? start.error ?? range.error ?? exportRun.error; return node || flowError ? <>{node}<ErrorNotice error={flowError} /></> : null; }}</Conversation> : <div className="loading conversation-loading"><ErrorNotice error={chat.error ?? novel.error} /></div>}
  </main><ArtifactPanel novelId={id} artifacts={novel.data?.novel.artifacts ?? {}} open={artifactsOpen} onClose={() => setArtifactsOpen(false)} onExport={() => exportRun.mutate()} /></div>;
}

export function App() {
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(readStoredTheme);
  const required = bootstrap.isSuccess && !bootstrap.data.models.configured;
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; persistTheme(theme); }, [theme]);
  return <><Routes><Route path="/" element={<HomePage onSettings={() => setSettingsOpen(true)} theme={theme} onThemeChange={setTheme} />} /><Route path="/novels/:id" element={<NovelPage onSettings={() => setSettingsOpen(true)} theme={theme} onThemeChange={setTheme} />} /></Routes><ModelSetup open={settingsOpen || required} required={required} onClose={() => setSettingsOpen(false)} /></>;
}
