import type { ReferenceStructureRadar } from "../../shared/contracts";

const systemLabels: Record<string, string> = {
  character: "人物",
  geography: "地理空间",
  narrative: "时间叙事",
  power: "器物战力",
  worldview: "世界观",
  expression: "精神表意",
  form: "创作形式",
};

const point = (index: number, total: number, radius: number) => {
  const angle = -Math.PI / 2 + index * Math.PI * 2 / total;
  return [100 + Math.cos(angle) * radius, 100 + Math.sin(angle) * radius] as const;
};

const polygon = (values: number[]) => values
  .map((value, index) => point(index, values.length, 70 * Math.max(0, Math.min(1, value))).join(","))
  .join(" ");

export function StructureRadar({ radar }: { radar: ReferenceStructureRadar }) {
  const scores = radar.systems.map((item) => (item.score ?? 0) / 100);
  return (
    <section className="structure-radar">
      <header>
        <div>
          <small>STRUCTURE RADAR</small>
          <h3>七大体系结构雷达</h3>
        </div>
        <span>{radar.observations.length}/70 个维度有证据</span>
      </header>
      <div className="structure-radar-body">
        <svg viewBox="0 0 200 200" role="img" aria-label="七大体系结构雷达图">
          {[.25, .5, .75, 1].map((ratio) => (
            <polygon key={ratio} points={polygon(radar.systems.map(() => ratio))} className="radar-grid" />
          ))}
          {radar.systems.map((_, index) => {
            const [x, y] = point(index, radar.systems.length, 70);
            return <line key={index} x1="100" y1="100" x2={x} y2={y} className="radar-axis" />;
          })}
          <polygon points={polygon(scores)} className="radar-value" />
          {radar.systems.map((item, index) => {
            const [x, y] = point(index, radar.systems.length, 86);
            return <text key={item.systemId} x={x} y={y} textAnchor="middle" dominantBaseline="middle">{systemLabels[item.systemId]}</text>;
          })}
        </svg>
        <div className="structure-radar-systems">
          {radar.systems.map((item) => (
            <div key={item.systemId}>
              <strong>{systemLabels[item.systemId]}</strong>
              <span>{item.score === null ? "未分析" : `${item.score} 分`}</span>
              <small>覆盖 {item.observedDimensions}/{item.totalDimensions}（{Math.round(item.coverage * 100)}%）</small>
            </div>
          ))}
        </div>
      </div>
      <p>分数只聚合已有证据的维度；覆盖率单独显示，未分析不会被当成低分。</p>
    </section>
  );
}
