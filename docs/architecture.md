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

所有 Agent 写入先形成补丁：

- 创建 Agent 文件或更新仍由 Agent 拥有的文件可自动应用。
- 蓝图和作者编辑/保护文件必须作者批准。
- 替换必须携带当前基础哈希；过期提案拒绝并要求重新读取。
- v2 不提供 Agent 删除权威文件的操作。

同一本书只能有一个活动 Job，章节只能按 `nextChapter` 串行稳定提交。章节正文和连续性账本在同一补丁中通过校验后更新；Mastra 快照不保存完整正文。

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
→ accepted：提交正文与账本
→ repair：一次有限修复后提交
→ replan：Mastra suspend，等待作者处理后 resume
```

运行失败或取消不会覆盖最后稳定版本，活动任务标识只允许由持有该标识的运行清除。

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
