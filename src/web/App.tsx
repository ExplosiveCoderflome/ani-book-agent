import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, Check, ChevronLeft, CircleAlert, Download, Feather, FileText, LoaderCircle, Moon, Play, RotateCcw, Save, Settings, Sun } from "lucide-react";
import { Suspense, lazy, useCallback, useEffect, useLayoutEffect, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from "react-router-dom";
import type { NovelFileView, PatchProposal } from "../shared/contracts";
import { Conversation } from "./Conversation";
import { api } from "./api";
import { DEFAULT_THEME, persistTheme, readStoredTheme, type ThemeId } from "./themes";
import { NovelSkillBindings, SkillEditor, SkillLibrary } from "./Skills";
import { ReferenceLibrary, ReferenceWorkspace } from "./References";
import { TensionCurveComparison, TensionCurveEditor } from "./TensionCurveEditor";

const MarkdownEditor = lazy(() => import("./MarkdownEditor").then((module) => ({ default: module.MarkdownEditor })));

const AGENT_PANEL_WIDTH_KEY = "ani-novel-agent-panel-width";
const defaultAgentPanelWidth = 410;
function clampAgentPanelWidth(value: number) { return Math.min(Math.min(960, Math.max(360, window.innerWidth - 720)), Math.max(320, value)); }
function readAgentPanelWidth() { try { const stored = Number(window.localStorage.getItem(AGENT_PANEL_WIDTH_KEY)); return clampAgentPanelWidth(Number.isFinite(stored) && stored > 0 ? stored : defaultAgentPanelWidth); } catch { return defaultAgentPanelWidth; } }

function ThemeButton({ theme, onClick }: { theme: ThemeId; onClick: () => void }) { return <button className="icon-button theme-button" onClick={onClick} aria-label={theme === "night" ? "切换到白天主题" : "切换到夜晚主题"}>{theme === "night" ? <Sun /> : <Moon />}</button>; }

function Home({ openSettings, theme, toggleTheme }: { openSettings: () => void; theme: ThemeId; toggleTheme: () => void }) {
  const navigate = useNavigate(); const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap }); const [title, setTitle] = useState("");
  const create = useMutation({ mutationFn: () => api.createNovel(title.trim() || "未命名作品"), onSuccess: (novel) => navigate(`/novels/${novel.novelId}`) });
  if (bootstrap.isLoading) return <Loading label="正在打开创作工作区…" />;
  return <main className="home"><header className="home-head"><div className="brand"><span><Feather /></span>ANI 小说 Agent</div><div className="home-actions"><Link className="header-link" to="/references">拆书库</Link><Link className="header-link" to="/skills">创作 Skill</Link><ThemeButton theme={theme} onClick={toggleTheme} /><button className="icon-button" onClick={openSettings} aria-label="模型设置"><Settings /></button></div></header><section className="project-browser"><header><div><small>PROJECTS</small><h1>作品</h1><p>选择一部作品进入工作台，或直接建立新作品。</p></div><div className="new-novel"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="给新作品一个临时名字" onKeyDown={(event) => { if (event.key === "Enter") create.mutate(); }} /><button disabled={create.isPending} onClick={() => create.mutate()}>{create.isPending ? <LoaderCircle className="spin" /> : <Feather />}新建作品</button></div></header>{create.error && <ErrorLine error={create.error} />}<section className="recent"><div><small>全部作品</small><span>{bootstrap.data?.novels.length ?? 0} 部</span></div><div className="novel-grid">{bootstrap.data?.novels.map((novel) => <Link to={`/novels/${novel.novelId}`} key={novel.novelId}><BookOpen /><div><strong>{novel.title}</strong><span>{novel.phase === "discovery" ? "正在开书" : novel.phase === "completed" ? "已完成" : `下一章 · ${novel.nextChapter}`}</span></div></Link>)}{!bootstrap.data?.novels.length && <p className="empty-note">还没有作品，建立一部就会直接进入创作工作台。</p>}</div></section></section></main>;
}

function NovelWorkspace({ openSettings, theme, toggleTheme }: { openSettings: () => void; theme: ThemeId; toggleTheme: () => void }) {
  const { id = "" } = useParams(); const [searchParams] = useSearchParams(); const client = useQueryClient();
  const snapshot = useQuery({ queryKey: ["snapshot", id], queryFn: () => api.snapshot(id), enabled: Boolean(id), refetchInterval: (query) => query.state.data?.activeJob && ["running", "queued"].includes(query.state.data.activeJob.status) ? 2_000 : false });
  const chat = useQuery({ queryKey: ["chat", id], queryFn: () => api.chat(id), enabled: Boolean(id) });
  const [proposal, setProposal] = useState<PatchProposal>(); const [selected, setSelected] = useState(""); const [editing, setEditing] = useState(""); const [dirty, setDirty] = useState(false); const [feedback, setFeedback] = useState(""); const [agentCommand, setAgentCommand] = useState<{ id: number; text: string; activity: { title: string; detail: string } }>(); const [agentWidth, setAgentWidth] = useState(readAgentPanelWidth);
  const refresh = useCallback(async () => { await Promise.all([client.invalidateQueries({ queryKey: ["snapshot", id] }), client.invalidateQueries({ queryKey: ["chat", id] })]); }, [client, id]);
  const files = snapshot.data?.files ?? [];
  useEffect(() => { if (selected && files.some((item) => item.path === selected)) return; const chapters = files.filter((item) => item.path.startsWith("chapters/")).sort((a, b) => b.path.localeCompare(a.path)); setSelected(chapters[0]?.path ?? (files.some((item) => item.path === "book/blueprint.md") ? "book/blueprint.md" : files[0]?.path ?? "")); }, [files, selected]);
  const file = useQuery({ queryKey: ["file", id, selected], queryFn: () => api.file(id, selected), enabled: Boolean(id && selected) });
  const selectedVolume = selected.match(/^volumes\/volume-(\d{3})-tension\.yaml$/)?.[1];
  const actualPath = selectedVolume ? `workspace/analysis/volume-${selectedVolume}-tension-actual.yaml` : "";
  const actualFile = useQuery({ queryKey: ["file", id, actualPath], queryFn: () => api.file(id, actualPath), enabled: Boolean(id && actualPath && files.some((item) => item.path === actualPath)) });
  useEffect(() => { if (file.data && !dirty) setEditing(file.data.content); }, [dirty, file.data]);
  useEffect(() => { try { window.localStorage.setItem(AGENT_PANEL_WIDTH_KEY, String(agentWidth)); } catch { /* The panel still resizes for this session. */ } }, [agentWidth]);
  useEffect(() => { const warn = (event: BeforeUnloadEvent) => { if (!dirty) return; event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", warn); return () => window.removeEventListener("beforeunload", warn); }, [dirty]);
  const save = useMutation({ mutationFn: () => api.saveFile(id, { path: selected, content: editing, expectedSha256: file.data!.sha256 }), onSuccess: async () => { setDirty(false); await refresh(); await client.invalidateQueries({ queryKey: ["file", id, selected] }); } });
  const approve = useMutation({ mutationFn: () => api.approveProposal(id, proposal!), onSuccess: async () => { setProposal(undefined); await refresh(); } });
  const start = useMutation({ mutationFn: (goal: "write_chapters" | "export") => api.startJob(id, { goal, scope: goal === "write_chapters" ? { fromChapter: snapshot.data!.novel.nextChapter, toChapter: snapshot.data!.novel.nextChapter + 2 } : {} }), onSuccess: refresh });
  const action = useMutation({ mutationFn: (value: { action: "continue" | "revise" | "cancel"; feedback?: string }) => api.jobAction(id, snapshot.data!.activeJob!.id, value), onSuccess: async () => { setFeedback(""); await refresh(); } });
  if (snapshot.isLoading || chat.isLoading) return <Loading label="正在恢复作品…" />;
  if (!snapshot.data || !chat.data) return <main className="fatal"><CircleAlert /><h1>无法打开作品</h1><ErrorLine error={snapshot.error ?? chat.error} /></main>;
  const discovery = snapshot.data.novel.phase === "discovery";
  const jobBusy = Boolean(snapshot.data.activeJob && ["queued", "running", "awaiting_author"].includes(snapshot.data.activeJob.status));
  const groups = fileGroups(files, discovery);
  const characterById = new Map((snapshot.data.characterStates ?? []).map((character) => [character.id, character]));
  const markdownFile = selected.toLowerCase().endsWith(".md");
  const curveFile = selected === "book/tension-curve.yaml" || /^volumes\/volume-\d{3}-tension\.yaml$/.test(selected);
  const chooseFile = (path: string) => { if (dirty && !window.confirm("当前文档还有未保存的修改，确定要离开吗？")) return; setDirty(false); setSelected(path); };
  const beginAgentResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const layout = event.currentTarget.parentElement; const startX = event.clientX; const startWidth = agentWidth; let nextWidth = startWidth; let frame = 0;
    const render = () => { frame = 0; layout?.style.setProperty("--agent-panel-width", `${nextWidth}px`); };
    const move = (next: PointerEvent) => { nextWidth = clampAgentPanelWidth(startWidth + startX - next.clientX); if (!frame) frame = window.requestAnimationFrame(render); };
    const stop = () => { if (frame) window.cancelAnimationFrame(frame); render(); setAgentWidth(nextWidth); document.body.classList.remove("resizing-panel"); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", stop); window.removeEventListener("pointercancel", stop); };
    document.body.classList.add("resizing-panel"); window.addEventListener("pointermove", move); window.addEventListener("pointerup", stop); window.addEventListener("pointercancel", stop);
  };
  const externalActivity = approve.isPending
    ? { title: "正在确认蓝图并规划第一卷", detail: "原子写入蓝图、角色与全书曲线 → 生成卷计划和逐章曲线 → 等待你确认后再写正文。" }
    : start.isPending ? { title: "正在启动章节生产", detail: "任务创建成功后，规划、写作和独立审查进度会继续显示在这里。" } : undefined;
  const applyReference = searchParams.get("applyReference"); const analysisId = searchParams.get("analysis"); const referenceGoal = searchParams.get("goal"); const referenceSection = searchParams.get("section"); const insightIds = searchParams.get("insights")?.split(",").filter(Boolean) ?? [];
  const referenceDraft = applyReference && analysisId && referenceSection ? `请读取拆书小节（referenceId: ${applyReference}，analysisId: ${analysisId}，kind: section，id: ${referenceSection}），只研究已选洞察：${insightIds.join("、") || "该小节全部可靠洞察"}。结合当前作品已有蓝图、角色和卷计划，围绕这个明确目标提出适配方案：${referenceGoal || "提炼最值得迁移的抽象机制"}。先说明建议、适用边界和与参考书的差异；我确认后才提交作品文件修改提案。不得复制参考书专有名字、设定、情节组合或表达，也不得把参考书事实写入连续性账本。` : "";
  const conversation = <Conversation novelId={id} initialMessages={chat.data.messages} initialDraft={referenceDraft} command={agentCommand} centered={discovery} job={snapshot.data.activeJob} externalActivity={externalActivity} appliedProposalIds={snapshot.data.novel.appliedProposalIds} onProposal={setProposal} onChange={refresh} />;
  return <div className={`workspace ${discovery ? "discovery" : "writing"}`}>
    <header className="topbar">
      <Link className="topbar-home" to="/projects" onClick={(event) => { if (dirty && !window.confirm("当前文档还有未保存的修改，确定要离开吗？")) event.preventDefault(); }}><span><Feather /></span><ChevronLeft />全部作品</Link>
      <div className="project-heading"><div><span className={`phase-dot ${snapshot.data.novel.phase}`} />{discovery ? "正在构思" : snapshot.data.novel.phase === "completed" ? "已经完本" : `第 ${snapshot.data.novel.currentVolume} 卷 · 下一章 ${snapshot.data.novel.nextChapter}`}</div><strong>{snapshot.data.novel.title}</strong></div>
      <div className="topbar-actions">{!discovery && <><button disabled={jobBusy || start.isPending} onClick={() => start.mutate("write_chapters")}><Play />续写第 {snapshot.data.novel.nextChapter}–{snapshot.data.novel.nextChapter + 2} 章</button><button className="quiet-action" disabled={jobBusy || start.isPending} onClick={() => start.mutate("export")}><Download />导出</button></>}<ThemeButton theme={theme} onClick={toggleTheme} /><button className="icon-button" aria-label="模型设置" onClick={openSettings}><Settings /></button></div>
    </header>
    <main className="writing-main" style={{ "--agent-panel-width": `${agentWidth}px` } as CSSProperties}>
      <aside className="file-nav">
        <header><div><small>{discovery ? "从想法到开书" : "当前作品"}</small><h2>{discovery ? "创作进度" : "作品目录"}</h2></div></header>
        <nav>
          {discovery && <CreationProgress files={files} />}
          {groups.map((group) => <section className="file-group" key={group.label}><header><span>{group.label}</span><small>{group.files.length}</small></header>{group.files.map((item) => { const characterId = item.path.match(/^book\/characters\/(.+)\.md$/)?.[1]; const character = characterId ? characterById.get(characterId) : undefined; return <button className={selected === item.path ? "active" : ""} key={item.path} onClick={() => chooseFile(item.path)}><FileText /><span><strong>{character?.name ?? fileLabel(item.path)}</strong><small>{character ? `${character.role} · ${character.state}` : fileMeta(item)}</small></span></button>; })}</section>)}
          <details className="project-settings"><summary><span>项目设置</span><small>创作方法自动选择</small></summary><NovelSkillBindings novelId={id} /></details>
        </nav>
      </aside>
      <section className="document-pane">
        {proposal ? <ProposalReview proposal={proposal} pending={approve.isPending} onApprove={() => approve.mutate()} onReject={() => setProposal(undefined)} /> : <section className={`editor ${curveFile ? "curve-document" : ""}`}><header><div><small>{selected || "尚未选择文件"}</small><strong>{fileLabel(selected)}</strong></div><div>{dirty && <span className="dirty-state">未保存</span>}{!curveFile && <button disabled={!dirty || save.isPending || !file.data} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" /> : <Save />}保存</button>}</div></header>{file.isLoading ? <Loading label="正在读取文档…" /> : file.data ? curveFile ? <TensionCurveEditor key={`${selected}:${file.data.sha256}`} content={editing || file.data.content} actualContent={actualFile.data?.content} fileHashes={Object.fromEntries(files.map((item) => [item.path, item.sha256]))} authorEdited={file.data.source === "author"} dirty={dirty} saving={save.isPending} onChange={(value) => { setEditing(value); setDirty(value !== file.data.content); }} onSave={() => save.mutate()} onRequestAi={() => setAgentCommand({ id: Date.now(), text: `请读取 ${selected} 及其生成依据，结合${actualFile.data ? `${actualPath} 的实际走势、异常诊断和` : ""}当前蓝图与卷计划，优化所有未锁定节点。必须保留 locked: true 节点，不复制或重排它们；先说明调整理由，再通过 propose_patch 提交曲线替换提案。`, activity: { title: "正在优化未锁定节点", detail: "读取目标与实际走势 → 保留作者锁定点 → 生成幽灵曲线提案；批准前不会替换资产。" } })} /> : markdownFile ? <Suspense fallback={<Loading label="正在打开可视化编辑器…" />}><MarkdownEditor fileKey={`${selected}:${file.data.sha256}`} markdown={file.data.content} onChange={(value, initialMarkdownNormalize) => { if (initialMarkdownNormalize) return; setEditing(value); setDirty(value !== file.data.content); }} /></Suspense> : <textarea className="source-text-editor" value={editing} onChange={(event) => { setEditing(event.target.value); setDirty(event.target.value !== file.data.content); }} spellCheck={false} aria-label={fileLabel(selected)} /> : <div className="document-empty"><FileText /><h2>这里会显示作品文件</h2><p>与右侧 Agent 讨论时，灵感、蓝图、卷计划和章节会持续出现在左侧。</p></div>}{save.error && <ErrorLine error={save.error} />}{selected.startsWith("exports/") && file.data && <button className="download-file" onClick={() => download(file.data!.content, selected)}><Download />下载 TXT</button>}</section>}
      </section>
      <div className="panel-resizer" role="separator" aria-label="调整 Agent 面板宽度" aria-orientation="vertical" aria-valuemin={320} aria-valuemax={960} aria-valuenow={agentWidth} tabIndex={0} onPointerDown={beginAgentResize} onDoubleClick={() => setAgentWidth(defaultAgentPanelWidth)} onKeyDown={(event) => { if (event.key === "ArrowLeft") setAgentWidth((value) => clampAgentPanelWidth(value + 24)); if (event.key === "ArrowRight") setAgentWidth((value) => clampAgentPanelWidth(value - 24)); }} />
      <aside className="agent-panel">{conversation}</aside>
    </main>
    <JobDock job={snapshot.data.activeJob} feedback={feedback} setFeedback={setFeedback} pending={action.isPending} curveDirty={curveFile && dirty} onAction={(value) => action.mutate(value)} />
    {approve.error || start.error || action.error ? <div className="global-error"><ErrorLine error={approve.error ?? start.error ?? action.error} /></div> : null}
  </div>;
}

function fileGroups(files: NovelFileView[], discovery: boolean) {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path, "zh-CN", { numeric: true }));
  return [
    { label: discovery ? "已生成内容" : "故事", files: sorted.filter((item) => item.path === "workspace/ideas.md" || (item.path.startsWith("book/") && !item.path.startsWith("book/characters/") && item.path !== "book/ledger.yaml")) },
    { label: "角色", files: sorted.filter((item) => item.path.startsWith("book/characters/")) },
    { label: "卷与章节", files: sorted.filter((item) => item.path.startsWith("volumes/") || item.path.startsWith("chapters/")) },
    { label: "参考与审查", files: sorted.filter((item) => item.path.startsWith("workspace/references/") || item.path.startsWith("workspace/reviews/")) },
    { label: "导出文件", files: sorted.filter((item) => item.path.startsWith("exports/")) },
  ].filter((group) => group.files.length > 0);
}

function fileMeta(file: NovelFileView) { return file.protected ? "作者保护" : file.source === "agent" ? `Agent · v${file.version}` : `${file.source} · v${file.version}`; }

function CreationProgress({ files }: { files: NovelFileView[] }) {
  const paths = files.map((file) => file.path);
  const steps = [
    ["灵感与方向", paths.includes("workspace/ideas.md")],
    ["故事蓝图", paths.includes("book/blueprint.md")],
    ["全书张力", paths.includes("book/tension-curve.yaml")],
    ["主要角色", paths.some((path) => path.startsWith("book/characters/"))],
    ["第一卷规划", paths.some((path) => path.startsWith("volumes/"))],
  ] as const;
  const current = steps.findIndex(([, done]) => !done);
  return <ol className="creation-progress">{steps.map(([label, done], index) => <li className={done ? "done" : index === current ? "current" : ""} key={label}><i>{done ? <Check /> : index + 1}</i><span>{label}</span>{index === current && <small>下一步</small>}</li>)}</ol>;
}

function ProposalReview({ proposal, pending, onApprove, onReject, compact = false }: { proposal: PatchProposal; pending: boolean; onApprove: () => void; onReject: () => void; compact?: boolean }) {
  const opensBook = proposal.changes.some((change) => change.path === "book/blueprint.md" && change.operation === "create");
  return <section className={`proposal-review ${compact ? "compact" : ""}`}><small>Agent 提案</small><h2>{proposal.summary}</h2><p>{proposal.intent}</p><div className="proposal-files">{proposal.changes.map((change) => <ProposalChange key={change.path} novelId={proposal.novelId} change={change} compact={compact} />)}</div><div className="proposal-actions"><button disabled={pending} onClick={onApprove}>{pending ? <LoaderCircle className="spin" /> : <Check />}{opensBook ? "确认蓝图并规划第一卷" : "批准修改"}</button><button disabled={pending} onClick={onReject}>{opensBook ? "继续讨论" : "拒绝"}</button></div></section>;
}

function ProposalChange({ novelId, change, compact }: { novelId: string; change: PatchProposal["changes"][number]; compact: boolean }) {
  const previous = useQuery({ queryKey: ["proposal-base", novelId, change.path, change.baseSha256], queryFn: () => api.file(novelId, change.path), enabled: change.operation === "replace" });
  const curve = change.path === "book/tension-curve.yaml" || /^volumes\/volume-\d{3}-tension\.yaml$/.test(change.path);
  const lines = change.operation === "replace" && previous.data ? lineDiff(previous.data.content, change.content) : change.content.split("\n").map((value) => ({ kind: "add" as const, value }));
  return <details open={!compact}><summary>{fileLabel(change.path)}<span>{curve ? change.overrideLockedNodes ? "整条替换 · 覆盖锁定节点" : "曲线对比" : change.operation === "create" ? "新建" : "逐行差异"}</span></summary>{previous.isLoading ? <Loading label="正在生成差异…" /> : curve ? <><TensionCurveComparison before={previous.data?.content} after={change.content} />{change.overrideLockedNodes && <div className="curve-override-warning"><CircleAlert />批准后会覆盖作者锁定节点，请确认这是你明确要求的整条替换。</div>}</> : <pre className="line-diff">{lines.map((line, index) => <span className={line.kind} key={`${line.kind}-${index}`}><i>{line.kind === "add" ? "+" : line.kind === "remove" ? "−" : " "}</i>{line.value || " "}</span>)}</pre>}</details>;
}

function lineDiff(before: string, after: string) {
  const oldLines = before.split("\n"); const newLines = after.split("\n"); let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix += 1;
  return [
    ...oldLines.slice(0, prefix).map((value) => ({ kind: "same" as const, value })),
    ...oldLines.slice(prefix, oldLines.length - suffix).map((value) => ({ kind: "remove" as const, value })),
    ...newLines.slice(prefix, newLines.length - suffix).map((value) => ({ kind: "add" as const, value })),
    ...oldLines.slice(oldLines.length - suffix).map((value) => ({ kind: "same" as const, value })),
  ];
}

function JobDock({ job, feedback, setFeedback, pending, curveDirty, onAction }: { job: any; feedback: string; setFeedback: (value: string) => void; pending: boolean; curveDirty: boolean; onAction: (value: { action: "continue" | "revise" | "cancel"; feedback?: string }) => void }) {
  if (!job) return null;
  const curveConfirmation = job.status === "awaiting_author" && job.checkpoint === "curve_confirmation";
  return <footer className={`job-dock ${job.status}`}><div>{job.status === "running" ? <LoaderCircle className="spin" /> : job.status === "awaiting_author" ? <CircleAlert /> : <RotateCcw />}<span><strong>{job.status === "running" ? job.goal === "review_project" ? "Critic 正在审查作品" : "Agent 正在连续写作" : curveConfirmation ? "请确认本卷张力曲线" : job.status === "awaiting_author" ? `第 ${job.cursor} 章需要你的判断` : "生产任务未完成"}</strong><small>{job.status === "running" ? job.goal === "review_project" ? job.brief ?? "读取证据 → 分批审查 → 保存报告" : "写作 → 独立验收 → 稳定提交" : curveConfirmation ? curveDirty ? "当前曲线有未保存修改，保存后才能继续。" : "可打开卷张力曲线拖动调整；保存后再继续章节生产。" : job.error?.message ?? "可以取消后重新开始"}</small></span></div>{job.status === "awaiting_author" && !curveConfirmation && <input value={feedback} onChange={(event) => setFeedback(event.target.value)} placeholder="可选：告诉 Agent 如何调整" />}{job.status === "awaiting_author" && <button disabled={pending || (curveConfirmation && curveDirty)} onClick={() => onAction({ action: curveConfirmation ? "continue" : feedback ? "revise" : "continue", feedback: feedback || undefined })}>{curveConfirmation ? curveDirty ? "先保存曲线" : "曲线已确认，继续" : "继续处理"}</button>}<button className="danger" disabled={pending} onClick={() => onAction({ action: "cancel" })}>取消</button></footer>;
}

function ModelSetup({ open, required, onClose }: { open: boolean; required: boolean; onClose: () => void }) {
  const providers = useQuery({ queryKey: ["providers"], queryFn: api.providers, enabled: open }); const profiles = useQuery({ queryKey: ["model-profiles"], queryFn: api.modelProfiles, enabled: open }); const [providerId, setProviderId] = useState(""); const [modelId, setModelId] = useState(""); const [analysisModel, setAnalysisModel] = useState(""); const [credentials, setCredentials] = useState<Record<string, string>>({}); const client = useQueryClient();
  const provider = providers.data?.providers.find((item) => item.id === providerId) ?? providers.data?.providers[0];
  useEffect(() => { if (!providerId && provider) setProviderId(provider.id); }, [provider, providerId]);
  useEffect(() => { if (provider && !provider.models.some((item) => item.id === modelId)) setModelId(provider.models[0]?.id ?? ""); }, [modelId, provider]);
  useEffect(() => { const value = profiles.data?.profiles.analysis; if (value) setAnalysisModel(JSON.stringify([value.providerId, value.modelId])); }, [profiles.data]);
  const save = useMutation({ mutationFn: async () => { await api.saveModel({ providerId: provider!.id, modelId, credentials }); const selected = analysisModel ? JSON.parse(analysisModel) as [string, string] : undefined; await api.saveModelProfiles({ ...profiles.data?.profiles, analysis: selected ? { providerId: selected[0], modelId: selected[1], parameters: profiles.data?.profiles.analysis?.parameters ?? {} } : null }); }, onSuccess: async () => { await Promise.all([client.invalidateQueries({ queryKey: ["bootstrap"] }), client.invalidateQueries({ queryKey: ["model-profiles"] })]); onClose(); } });
  if (!open) return null;
  return <div className="modal-backdrop"><section className="model-modal"><small>模型设置</small><h2>连接你的创作模型</h2><p>默认模型用于聊天、写作和审查；拆书可单独指定分析模型，留空时自动回退到审查模型或默认模型。</p>{providers.isLoading || profiles.isLoading ? <Loading label="正在读取模型目录…" /> : <><label>默认提供商<select value={provider?.id ?? ""} onChange={(event) => { setProviderId(event.target.value); setCredentials({}); }}>{providers.data?.providers.map((item) => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label><label>默认模型<select value={modelId} onChange={(event) => setModelId(event.target.value)}>{provider?.models.map((item) => <option value={item.id} key={item.id}>{item.name}</option>)}</select></label>{provider?.envVar.map((name) => <label key={name}>{name}<input type="password" value={credentials[name] ?? ""} onChange={(event) => setCredentials((current) => ({ ...current, [name]: event.target.value }))} placeholder={provider.connected ? "已保存；留空保持不变" : "请输入密钥"} /></label>)}<label>拆书分析模型<select value={analysisModel} onChange={(event) => setAnalysisModel(event.target.value)}><option value="">沿用审查模型或默认模型</option>{providers.data?.providers.filter((item) => item.connected || item.id === provider?.id).flatMap((item) => item.models.map((model) => <option key={`${item.id}/${model.id}`} value={JSON.stringify([item.id, model.id])}>{item.label} · {model.name}</option>))}</select></label><div className="modal-actions"><button disabled={!provider || !modelId || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" /> : <Check />}保存</button>{!required && <button onClick={onClose}>取消</button>}</div>{save.error && <ErrorLine error={save.error} />}</>}</section></div>;
}

function Loading({ label }: { label: string }) { return <div className="loading"><LoaderCircle className="spin" />{label}</div>; }
function ErrorLine({ error }: { error: unknown }) { return <div className="error-line"><CircleAlert />{error instanceof Error ? error.message : "操作没有完成，请重试。"}</div>; }
function fileLabel(path: string) { const name = path.split("/").at(-1) ?? path; if (!path) return "未选择文档"; if (path === "workspace/ideas.md") return "灵感便笺"; if (path === "book/blueprint.md") return "作品蓝图"; if (path === "book/tension-curve.yaml") return "全书张力曲线"; if (path.startsWith("book/characters/")) return `角色 · ${name.replace(/\.md$/i, "")}`; if (path === "book/ledger.yaml") return "连续性账本"; if (path.startsWith("workspace/reviews/")) return "项目审查报告"; if (path.startsWith("workspace/references/")) return name; if (/^volumes\/volume-\d{3}-tension\.yaml$/.test(path)) return `第 ${Number(name.match(/\d+/)?.[0] ?? 0)} 卷张力曲线`; if (path.startsWith("volumes/")) return "当前卷计划"; if (path.startsWith("chapters/")) return `第 ${Number(name.match(/\d+/)?.[0] ?? 0)} 章`; if (path.startsWith("exports/")) return "TXT 导出"; return name; }
function download(content: string, path: string) { const url = URL.createObjectURL(new Blob([content], { type: "text/plain;charset=utf-8" })); const anchor = document.createElement("a"); anchor.href = url; anchor.download = path.split("/").at(-1) ?? "novel.txt"; anchor.click(); URL.revokeObjectURL(url); }

export function App() {
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap, retry: true, retryDelay: 1_500 }); const [settings, setSettings] = useState(false); const [theme, setTheme] = useState<ThemeId>(() => readStoredTheme() || DEFAULT_THEME);
  useLayoutEffect(() => { document.documentElement.dataset.theme = theme; persistTheme(theme); }, [theme]);
  if (bootstrap.isLoading) return <Loading label="正在启动创作服务…" />;
  const required = Boolean(bootstrap.data && !bootstrap.data.models.configured);
  const toggleTheme = () => setTheme(theme === "night" ? "daylight" : "night");
  const home = <Home openSettings={() => setSettings(true)} theme={theme} toggleTheme={toggleTheme} />;
  return <><Routes><Route path="/" element={bootstrap.data?.novels[0] ? <Navigate replace to={`/novels/${bootstrap.data.novels[0].novelId}`} /> : home} /><Route path="/projects" element={home} /><Route path="/references" element={<ReferenceLibrary />} /><Route path="/references/:referenceId" element={<ReferenceWorkspace />} /><Route path="/skills" element={<SkillLibrary />} /><Route path="/skills/:skillId" element={<SkillEditor />} /><Route path="/novels/:id" element={<NovelWorkspace openSettings={() => setSettings(true)} theme={theme} toggleTheme={toggleTheme} />} /></Routes><ModelSetup open={settings || required} required={required} onClose={() => setSettings(false)} /></>;
}
