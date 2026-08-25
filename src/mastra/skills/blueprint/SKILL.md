---
id: blueprint
version: 3
description: 将讨论收束为可执行蓝图，并在作者选定后同时建立全书张力曲线。
---
# 作品蓝图

每份候选必须包含：暂定书名、一句话 premise、目标读者、主要阅读回报、主角反差与欲望、核心冲突、故事发动机、开篇钩子、升级路线、关键角色关系、世界硬规则、终局方向和主要风险。

两份候选必须在同一条普通 Markdown 对话回复中以“方案一”和“方案二”完整展示，不使用 JSON、表格、卡片字段或选项工具。结尾邀请作者用自然语言选择、混合或调整；作者确认之前不提交正式文件。

两份方案的差异必须落在主角路径、冲突引擎、关系结构或回报循环，不能只是换名字。作者选定后，先按需读取 `character-planning` Skill，并在同一个 `propose_patch` 中同时创建 `book/blueprint.md`、`book/ledger.yaml`、`book/tension-curve.yaml`，以及 `book/characters/<character-id>.md` 下每名开篇主要角色的独立文件，不能把多名角色合并为一个角色文档，也不能拆成多个提案。蓝图与角色档案使用清晰 Markdown。

全书张力曲线是作者确认的创作方向，不是正文评分。使用 `schemaVersion: 1`、`kind: book`，节点 `progress` 必须从 0 开始、在 100 结束并严格递增。每个节点包含 `id`、`progress`、`label`、0–100 整数 `tension`、`emotion.kind`、1–5 整数 `emotion.intensity`、`function`、`rationale`、`source: ai`、`locked: false`。`basis.blueprintSha256` 可先填 64 个 `0`，Repository 会按同一提案中的蓝图确定性写入真实哈希；`basis.generatedAt` 写当前 ISO 时间；`calibration` 初始为 `status: aligned` 和空 `reasons`。

`emotion.kind` 只使用 anticipation、curiosity、pressure、fear、exhilaration、grief、warmth、relief；`function` 只使用 hook、setup、escalation、turn、reveal、payoff、breather、climax、aftermath。曲线要有积累、释放、转折和真正高峰，不把“全程高压”误当精彩。

角色档案只展开开篇会实际承担剧情功能的主要角色，写清叙事功能、目标与需要、核心矛盾、能力限制、行为声音、秘密知情边界、关系张力和人物弧检查点。不要在开书阶段制造庞大角色百科。

账本必须严格使用以下 YAML 结构，不得增加 `book`、`phase`、`openQuestions` 等字段。只记录开篇前已经成立的角色事实，不把计划中的人物弧转折提前写入账本。数组暂时没有内容时写 `[]`；未确认内容直接省略，不进入 decisions。所有 `knowledge`、`relationships` 和 `exceptions` 都是字符串数组；`relationships` 每项使用“对方角色 ID：当前关系——已成立依据”的单个字符串，绝不能写成包含 `id`、`type`、`note` 的对象：

```yaml
version: 1
decisions:
  - id: decision-001
    text: 作者已经确认的方向或边界
    source: author
characters:
  - id: hero
    name: 角色名
    role: 主角
    goal: 当前目标
    state: 当前状态
    knowledge: []
    relationships:
      - "mentor: 师徒——导师已经收主角入门"
worldRules:
  - id: rule-001
    rule: 会限制剧情的世界规则
    exceptions: []
openThreads:
  - id: thread-001
    kind: promise
    text: 已建立的承诺、悬念或冲突
    status: open
    introducedChapter: 0
    lastAdvancedChapter: 0
continuity: []
```
