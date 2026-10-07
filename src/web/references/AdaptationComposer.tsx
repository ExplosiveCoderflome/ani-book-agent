import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { NovelSummary, ReferenceAdaptation } from "../../shared/contracts";
import { api } from "../api";

const statusLabels: Record<ReferenceAdaptation["status"], string> = {
  proposed: "等待作者批准",
  approved: "已批准",
  rejected: "已拒绝",
  stale: "已过期",
};

export function AdaptationComposer({
  referenceId,
  analysisId,
  novels,
  selectedInsightIds,
}: {
  referenceId: string;
  analysisId: string;
  novels: NovelSummary[];
  selectedInsightIds: string[];
}) {
  const client = useQueryClient();
  const [novelId, setNovelId] = useState("");
  const [adaptation, setAdaptation] = useState<ReferenceAdaptation>();
  useEffect(() => setAdaptation(undefined), [novelId, selectedInsightIds.join("|")]);
  const create = useMutation({
    mutationFn: () => api.createReferenceAdaptation(referenceId, analysisId, {
      novelId,
      selectedInsightIds,
    }),
    onSuccess: (result) => setAdaptation(result.adaptation),
  });
  const decide = useMutation({
    mutationFn: (action: "approve" | "reject") => api.adaptationAction(novelId, adaptation!.id, action),
    onSuccess: async (result) => {
      setAdaptation(result.adaptation);
      await client.invalidateQueries({ queryKey: ["novel-adaptations", novelId] });
    },
  });
  return (
    <footer className="adaptation-composer">
      {!adaptation ? (
        <>
          <div>
            <strong>创建仿写提案</strong>
            <small>默认从下一章开始作用 3 章；只传递结构机制，不传递参考原文。</small>
          </div>
          <select value={novelId} onChange={(event) => setNovelId(event.target.value)}>
            <option value="">选择目标作品</option>
            {novels.map((novel) => <option value={novel.novelId} key={novel.novelId}>{novel.title}</option>)}
          </select>
          <button disabled={!novelId || selectedInsightIds.length === 0 || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? <LoaderCircle className="spin" /> : null}
            生成提案
          </button>
          {create.error && <p className="reference-error">{create.error.message}</p>}
        </>
      ) : (
        <section className={`adaptation-proposal ${adaptation.status}`}>
          <header>
            <div>
              <small>{statusLabels[adaptation.status]}</small>
              <strong>第 {adaptation.scope.fromChapter}–{adaptation.scope.toChapter} 章仿写约束</strong>
            </div>
            <span>{adaptation.selectedInsightIds.length} 条洞察</span>
          </header>
          <p>{adaptation.summary}</p>
          <dl>
            <div><dt>规划</dt><dd>{adaptation.constraints.planning.join("；") || "无额外约束"}</dd></div>
            <div><dt>写作</dt><dd>{adaptation.constraints.writing.join("；") || "无额外约束"}</dd></div>
            <div><dt>审查</dt><dd>{adaptation.constraints.review.join("；") || "无额外约束"}</dd></div>
          </dl>
          {adaptation.status === "proposed" ? (
            <div className="adaptation-actions">
              <button disabled={decide.isPending} onClick={() => decide.mutate("approve")}><Check />作者批准</button>
              <button disabled={decide.isPending} onClick={() => decide.mutate("reject")}>拒绝</button>
            </div>
          ) : adaptation.status === "approved" ? (
            <p className="adaptation-approved"><Check />提案已批准，不会自动生成章节。请进入作品后手动点击继续。<Link to={`/novels/${novelId}`}>进入作品</Link></p>
          ) : null}
          {decide.error && <p className="reference-error">{decide.error.message}</p>}
        </section>
      )}
    </footer>
  );
}
