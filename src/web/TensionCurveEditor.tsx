import { Check, ChevronLeft, ChevronRight, Lock, LockOpen, RotateCcw, Save, Sparkles, Undo2, Redo2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { parse, stringify } from "yaml";
import { actualTensionCurveSchema, EMOTION_LABELS, STORY_FUNCTION_LABELS, targetTensionCurveSchema, tensionCurveDependencyReasons, type ActualTensionCurve, type TargetTensionCurve } from "../domain";

type CurvePoint = TargetTensionCurve["points"][number];
type Zoom = "fit" | "75" | "100" | "125";

export function TensionCurveEditor({ content, actualContent, ghostContent, fileHashes, authorEdited = false, dirty = false, onChange, onSave, onRequestAi, saving = false, readOnly = false, compact = false }: {
  content: string; actualContent?: string; ghostContent?: string; fileHashes?: Record<string, string>; authorEdited?: boolean; dirty?: boolean; onChange?: (content: string) => void; onSave?: () => void; onRequestAi?: () => void; saving?: boolean; readOnly?: boolean; compact?: boolean;
}) {
  const parsed = useMemo(() => safeTarget(content), [content]);
  const actual = useMemo(() => safeActual(actualContent), [actualContent]);
  const ghost = useMemo(() => safeTarget(ghostContent).curve, [ghostContent]);
  const [curve, setCurve] = useState(parsed.curve);
  const [selected, setSelected] = useState(parsed.curve?.points[0]?.id ?? "");
  const [past, setPast] = useState<TargetTensionCurve[]>([]);
  const [future, setFuture] = useState<TargetTensionCurve[]>([]);
  const [zoom, setZoom] = useState<Zoom>(parsed.curve && parsed.curve.points.length > 30 ? "100" : "fit");
  const dragStart = useRef<TargetTensionCurve | null>(null);
  const frame = useRef(0);
  const pendingTension = useRef<number | null>(null);
  const lastEmitted = useRef("");
  const baseline = useRef(parsed.curve);

  useEffect(() => { if (content === lastEmitted.current) return; baseline.current = parsed.curve; setCurve(parsed.curve); setPast([]); setFuture([]); setZoom(parsed.curve && parsed.curve.points.length > 30 ? "100" : "fit"); setSelected((current) => parsed.curve?.points.some((point) => point.id === current) ? current : parsed.curve?.points[0]?.id ?? ""); }, [content, parsed.curve]);
  useEffect(() => () => { if (frame.current) cancelAnimationFrame(frame.current); }, []);
  if (!parsed.curve || !curve) return <div className="curve-error"><strong>曲线文件无法读取</strong><span>{parsed.error}</span></div>;

  const selectedPoint = curve.points.find((point) => point.id === selected);
  const dependencyReasons = fileHashes ? tensionCurveDependencyReasons(curve, fileHashes) : [];
  const staleReasons = [...new Set([...curve.calibration.reasons, ...dependencyReasons])];
  const actualStale = Boolean(actual && curve.kind === "volume" && fileHashes?.[`volumes/volume-${String(curve.volume).padStart(3, "0")}-tension.yaml`] !== actual.basis.targetCurveSha256);
  const emit = (next: TargetTensionCurve) => { const value = stringify(next, { lineWidth: 0 }); lastEmitted.current = value; onChange?.(value); };
  const commit = (next: TargetTensionCurve, before = curve) => { setPast((items) => [...items.slice(-49), before]); setFuture([]); setCurve(next); emit(next); };
  const replacePoint = (id: string, updater: (point: CurvePoint) => CurvePoint, remember = true) => {
    const next = targetTensionCurveSchema.parse({ ...curve, points: curve.points.map((point) => point.id === id ? updater(point) : point) });
    if (remember) commit(next); else setCurve(next);
  };
  const undo = () => { const previous = past.at(-1); if (!previous) return; setPast((items) => items.slice(0, -1)); setFuture((items) => [curve, ...items].slice(0, 50)); setCurve(previous); emit(previous); };
  const redo = () => { const next = future[0]; if (!next) return; setFuture((items) => items.slice(1)); setPast((items) => [...items, curve]); setCurve(next); emit(next); };
  const discard = () => { if (!baseline.current) return; setCurve(baseline.current); setPast([]); setFuture([]); emit(baseline.current); };

  return <section className={`tension-editor ${compact ? "compact" : ""}`}>
    {!compact && <header className="curve-toolbar"><div><strong>{curve.title}</strong><span>{curve.kind === "book" ? "全书宏观峰谷" : `第 ${curve.chapterRange.from}–${curve.chapterRange.to} 章目标`}</span></div><div className="curve-tools">
      <button onClick={undo} disabled={!past.length} aria-label="撤销"><Undo2 />撤销</button><button onClick={redo} disabled={!future.length} aria-label="重做"><Redo2 />重做</button><button onClick={discard} disabled={!past.length && !future.length}><RotateCcw />放弃修改</button>
      <select aria-label="曲线缩放" value={zoom} onChange={(event) => setZoom(event.target.value as Zoom)}><option value="fit">适应宽度</option><option value="75">75%</option><option value="100">100%</option><option value="125">125%</option></select>
      {onRequestAi && <button className="curve-ai" onClick={onRequestAi}><Sparkles />AI 优化未锁定节点</button>}{onSave && <button className="curve-save" onClick={onSave} disabled={saving || !dirty}><Save />{saving ? "保存中" : "保存曲线"}</button>}
    </div></header>}
    {!compact && <div className="curve-alerts">{(curve.calibration.status === "needs_recalibration" || staleReasons.length > 0) && <div className="curve-stale"><RotateCcw />需要重新校准：{staleReasons.join("；") || "生成依据已经变化"}</div>}{authorEdited && curve.kind === "volume" && <div className="curve-author-note"><Check />作者曲线已生效；后续写作读取最新节点。若要同步改动章节卡，请让 Agent 提交卷计划提案。</div>}</div>}
    <div className="curve-body">
      <CurveCanvas curve={curve} actual={actual} ghost={ghost} selected={selected} setSelected={setSelected} zoom={zoom} readOnly={readOnly} compact={compact}
        onDragStart={() => { dragStart.current = structuredClone(curve); }}
        onTension={(id, tension) => { pendingTension.current = tension; if (frame.current) return; frame.current = requestAnimationFrame(() => { frame.current = 0; const value = pendingTension.current; if (value === null) return; replacePoint(id, (point) => ({ ...point, tension: value }), false); }); }}
        onDragEnd={(id) => { if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; } const before = dragStart.current; dragStart.current = null; if (!before) return; const point = curve.points.find((item) => item.id === id); const tension = pendingTension.current ?? point?.tension; pendingTension.current = null; if (tension === undefined) return; const next = targetTensionCurveSchema.parse({ ...curve, points: curve.points.map((item) => item.id === id ? { ...item, tension, source: "author", locked: true } : item) }); commit(next, before); }}
        onKeyboard={(id, delta) => replacePoint(id, (point) => ({ ...point, tension: clamp(point.tension + delta), source: "author", locked: true }))} />
      {!compact && selectedPoint && <PointInspector point={selectedPoint} actual={curve.kind === "volume" ? actual?.points.find((item) => "chapter" in selectedPoint && item.chapter === selectedPoint.chapter) : undefined} readOnly={readOnly} onChange={(next) => replacePoint(selectedPoint.id, () => ({ ...next, source: "author", locked: true }))} onToggleLock={() => replacePoint(selectedPoint.id, (point) => ({ ...point, source: "author", locked: !point.locked }))} />}
    </div>
    {!compact && actual && <div className="curve-legend"><span><i className="target" />目标曲线</span><span><i className="actual" />实际曲线</span>{ghost && <span><i className="ghost" />AI 候选</span>}<small>{actualStale ? "实际曲线基于修改前目标，仅作走势对照。" : "分数用于比较走势，不是正文达标线。"}</small></div>}
  </section>;
}

function CurveCanvas({ curve, actual, ghost, selected, setSelected, zoom, readOnly, compact, onDragStart, onTension, onDragEnd, onKeyboard }: {
  curve: TargetTensionCurve; actual?: ActualTensionCurve; ghost?: TargetTensionCurve; selected: string; setSelected: (id: string) => void; zoom: Zoom; readOnly: boolean; compact: boolean;
  onDragStart: () => void; onTension: (id: string, value: number) => void; onDragEnd: (id: string) => void; onKeyboard: (id: string, delta: number) => void;
}) {
  const shell = useRef<HTMLDivElement>(null);
  const pointCount = curve.points.length; const baseWidth = Math.max(720, (pointCount - 1) * 54 + 96); const width = zoom === "fit" ? baseWidth : Math.round(baseWidth * Number(zoom) / 100); const height = compact ? 250 : 430;
  const inset = { left: 48, right: 24, top: 24, bottom: compact ? 34 : 58 }; const plotWidth = width - inset.left - inset.right; const plotHeight = height - inset.top - inset.bottom;
  const x = (index: number) => inset.left + (pointCount === 1 ? plotWidth / 2 : index / (pointCount - 1) * plotWidth); const y = (value: number) => inset.top + (100 - value) / 100 * plotHeight;
  const points = curve.points.map((point, index) => ({ point, x: x(index), y: y(point.tension) }));
  const actualPoints = actual?.points.map((point) => { const index = curve.kind === "volume" ? curve.points.findIndex((item) => item.chapter === point.chapter) : -1; return index < 0 ? undefined : { x: x(index), y: y(point.tension), point }; }).filter(Boolean) as Array<{ x: number; y: number; point: ActualTensionCurve["points"][number] }> | undefined;
  const ghostPoints = ghost?.points.map((point, index) => ({ x: x(index), y: y(point.tension) }));
  const drag = (event: PointerEvent<SVGCircleElement>, id: string) => { if (readOnly) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); setSelected(id); onDragStart(); };
  const move = (event: PointerEvent<SVGCircleElement>, id: string) => { if (readOnly || !event.currentTarget.hasPointerCapture(event.pointerId)) return; const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect(); const svgY = (event.clientY - bounds.top) * height / bounds.height; onTension(id, clamp(Math.round(100 - (svgY - inset.top) / plotHeight * 100))); };
  const end = (event: PointerEvent<SVGCircleElement>, id: string) => { if (readOnly || !event.currentTarget.hasPointerCapture(event.pointerId)) return; event.currentTarget.releasePointerCapture(event.pointerId); onDragEnd(id); };
  return <div className={`curve-scroll ${zoom === "fit" ? "fit" : ""}`} ref={shell}><svg className="curve-chart" viewBox={`0 0 ${width} ${height}`} style={{ width: zoom === "fit" ? "100%" : `${width}px` }} role="img" aria-label={`${curve.title}张力曲线`}>
    <defs><linearGradient id="tension-line" x1="0" x2="1"><stop offset="0" stopColor="#6f63e8" /><stop offset=".58" stopColor="#a160e8" /><stop offset="1" stopColor="#ef6b78" /></linearGradient><linearGradient id="tension-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#8a72ef" stopOpacity=".24" /><stop offset="1" stopColor="#8a72ef" stopOpacity="0" /></linearGradient></defs>
    {[[0, 35, "舒缓"], [35, 60, "积累"], [60, 85, "紧张"], [85, 100, "高潮"]].map(([from, to, label]) => <g key={label as string}><rect className={`curve-band band-${label}`} x={inset.left} y={y(to as number)} width={plotWidth} height={y(from as number) - y(to as number)} /><text x={inset.left + 8} y={y(to as number) + 16}>{label}</text></g>)}
    {[0, 20, 40, 60, 80, 100].map((value) => <g key={value}><line className="curve-grid" x1={inset.left} x2={width - inset.right} y1={y(value)} y2={y(value)} /><text className="curve-y-label" x={inset.left - 10} y={y(value) + 4} textAnchor="end">{value}</text></g>)}
    {curve.kind === "volume" && actual?.diagnostics.map((diagnostic) => { const start = curve.points.findIndex((point) => point.chapter === diagnostic.fromChapter); const finish = curve.points.findIndex((point) => point.chapter === diagnostic.toChapter); if (start < 0 || finish < 0) return null; return <rect key={`${diagnostic.type}-${diagnostic.fromChapter}`} className={`curve-warning ${diagnostic.type}`} x={Math.max(inset.left, x(start) - 20)} y={inset.top} width={Math.max(40, x(finish) - x(start) + 40)} height={plotHeight}><title>{diagnostic.message}</title></rect>; })}
    <path className="curve-area" d={`${smoothPath(points)} L ${points.at(-1)!.x} ${y(0)} L ${points[0]!.x} ${y(0)} Z`} /><path className="curve-target" d={smoothPath(points)} />
    {ghostPoints && <path className="curve-ghost" d={smoothPath(ghostPoints)} />}{actualPoints?.length ? <path className="curve-actual" d={smoothPath(actualPoints)} /> : null}
    {points.map(({ point, x: cx, y: cy }, index) => <g className={`curve-node ${point.id === selected ? "selected" : ""} ${point.locked ? "locked" : ""}`} key={point.id}>
      <circle className="curve-hit" cx={cx} cy={cy} r="16" tabIndex={readOnly ? -1 : 0} role="slider" aria-label={`${point.label}，张力 ${point.tension}，${EMOTION_LABELS[point.emotion.kind]}，${point.locked ? "已锁定" : "未锁定"}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={point.tension} onFocus={() => setSelected(point.id)} onPointerDown={(event) => drag(event, point.id)} onPointerMove={(event) => move(event, point.id)} onPointerUp={(event) => end(event, point.id)} onPointerCancel={(event) => end(event, point.id)} onKeyDown={(event: KeyboardEvent<SVGCircleElement>) => { const step = event.shiftKey ? 5 : 1; if (event.key === "ArrowUp" || event.key === "ArrowRight") { event.preventDefault(); onKeyboard(point.id, step); } if (event.key === "ArrowDown" || event.key === "ArrowLeft") { event.preventDefault(); onKeyboard(point.id, -step); } }} />
      <circle className="curve-dot" cx={cx} cy={cy} r={point.id === selected ? 6 : 4.5} /><text className="curve-x-label" x={cx} y={height - 18} textAnchor="middle">{pointPosition(point)}</text><title>{point.label} · {point.tension} · {EMOTION_LABELS[point.emotion.kind]}</title>
      {point.locked && <g className="curve-lock" transform={`translate(${cx + 8} ${cy - 14})`}><rect x="-5" y="-3" width="10" height="8" rx="2" /><path d="M-3-3v-2a3 3 0 016 0v2" /></g>}
      {point.id === selected && <g className="curve-tooltip" transform={`translate(${Math.max(inset.left + 58, Math.min(width - inset.right - 58, cx))} ${Math.max(inset.top + 16, cy - 25)})`}><rect x="-58" y="-14" width="116" height="24" rx="7" /><text textAnchor="middle" y="2">{point.tension} · {EMOTION_LABELS[point.emotion.kind]} · {point.label.slice(0, 8)}</text></g>}
      {ghost?.points[index] && ghost.points[index]!.tension !== point.tension && <text className="curve-delta" x={cx} y={Math.min(cy, y(ghost.points[index]!.tension)) - 10} textAnchor="middle">{ghost.points[index]!.tension > point.tension ? "+" : ""}{ghost.points[index]!.tension - point.tension}</text>}
    </g>)}
    {actualPoints?.map(({ x: cx, y: cy, point }) => <circle className="curve-actual-dot" key={point.id} cx={cx} cy={cy} r="3"><title>{`实际 ${point.tension}：${point.evidence.join("；")}`}</title></circle>)}
  </svg></div>;
}

function PointInspector({ point, actual, readOnly, onChange, onToggleLock }: { point: CurvePoint; actual?: ActualTensionCurve["points"][number]; readOnly: boolean; onChange: (point: CurvePoint) => void; onToggleLock: () => void }) {
  const position = "progress" in point ? `全书 ${point.progress}%` : `第 ${point.chapter} 章`;
  return <aside className="curve-inspector"><header><div><small>{position}</small><strong>{point.label}</strong></div><span className={point.locked ? "locked" : ""}>{point.locked ? <Lock /> : <LockOpen />}{point.locked ? "作者锁定" : "AI 可调整"}</span></header>
    <label>节点名称<input disabled={readOnly} value={point.label} onChange={(event) => onChange({ ...point, label: event.target.value } as CurvePoint)} /></label>
    <div className="inspector-pair"><label>主导情绪<select disabled={readOnly} value={point.emotion.kind} onChange={(event) => onChange({ ...point, emotion: { ...point.emotion, kind: event.target.value as CurvePoint["emotion"]["kind"] } } as CurvePoint)}>{Object.entries(EMOTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><label>情绪强度<select disabled={readOnly} value={point.emotion.intensity} onChange={(event) => onChange({ ...point, emotion: { ...point.emotion, intensity: Number(event.target.value) } } as CurvePoint)}>{[1, 2, 3, 4, 5].map((value) => <option key={value}>{value}</option>)}</select></label></div>
    <label>剧情功能<select disabled={readOnly} value={point.function} onChange={(event) => onChange({ ...point, function: event.target.value as CurvePoint["function"] } as CurvePoint)}>{Object.entries(STORY_FUNCTION_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
    <label>设计理由<textarea disabled={readOnly} value={point.rationale} rows={6} onChange={(event) => onChange({ ...point, rationale: event.target.value } as CurvePoint)} /></label>
    {!readOnly && <button className="lock-toggle" onClick={onToggleLock}>{point.locked ? <><LockOpen />解锁，让 AI 可调整</> : <><Lock />锁定这个节点</>}</button>}
    {actual && <section className="actual-evidence"><header><strong>正文实际观察 · {actual.tension}</strong><span>置信度 {Math.round(actual.confidence * 100)}%</span></header><p>{EMOTION_LABELS[actual.emotion.kind]} · {STORY_FUNCTION_LABELS[actual.function]}</p><ul>{actual.evidence.map((evidence, index) => <li key={index}>{evidence}</li>)}</ul></section>}
  </aside>;
}

function smoothPath(points: Array<{ x: number; y: number }>) {
  if (!points.length) return ""; let path = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let index = 1; index < points.length; index += 1) { const previous = points[index - 1]!; const current = points[index]!; const middle = (previous.x + current.x) / 2; path += ` C ${middle} ${previous.y}, ${middle} ${current.y}, ${current.x} ${current.y}`; }
  return path;
}
function clamp(value: number) { return Math.max(0, Math.min(100, Math.round(value))); }
function pointPosition(point: CurvePoint) { return "progress" in point ? `${point.progress}%` : `${point.chapter}章`; }
function safeTarget(content?: string): { curve?: TargetTensionCurve; error?: string } { if (!content) return {}; const parsed = targetTensionCurveSchema.safeParse(parse(content)); return parsed.success ? { curve: parsed.data } : { error: parsed.error.issues.map((issue) => issue.message).join("；") }; }
function safeActual(content?: string) { if (!content) return undefined; const parsed = actualTensionCurveSchema.safeParse(parse(content)); return parsed.success ? parsed.data : undefined; }

export function TensionCurveComparison({ before, after }: { before?: string; after: string }) {
  return <div className="curve-comparison"><div className="curve-comparison-label"><span><ChevronLeft />当前曲线</span><span>Agent 提案<ChevronRight /></span></div><TensionCurveEditor content={before || after} ghostContent={after} readOnly compact /><p><Sparkles />半透明曲线是 Agent 候选；批准提案后才会替换当前资产。锁定节点如被覆盖，会在提案中明确标示。</p></div>;
}
