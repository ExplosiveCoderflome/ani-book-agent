# 架构

## 边界

```text
React 作者工作区 / Mastra Studio
              ↓
      Application + HTTP API
              ↓
 Domain policy ← NovelRepository
              ↑
 Mastra Agent + novel-production Workflow
```

依赖只向内流动：UI、Mastra 和基础设施可以依赖 Application/Domain，Domain 不依赖 Mastra。

## 三个 Agent

- `novel-agent`：对话、探索、蓝图、规划、正文和修订判断；拥有六个通用工具。
- `novel-critic`：无记忆、无工具，负责章节验收、连续性增量抽取和通用项目审查。
- `deconstruction-agent`：无记忆、无工具，只在全局拆书 Workflow 内完成逐章提取、聚合、专项分析和证据复核。

主 Agent 的确定性工具包括 `read_project`、`search_project`、`read_skill`、`read_reference`、`propose_patch`、`start_job`。`read_reference` 只能读取已完成报告、阶段、章节分析和短证据，不能修改参考书或把参考书事实写入连续性账本。工具只读取、校验或发起运行，不调用模型，也不能绕过 Domain 写权威文件。

创作方法按需从仓库内五个只读 Skill 加载：`discovery`、`blueprint`、`volume-planning`、`chapter-writing`、`critique`。

## 数据与权限

`novel-state.yaml` 是生产进度权威，`book/ledger.yaml` 是已确认决定、角色状态、世界规则、开放线索和连续性变化的权威。状态文件记录每个作品文件的 SHA-256、版本、来源和保护状态。

通用 Agent 编辑先形成补丁，生产链只能提交明确的业务动作：

- 普通笔记或未受保护的规划编辑可以自动应用；通用补丁不能创建稳定章节、实际张力曲线、审批记录或仿写批准记录。
- 蓝图和作者编辑/保护文件必须作者批准。
- 替换必须携带当前基础哈希；过期提案拒绝并要求重新读取。
- v2 不提供 Agent 删除权威文件的操作。

同一本书只能有一个活动 Job，章节只能按 `nextChapter` 串行稳定提交。章节正文和连续性账本经过章节命令校验后一起更新；Mastra 快照不保存完整正文。

同一服务进程内，小说仓库按作品目录串行处理状态读改写，包括作者保存、补丁提交、外部修改同步和任务标识更新。不同小说仍可并行；多个服务进程不能同时操作同一作品目录。多文件提交使用临时恢复日志，在状态提交失败时还原文件；启动后的首次读取会恢复未完成提交。恢复日志不替代 Markdown/YAML 权威数据，遇到日志之外的作者修改会保留现场并报告冲突。

Skill 绑定的首次初始化使用固定的系统入口，幂等创建受保护的绑定文件，不经过创作开书包审批。章节生产可以新增正文和角色档案，但不能自动替换已有作者保护文件。

## 统一提交边界

小说权威写入统一遵循：`受限业务方法 → Repository 同书锁与最新文件快照 → Domain 命令决策 → 同一事务提交`。`domain/novel-commands.ts` 负责权限、合法状态变化、内容合同、版本校验和下一状态；Repository 负责文件访问、外部修改识别、串行化与故障恢复。Application 和 Workflow 可以提前检查以尽早报错，最终决定必须在锁内重新执行领域策略。

公开接口不接受任意状态修改回调，也不接受 `authorApproved` 布尔开关。组合根给 Agent 只读/提案能力，给 Workflow 规划、章节、审查、导出与任务收尾能力；作者批准、拒绝、编辑及规划确认仅由对应作者操作调用。

补丁原文及决策保存在版本化的 `workspace/proposals/` 文件中。批准和拒绝必须匹配登记的原提案；不能替换内容后沿用同一 ID，也不能重新应用已拒绝的提案。重复提交同一已应用提案保持幂等。

`novel-state.yaml` 的生产授权只记录任务身份、允许的目标/范围和已确认规划版本，不复制 Mastra 的执行游标、重试或暂停快照。卷规划生成只保存待确认资产；标准生产的作者继续动作确认当时的计划/曲线哈希，后续编辑使该许可失效。全自动开书的前三章由明确模式授权。章节提交还必须提供完整 Critic 验收结果与所用上下文版本，只有 `accepted` 且所有权、顺序、范围和版本仍有效时才能推进 `nextChapter`。

失败任务保留占用供作者重试或放弃，同时撤销旧运行的提交权限；成功和取消按任务所有权释放占用。重试原子替换旧任务，旧任务的迟到收尾不能影响新任务。

升级前缺少生产授权记录的活动任务需要取消后重新启动；未登记到 `workspace/proposals/` 的历史待审批提案需要重新生成。已有正文和作者文件不需要迁移。

## Mastra Workflow

`novel-production` 处理写章、通用项目审查和导出。写章批次从当前 `nextChapter` 开始，最多五章；默认蓝图批准后生成三章。

`reference-deconstruction` 是同一 Mastra Runtime 内的全局拆书 Workflow。它按“完整章节批次 → 阶段 → 宏观结构 → 全书 → 证据复核”执行，批次上下文不超过约 18,000 字符，`foreach` 并发为 2，全局只允许一个活动拆书 Job。标准模式全量遍历一次原文；深度模式在标准报告后按所选专项复扫。不存在第二套 Agent 循环、向量库或独立运行时。

参考书的权威数据位于 `reference-library/`：`library-state.yaml` 保存全局活动任务锁，每本书的 `reference-state.yaml`、规范化原文、章节清单和版本化分析均为本地 Markdown/YAML。Mastra storage 只保存运行快照、暂停、Trace 和评估。

项目审查只有一个通用 `review_project` 目标。主 Agent 把作者的自然语言要求整理成 `brief` 和文件/章节范围，Workflow 只负责安全取材、上下文分批、调用 Critic 和保存报告。连续性、节奏、人物、伏笔等审查主题不进入 Domain 枚举，也不新增专用工具；方法变化优先通过仓库内 `project-review` Skill 演进。

每章路径为：

```text
读取蓝图/账本/卷计划/上一章
→ Writer 生成正文
→ Critic 返回 accepted | repair | replan
→ accepted：领域提交边界校验后保存正文与账本
→ repair / replan：最多两次重写并重新验收，仍不通过则失败
```

运行失败或取消不会覆盖最后稳定版本，活动任务标识只允许由持有该标识的运行清除。

拆书任务在仓库中原子取得全局占用，模型调用继承 Workflow 的取消信号。每次分析写入和任务完成都校验运行 ID；取消先撤销写入权限，再中止运行，旧任务不能覆盖终态或释放新任务的占用。

用户与 AI 提供的章节切分正则在独立 Worker 中匹配，单次扫描超过两秒即终止并返回可读错误。保存规则前先验证原文，失败时保留已有规则。

## API

业务 API 暴露小说、文件、补丁提案、生产 Job、全局参考书、拆书 Job、受限原文区间、导出文件和模型设置。原文接口单次最多返回 40,000 字符，Agent Tool 不提供整本读取。错误统一为：

```json
{
  "error": {
    "code": "FILE_STALE",
    "message": "文件已变化，请重新读取后再保存。",
    "recoverable": true,
    "nextAction": "reread"
  }
}
```

前端统一抽取可读消息，不渲染内部堆栈或对象字符串。
