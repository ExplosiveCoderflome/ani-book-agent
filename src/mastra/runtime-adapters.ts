import type { AdaptationPlannerPort, ChapterPatternAdvisorPort, InteractiveNovelPort, RuntimeRun, RuntimeRunState, WorkflowRunnerPort } from "../application/ports";

type WorkflowLike = {
  createRun(input?: { runId?: string; resourceId?: string }): Promise<any>;
  getWorkflowRunById(runId: string, options?: any): Promise<any>;
};

export class DeferredWorkflowRunner implements WorkflowRunnerPort {
  private workflow?: WorkflowLike;
  constructor(private readonly name: string) {}
  bind(workflow: WorkflowLike) {
    if (this.workflow && this.workflow !== workflow) throw new Error(`${this.name} 已绑定，不能重复替换`);
    this.workflow = workflow;
  }
  assertBound() { if (!this.workflow) throw new Error(`${this.name} 尚未完成组合根绑定`); }
  async createRun(input?: { runId?: string; resourceId?: string }): Promise<RuntimeRun> { this.assertBound(); return this.workflow!.createRun(input) as Promise<RuntimeRun>; }
  async getWorkflowRunById(runId: string, options?: unknown): Promise<RuntimeRunState | null | undefined> { this.assertBound(); return this.workflow!.getWorkflowRunById(runId, options) as Promise<RuntimeRunState | null | undefined>; }
}

export class DeferredAdaptationPlanner implements AdaptationPlannerPort {
  private delegate?: AdaptationPlannerPort;
  bind(value: AdaptationPlannerPort) { if (this.delegate && this.delegate !== value) throw new Error("仿写规划器已经绑定"); this.delegate = value; }
  assertBound() { if (!this.delegate) throw new Error("仿写规划器尚未完成组合根绑定"); }
  async plan(input: Parameters<AdaptationPlannerPort["plan"]>[0]) { this.assertBound(); return this.delegate!.plan(input); }
}

export class DeferredChapterPatternAdvisor implements ChapterPatternAdvisorPort {
  private delegate?: ChapterPatternAdvisorPort;
  bind(value: ChapterPatternAdvisorPort) { if (this.delegate && this.delegate !== value) throw new Error("章节规则顾问已经绑定"); this.delegate = value; }
  assertBound() { if (!this.delegate) throw new Error("章节规则顾问尚未完成组合根绑定"); }
  async suggest(sample: unknown) { this.assertBound(); return this.delegate!.suggest(sample); }
}

export class DeferredInteractiveNovel implements InteractiveNovelPort {
  private delegate?: InteractiveNovelPort;
  bind(value: InteractiveNovelPort) { if (this.delegate && this.delegate !== value) throw new Error("交互 Agent 已经绑定"); this.delegate = value; }
  assertBound() { if (!this.delegate) throw new Error("交互 Agent 尚未完成组合根绑定"); }
  async recall(novelId: string) { this.assertBound(); return this.delegate!.recall(novelId); }
  async testConnection() { this.assertBound(); return this.delegate!.testConnection(); }
  async testSkill(prompt: string) { this.assertBound(); return this.delegate!.testSkill(prompt); }
}
