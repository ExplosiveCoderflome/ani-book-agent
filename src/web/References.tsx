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
import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { Link, useNavigate, useParams } from "react-router-dom";
import remarkGfm from "remark-gfm";
import { parse } from "yaml";
import {
  MAX_REFERENCE_TOKEN_BUDGET,
  MIN_REFERENCE_TOKEN_BUDGET,
  type DeconstructionFocus,
  type DeconstructionMode,
  type ReferenceJob,
} from "../shared/contracts";
import { api } from "./api";

const focusLabels: Record<DeconstructionFocus, string> = {
  structure: "结构与升级",
  characters: "人物与关系",
  pacing_hooks: "节奏与钩子",
};
const formatted = (value: number) =>
  new Intl.NumberFormat("zh-CN").format(value);
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
  const [rights, setRights] = useState(false);
  const imported = useMutation({
    mutationFn: () => api.importReference(file!, title, rights),
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
        <label className="reference-rights">
          <input
            type="checkbox"
            checked={rights}
            onChange={(event) => setRights(event.target.checked)}
          />
          我确认有权分析并在本地保存这份材料
        </label>
        <button
          disabled={!file || !rights || imported.isPending}
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
    refetchInterval: (query) =>
      query.state.data?.activeJob &&
      ["running", "queued"].includes(query.state.data.activeJob.status)
        ? 2_000
        : false,
  });
  const [mode, setMode] = useState<DeconstructionMode>("standard");
  const [focuses, setFocuses] = useState<DeconstructionFocus[]>([]);
  const [budget, setBudget] = useState(0);
  const [startedJob, setStartedJob] = useState<ReferenceJob>();
  const [extraBudget, setExtraBudget] = useState(1_000_000);
  const [selectedAnalysisId, setSelectedAnalysisId] = useState("");
  const [rerun, setRerun] = useState(false);
  const focusKey = [...focuses].sort().join(",");
  const estimate = useQuery({
    queryKey: ["reference-estimate", referenceId, mode, focusKey],
    queryFn: () => api.estimateReference(referenceId, mode, focuses),
    enabled: Boolean(referenceId),
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
  const confirm = useMutation({
    mutationFn: () =>
      api.confirmReference(referenceId, detail.data!.manifest.sha256),
    onSuccess: async () =>
      client.invalidateQueries({ queryKey: ["reference", referenceId] }),
  });
  const start = useMutation({
    mutationFn: () =>
      api.startReferenceJob(referenceId, {
        mode,
        focuses: mode === "deep" ? focuses : [],
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
      void client.invalidateQueries({ queryKey: ["reference", referenceId] });
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
  const analysisId = selectedAnalysisId || detail.data?.state.latestAnalysisId;
  const analysis = useQuery({
    queryKey: ["reference-analysis", referenceId, analysisId],
    queryFn: () => api.referenceAnalysis(referenceId, analysisId!),
    enabled: Boolean(analysisId),
  });
  const [segmentId, setSegmentId] = useState("");
  const [chapterId, setChapterId] = useState("");
  const segment = useQuery({
    queryKey: ["reference-segment", referenceId, analysisId, segmentId],
    queryFn: () => api.referenceSegment(referenceId, analysisId!, segmentId),
    enabled: Boolean(analysisId && segmentId),
  });
  const chapter = useQuery({
    queryKey: ["reference-chapter", referenceId, analysisId, chapterId],
    queryFn: () => api.referenceChapter(referenceId, analysisId!, chapterId),
    enabled: Boolean(analysisId && chapterId),
  });
  const chapterValue = useMemo(() => {
    try {
      return chapter.data ? (parse(chapter.data.content) as any) : undefined;
    } catch {
      return undefined;
    }
  }, [chapter.data]);
  const [source, setSource] = useState<{
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
    onSuccess: setSource,
  });
  const bootstrap = useQuery({
    queryKey: ["bootstrap"],
    queryFn: api.bootstrap,
  });
  const [targetNovel, setTargetNovel] = useState("");
  const [applicationGoal, setApplicationGoal] = useState("");
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
  const toggleFocus = (focus: DeconstructionFocus) =>
    setFocuses((current) =>
      current.includes(focus)
        ? current.filter((item) => item !== focus)
        : [...current, focus],
    );
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
          <h3>章节预览</h3>
          <div className="chapter-preview">
            {chapters.slice(0, 3).map((item) => (
              <span key={item.id}>{item.title}</span>
            ))}
            {chapters.length > 6 && <em>… {chapters.length - 6} 章 …</em>}
            {chapters.slice(Math.max(3, chapters.length - 3)).map((item) => (
              <span key={item.id}>{item.title}</span>
            ))}
          </div>
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
          {confirm.error && <ErrorLine error={confirm.error} />}
        </aside>
        <section className="reference-main">
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
                      setSegmentId("");
                      setChapterId("");
                      setSource(undefined);
                    }}
                  >
                    {state.analyses
                      .filter((item) => item.status === "completed")
                      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
                      .map((item) => (
                        <option value={item.id} key={item.id}>
                          {new Date(item.createdAt).toLocaleString("zh-CN")} ·{" "}
                          {item.mode === "deep" ? "深度" : "标准"}
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
              mode={mode}
              setMode={setMode}
              focuses={focuses}
              toggleFocus={toggleFocus}
              estimate={estimate.data}
              budget={budget}
              setBudget={setBudget}
              pending={start.isPending}
              start={() => start.mutate()}
              error={start.error}
            />
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
          {!rerun && analysis.data?.report && (
            <AnalysisResults
              report={analysis.data.report}
              segmentCount={analysis.data.index?.segmentCount ?? 0}
              chapters={chapters}
              segmentId={segmentId}
              setSegmentId={setSegmentId}
              segment={segment.data?.content}
              chapterId={chapterId}
              setChapterId={setChapterId}
              chapter={chapter.data?.content}
              chapterValue={chapterValue}
              source={source?.content}
              showEvidence={(item) => evidence.mutate(item)}
              novels={bootstrap.data?.novels ?? []}
              targetNovel={targetNovel}
              setTargetNovel={setTargetNovel}
              applicationGoal={applicationGoal}
              setApplicationGoal={setApplicationGoal}
              apply={() =>
                navigate(
                  `/novels/${targetNovel}?applyReference=${referenceId}&analysis=${analysisId}&goal=${encodeURIComponent(applicationGoal)}`,
                )
              }
            />
          )}
        </section>
      </section>
    </main>
  );
}

function AnalysisSetup({
  stateConfirmed,
  mode,
  setMode,
  focuses,
  toggleFocus,
  estimate,
  budget,
  setBudget,
  pending,
  start,
  error,
}: any) {
  return (
    <section className="analysis-setup">
      <h2>选择拆书深度</h2>
      <div className="mode-cards">
        <button
          className={mode === "standard" ? "active" : ""}
          onClick={() => setMode("standard")}
        >
          <strong>标准全拆</strong>
          <span>全文读取一次，完成章节、阶段、全书和证据复核。</span>
        </button>
        <button
          className={mode === "deep" ? "active" : ""}
          onClick={() => setMode("deep")}
        >
          <strong>深度拆书</strong>
          <span>标准全拆后，再对所选专项完整复扫原文。</span>
        </button>
      </div>
      {mode === "deep" && (
        <div className="focus-options">
          {(Object.keys(focusLabels) as DeconstructionFocus[]).map((focus) => (
            <label key={focus}>
              <input
                type="checkbox"
                checked={focuses.includes(focus)}
                onChange={() => toggleFocus(focus)}
              />
              {focusLabels[focus]}
            </label>
          ))}
        </div>
      )}
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
          budget > MAX_REFERENCE_TOKEN_BUDGET ||
          (mode === "deep" && !focuses.length)
        }
        onClick={start}
      >
        {pending ? <LoaderCircle className="spin" /> : <Play />}确认预算并开始
      </button>
      {error && <ErrorLine error={error} />}
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
  return (
    <section className="reference-progress">
      <h2>{job.stage}</h2>
      <progress max={Math.max(1, job.total)} value={job.completed} />
      <p>
        {job.completed}/{job.total} 个处理单元
      </p>
      <div className="token-estimate">
        <span>
          输入 <b>{formatted(job.inputTokens)}</b>
        </span>
        <span>
          输出 <b>{formatted(job.outputTokens)}</b>
        </span>
        <span>
          预算 <b>{formatted(job.tokenBudget)}</b>
        </span>
      </div>
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
  return (
    <section className="analysis-results">
      <nav>
        <button
          className={!segmentId && !chapterId ? "active" : ""}
          onClick={() => {
            setSegmentId("");
            setChapterId("");
          }}
        >
          全书报告
        </button>
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
            阶段 {Number(id.slice(-3))}
          </button>
        ))}
        <details>
          <summary>逐章分析</summary>
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
        {chapterId ? (
          <>
            <h2>
              {chapters.find((item: any) => item.id === chapterId)?.title}
            </h2>
            <pre>{chapter}</pre>
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
          <pre>{segment}</pre>
        ) : (
          <div className="message-markdown">
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
