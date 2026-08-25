import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  BookOpen,
  Check,
  CircleAlert,
  FileUp,
  LoaderCircle,
  Play,
  Plus,
  Trash2,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { parse } from "yaml";
import {
  MAX_REFERENCE_TOKEN_BUDGET,
  MIN_REFERENCE_TOKEN_BUDGET,
  type ChapterParserConfig,
  type ChapterPattern,
  type DeconstructionFocus,
  type DeconstructionMode,
  type ReferenceAnalysisPreset,
  referenceAnalysisFieldLabels,
  type ReferenceJob,
} from "../shared/contracts";
import { api } from "./api";

const formatted = (value: number) =>
  new Intl.NumberFormat("zh-CN").format(value);
const REFERENCE_CONTROL_WIDTH_KEY = "ani-reference-control-width";
const defaultReferenceControlWidth = 440;
function clampReferenceControlWidth(value: number) {
  return Math.min(
    Math.max(320, Math.min(680, window.innerWidth - 780)),
    Math.max(320, value),
  );
}
function readReferenceControlWidth() {
  try {
    const stored = Number(window.localStorage.getItem(REFERENCE_CONTROL_WIDTH_KEY));
    return clampReferenceControlWidth(Number.isFinite(stored) && stored > 0 ? stored : defaultReferenceControlWidth);
  } catch {
    return defaultReferenceControlWidth;
  }
}
function ErrorLine({ error }: { error: unknown }) {
  return (
    <p className="reference-error">
      <CircleAlert />
      {error instanceof Error ? error.message : "操作没有完成。"}
    </p>
  );
}

export function ReferenceLibrary() {
  const navigate = useNavigate();
  const client = useQueryClient();
  const references = useQuery({
    queryKey: ["references"],
    queryFn: api.references,
  });
  const [file, setFile] = useState<File>();
  const [title, setTitle] = useState("");
  const imported = useMutation({
    mutationFn: () => api.importReference(file!, title),
    onSuccess: async (result) => {
      await client.invalidateQueries({ queryKey: ["references"] });
      navigate(`/references/${result.state.referenceId}`);
    },
  });
  return (
    <main className="reference-page">
      <header className="reference-topbar">
        <Link to="/projects">
          <ArrowLeft />
          作品
        </Link>
        <div>
          <small>REFERENCE LIBRARY</small>
          <h1>拆书库</h1>
        </div>
      </header>
      <section className="reference-import">
        <div>
          <h2>导入一本参考小说</h2>
          <p>本地保存原文，先预览章节和 Token，再由你确认是否开始。</p>
        </div>
        <input
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="可选：参考书名称"
        />
        <label className="reference-file">
          <FileUp />
          {file?.name ?? "选择 TXT 或 Markdown"}
          <input
            type="file"
            accept=".txt,.md,.markdown,text/plain,text/markdown"
            onChange={(event) => setFile(event.currentTarget.files?.[0])}
          />
        </label>
        <button
          disabled={!file || imported.isPending}
          onClick={() => imported.mutate()}
        >
          {imported.isPending ? <LoaderCircle className="spin" /> : <Plus />}
          导入并解析
        </button>
        {imported.error && <ErrorLine error={imported.error} />}
      </section>
      <section className="reference-list">
        <header>
          <h2>参考书</h2>
          <span>{references.data?.references.length ?? 0} 本</span>
        </header>
        {references.isLoading ? (
          <p>正在读取…</p>
        ) : references.data?.references.length ? (
          references.data.references.map((item) => (
            <Link to={`/references/${item.referenceId}`} key={item.referenceId}>
              <BookOpen />
              <div>
                <strong>{item.title}</strong>
                <span>
                  {formatted(item.source.chars)} 字符 ·{" "}
                  {item.manifestConfirmed
                    ? item.latestAnalysisId
                      ? "已有拆书结果"
                      : "可以开始拆书"
                    : "等待确认章节"}
                </span>
              </div>
            </Link>
          ))
        ) : (
          <p className="reference-empty">
            还没有参考书。导入后只做章节切分，不会立即调用模型。
          </p>
        )}
      </section>
    </main>
  );
}

export function ReferenceWorkspace() {
  const { referenceId = "" } = useParams();
  const navigate = useNavigate();
  const client = useQueryClient();
  const detail = useQuery({
    queryKey: ["reference", referenceId],
    queryFn: () => api.reference(referenceId),
    enabled: Boolean(referenceId),
  });
  const [preset, setPreset] = useState<ReferenceAnalysisPreset>("standard");
  const mode: DeconstructionMode = "standard";
  const focuses: DeconstructionFocus[] = [];
  const [budget, setBudget] = useState(0);
  const [startedJob, setStartedJob] = useState<ReferenceJob>();
  const [extraBudget, setExtraBudget] = useState(1_000_000);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState("");
  const [rerun, setRerun] = useState(false);
  const [contentView, setContentView] = useState<"source" | "analysis">("source");
  const [sourceChapterId, setSourceChapterId] = useState("");
  const [controlWidth, setControlWidth] = useState(readReferenceControlWidth);
  const [rangeFrom, setRangeFrom] = useState(1);
  const [rangeTo, setRangeTo] = useState(0);
  const focusKey = [...focuses].sort().join(",");
  const manifestChapterCount = detail.data?.manifest.chapters.length ?? 0;
  useEffect(() => {
    if (!manifestChapterCount) return;
    setRangeFrom(1);
    setRangeTo(manifestChapterCount);
  }, [detail.data?.manifest.sha256, manifestChapterCount]);
  const chapterRange = { fromChapter: rangeFrom, toChapter: rangeTo || Math.max(1, manifestChapterCount) };
  const estimate = useQuery({
    queryKey: ["reference-estimate", referenceId, preset, mode, focusKey, chapterRange.fromChapter, chapterRange.toChapter],
    queryFn: () => api.estimateReference(referenceId, mode, focuses, chapterRange, preset),
    enabled: Boolean(referenceId && manifestChapterCount && rangeTo),
  });
  useEffect(() => {
    if (estimate.data)
      setBudget(
        Math.max(
          MIN_REFERENCE_TOKEN_BUDGET,
          Math.min(MAX_REFERENCE_TOKEN_BUDGET, estimate.data.recommendedBudget),
        ),
      );
  }, [estimate.data]);
  useEffect(() => {
    try {
      window.localStorage.setItem(REFERENCE_CONTROL_WIDTH_KEY, String(controlWidth));
    } catch {
      // The split pane still resizes for this session.
    }
  }, [controlWidth]);
  const confirm = useMutation({
    mutationFn: () =>
      api.confirmReference(referenceId, detail.data!.manifest.sha256),
    onSuccess: async () =>
      client.invalidateQueries({ queryKey: ["reference", referenceId] }),
  });
  const rebuildManifest = useMutation({
    mutationFn: () => api.rebuildReferenceManifest(referenceId),
    onSuccess: async () => {
      setSourceChapterId("");
      setContentView("source");
      setSelectedAnalysisId("");
      setRerun(true);
      await Promise.all([
        client.invalidateQueries({ queryKey: ["reference", referenceId] }),
        client.invalidateQueries({ queryKey: ["reference-estimate", referenceId] }),
      ]);
    },
  });
  const start = useMutation({
    mutationFn: () =>
      api.startReferenceJob(referenceId, {
        mode,
        preset,
        chapterRange,
        manifestHash: detail.data!.manifest.sha256,
        tokenBudget: budget,
      }),
    onSuccess: async (job) => {
      setStartedJob(job);
      setSelectedAnalysisId(job.analysisId);
      setRerun(false);
      await client.invalidateQueries({ queryKey: ["reference", referenceId] });
    },
  });
  const jobId = detail.data?.activeJob?.id ?? startedJob?.id;
  const job = useQuery({
    queryKey: ["reference-job", referenceId, jobId],
    queryFn: () => api.referenceJob(referenceId, jobId!),
    enabled: Boolean(jobId),
    refetchInterval: (query) =>
      ["running", "queued"].includes(query.state.data?.status ?? "")
        ? 2_000
        : false,
  });
  useEffect(() => {
    if (
      job.data &&
      ["completed", "failed", "canceled"].includes(job.data.status)
    ) {
      void Promise.all([
        client.invalidateQueries({ queryKey: ["reference", referenceId] }),
        client.invalidateQueries({ queryKey: ["reference-analysis", referenceId, job.data.analysisId] }),
      ]);
      if (["failed", "canceled"].includes(job.data.status)) {
        setSelectedAnalysisId("");
        setRerun(true);
      }
    }
  }, [client, job.data, referenceId]);
  const action = useMutation({
    mutationFn: (value: {
      action: "add_budget" | "cancel";
      additionalTokens?: number;
    }) => api.referenceJobAction(referenceId, jobId!, value),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({
          queryKey: ["reference-job", referenceId, jobId],
        }),
        client.invalidateQueries({ queryKey: ["reference", referenceId] }),
      ]);
    },
  });
  const removed = useMutation({
    mutationFn: () => api.deleteReference(referenceId),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ["references"] });
      navigate("/references");
    },
  });
  const clearedAnalyses = useMutation({
    mutationFn: () => api.clearReferenceAnalyses(referenceId),
    onSuccess: async () => {
      setSelectedAnalysisId("");
      setRerun(true);
      await client.invalidateQueries({ queryKey: ["reference", referenceId] });
    },
  });
  const analysisId = selectedAnalysisId || detail.data?.state.latestAnalysisId;
  const analysis = useQuery({
    queryKey: ["reference-analysis", referenceId, analysisId],
    queryFn: () => api.referenceAnalysis(referenceId, analysisId!),
    enabled: Boolean(analysisId),
    refetchInterval: (query) => query.state.data?.analysis.characterProfiles.some((item: any) => item.status === "generating") ? 2_000 : false,
  });
  const needsLegacyCleanup = analysis.data?.analysis.reportPath === "report.md";
  const sourceChapters = detail.data?.manifest.chapters ?? [];
  const sourceChapter =
    sourceChapters.find((item) => item.id === sourceChapterId) ??
    sourceChapters[0];
  useEffect(() => {
    if (sourceChapter && sourceChapter.id !== sourceChapterId) {
      setSourceChapterId(sourceChapter.id);
    }
  }, [sourceChapter?.id, sourceChapterId]);
  const sourceDocument = useQuery({
    queryKey: [
      "reference-source-chapter",
      referenceId,
      sourceChapter?.id,
      sourceChapter?.start,
      sourceChapter?.end,
    ],
    queryFn: () =>
      api.referenceSource(referenceId, sourceChapter!.start, sourceChapter!.end),
    enabled: Boolean(referenceId && sourceChapter),
  });
  const [sourceExcerpt, setSourceExcerpt] = useState<{
    start: number;
    end: number;
    content: string;
  }>();
  const evidence = useMutation({
    mutationFn: (item: { start: number; end: number }) =>
      api.referenceSource(
        referenceId,
        Math.max(0, item.start - 200),
        Math.min(detail.data?.state.source.chars ?? item.end, item.end + 300),
      ),
    onSuccess: setSourceExcerpt,
  });
  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    queryFn: api.bootstrap,
  });
  if (detail.isLoading)
    return (
      <main className="reference-page">
        <p>正在读取参考书…</p>
      </main>
    );
  if (!detail.data)
    return (
      <main className="reference-page">
        <ErrorLine error={detail.error} />
      </main>
    );
  const { state, manifest } = detail.data;
  const currentJob = job.data ?? detail.data.activeJob ?? startedJob;
  const activeJob =
    currentJob && ["queued", "running", "paused"].includes(currentJob.status)
      ? currentJob
      : undefined;
  const chapters = manifest.chapters;
  const beginControlResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const layout = event.currentTarget.parentElement;
    const startX = event.clientX;
    const startWidth = controlWidth;
    let nextWidth = startWidth;
    let frame = 0;
    const render = () => {
      frame = 0;
      layout?.style.setProperty("--reference-control-width", `${nextWidth}px`);
    };
    const move = (next: PointerEvent) => {
      nextWidth = clampReferenceControlWidth(startWidth + startX - next.clientX);
      if (!frame) frame = window.requestAnimationFrame(render);
    };
    const stop = () => {
      if (frame) window.cancelAnimationFrame(frame);
      render();
      setControlWidth(nextWidth);
      document.body.classList.remove("resizing-panel");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
    document.body.classList.add("resizing-panel");
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  };
  return (
    <main className="reference-workspace">
      <header className="reference-topbar">
        <Link to="/references">
          <ArrowLeft />
          拆书库
        </Link>
        <div>
          <small>{state.source.fileName}</small>
          <h1>{state.title}</h1>
        </div>
        <button
          className="reference-delete"
          disabled={Boolean(
            currentJob && ["running", "paused"].includes(currentJob.status),
          )}
          onClick={() =>
            window.confirm("删除后原文和全部拆书结果都无法恢复，确定吗？") &&
            removed.mutate()
          }
        >
          <Trash2 />
          删除
        </button>
      </header>
      <section className="reference-layout">
        <aside className="reference-summary">
          <h2>原文与切分</h2>
          <dl>
            <div>
              <dt>编码</dt>
              <dd>{state.source.encoding}</dd>
            </div>
            <div>
              <dt>字符</dt>
              <dd>{formatted(state.source.chars)}</dd>
            </div>
            <div>
              <dt>章节/片段</dt>
              <dd>{chapters.length}</dd>
            </div>
            <div>
              <dt>方式</dt>
              <dd>
                {manifest.method === "headings" ? "标题识别" : "段落定长"}
              </dd>
            </div>
          </dl>
          <h3>全文目录</h3>
          <div className="chapter-preview">
            {chapters.map((item) => (
              <button
                className={sourceChapter?.id === item.id ? "active" : ""}
                key={item.id}
                onClick={() => {
                  setSourceChapterId(item.id);
                  setContentView("source");
                }}
              >
                <span>{item.index + 1}</span>
                {item.title}
              </button>
            ))}
          </div>
          <button
            className="reference-rebuild"
            disabled={Boolean(activeJob) || rebuildManifest.isPending}
            onClick={() => rebuildManifest.mutate()}
          >
            {rebuildManifest.isPending ? <LoaderCircle className="spin" /> : null}
            重新识别章节
          </button>
          {!state.manifestConfirmed ? (
            <button
              disabled={confirm.isPending}
              onClick={() => confirm.mutate()}
            >
              {confirm.isPending ? (
                <LoaderCircle className="spin" />
              ) : (
                <Check />
              )}
              确认切分
            </button>
          ) : (
            <p className="confirmed">
              <Check />
              章节切分已确认
            </p>
          )}
          {rebuildManifest.error && <ErrorLine error={rebuildManifest.error} />}
          {confirm.error && <ErrorLine error={confirm.error} />}
        </aside>
        <section
          className="reference-main"
          style={{ "--reference-control-width": `${controlWidth}px` } as CSSProperties}
        >
          <aside className="reference-control-pane">
          <ChapterParserEditor
            referenceId={referenceId}
            parser={detail.data.parser}
            disabled={Boolean(activeJob)}
            onApplied={async () => {
              setSourceChapterId("");
              setContentView("source");
              setSelectedAnalysisId("");
              setRerun(true);
              await Promise.all([
                client.invalidateQueries({ queryKey: ["reference", referenceId] }),
                client.invalidateQueries({ queryKey: ["reference-estimate", referenceId] }),
              ]);
            }}
          />
          {state.analyses.some((item) => item.status === "completed") &&
            !activeJob &&
            !rerun && (
              <div className="analysis-history">
                <label>
                  分析历史
                  <select
                    value={analysisId}
                    onChange={(event) => {
                      setSelectedAnalysisId(event.target.value);
                      setSourceExcerpt(undefined);
                    }}
                  >
                    {state.analyses
                      .filter((item) => item.status === "completed")
                      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                      .map((item) => (
                        <option value={item.id} key={item.id}>
                          {new Date(item.createdAt).toLocaleString("zh-CN")} ·{" "}
                          {item.preset === "quick" ? "快速" : item.preset === "complete" ? "完整" : "标准"}
                          {item.chapterRange ? ` · 第 ${item.chapterRange.fromChapter}–${item.chapterRange.toChapter} 章` : " · 全书"}
                          {item.stale ? " · 已陈旧" : ""}
                        </option>
                      ))}
                  </select>
                </label>
                <button onClick={() => setRerun(true)}>重新拆解</button>
              </div>
            )}
          {(!analysisId || rerun) && !activeJob && (
            <AnalysisSetup
              stateConfirmed={state.manifestConfirmed}
              preset={preset}
              setPreset={setPreset}
              chapters={chapters}
              rangeFrom={rangeFrom}
              rangeTo={rangeTo}
              setRangeFrom={setRangeFrom}
              setRangeTo={setRangeTo}
              estimate={estimate.data}
              budget={budget}
              setBudget={setBudget}
              pending={start.isPending}
              start={() => start.mutate()}
              error={start.error}
            />
          )}
          {analysisId && !rerun && !activeJob && analysis.isSuccess && needsLegacyCleanup && (
            <section className="analysis-setup">
              <h2>需要重新拆书</h2>
              <p>旧版结果不再使用。清理后会保留原文、章节切分与识别规则，你可以按新的档位重新开始。</p>
              <button disabled={clearedAnalyses.isPending} onClick={() => window.confirm("将删除这本书现有的拆书任务与分析产物，原文和章节切分会保留。确定继续吗？") && clearedAnalyses.mutate()}>{clearedAnalyses.isPending ? <LoaderCircle className="spin" /> : null}清理旧结果</button>
              {clearedAnalyses.error && <ErrorLine error={clearedAnalyses.error} />}
            </section>
          )}
          {activeJob && (
            <ReferenceProgress
              job={activeJob}
              extraBudget={extraBudget}
              setExtraBudget={setExtraBudget}
              pending={action.isPending}
              act={(value) => action.mutate(value)}
            />
          )}
          {currentJob?.status === "failed" && (
            <ErrorLine
              error={
                new Error(
                  currentJob.error ??
                    "拆书任务失败，可重新开始并复用已完成批次。",
                )
              }
            />
          )}
          </aside>
          <div
            className="panel-resizer reference-resizer"
            role="separator"
            aria-label="调整拆书设置栏宽度"
            aria-orientation="vertical"
            aria-valuemin={320}
            aria-valuemax={680}
            aria-valuenow={controlWidth}
            tabIndex={0}
            onPointerDown={beginControlResize}
            onDoubleClick={() => setControlWidth(defaultReferenceControlWidth)}
            onKeyDown={(event) => {
              if (event.key === "ArrowLeft") setControlWidth((value) => clampReferenceControlWidth(value + 24));
              if (event.key === "ArrowRight") setControlWidth((value) => clampReferenceControlWidth(value - 24));
            }}
          />
          <section className="reference-content-pane">
          <div className="reference-view-tabs" aria-label="参考书内容视图">
            <button
              className={contentView === "source" ? "active" : ""}
              onClick={() => setContentView("source")}
            >
              原文
            </button>
            {!rerun && (analysis.data?.sections.length ?? 0) > 0 && (
              <button
                className={contentView === "analysis" ? "active" : ""}
                onClick={() => setContentView("analysis")}
              >
                拆书结果
              </button>
            )}
          </div>
          {contentView === "source" && (
            <SourceReader
              chapter={sourceChapter}
              chapterCount={chapters.length}
              content={sourceDocument.data?.content}
              loading={sourceDocument.isLoading}
              error={sourceDocument.error}
            />
          )}
          {contentView === "analysis" && !rerun && (analysis.data?.sections.length ?? 0) > 0 && (
            <SectionResults
              sections={analysis.data!.sections}
              analysis={analysis.data!.analysis}
              source={sourceExcerpt?.content}
              showEvidence={(item: { start: number; end: number }) => evidence.mutate(item)}
              novels={bootstrap.data?.novels ?? []}
              referenceId={referenceId}
              analysisId={analysisId!}
              navigate={navigate}
            />
          )}
          </section>
        </section>
      </section>
    </main>
  );
}

function ChapterParserEditor({
  referenceId,
  parser,
  disabled,
  onApplied,
}: {
  referenceId: string;
  parser: ChapterParserConfig;
  disabled: boolean;
  onApplied: () => Promise<void> | void;
}) {
  const [draft, setDraft] = useState(parser);
  const [sample, setSample] = useState("");
  const [suggestionNote, setSuggestionNote] = useState("");
  useEffect(() => setDraft(parser), [parser]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(parser);
  const updatePattern = (id: string, change: Partial<ChapterPattern>) => setDraft((current) => ({ ...current, patterns: current.patterns.map((item) => item.id === id ? { ...item, ...change } : item) }));
  const addPattern = (source: ChapterPattern["source"], name = "自定义章节", pattern = "^(?:第\\s*)?\\d+\\s*章") => setDraft((current) => ({ ...current, patterns: [...current.patterns, { id: `${source}-${crypto.randomUUID()}`, name, pattern, enabled: true, source }] }));
  const save = useMutation({
    mutationFn: () => api.saveReferenceParser(referenceId, draft),
    onSuccess: async (result) => {
      setDraft(result.parser);
      await onApplied();
    },
  });
  const suggest = useMutation({
    mutationFn: () => api.suggestReferencePattern(referenceId, sample),
    onSuccess: (result) => {
      addPattern("ai", result.name, result.pattern);
      setSuggestionNote(result.explanation);
    },
  });
  return (
    <details className="reference-parser-editor">
      <summary>
        <span><strong>章节识别规则</strong><small>{draft.patterns.filter((item) => item.enabled).length} 条启用</small></span>
        <i>展开编辑</i>
      </summary>
      <p>每行会按以下正则判断是否为章节标题。正则必须从 <code>^</code> 开始。</p>
      <div className="reference-patterns">
        {draft.patterns.map((item) => (
          <div className="reference-pattern" key={item.id}>
            <label className="pattern-enabled"><input type="checkbox" checked={item.enabled} onChange={(event) => updatePattern(item.id, { enabled: event.target.checked })} />启用</label>
            <input aria-label={`规则名称 ${item.name}`} value={item.name} maxLength={40} onChange={(event) => updatePattern(item.id, { name: event.target.value })} />
            <button aria-label={`删除规则 ${item.name}`} disabled={draft.patterns.length <= 1} onClick={() => setDraft((current) => ({ ...current, patterns: current.patterns.filter((pattern) => pattern.id !== item.id) }))}><Trash2 /></button>
            <textarea aria-label={`正则 ${item.name}`} spellCheck={false} value={item.pattern} onChange={(event) => updatePattern(item.id, { pattern: event.target.value })} />
            <small>{item.source === "builtin" ? "内置" : item.source === "ai" ? "AI 建议" : "手动添加"}</small>
          </div>
        ))}
      </div>
      <button className="pattern-add" disabled={draft.patterns.length >= 20} onClick={() => addPattern("author")}><Plus />手动添加正则</button>
      <div className="pattern-ai">
        <label>让 AI 根据样例生成正则<textarea placeholder={"每行粘贴一个真实章节标题，例如：\n001章\n002章 餐厅约会\n番外一"} value={sample} onChange={(event) => setSample(event.target.value)} /></label>
        <button disabled={!sample.trim() || suggest.isPending} onClick={() => suggest.mutate()}>{suggest.isPending ? <LoaderCircle className="spin" /> : null}生成候选正则</button>
        {suggestionNote && <p>{suggestionNote}</p>}
        {suggest.error && <ErrorLine error={suggest.error} />}
      </div>
      <button className="pattern-save" disabled={disabled || !dirty || save.isPending} onClick={() => save.mutate()}>{save.isPending ? <LoaderCircle className="spin" /> : null}保存规则并重新识别</button>
      {save.error && <ErrorLine error={save.error} />}
    </details>
  );
}

function SourceReader({
  chapter,
  chapterCount,
  content,
  loading,
  error,
}: {
  chapter?: { index: number; title: string; start: number; end: number; volume?: string };
  chapterCount: number;
  content?: string;
  loading: boolean;
  error: unknown;
}) {
  return (
    <section className="reference-source-reader">
      <header>
        <div>
          <small>{chapter?.volume ?? "小说原文"}</small>
          <h2>{chapter?.title ?? "正在读取章节"}</h2>
        </div>
        {chapter && (
          <span>
            第 {chapter.index + 1} / {chapterCount} 节 · {formatted(chapter.end - chapter.start)} 字符
          </span>
        )}
      </header>
      {loading ? (
        <p className="reference-source-state"><LoaderCircle className="spin" />正在读取本章全文…</p>
      ) : error ? (
        <ErrorLine error={error} />
      ) : (
        <pre>{content}</pre>
      )}
    </section>
  );
}

function AnalysisSetup({
  stateConfirmed,
  preset,
  setPreset,
  chapters,
  rangeFrom,
  rangeTo,
  setRangeFrom,
  setRangeTo,
  estimate,
  budget,
  setBudget,
  pending,
  start,
  error,
}: any) {
  return (
    <section className="analysis-setup">
      <h2>选择拆书档位</h2>
      <div className="mode-cards">
        <button
          className={preset === "quick" ? "active" : ""}
          onClick={() => setPreset("quick")}
        >
          <strong>快速拆书</strong>
          <span>快速判断作品定位、结构、人物与写法是否值得学习。</span>
        </button>
        <button
          className={preset === "standard" ? "active" : ""}
          onClick={() => setPreset("standard")}
        >
          <strong>标准拆书</strong>
          <span>额外分析设定、主题与商业卖点，适合大多数参考作品。</span>
        </button>
        <button
          className={preset === "complete" ? "active" : ""}
          onClick={() => setPreset("complete")}
        >
          <strong>完整拆书</strong>
          <span>加入故事时间线，适合深度复盘与长篇结构研究。</span>
        </button>
      </div>
      <ChapterRangeSelector
        chapters={chapters}
        from={rangeFrom}
        to={rangeTo}
        setFrom={setRangeFrom}
        setTo={setRangeTo}
      />
      <h3>Token 预算确认</h3>
      {estimate && (
        <>
          <div className="token-estimate">
            <span>
              预计调用 <b>{formatted(estimate.calls)}</b> 次
            </span>
            <span>
              输入{" "}
              <b>
                {formatted(estimate.inputMin)}–{formatted(estimate.inputMax)}
              </b>
            </span>
            <span>
              输出{" "}
              <b>
                {formatted(estimate.outputMin)}–{formatted(estimate.outputMax)}
              </b>
            </span>
          </div>
          <p className="cost-formula">
            可能费用 = 输入 Token ÷ 1,000,000 × 模型输入单价 + 输出 Token ÷
            1,000,000 × 模型输出单价。
          </p>
        </>
      )}
      <label className="budget-input">
        硬预算
        <input
          type="number"
          min={MIN_REFERENCE_TOKEN_BUDGET}
          max={MAX_REFERENCE_TOKEN_BUDGET}
          step={100000}
          value={budget}
          onChange={(event) => setBudget(Number(event.target.value))}
        />
        Token
      </label>
      {(budget < MIN_REFERENCE_TOKEN_BUDGET ||
        budget > MAX_REFERENCE_TOKEN_BUDGET) && (
        <p className="reference-error">
          硬预算必须在 100,000–50,000,000 Token 之间。
        </p>
      )}
      <button
        disabled={
          !stateConfirmed ||
          pending ||
          !estimate ||
          budget < MIN_REFERENCE_TOKEN_BUDGET ||
          budget > MAX_REFERENCE_TOKEN_BUDGET
        }
        onClick={start}
      >
        {pending ? <LoaderCircle className="spin" /> : <Play />}确认预算并开始
      </button>
      {error && <ErrorLine error={error} />}
    </section>
  );
}

function ChapterRangeSelector({ chapters, from, to, setFrom, setTo }: {
  chapters: Array<{ title: string; start: number; end: number }>;
  from: number;
  to: number;
  setFrom: (value: number) => void;
  setTo: (value: number) => void;
}) {
  const total = Math.max(1, chapters.length);
  const safeFrom = Math.min(Math.max(1, from), total);
  const safeTo = Math.min(Math.max(safeFrom, to || total), total);
  const denominator = Math.max(1, total - 1);
  const selected = chapters.slice(safeFrom - 1, safeTo);
  const chars = selected.reduce((sum, chapter) => sum + chapter.end - chapter.start, 0);
  return (
    <section className="chapter-range-picker">
      <header>
        <div><h3>拆书范围</h3><p>拖动两端手柄，只分析选中的连续章节。</p></div>
        <button disabled={safeFrom === 1 && safeTo === total} onClick={() => { setFrom(1); setTo(total); }}>全书</button>
      </header>
      <div
        className="chapter-range-slider"
        style={{ "--range-start": `${((safeFrom - 1) / denominator) * 100}%`, "--range-end": `${((safeTo - 1) / denominator) * 100}%` } as CSSProperties}
      >
        <i />
        <input aria-label="起始章节" type="range" min={1} max={total} value={safeFrom} onChange={(event) => setFrom(Math.min(Number(event.target.value), safeTo))} />
        <input aria-label="结束章节" type="range" min={1} max={total} value={safeTo} onChange={(event) => setTo(Math.max(Number(event.target.value), safeFrom))} />
      </div>
      <div className="chapter-range-values">
        <label>从第<input aria-label="起始章节数字" type="number" min={1} max={safeTo} value={safeFrom} onChange={(event) => setFrom(Math.min(safeTo, Math.max(1, Number(event.target.value))))} />章</label>
        <span>—</span>
        <label>到第<input aria-label="结束章节数字" type="number" min={safeFrom} max={total} value={safeTo} onChange={(event) => setTo(Math.min(total, Math.max(safeFrom, Number(event.target.value))))} />章</label>
      </div>
      <p className="chapter-range-summary"><strong>第 {safeFrom}–{safeTo} 章</strong><span>共 {safeTo - safeFrom + 1} 章 · 约 {formatted(chars)} 字符</span></p>
      <p className="chapter-range-titles"><span>{chapters[safeFrom - 1]?.title}</span><i>→</i><span>{chapters[safeTo - 1]?.title}</span></p>
    </section>
  );
}
function ReferenceProgress({
  job,
  extraBudget,
  setExtraBudget,
  pending,
  act,
}: {
  job: ReferenceJob;
  extraBudget: number;
  setExtraBudget: (value: number) => void;
  pending: boolean;
  act: (value: {
    action: "add_budget" | "cancel";
    additionalTokens?: number;
  }) => void;
}) {
  const progress = job.progress;
  const usedTokens = job.inputTokens + job.outputTokens;
  const remainingTokens = Math.max(0, job.tokenBudget - usedTokens);
  const phases = [
    "逐章拆解",
    "阶段聚合",
    "全书结构",
    "小节结论",
    "报告复核",
  ];
  const phaseIndex = progress?.phaseIndex ?? Math.min(phases.length, Math.max(1, Math.ceil((job.completed / Math.max(1, job.total)) * phases.length)));
  return (
    <section className="reference-progress">
      <header>
        <div>
          <small>第 {phaseIndex} / {progress?.phaseTotal ?? phases.length} 阶段{job.chapterRange ? ` · 章节 ${job.chapterRange.fromChapter}–${job.chapterRange.toChapter}` : ""}</small>
          <h2>{job.stage}</h2>
        </div>
        <span>{Math.round((job.completed / Math.max(1, job.total)) * 100)}%</span>
      </header>
      <p className="reference-progress-detail">{progress?.detail ?? "任务正在运行，完成的结果会持续写入本地工作区。"}</p>
      <progress max={Math.max(1, job.total)} value={job.completed} />
      <ol className="reference-phases">
        {phases.map((phase, index) => (
          <li className={index + 1 < phaseIndex ? "done" : index + 1 === phaseIndex ? "active" : ""} key={phase}>
            <i>{index + 1 < phaseIndex ? "✓" : index + 1}</i>
            {phase}
          </li>
        ))}
      </ol>
      <div className="reference-progress-metrics">
        <div><span>原文章节</span><strong>{progress ? `${progress.chaptersCovered} / ${progress.chaptersTotal}` : "读取中"}</strong><small>{progress?.currentChapter ? `最近：${progress.currentChapter}` : "按目录持续覆盖"}</small></div>
        <div><span>逐章批次</span><strong>{progress ? `${progress.batchesCompleted} / ${progress.batchesTotal}` : `${job.completed} / ${job.total}`}</strong><small>完成一个批次即落盘</small></div>
        <div><span>结构聚合</span><strong>{progress ? `${progress.segmentsCompleted + progress.macrosCompleted} / ${progress.segmentsTotal + progress.macrosTotal}` : "等待中"}</strong><small>故事阶段 + 全书结构</small></div>
        <div><span>小节结论</span><strong>{job.status === "completed" ? "已完成" : "生成中"}</strong><small>先总览，再产出结构化创作结论</small></div>
        <div><span>已结算 Token</span><strong>{formatted(usedTokens)}</strong><small>输入 {formatted(job.inputTokens)} · 输出 {formatted(job.outputTokens)}</small></div>
        <div><span>剩余预算</span><strong>{formatted(remainingTokens)}</strong><small>总预算 {formatted(job.tokenBudget)}{job.usageEstimated ? " · 含估算" : ""}</small></div>
      </div>
      <p className="reference-progress-time">最近更新：{new Date(job.updatedAt).toLocaleString("zh-CN")}</p>
      {job.status === "paused" && (
        <div className="budget-add">
          <input
            type="number"
            value={extraBudget}
            min={100000}
            step={100000}
            onChange={(event) => setExtraBudget(Number(event.target.value))}
          />
          <button
            onClick={() =>
              act({ action: "add_budget", additionalTokens: extraBudget })
            }
          >
            追加预算并继续
          </button>
        </div>
      )}
      <button
        className="danger"
        disabled={pending}
        onClick={() => act({ action: "cancel" })}
      >
        取消任务
      </button>
      {job.error && <ErrorLine error={new Error(job.error)} />}
    </section>
  );
}
type AnalysisResultsProps = {
  showEvidence: (item: { start: number; end: number }) => void;
  [key: string]: any;
};
function analysisFieldLabel(key: string) {
  return referenceAnalysisFieldLabels[key] ?? key.replace(/([A-Z])/g, " $1").trim();
}

function AnalysisValue({ value }: { value: unknown }) {
  if (value === null || value === undefined || value === "") return <span>—</span>;
  if (typeof value !== "object") return <span>{String(value)}</span>;
  if (Array.isArray(value)) {
    return (
      <ul>
        {value.map((item, index) => (
          <li key={index}><AnalysisValue value={item} /></li>
        ))}
      </ul>
    );
  }
  return (
    <dl className="analysis-value-list">
      {Object.entries(value as Record<string, unknown>).map(([key, item]) => (
        <div key={key}>
          <dt>{analysisFieldLabel(key)}</dt>
          <dd><AnalysisValue value={item} /></dd>
        </div>
      ))}
    </dl>
  );
}

function AnalysisDocument({ content, loading }: { content?: string; loading?: boolean }) {
  if (loading) return <p className="analysis-state"><LoaderCircle className="spin" />正在整理分析内容…</p>;
  if (!content) return <p className="analysis-state">选择左侧条目查看分析。</p>;
  try {
    const value = parse(content);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    const entries = Object.entries(value as Record<string, unknown>);
    const facts = entries.filter(([, item]) => item === null || ["string", "number", "boolean"].includes(typeof item));
    const sections = entries.filter(([, item]) => !["string", "number", "boolean"].includes(typeof item) && item !== null);
    return (
      <div className="analysis-document">
        {facts.length > 0 && (
          <dl className="analysis-facts">
            {facts.map(([key, value]) => <div key={key}><dt>{analysisFieldLabel(key)}</dt><dd>{String(value ?? "—")}</dd></div>)}
          </dl>
        )}
        {sections.map(([key, value]) => (
          <section className="analysis-section" key={key}>
            <h3>{analysisFieldLabel(key)}</h3>
            <AnalysisValue value={value} />
          </section>
        ))}
      </div>
    );
  } catch {
    return <pre>{content}</pre>;
  }
}

function SectionResults({ sections, analysis, source, showEvidence, novels, referenceId, analysisId, navigate }: any) {
  const client = useQueryClient();
  const [view, setView] = useState<"sections" | "characters">("sections");
  const [sectionKey, setSectionKey] = useState("overview");
  const [insightIds, setInsightIds] = useState<string[]>([]);
  const [targetNovel, setTargetNovel] = useState("");
  const [goal, setGoal] = useState("");
  const [characterName, setCharacterName] = useState("");
  const section = sections.find((item: any) => item.key === sectionKey) ?? sections[0];
  const characterSection = sections.find((item: any) => item.key === "character_system");
  const candidates = characterSection?.characterCandidates ?? [];
  const profile = useQuery({ queryKey: ["reference-character", referenceId, analysisId, characterName], queryFn: () => api.referenceCharacter(referenceId, analysisId, characterName), enabled: Boolean(characterName && analysis.characterProfiles.some((item: any) => item.name === characterName && item.status === "generated")) });
  const generateCharacter = useMutation({ mutationFn: (name: string) => api.startReferenceCharacter(referenceId, analysisId, name), onSuccess: async () => { await client.invalidateQueries({ queryKey: ["reference-analysis", referenceId, analysisId] }); } });
  const chooseSection = (key: string) => { setSectionKey(key); setInsightIds([]); };
  const toggleInsight = (id: string) => setInsightIds((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length < 3 ? [...current, id] : current);
  return (
    <section className="section-results">
      <header className="section-results-tabs">
        <button className={view === "sections" ? "active" : ""} onClick={() => setView("sections")}>小节分析</button>
        <button className={view === "characters" ? "active" : ""} onClick={() => setView("characters")}>角色档案 <span>{candidates.length}</span></button>
      </header>
      {view === "sections" ? (
        <div className="section-results-body">
          <nav aria-label="拆书小节">
            {sections.map((item: any) => <button className={item.key === section?.key ? "active" : ""} key={item.key} onClick={() => chooseSection(item.key)}>{item.title}<small>{item.insights.length ? `${item.insights.length} 条可借鉴` : ""}</small></button>)}
          </nav>
          <article>
            <header className="section-article-head"><div><small>结构化关键结论</small><h2>{section?.title}</h2></div><span>{section?.evidence.length ?? 0} 条证据</span></header>
            {section && <>
              <p className="section-summary">{section.summary}</p>
              <AnalysisValue value={section.structuredData} />
              {section.insights.length > 0 && <section className="transferable-insights"><header><div><small>可迁移写法</small><h3>选择最多 3 条，带回自己的作品讨论</h3></div><span>{insightIds.length}/3</span></header>{section.insights.map((item: any) => <label className={insightIds.includes(item.id) ? "selected" : ""} key={item.id}><input type="checkbox" checked={insightIds.includes(item.id)} onChange={() => toggleInsight(item.id)} /><div><strong>{item.title}</strong><p>{item.mechanism}</p><dl><div><dt>适用场景</dt><dd>{item.fitFor.join("、")}</dd></div><div><dt>不可照搬</dt><dd>{item.doNotCopy.join("、")}</dd></div><div><dt>适配提示</dt><dd>{item.adaptationHint}</dd></div></dl></div></label>)}</section>}
              {section.evidence.length > 0 && <div className="evidence-list"><h3>本节证据</h3>{section.evidence.map((item: any, index: number) => <button key={index} onClick={() => showEvidence(item)}>“{item.excerpt}”</button>)}</div>}
              {source && <blockquote className="source-excerpt">{source}</blockquote>}
              <details className="section-full-reading"><summary>完整阅读</summary><ReactMarkdown remarkPlugins={[remarkGfm]}>{section.content}</ReactMarkdown></details>
            </>}
          </article>
        </div>
      ) : (
        <div className="character-results">
          <aside>{candidates.length ? candidates.map((candidate: any) => { const state = analysis.characterProfiles.find((item: any) => item.name === candidate.name); return <button className={characterName === candidate.name ? "active" : ""} key={candidate.name} onClick={() => setCharacterName(candidate.name)}><strong>{candidate.name}</strong><span>{candidate.role} · {candidate.importance === "main" ? "核心" : candidate.importance === "major" ? "重要" : "配角"}</span><small>{state?.status === "generated" ? "档案已生成" : state?.status === "generating" ? "正在生成" : "可深入研究"}</small></button>; }) : <p>人物系统尚未给出可研究的角色候选。</p>}</aside>
          <article>{characterName ? <>{profile.data ? <><header className="section-article-head"><div><small>角色档案</small><h2>{profile.data.name}</h2></div><span>{profile.data.role}</span></header><p className="section-summary">{profile.data.summary}</p><AnalysisValue value={profile.data} />{profile.data.evidence.length > 0 && <div className="evidence-list"><h3>原文证据</h3>{profile.data.evidence.map((item: any, index: number) => <button key={index} onClick={() => showEvidence(item)}>“{item.excerpt}”</button>)}</div>}</> : <div className="character-empty"><h2>{characterName}</h2><p>先生成角色档案，系统会围绕欲望、压力、关系、变化轨迹和可借鉴的人物设计研究原文。</p><button disabled={generateCharacter.isPending || analysis.characterProfiles.some((item: any) => item.name === characterName && item.status === "generating")} onClick={() => generateCharacter.mutate(characterName)}>{generateCharacter.isPending ? "正在启动…" : "生成角色档案"}</button>{generateCharacter.error && <ErrorLine error={generateCharacter.error} />}</div>}</> : <p className="analysis-state">从左侧选择一个角色候选。</p>}</article>
        </div>
      )}
      {view === "sections" && <footer className="section-apply"><input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="想解决什么问题？例如：强化第一卷的升级节奏" /><select value={targetNovel} onChange={(event) => setTargetNovel(event.target.value)}><option value="">选择要应用的作品</option>{novels.map((novel: any) => <option value={novel.novelId} key={novel.novelId}>{novel.title}</option>)}</select><button disabled={!targetNovel || !goal.trim() || !insightIds.length} onClick={() => navigate(`/novels/${targetNovel}?applyReference=${referenceId}&analysis=${analysisId}&section=${section.key}&insights=${encodeURIComponent(insightIds.join(","))}&goal=${encodeURIComponent(goal)}`)}>带入作品讨论</button></footer>}
    </section>
  );
}

function AnalysisResults({
  report,
  segmentCount,
  chapters,
  segmentId,
  setSegmentId,
  segment,
  chapterId,
  setChapterId,
  chapter,
  chapterValue,
  source,
  showEvidence,
  novels,
  targetNovel,
  setTargetNovel,
  applicationGoal,
  setApplicationGoal,
  apply,
}: AnalysisResultsProps) {
  const activeTitle = chapterId
    ? chapters.find((item: any) => item.id === chapterId)?.title
    : segmentId
      ? `阶段 ${Number(segmentId.slice(-3))}`
      : "全书报告";
  return (
    <section className="analysis-results">
      <nav aria-label="拆书结果目录">
        <p className="analysis-nav-label">结构总览</p>
        <button
          className={!segmentId && !chapterId ? "active" : ""}
          onClick={() => {
            setSegmentId("");
            setChapterId("");
          }}
        >
          全书报告
        </button>
        {segmentCount > 0 && <p className="analysis-nav-label">故事阶段 <span>{segmentCount}</span></p>}
        <div className="analysis-nav-group">
          {Array.from(
            { length: segmentCount },
            (_, index) => `segment-${String(index + 1).padStart(3, "0")}`,
          ).map((id) => (
            <button
              className={segmentId === id ? "active" : ""}
              key={id}
              onClick={() => {
                setSegmentId(id);
                setChapterId("");
              }}
            >
              <span>阶段</span>{Number(id.slice(-3))}
            </button>
          ))}
        </div>
        <details>
          <summary>逐章分析 <span>{chapters.length}</span></summary>
          {chapters.map((item: any) => (
            <button
              className={chapterId === item.id ? "active" : ""}
              key={item.id}
              onClick={() => {
                setChapterId(item.id);
                setSegmentId("");
              }}
            >
              {item.title}
            </button>
          ))}
        </details>
      </nav>
      <article>
        <header className="analysis-article-head">
          <div><small>{chapterId ? "逐章分析" : segmentId ? "故事阶段" : "全书结构"}</small><h2>{activeTitle}</h2></div>
          <span>{chapterId ? "含原文证据" : "结构化阅读"}</span>
        </header>
        {chapterId ? (
          <>
            <AnalysisDocument content={chapter} loading={!chapter} />
            {chapterValue?.evidence?.length > 0 && (
              <div className="evidence-list">
                <h3>原文证据</h3>
                {chapterValue.evidence.map((item: any, index: number) => (
                  <button key={index} onClick={() => showEvidence(item)}>
                    “{item.excerpt}”
                  </button>
                ))}
              </div>
            )}
            {source && (
              <blockquote className="source-excerpt">{source}</blockquote>
            )}
          </>
        ) : segmentId ? (
          <AnalysisDocument content={segment} loading={!segment} />
        ) : (
          <div className="message-markdown analysis-report">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{report}</ReactMarkdown>
          </div>
        )}
      </article>
      <footer>
        <input
          value={applicationGoal}
          onChange={(event) => setApplicationGoal(event.target.value)}
          placeholder="明确应用目标，如：强化第一卷升级节奏"
        />
        <select
          value={targetNovel}
          onChange={(event) => setTargetNovel(event.target.value)}
        >
          <option value="">选择要应用的作品</option>
          {novels.map((novel: any) => (
            <option value={novel.novelId} key={novel.novelId}>
              {novel.title}
            </option>
          ))}
        </select>
        <button
          disabled={!targetNovel || !applicationGoal.trim()}
          onClick={apply}
        >
          应用到作品
        </button>
      </footer>
    </section>
  );
}
