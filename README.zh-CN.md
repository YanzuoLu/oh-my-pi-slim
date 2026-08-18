# oh-my-pi-slim

> Pi 的 preset 驱动编排层，内置后台 run、loop、monitor、结构化提问、durable Goal 与 session todo。

[English](./README.md) | **中文**

主 Pi 会话负责规划、调度、监督与验收。每个 child 都是独立的 Pi RPC 进程，并拥有可持久化的 session。preset 统一选择主 orchestrator 与六个 specialist 的模型和 thinking 档位。

```bash
pi --omps
```

## 六个 specialist

| Specialist | 用途 |
| --- | --- |
| `explorer` | 代码库侦察，定位相关代码与测试 |
| `librarian` | 官方文档、库行为、版本相关 API 与公开源码示例 |
| `oracle` | 架构、风险、调试策略、简化与审查 |
| `designer` | UI/UX 实现、审查与视觉打磨 |
| `fixer` | 边界明确的实现与验证 |
| `observer` | 图片、截图、PDF 与图表的视觉分析 |

`orchestrator` 只是主会话 preset 角色。specialist 只从 package 根目录的 `agents/` 加载，并使用 Pi 的 `parseFrontmatter`；用户或项目 agent manifest 不参与发现。角色 frontmatter 只包含 `name` 与 `description`；能力在启动时控制，不再使用逐角色正向工具 allowlist。

## 要求与安装

- 与 Pi 0.84.2 的 package 和 RPC API 兼容。
- 所选 preset 的七个 provider/model 必须存在并已配置认证；显式配置的 `observer` model 必须声明 image input 支持。

```bash
pi install git:github.com/YanzuoLu/oh-my-pi-slim
```

package manifest 加载 `./extensions/oh-my-pi-slim/index.ts`，以及独立的内置 Todo 入口 `./extensions/todo/index.ts`；不再包含 `pi-subagents` dependency 或 extension entry。

## 工具可用性

在受支持的 POSIX 系统上，main session 精确获得本 package 的六个工具：`ask_user_question`、`goal`、`loop`、`monitor`、`subagent` 与 `todo`。detached child 精确获得 `contact_supervisor` 与 `todo`。Ask、Goal、Monitor、Loop 和 subagent 都只属于 main，因为 main extension 在 child 环境中会先 return；Todo 是 main/child 都加载的独立入口，`contact_supervisor` 只由 child launcher 加载。Windows 不注册 Monitor。

Ask、Goal 与 Monitor 在 package load 时立即注册，不依赖 `/omps on`、`--omps` 或 active preset；Loop 也具有相同的 load-time independence。因此 active Goal 的 phase reminder 即使在 orchestrator preset inactive 时也可独立出现；它是每次 run 前的 invisible message，不是 Goal 专属的动态 system-prompt rewrite，也不是 `context` hook。RPC session 暴露相同的受支持工具，但绝不注册 package widget。JSON 与 print mode 因无法服务 dialog，会从 active tool set 移除 Ask。

所有 package 自有的 expandable tool row 或 custom notification 使用同一 data invariant：折叠渲染包含 `(ctrl+o to expand)` 提示；展开后显示完整公开细节；Ctrl+O 绝不改变工具参数、模型可见 content、result details 或持久化状态。

## 外部 package 迁移

内置 Ask 与 `npm:@juicesharp/rpiv-ask-user-question` 注册同一个工具名，因此两者不能共存。内置 Monitor 替代 `npm:@aliou/pi-processes`，不会 import 或调用该 package。本地安装前，请分开执行以下 Pi 操作移除外部 package：

```bash
pi remove npm:@juicesharp/rpiv-ask-user-question
pi remove npm:@aliou/pi-processes
```

还应从任何用户 specialist deny list 中移除 `ask_user_question`。detached child 根本不会注册 Ask，因此在 child policy 中 deny 该名称已经没有意义。这些都属于用户显式执行的迁移步骤：本 package 绝不会自动运行 `pi remove`、编辑用户 package settings 或重写用户 deny list。

## 内置 Todo

package 在 main 与 child session 中始终注册一个名为 `todo` 的模型工具。Todo 不依赖 OMPS 是否激活，也不依赖 preset；它不增加 command、shortcut 或配置。

```ts
{ action: "list" }
{ action: "update", operations: [
  { op: "append", subject, abstract, blockedBy? },
  { op: "modify", target, newSubject?, abstract?, status?, addBlockedBy?, removeBlockedBy? },
  { op: "clear" }
] }
```

每个 task 精确为 `{ subject, abstract, status, blockedBy }`。subject 会 trim，在 session 内区分大小写且全局唯一，并使用精确匹配。`list` 按 append 顺序返回当前 session 的完整数组，包括 completed item；它不会创建持久化 snapshot。

`update` 按顺序在 draft 上应用非空 operations 数组，最后只 commit 一次。任一 operation 非法都会取消整个 update。依赖只能引用执行到该 operation 时已经存在的 subject。rename 会原子更新所有依赖引用。最终依赖图不能包含缺失引用、自依赖或环；每个 `in_progress` 或 `completed` item 的全部依赖都必须 completed。只要满足该依赖规则，多个 item 可以同时为 `in_progress`。

`clear` 在一个 batch 中最多出现一次，并可位于任意位置。执行 clear 时，draft 必须为空或只包含 completed item。一个 batch 可以先完成旧任务组，再 clear，并 append 新任务组。否则 completed item 会一直保留到 clear。

状态按 Pi session 独立，只通过成功 `todo update` 的新版本 tool-result details 持久化。reload、tree navigation 与 compaction 会从当前 branch 恢复最后一个合法 snapshot。RPC child 会注册工具，但绝不注册 widget。

前台 TUI session 会在 editor 上方显示 tree widget。每个 item 只显示 subject；存在依赖时，行尾显示 `⛓ subject1, subject2`。abstract 不进入 widget，并继续保留在模型可见的完整 `list` JSON 中。widget 显示 `● Todos (completed/total)` 与状态 glyph，总计最多 12 行。overflow 会优先隐藏 completed item，并准确分别统计隐藏状态。空状态会移除 widget。

Todo call/result renderer 与 subagent transcript 使用相同的 Ctrl+O 规则。折叠的 list 与 update call 都只显示标题与 action。展开的 update call 按输入顺序显示每个 operation 的完整字段、abstract 与依赖列表。折叠的 update result 显示 operation summary：`Applied <append> append · <modify> modify · <clear> clear → <changed> changed · <no-change> no-change`；展开后再增加编号稳定的逐项 receipt。折叠的 list result 只显示 `● Todos (completed/total)`；展开后显示每个 task 的 subject、abstract、status 与依赖。fallback 折叠为安全首行，展开为完整文本。Ctrl+O 只改变 TUI 渲染，不改变 list JSON、update receipt content 或 tool-result details。

任何同样注册 `todo` 的外部 package 都不能与内置工具共存。本地迁移时，请在加载 OMPS 前单独对该外部 package 执行 `pi remove`。本 package 不会主动删除或卸载任何外部 package。

## 内置 Loop

package 自有一个 `/loop` command 和一个名为 `loop` 的模型工具。只要 package 在 main session 中加载，两者就会注册，不依赖 OMPS 编排是否激活。现有 child 环境 early return 会阻止这两个入口在 child session 注册；不存在 child replay 路径。

command 不解析请求。任何自然语言 `/loop ...` 调用都会关闭 prompt-template expansion，并作为真实 user message 原样转发；Pi busy 时使用 `deliverAs: "steer"`。模型 guideline 只允许在最新 user message 以 `/loop` 开头时调用 `create`。普通自然语言请求可以 list、modify、pause、resume 或 delete，但不能 create。裸 `/loop` 会让模型调用 `list`，并说明 `/loop <interval> <prompt>` 用法。

唯一的 sequential 工具有六个 action，并严格隔离各 action 字段：

```ts
{ action: "create", interval, abstract, prompt }
{ action: "delete", id }
{ action: "modify", id, interval?, abstract?, prompt? }
{ action: "list" }
{ action: "pause", id }
{ action: "resume", id }
```

`modify` 至少需要提供一个修改字段。ID 是精确八位小写十六进制字符串；缺失或未知 ID 会报错。允许重复 loop 配置。`abstract` 是紧凑 UI 使用的简短人类可读摘要。`prompt` 是每个未来模型 turn 都会收到的完整、自包含指令；它没有文本长度上限，也不是 abstract 的缩写。

interval 严格使用一个正整数和一个小写单位：`s`、`m`、`h` 或 `d`。范围闭区间为 `10s` 到 `7d`。存储时使用可精确整除的最大单位，因此 `60s` 会变为 `1m`，`120m` 会变为 `2h`，`48h` 会变为 `2d`。

每个 loop 使用 recursive one-shot timeout 实现 repeating fixed-delay。create 会等待一个完整 interval 才首次 fire；resume 也会等待完整 interval。后续 timeout 只在前一个 tick 处理完成后开始。没有最大 fire 次数、expiry、loop 数量限制、backlog 限制或 coalescing。

`pause` 会清除 timer，把 `nextFireAt` 设为 `null`，并取消该 loop 尚未投递的 compaction-gated fire。重复 pause 是成功的 no-change。`resume` 从 resume 时刻重新等待完整 interval；重复 resume 也是成功的 no-change。paused loop 可以 modify。active loop 的有效 interval 变化会重新等待完整 delay；等价 canonical interval 是 no-change。只修改 abstract 或 prompt 会保留 active `nextFireAt`。已经被 delivery gate 捕获的 fire 保持其旧 abstract、interval 与 prompt 的 immutable snapshot。`delete` 直接移除 loop，不保留 tombstone 或 history。

Loop 状态只存在于 runtime memory，绝不使用 `appendEntry`、journal、文件或 snapshot persistence。compaction 与 tree navigation 会保留 loops、timers 和 gated fire records；reload、new session、resumed session、fork 与 quit 会清空全部 loop。tree 与 compaction host operation 共用 notification pause gate，随后按 FIFO 释放匹配 records，且不改变 subagent notification 的 content 或 delivery 语义。

每个 tick 都会生成独立的 package custom message，并使用 `deliverAs: "steer"` 与 `triggerTurn: true`。content 和 details 包含 ID、abstract、canonical interval、成功 fire count、fire 时间与完整 prompt。每条 queued fire 都保持独立，delivery 不会 merge 或 coalesce。只有 `sendMessage` 成功后才增加 `fireCount`。send 抛错时增加 `failureCount`，记录 `lastFailedAt` 与 `lastError`；后续成功会清除 `lastError`，但保留失败历史。

`list` 按创建顺序返回每个 loop 的完整公开 JSON：

```json
{
  "id": "1a2b3c4d",
  "abstract": "检查最新项目状态",
  "prompt": "读取完整状态并报告所有相关变化。",
  "interval": "1m",
  "status": "active",
  "createdAt": "2026-05-01T00:00:00.000Z",
  "updatedAt": "2026-05-01T00:00:00.000Z",
  "nextFireAt": "2026-05-01T00:01:00.000Z",
  "fireCount": 0,
  "failureCount": 0,
  "lastFiredAt": null,
  "lastFailedAt": null,
  "lastError": null
}
```

前台 TUI session 会在 editor 上方显示 package 自有 widget，heading 为 `● Loops (active/total)`。每个可见 loop 使用不可拆分的两行 tree entry：第一行用 `↻` 表示 active、`!` 表示最近 delivery error、`Ⅱ` 表示 paused，并显示 abstract 与 ID；第二行显示 `Every <interval>`、每秒刷新一次的 countdown 或 paused 状态、fire count 与当前 failure 文本。active loop 先按 `nextFireAt` 排序，paused loop 再按 `createdAt` 排序。widget 最多 12 行、最多显示五个 loop，并使用 `… n more` 报告 overflow。RPC session 绝不注册该 widget。

package 自有 call、result 与 fire renderer 遵守 Ctrl+O data invariant。折叠视图保持紧凑并显示展开提示；展开视图显示完整 action-specific input、全部公开 list 字段、完整 error 与完整 prompt。Ctrl+O 只改变 TUI rendering，绝不改变 tool-call arguments、模型可见 content、custom-message details、list JSON 或 mutation receipt。

## 内置 Monitor

Monitor 是 main-session-only 的 POSIX 工具，包含四个 sequential action：

```ts
{ action: "create", abstract, command, cwd?, notifyOn? }
{ action: "delete", id }
{ action: "list" }
{ action: "status", id, start?, end? }
```

`create` 要求 trim 后非空的人类可读 `abstract` 与一个 foreground Bash `command`；`cwd` 默认使用 session cwd。`notifyOn` 最多接受 20 个 unique、非空、区分大小写的 literal string，每个最多 500 字符。Monitor ID 是精确八位小写十六进制字符串。Monitor 数量没有上限。

runtime 解析 absolute executable Bash，通过新的 detached POSIX process group 启动 `bash -lc <command>`，并由 Monitor 持有该 group；stdin 被 ignore，stdout/stderr 通过 pipe 捕获。它绝不提供 stdin、PTY 或 interactive terminal 语义。模型 guideline 要求 foreground command，并禁止 `nohup`、`setsid`、`disown`、尾随 `&` 或其他 daemon escape。这只是 guideline，不是 shell parser 或 sandbox：command 仍可故意 detach descendant，而有界 TERM/KILL cleanup 可能返回该 descendant 仍存活的 warning。

`list` 是紧凑结果，只返回 `{ id, status, abstract }`。running monitor 先按创建顺序排列，terminal monitor 再按结束时间倒序排列。`status` 返回完整但有界的 operational record，包括 command、cwd、PID、lifecycle timestamp、exit/signal/error、match/notification counter、log rollover counter 与 combined stdout/stderr lines。分页使用 reverse offset：`start` 跳过这么多条最新 retained record，`end` 是 exclusive reverse offset；默认窗口为 `0..100`，最大窗口 2,000 行；返回行会恢复为 chronological order。

Monitor state 由 runtime 持有，绝不进入 Pi session journal。log 位于 OS temporary directory 下新建的 mode-0700 目录，JSONL 文件为 mode-0600。每个 combined log 到 64 MiB 时 rollover，并保留大约最新 32 MiB 的完整 record 加 rollover marker；counter 报告 dropped bytes/lines。partial line 在 64 KiB 截断并附 suffix。tool content 上限 50 KiB，notification content 上限 50 KiB，notification details 上限 96 KiB；status line collection 在 serialization 前还有额外边界。

literal match 以 100 ms batch 聚合；每个 batch 最多携带 100 条新增 combined line。matcher delivery 全局限制为 rolling minute 内 20 个 batch；被 suppress 的 batch 会在窗口重新开放后汇总。match、rate-summary 与 terminal event 都使用 visible custom message，并设置 `deliverAs: "steer"` 与 `triggerTurn: true`；它们共用 package notification pause gate，在 agent settled 后安全 retry，并一直 pending 到 delivered message acknowledgement。terminal record 与 log 会保留到显式 `delete` 或 session teardown。`delete` 会取消该 monitor 仍被 gate 的 notification，需要时对 process group 做有界 TERM 再 KILL，移除 record 与 log，并报告 forced-cleanup warning。notification 一旦已经交给 Pi，删除 monitor 也不能撤回该消息。

running monitor 或尚未 acknowledgement 的 terminal Monitor notification 会阻塞 Goal continuation，避免 Goal 在后台工作 terminal evidence 交付前越过它。reload、new/resumed/forked session transition 与 quit 会关闭所有 monitor、删除 temporary log root，并清空全部 Monitor state。

前台 TUI 在 editor 上方显示 `● Monitors (running/total)`。running entry 位于 terminal entry 前；widget 最多显示十个 monitor、总计十二行；output-driven refresh 会 throttle/coalesce。RPC session 没有 widget。Monitor call、result、matcher、summary 与 terminal renderer 都由 package 自有：折叠视图包含 Ctrl+O hint，展开后显示 action 字段、operational state、combined lines、matches、omission、truncation 与 forced-delete warning，且不修改模型可见数据。

## 内置 Ask

Ask 是 main-session-only 的 sequential `ask_user_question` 工具。其 strict provider-portable schema 兼容一到四个 question，每个 question 含二到四个 authored option：

```ts
{
  questions: [{
    question,
    header,          // 最多 16 字符
    options: [{
      label,         // 最多 60 字符
      description,
      preview?       // 仅 single-select
    }],
    multiSelect?
  }]
}
```

question 与 option label 在各自 scope 内必须 exact-unique。`Other`、`Type something.` 与 `Next` 是 reserved option label。recommended option 应放在第一项，并在 label 后附 `(Recommended)`。multi-select question 使用 `preview` 会被拒绝。

前台 TUI 使用一个 bottom-centered、full-width overlay，并为全部 question 提供 tab。tab 可双向 wrap，并保存各 question draft。single-select question 可选择一个 authored option 或提交 custom inline response。multi-select question 按 authored order toggle option，允许 empty selection，也可用一个 custom response 替换 selection。single-select preview 在宽 terminal 中显示于 option list 旁边，在窄 terminal 中堆叠到下方。questionnaire 可返回 complete、partial、cancelled-with-partial、empty multi-select、empty custom 或 zero-answer/empty-submit 结果；empty submit 表示为带 `cancelReason: "empty_submit"` 的 cancelled partial result，而不是 tool error。

RPC mode 使用 Pi native `select` 与 `input` extension UI request，并提供显式 Submit、Cancel、Done control；绝不会尝试实例化 TUI overlay。JSON 与 print mode 会 deactivate Ask，同时保留 no-UI execute backstop。Ask 内部不存在付费或 nested model call。

Ask 是 single-flight：最多一个 dialog active，后续调用排队，只有 active dialog 计为 waiting。tool abort、session switch/fork/tree navigation、reset 与 shutdown 会用 `AbortError` 精确一次 reject active 和 queued call。用户 cancel 是正常 result，不是 abort。只要 Goal active，合法 Ask call 也会在打开 UI 前 hard reject，因为 active Goal prompt 禁止向用户提问。

Ask 没有 persistence、notification message、widget、slash command、configuration、i18n layer、notes 字段或 Ask-specific answer-collapse 功能，只拥有 call/result transcript renderer。折叠 row 包含 Ctrl+O expansion hint；展开后显示全部 question、option、description、single-select preview、confirmed answer、unanswered question 与 cancellation reason，且不改变 tool envelope。

## 内置 Goal

Goal 是 main-session-only 的 durable scheduler surface，由 raw-forwarding `/goal` command 与一个含精确七个 action 的 sequential `goal` 工具组成：

```ts
{ action: "create", abstract, objective, criteria }
{ action: "modify", abstract, objective, criteria }
{ action: "status" }
{ action: "pause", reason }
{ action: "resume" }
{ action: "complete", evidence }
{ action: "cancel", reason }
```

`/goal ...` 不解析 request，而是关闭 prompt-template expansion，把精确原文作为真实 user message 转发；仅在 Pi busy 时使用 `deliverAs: "steer"`。模型 guideline 只允许在最新 user message 以 `/goal` 开头时调用 `create`；裸 `/goal` 会调用 `status` 并说明 `/goal <objective>`。

当前 branch 上存在零个或一个 Goal。`create` 要求 short abstract、complete objective 与一到八条非空 completion criteria；仅在不存在 Goal 或旧 Goal 已 terminal 时允许。`modify` 完整替换任意 nonterminal Goal 的 contract，并使其 active。`complete` 只在 active 时合法，且必须为每条 criterion 提供精确一条非空 evidence。公开 Goal status 包含 contract、lifecycle timestamp、retry/no-progress 字段、pause/cancel reason 与 completion evidence；不暴露公开 Goal ID、revision、ownership list、continuation count 或 execution statistics。

Goal state 使用 strict version-1 branch-local snapshot，并以不进入 context 的 custom entry append。replay 选择 active branch 上最后一个合法 snapshot，并跳过 malformed record。reload/startup、resumed/forked session 与 tree restore 会把 `active` 或 `retry_wait` Goal 转为 `paused`，reason 为 `session_restored`；Goal 在 host restore 后绝不会静默继续。complete 与 cancel 是 terminal，但之后显式的新 `/goal` create 可替换 terminal Goal。

公开 state transition 为：

- `create` → `active`；`modify` 与有效 `resume` → `active`。
- `pause` 把 `active` 或 `retry_wait` 变为 `paused`；重复 pause 是成功的 no-change。
- active 时重复 resume 是成功的 no-change；从 paused 或 retry wait resume 会清除 retry/no-progress metadata。
- `complete` 只把 `active` 变为 `completed`；`cancel` 把任意 nonterminal state 变为 `cancelled`。
- provider error 会把 pursuing Goal 变为 `retry_wait`。冻结 backoff 为 10 秒、30 秒、1 分钟、5 分钟、15 分钟，之后每次 1 小时；后续成功 run 会清除 retry metadata。
- user abort 会以 `user_abort` pause；OMPS 自己的 checkpoint abort 不会。连续三次 automatic continuation run 没有 tool call、package lifecycle change 或 external user input 时，会以 `no_progress` pause。

Goal continuation 是 package 中最低优先级的 scheduler。它会等待 Pi idle 且没有 pending message、checkpoint、tree/compaction notification pause、active subagent、pending subagent notification、running Monitor、未 acknowledgement 的 terminal Monitor notification 或 waiting Ask。deferred work 还绑定当前 session、branch leaf、Goal snapshot 与 external-input generation。continuation 本身是一条 visible custom message，使用 `deliverAs: "steer"` 与 `triggerTurn: true`；acknowledgement 防止重复交付。

冻结 activation 与 continuation prompt 始终重述 abstract、objective 与编号 criteria，之后使用以下规则：

```text
Pursue this Goal now.                         # 仅 activation
Do not ask the user questions while this Goal is active.
Continue until every criterion has concrete evidence.  # activation
Continue making concrete progress toward every criterion.  # continuation
Use Todo, Monitor, and Subagents when useful.
If safe progress is blocked, call `goal pause` with a concrete reason.
Call `goal complete` only with one evidence entry for every criterion.
```

active Goal 的每次 run 前，package 会增加一条独立 invisible phase message，其中包含 `You are pursuing the active Goal: <abstract>` 与 concrete-progress reminder。即使 OMPS orchestration inactive，该 Goal phase reminder 也可出现。Goal 不会为该 reminder 动态改写 system prompt，也不注册 `context` mutation hook。旧 file-tool nudge mechanism 已被彻底移除。

Goal active 时创建的每个 subagent 都成为 Goal-owned。main statistics 来自 pursuing state 期间 branch assistant/tool-result/compaction usage。child token/tool/turn/compaction total 来自 private、session-owned、mode-0600 sidecar record；即使 terminal run directory cleanup，aggregate 仍可保留；write 是 best-effort，绝不影响 child lifecycle。ownership 与 statistics 只驱动 Goal widget 和 scheduler bookkeeping，绝不进入 `goal status`。

前台 widget 精确为两行并保持以下顺序。第一行是 `● Goal · <status glyph> <status> · <abstract>`。第二行依次是 elapsed time、continuation count、owned run count、可选 retry countdown 或 pause reason、main token/tool/turn/compaction total，最后是 child total。它每秒刷新 countdown/elapsed，分别用 `↻`、`◷`、`Ⅱ`、`✓`、`×` 表示 active、retry wait、paused、completed 与 cancelled；不存在 Goal 时消失。RPC 与 print session 没有 widget。

Goal call/result、continuation 与 automatic-state notification 都使用 package 自有 expandable renderer。折叠 row 包含 Ctrl+O hint；展开后显示完整 contract、criteria、evidence、retry 字段、reason 与模型可见 continuation content。Ctrl+O 绝不显示 private scheduler key，也不改变 snapshot。已知风险属于 deliberate contract：provider backoff 会在一小时 ceiling 上无限持续，直到成功或显式 pause/cancel；no-progress 是保守 activity heuristic；child statistics 是 observational best-effort 数据；restore 后始终需要显式 resume。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/omps on [preset]` | 启用编排，可指定 preset |
| `/omps off` | 停用编排并恢复原主模型/thinking |
| `/omps status` | 查看激活状态 |
| `/omps presets` | 列出 preset |
| `/preset [name]` | 切换 preset；不带参数时列出 |
| `/loop [request]` | 把原样 request 转发给模型以管理 runtime loop |
| `/goal [request]` | 把原样 request 转发给模型以管理 durable Goal |
| `/omps uninstall` | 清理旧 OMPS backend migration state，并显示 package 删除命令 |

`/reload` 通过一次性进程内槽位恢复 active preset。新建、恢复或 fork 的 parent session 不继承该槽位。

## Presets

唯一运行时 preset 来源是：

```text
~/.pi/agent/oh-my-pi-slim.json
```

`config/oh-my-pi-slim.example.json` 只在用户文件缺失时 seed 一次。已有 preset 不会被覆盖或删除。当前每个 preset 定义 `orchestrator`、`explorer`、`librarian`、`oracle`、`designer`、`fixer`、`observer`，每个角色包含 `provider`、`model` 和 `off, minimal, low, medium, high, xhigh, max` 之一的 thinking。

为兼容旧配置，preset 缺少 `observer` 时会临时复制同一 preset 的 `explorer` 配置并发出 warning。即使该 fallback model 不支持 image，preset 仍可激活，但真正创建 Observer run 时会拒绝；显式配置为非 image model 的 Observer 会在 preset 激活时直接失败。

顶层 `deny` 独立为每个 specialist 配置精确、区分大小写的工具名：

```json
{
  "deny": {
    "explorer": ["example_extension_tool"],
    "observer": ["example_extension_tool"]
  }
}
```

该对象可只包含六个 specialist 的任意子集；缺失角色表示 `[]`。未知或未安装的工具名是合法的并会被静默忽略，以便配置可移植。未知角色、重复名称、空名称、包含逗号的名称，以及生命周期保留名称 `subagent` 与 `contact_supervisor` 都会被拒绝；旧的未知名称 `subagent_supervisor` 会像其他可移植 deny 条目一样被接受。

激活会验证全部模型与认证，并把主会话切到 orchestrator 配置。`create` 时 OMPS 注入 specialist 的 `provider/model:thinking`；模型可见 schema 不暴露 model、thinking、context 或工具策略 override。

## 运行时合同

### Create runs

```js
subagent({ action: "create", agent: "explorer", abstract: "梳理认证流程", task: "定位认证流程和相关测试。" })
subagent({ action: "create", agent: "observer", abstract: "分析截图", task: "分析 /absolute/path/to/screenshot.png。" })
```

create 输入严格为 `{ action: "create", agent, abstract, task, cwd? }`；`abstract` 必填、会 trim，并随 run 持久化；`action` 必填，省略 action 的启动会被拒绝。每次 create 都会先写 launch config，再启动 detached background runner，并立即返回 run ID。没有 wait tool，parent runtime 也不持有进程内 child client；只有 runner 持有 Pi RPC child，parent 与 runner 完全通过文件交换生命周期数据。

child 启动使用完整 Pi invocation：

- preset 选择的 `--model` 与 `--mode rpc`；
- parent Pi session 目录下的持久化 `--session-dir`；
- package specialist body 作为 `--system-prompt`；
- 仅当当前角色 deny 非空时添加 `--exclude-tools <逗号分隔的精确名称>`；
- 只在 child 加载、注册 `contact_supervisor` 的 `--extension`；
- trusted 且 cwd 位于 parent project 内时使用 `--approve`，否则使用 `--no-approve`；
- `PI_SUBAGENT_CHILD=1`、`OMPS_SUBAGENT_CHILD=1` 与 run ID，使主 OMPS extension 在 child 中完全不注册。

child 在 `session_start` 时会激活 Pi 配置 registry 中经过 deny 后剩余的全部工具：所有 built-in tools，以及该 child session 发现的受信任 extension tools，包括全局和受信任的项目级 extension。启动时 deny 会先于该激活生效，因此被 deny 的工具仍不会进入 active registry、provider schema 与 Pi 生成的工具 prompt metadata。OMPS 不尝试 sandbox 未知的未来 extension 能力；已安装及项目级 extension 都属于用户的信任边界。

`subagent` 只在主会话注册，因为主 extension 在 child 中会提前返回；`contact_supervisor` 只在 child 中显式加载。这两个生命周期工具都不能通过 deny 配置。每次 create 与 resume 前都会重新读取 deny；已经 active 的 child 保留其启动时策略。

### List、status、通知与控制

```js
subagent({ action: "list" })
subagent({ action: "steer", id: "run-id", message: "只检查 parser 测试。" })
subagent({ action: "interrupt", id: "run-id" })
subagent({ action: "reply", id: "waiting-run-id", message: "采用方案 A。" })
```

completed、waiting、failed 与 interrupted 都只入队一条 custom message，并设置 `display: true`、`deliverAs: "steer"` 与 `triggerTurn: true`。Pi 会在当前 assistant/tool batch 之后的下一个安全模型边界交付同一条消息；它同时显示在 TUI 并进入 model context，orchestrator 不需要主动 yield 或等待 idle。消息 content 包含完整 request、output 或 error，delivery metadata 保存在不会进入 model context 的 `details` 中；不会创建第二条 TUI entry 或模型消息。`list` 只返回 active status：仅包含 starting、running、waiting run 的 run ID、agent、abstract、status、liveness、可选 source run ID 与 waiting reason。它绝不返回 task、完整 request、cwd、model/deniedTools、时间戳、session file、activity、output、error 或 terminal 历史。waiting lifecycle notification 已直接携带完整且无独立 ID 的 request，不存在 pending 查询。依赖结果的后续进度由 lifecycle notification 恢复，而不是重复调用 `list`。

manual、threshold 或 overflow compaction 期间，主会话 lifecycle notification 会像 Pi 文本框中已经 queued 的输入一样暂停。`session_compact` 或 compaction abort 后的解除通过 `setImmediate` 延迟，让 Pi 先发布 `compaction_end`，也让 interactive host 有机会先启动 queued user turn。未改变的 steer notification 随后进入该 active turn；如果没有 user turn，未改变的 `triggerTurn: true` 会自行启动一个 turn。OMPS checkpoint compaction 会继续保持 gate，直到固定 continuation turn 启动后，再以同样方式延迟解除。notification 仍保持 pending，直到原有 delivered-message acknowledgement 完成。

`steer`、`interrupt` 与 `subagent reply` 都会向 run 的 `control/` 目录原子写入带 token 的控制文件，并立即返回而不等待。`steer` 是 best-effort。`interrupt` 发出 interruption request，最终通知报告实际 terminal status。runner 会应用可接受的控制并发布真实状态。写 terminal state 之前，runner 会先收集最终元数据、停止 timer/watcher，并完整停止 RPC child，因此保存的 `sessionFile` 可安全 resume。

### 最小 supervisor

child 可通过 `contact_supervisor` 提交 `need_decision`、`interview_request` 或 `progress_update`。每次调用都会让 child 进入 `waiting`，progress update 也一样，因此主 orchestrator 必须 reply 才会继续。terminating tool result 的 `details` 携带 request；后台 run 会向主会话发送可见通知。

使用 waiting request 携带的同一 run ID 调用 `subagent({ action: "reply", id: "waiting-run-id", message: "采用方案 A。" })`。reply 会向仍存活的 detached runner 写 control message，并乐观地把 journal 状态恢复为 `running`；runner 下一次 state 会确认该状态。之后再次 waiting 或进入 terminal 状态时，会在下一个安全模型边界通过另一条单一 lifecycle custom message 到达 orchestrator。

### Resume

```js
subagent({ action: "resume", id: "source-run-id", abstract: "应用后续修改", message: "应用后续修改。" })
```

resume 精确要求 terminal source run 的 `id`、新的 `abstract` 与 continuation `message`；abstract 与 create 合同相同，trim 后必须非空。resume 只允许拥有已保存 child session file 的 terminal retained run。它以 `--session <saved sessionFile>` 启动新的 detached background run，保留 source agent、model/thinking contract、cwd 与 child-session context，创建带 `sourceRunId` 的新 run ID，持久化调用方提供的新 abstract 而不是继承 source abstract，并立即返回。它不会继承 source run 的 denied-tool snapshot，而会为该 specialist 重新读取当前顶层 deny。source run 启动时的 model/thinking 字符串仍是快照，不会从后来编辑的 preset 重新读取。resume 不暴露 launch override，也拒绝复用正被 active run 使用的 session file。

## 持久化、run files 与 shutdown

OMPS 兼容读取 `customType: "oh-my-pi-slim:subagents"`、`version: 1` 的旧全量 registry snapshot，再按当前 branch 顺序 fold 后续 `version: 2` 单 run upsert：相同 ID 以后者覆盖，坏 entry 跳过。每次新的逻辑状态写入只追加一个完整 run 的 v2 entry；heartbeat 与 UI activity 只保存在 `state.json`，不会膨胀 journal。

每个 run 按 owner session 隔离在 `<parent-session-dir>/omps-subagent-runs/<ownerSessionId>/<runId>/`，其中包括 mode-0600 的 `launch.json`、`runner.json`、`state.json`，mode-0700 的 `control/` inbox，以及 `runner.log`。`runner.json` 将 run token 与 PID 绑定到可验证的 OS process identity。parent 以短周期 poll 这些文件，并在 signal 持久化 PID 前验证 owner/run/token/process identity，再通过通知驱动 orchestration，不做阻塞等待。

持久化元数据包括 run ID、role、abstract、task、cwd、model contract、启动时 `deniedTools`、时间戳、状态、最终输出/error、source run ID、supervisor request 与 child `sessionFile`。旧 journal 或 `launch.json` 若有 task 但缺 abstract，会统一使用确定性 fallback：task 的前 100 个 Unicode code point 加 `...`；若 abstract 字段存在，则 trim 后必须非空。旧 v1 中已存在的 launch-mode 字段会被忽略，不再保留。

Detached execution 只持续到当前 owner session 结束。所有 `session_shutdown`（包括 reload、new/resume/fork session 切换与 quit）都会向当前 owner 的 active run 写 interrupt control，短暂有界等待，强制终止超时进程，并把 `interrupted` 写入 journal，同时保留 `sessionFile`。restore 从不接管旧 live runner：异常遗留进程会先被终止并标记 `interrupted`；已是 terminal 的 state 保持 terminal。之后可用 `resume` 继续，但一定创建新的 run ID。

## 后台 agent UI

TUI 会在 editor 上方显示一个适配自 `gotgenes/pi-packages` 中 `packages/pi-subagents` 的 widget。它保留原 UI 的 tree layout、80 ms spinner、最多 12 行、active 优先 overflow、status bar 与 finished 短暂 linger。每个 active run 是不可拆分的三行 tree entry：第一行显示 spinner 或 waiting 标记、agent、run ID、waiting 状态与 abstract；dim 的第二行以 `(provider) model • thinking` 开头，随后显示 turn、tool use、token/context/compaction 与 elapsed；第三行显示当前 activity，或以 warning 色显示 supervisor request。compaction count 仅用于观察，并且只由成功的 Pi `compaction_end` RPC event 增加；runner 绝不会用 widget usage 或 compaction counter 触发 checkpoint。abstract 只占第一行并随该行截断，不再挤掉优先可见的 model/stats 行。12 行预算绝不显示半个 active entry，因此最多完整显示 3 个 active run，overflow 会准确汇总；`starting` 仍是一行 queued summary，terminal run 仍短暂显示一行 outcome。RPC mode 绝不注册 widget。

TUI transcript 还为 `subagent` 的 call/result 提供 package 自有 renderer。折叠的 call 保留 styled title、action 与识别字段，同时隐藏较长的 task、continuation、guidance 与 reply 正文。create 保留 agent 和 abstract；resume 保留 source run 和 abstract；steer、interrupt 与 reply 保留 run ID。按 Ctrl+O 后显示完整 action-specific input，包括 cwd 与全部正文。非 terminal immediate result 在两种视图中都保持紧凑单行确认。折叠的 terminal result 只显示紧凑确认；展开后才附加完整最终 output/error。折叠的 active-run list 显示标题、数量及含 abstract 的紧凑 status header；展开后额外显示 waiting reason，两种视图都不显示 task、activity、output、error、message 或 interview。result fallback 折叠为安全首行，展开为完整文本。回放早于 abstract 字段的旧 transcript row 时，renderer 会从 legacy task 使用同一个 100-code-point fallback；若两者都没有，则显示明确的 summary unavailable placeholder，并且不会把完整 task 作为独立字段渲染。每条 lifecycle notification 就是用于模型交付的同一条 custom message，不会再创建第二条 TUI-only entry。折叠的 TUI 视图只显示紧凑 run header；Ctrl+O 可展开 waiting request、terminal output/error 或 active live activity。terminal 通知绝不重复过期的 live response。Ctrl+O 只改变 TUI 渲染，不改变 tool 或 custom-message content/details，也不会把 `details` 复制进 model context。

## 有意限制的范围

内置 runtime 每个 run 只管理一个 child，仅提供本文记录的极小公开面。不包含脚本 workflow、schedule、mission、fleet、watchdog、agent/profile authoring、worktree 管理、聚合 chain/parallel 输入或 nested child orchestration。并发由主会话发起多个独立后台 `subagent` 调用实现。

deny/`--exclude-tools` 只减少 Pi 模型可见工具，并不是 OS sandbox。尤其是 `bash` 的真实能力仍取决于当前用户和运行环境。

## Tool-batch checkpoint compaction

主会话与每个 detached child 共享同一套 completed-tool-batch validator、固定 continuation text 与 threshold 边界。每个进程都读取 Pi 当前 `ctx.getContextUsage()` 的 effective context window，加上 trusted project 合并后的 `SettingsManager` compaction settings，再调用 `shouldCompact`；OMPS 不读取 runner totals 来触发 checkpoint，不猜 provider window，也不写死 window 大小。该机制尊重 Pi compaction 的 `enabled` 开关；关闭时 main 与 child 都不会主动 checkpoint。

OMPS active 时，主会话保持原有行为：完整 assistant tool batch 在没有 queued message 的情况下越过阈值后，调用 public `ctx.abort()`，等待匹配的 threshold compaction 与 `agent_settled`，再把固定 prompt 安排为 follow-up continuation turn。detached child 则在匹配的 `session_compact` event（`reason: "threshold"`、`willRetry: false`）内部同步排队同一条 follow-up，让 Pi 自身的 post-run queued-message continuation 延迟 child 唯一的 `agent_settled`；不引入 runner marker 或 terminal protocol。这个过程可经历多个 compaction cycle。任何调用过 `contact_supervisor` 的 turn 都会完整跳过，保留 waiting 边界，之后无关的 compaction 也不能 resume。reason/retry 不匹配的 compaction，以及 abort 后未发生匹配 compaction 就 settled 的 run，都只 warning，不 resume。model-visible prompt 不包含 tool call ID 或名称，OMPS 也不改写 context 副本或 compaction settings。

## Bootstrap 与卸载

bootstrap 现在只 seed 用户 preset，不再维护 `settings.subagents.disableBuiltins` 或 `extensions/subagent/config.json`。启动时会对旧 OMPS release 遗留的 migration state 做一次性安全清理：只有当前值仍等于 OMPS 当时写入值时，才恢复旧值。

卸载：

```text
/omps uninstall
```

然后退出 Pi：

```bash
pi remove git:github.com/YanzuoLu/oh-my-pi-slim
```

用户 preset 保留。

## 开发

```bash
npm test
npm run validate
git diff --check
```

测试覆盖 detached launch config、runner survival、control files、journal reconcile、shutdown interruption、resume、grace window、terminal ordering、notification wakeup 与精确 activity UI 格式。静态验证禁止 runtime 中出现进程内 client，并要求 detached runner、launch、poller 与 control protocol。自动化测试不要求真实认证模型调用。

## License

MIT
