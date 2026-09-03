# oh-my-pi-slim

> 精简的 Pi 工具包，内置后台 subagent、session Todo、进程 Monitor、结构化提问与 durable Goal。

[English](./README.md) | **中文**

## 核心特性

- 将任务交给彼此隔离的后台 subagent。
- 用支持依赖关系的 Todo 管理 session 工作。
- 用 Monitor 在后台运行长时间执行的 Bash 命令。
- 需要用户决策时发起结构化提问。
- 以明确 criteria 和 evidence 推进 branch-local durable Goal。
- 用 `/fast` 为匹配的 OpenAI request 切换 priority service。
- main session 在 Pi system prompt 后追加精简的主控指令，child session 保持使用 Pi 原生 system prompt。
- 每个 child launch 时继承 main session 当前的 model 与 thinking level。

child session 专注执行，使用 Pi 原生 system prompt，并可暂停工作联系 main session。

## 要求与包管理

### 要求

- 与 Pi 0.84.4 package 和 RPC API 兼容的 Pi 版本。Pi 0.84.4 是兼容性边界，因为 OMPS 依赖其原生的 tool result 后阈值压缩能力。
- Monitor 需要受支持的 POSIX 系统；Windows 不提供 Monitor。

Pi package 以当前用户权限运行。安装第三方 extension 前请审查源码，并把它视为受信任代码。

### 安装

```bash
pi install git:github.com/YanzuoLu/oh-my-pi-slim
```

### 从外部 Ask 与 Process package 迁移

内置 Ask 与 `npm:@juicesharp/rpiv-ask-user-question` 冲突；Monitor 则替代 `npm:@aliou/pi-processes`。加载本 package 前先移除它们：

```bash
pi remove npm:@juicesharp/rpiv-ask-user-question
pi remove npm:@aliou/pi-processes
```

本 package 不会自动卸载外部 package，也不会执行 `pi remove`。

### 更新

```bash
pi update --extension git:github.com/YanzuoLu/oh-my-pi-slim
```

### 移除

退出 Pi 后执行：

```bash
pi remove git:github.com/YanzuoLu/oh-my-pi-slim
```

## 工具可用性

本 package 有意保持很小的工具面：

| 环境 | Package 工具 |
| --- | --- |
| Main | 精确为 `subagent`、`todo`、`monitor`、`ask_user_question`、`goal` |
| Child | 精确为 `contact_supervisor` |

`ask_user_question`、`goal`、`monitor`、`subagent` 和 `todo` 仅 main 可用；`contact_supervisor` 仅 child 可用。RPC session 可使用对应工具，但不注册 package widget；JSON 与 print mode 无法使用 Ask。

`goal`、`monitor`、`subagent`、`contact_supervisor` 与 `todo` 的每个成功结果都会在 `content` 中放入一个紧凑单行 JSON 值。`ask_user_question` 的 complete、partial 与 empty-submit 结果使用同一契约。用户取消 Ask 时是唯一例外，此时 `content` 为自然语言 `The user declined to answer.`，`details` 保留 answer 为空的 `AskResult`，终止当前 agent run，并跳过 agent settle 前的全部非 retry threshold compaction，然后让 Pi 进入 idle。对于 JSON 结果，该 JSON 是面向模型的正文。`details` 仍是完整的 UI 与内部契约，正常 transcript 渲染会优先读取 `details`，仅在无法使用时才回退到 `content`。错误与主动 custom notification 仍使用自然语言，其中包括 Goal continuation、Monitor notification，以及 Subagent waiting 或 terminal notification。

## Main 工具

以下四个 lifecycle 工具都没有 `confirmed` 或 `force` 字段。删除动作被受保护工作拒绝时，main model 会先按需检查 status 并询问用户。获得同意后，它会按场景执行 `pause`、`stop`、`interrupt`、Todo `modify` 或 Goal `cancel`，再重试原动作。

### `subagent`

在隔离的后台 child session 中运行任务，并立即把控制权交还 main。

| Action | 作用 |
| --- | --- |
| `create` | 用简短 abstract、message、可选 cwd 与可选 `fork` 创建新 run |
| `list` | 按 retained-run 顺序返回全部 retained run 的精简公开状态 |
| `check` | 返回单个 retained run 的公开状态，并在 terminal 时返回已有结果 |
| `steer` | 向 running run 发送补充指导 |
| `interrupt` | 停止未结束的 run，但不回滚文件修改，并返回其最终结果 |
| `reply` | 回复 waiting child，并继续同一个 run |
| `resume` | 从 terminal run 保存的 child session 创建新 run，并生成新 ID。可选覆盖 cwd，省略时继承 source run 的工作目录 |
| `delete` | 删除一个 retained terminal run |
| `clear` | 所有 run 都 terminal 时删除全部 retained history |

`list` 包含 `starting`、`running`、`waiting`、`completed`、`failed` 与 `interrupted` run，但绝不包含 terminal `output` 或 `error`。使用单个 retained run ID 调用 `check`，可查看相同公开字段，并在结果存在时取回 terminal 结果。subagent widget 使用相同的 retained 集合与排序来计数并管理 lifecycle，但 foreground body 永久隐藏 terminal 行。这些 run 会一直保留到 `delete` 或 `clear` 将其移除，并且始终可通过 Subagent viewer 查看。

每个 starting、active 或 waiting widget entry 占一行。每行显示 `<abstract>[<id>]`，随后显示 turn、tool、token、context、compaction 与 elapsed statistics。foreground widget 不显示 provider、model、thinking level 或实时 activity 文本。12 行 widget 预算按每个可见 run 一行计算。

`fork` 默认为 `true`。forked run 会继承当前 tool-call batch 之前的 conversation context。同一 batch 中的每个 `create` 都从同一个点派生。使用 `fork: false` 时，run 会启动独立 session，并且只接收自己的 `message`。

`interrupt` 是同步的：它会等待目标 run 进入 terminal 状态，并直接返回完整最终结果，包括已保存的 `output` 或 `error`。当显式 `interrupt` 调用取得某个 live run 的结果交接权时，该 terminal event 不会再单独发送，reload 后也不会重放；而由 shutdown、reload、tree navigation 或 session 替换导致的中断，仍然按普通 terminal notification 送达。若 run 在调用前就已是 terminal，它保留自己的 terminal notification，不会收到 interrupt control，并且只返回精简回执。若无法确认 detached runner 已停止，结果会显式说明，并保留该 run 目录。

每次 `create` 或 `resume` launch 都继承 main session 当前的 model 与 thinking level。当 `resume` 跨越 provider 或 model ID 时，被复用的 child session 会在 resumed run 收到第一个 prompt 之前先被 compact 一次。仅 thinking level 变化时，session 会被原样复用。整个 preflight 期间 run 保持 `starting`，已经 compact 过或过小的 session 会直接继续，其他任何 compaction 失败都会让该 run 失败，而不会再发出 prompt。

main session 会在 Pi system prompt 后追加套件内置的主控指令。child session 使用 Pi 原生 system prompt。

`starting`、`running` 或 `waiting` run 不能被 `delete`，存在任何此类 run 时也不能 `clear`。main model 必须先询问是否执行 `interrupt`，等 run 进入 terminal 后再重试。单删或全清都会跨 reload 与 restore 保持结果，且都不改变 Goal statistics。

child 可用 `contact_supervisor` 发送 `need_decision`、`interview_request` 或 `progress_update`。每次请求都会让 child 进入 `waiting`；main 用 `reply` 继续同一个 run。

### `todo`

在 main session 中管理任务、依赖关系和进度。

| Action | 作用 |
| --- | --- |
| `list` | 返回当前完整 Todo list |
| `update` | 应用一批非空 operations |

| Update operation | 作用 |
| --- | --- |
| `append` | 添加唯一 subject、abstract 与可选依赖 |
| `modify` | 重命名，或修改 abstract、status、依赖 |
| `delete` | 删除 exact pending 或 completed subject |
| `clear` | 没有 in_progress item 时删除全部 pending 与 completed item |

subject 区分大小写并使用 exact match。多个 item 可以同时处于 `in_progress`。依赖必须构成无环图。`delete` 会按 batch draft 中目标的当前状态拒绝 `in_progress` item，其他任务仍在 `blockedBy` 中引用目标时也会拒绝。`clear` 检查同一 batch 中较早 operation 形成的 draft，只要其中还有 `in_progress` item 就拒绝。model 会先询问是否用 `modify` 将受保护 item 改为 `pending` 或 `completed`，得到同意后再重试。整个 `update` batch 保持原子性。

### `monitor`

在 POSIX 系统上运行长时间执行的 Bash 命令，同时让 agent 继续其他工作。

| Action | 作用 |
| --- | --- |
| `create` | 用 abstract、command 与可选 cwd 启动命令 |
| `list` | 列出精简的 monitor 状态 |
| `check` | 返回状态、有界的最近 stdout 与 stderr，以及终止诊断 |
| `stop` | 停止一个 running command，并返回最终状态 |
| `clear` | 没有 running monitor 时删除全部 terminal record |

每一行 stdout 都是一个事件。200 ms 内产生的多行可以合并交付。stderr 可通过 `check` 和失败时的 terminal diagnostic 获取。命令退出时会结束 Monitor，并发送一次最终状态通知。需要让每行表示独立事件时，command 可以过滤输出并启用 line buffering。

`stop` 会保留 terminal record 与 retained log。该 tool result 独占 terminal delivery，因此同一次 stop 不会再发送另一条 terminal notification。running monitor 会阻止 `clear`。main model 必须先询问是否停止，并在 stop 完成后重试。terminal record 与输出会一直保留到 `clear`。

### `ask_user_question`

在 main session 打开包含一到四个 question 的结构化问卷。

| Feature | 行为 |
| --- | --- |
| Selection | 支持 single-select 与 multi-select |
| Custom input | 支持 custom response |
| Preview | single-select option 支持 preview |
| Tool batch | 必须是所属 assistant message 中唯一的 tool call |
| Pending message | 仅在 Pi 没有 pending message 时打开 |
| Partial result | submit 会返回已确认的全部 answer，包括 partial 或空集，并让 run 继续 |
| Cancel | 丢弃全部 answer，终止当前 agent run，跳过 settle 前的全部非 retry threshold compaction，并让 Pi 进入 idle |
| Goal guard | Goal active 时不可用 |

只有一个 question 时没有单独的 Submit 步骤：确认一个 option、multi-select 的 `Next` 行或一段 custom response，问卷就当场完成。两个及以上 question 仍保留 `Submit` tab，可以在那里提交 partial 或空集 answer，也可以 cancel。Provider 必须单独调用 `ask_user_question`，使其成为所属 assistant message 中唯一的 tool call，并且 Pi 必须没有 pending message。混合 tool batch 或预存 pending message 会在问卷打开前被拒绝。Pi idle 后仅用 Ask 重试。

Ask 等待问卷输入期间，以及用户取消后到 agent 完全 settle 之前，普通 RPC prompt 会经过 input hook，并被拒绝且显示 `Ask is blocking new RPC prompts. Retry after Pi is idle.`。直接 RPC `steer` 或 `follow_up` message 可以绕过该 hook。发生这种情况时，它们会随 Ask abort 被丢弃，并收到一次性 warning `Queued RPC messages were aborted with Ask. Retry after Pi is idle.`。调用方必须等 Pi idle 后重试。

Submit 与 cancel 含义不同。Submit 会用紧凑 JSON 原样交回你确认过的内容，所以 partial submit 是对部分 question 的真实回答，对其余 question 保持沉默。Empty submit 也是普通结果，允许 provider run 继续。Cancel 表示用户拒绝，也是完全撤回。全部 answer 都会被丢弃，tool result 会记录带 `user_cancelled` 且 answer 为空的 `AskResult`，固定自然语言 `content` 为 `The user declined to answer.`。随后当前 agent run 会终止。Pi 会取消 agent settle 前的每次非 retry threshold compaction，避免这些 summary provider request，然后进入 idle。Manual 与 overflow compaction 不受影响。TUI 问卷与 RPC dialog 的每个 cancel 入口行为都一致。历史 transcript 回放继续使用现有的 `details` 优先渲染行为。

Ask 仅 main 可用，并要求交互式 UI。JSON 与 print mode 不提供该工具。

### `goal`

管理一个 branch-local durable Goal，并用明确 criteria 与 evidence 验收。

| Action | 作用 |
| --- | --- |
| `create` | 创建并激活 Goal |
| `check` | 读取当前 Goal |
| `modify` | 替换 nonterminal Goal 合同并激活 |
| `pause` | 带 reason 暂停 |
| `resume` | 显式重新激活 paused Goal |
| `complete` | 提交与 criteria 对应的 evidence 并完成 |
| `clear` | 从 branch 上移除当前 Goal |

Goal 在当前 branch 上持久化。reload、session resume、fork 与 tree restore 会把未完成 Goal 恢复为 paused，绝不会静默继续。provider failure 会自动重试，重复无进展会暂停 Goal。只有 Goal continuation 此刻可以安全交付时，用户 abort 才会暂停 Goal。任一 continuation gate 被阻塞时，Goal 会保持 active，等待 scheduler 后续重新评估。完成时，每条 criterion 必须精确对应一条非空 evidence。

自主 continuation 会等待阻塞工作消失，包括 active 或 waiting subagent、Monitor 工作与 pending terminal delivery，以及 waiting Ask dialog。你可以随时用 `check`、`pause`、`resume` 或 `clear` 控制推进。

completed Goal 的 detail 行会跟随共享的 Ctrl+O 折叠。tool output 折叠时，widget 只保留 Goal heading；其他状态在折叠与展开下都保留两行。

`goal clear` 会从 branch 上移除当前 Goal。清理后的 branch 不再报告 Goal，并移除该 Goal 的统计，同时保留 retained subagent run。

## `/goal`

`/goal <objective>` 让模型创建或管理当前 branch 上的 durable Goal。裸 `/goal` 会报告当前 Goal 并说明用法。

例如：`/goal finish the parser migration with passing validation`，或 `/goal pause because the required credentials are unavailable`。

该 command 会把自然语言交给模型处理，不是固定参数解析器。

## OpenAI Fast Mode

OpenAI Fast Mode 属于当前 Pi session，新 session 默认是 `off`。裸 `/fast` 不接受参数，并在 `on` 与 `off` 之间切换。最新状态会写入 session history，并跨 branch、reload、进程重启与 session resume 恢复。fork 会继承复制到 target path 的最后状态。

启用后，provider 精确为 `openai` 或 `openai-codex` 的匹配普通 request 会写入 `service_tier: "priority"`。其他 provider 的 request 保持不变。

只有 future child `create` 与 `resume` launch 会继承当前 Fast Mode snapshot。running child 不会热切换。只有选中 OpenAI model 时，OMPS footer 才显示 `OpenAI Fast Mode: on` 或 `OpenAI Fast Mode: off`。

## Cache Mode

Cache Mode 属于当前 Pi session，新 session 默认使用 Short。裸 `/cache` 在 Long 与 Short 之间切换。最近一次 toggle 对全部 branch 生效。reload、进程重启与 session resume 会从 session history 恢复状态。fork 会继承复制到 target path 的最后一条 Cache Mode 状态。使用 `--no-session` 时，状态只在当前进程内保留，进程重启后不会恢复。

只有选中符合条件的 Anthropic OAuth model 时，OMPS footer 才显示 `Anthropic Cache Mode: short` 或 `Anthropic Cache Mode: long`。

Cache Mode 只处理普通 Claude request。provider 必须精确为 `anthropic`，API 必须精确为 `anthropic-messages`，payload model 必须与当前 Pi model 匹配，model 不得明确禁用 long cache retention，并且 Pi 必须报告正在使用 Anthropic OAuth。API key request、compatible endpoint、OpenAI 与 `openai-codex` payload 都保持原样。

Long 只升级已有的合法 `{ type: "ephemeral" }` cache breakpoint，并通过 clone 添加 `ttl: "1h"`。Short 只删除这些 breakpoint 的 `ttl`，恢复隐式的五分钟 retention。处理范围包括已有的 top-level、system block、tool 与 message content marker，也包括 tool result content。变换采用 all-or-nothing。目标 surface 必须包含一到四个 marker，而且每个 marker 必须精确为 `{ type: "ephemeral" }`，或只额外包含值为 `"5m"` 或 `"1h"` 的合法 `ttl`。任一 marker malformed、marker 数为零或超过四个时，整个 payload 都保持原样。OMPS 不会创建 breakpoint，会保留全部无关字段，也不会原地修改 payload。后续 provider shaping 会保留这些字段。

`PI_CACHE_RETENTION` 控制 Pi 的上游 marker policy。OMPS 不会设置它，也不会修改 `process.env`。当 `PI_CACHE_RETENTION=long` 时，Cache Short 会从 Pi 已有 marker 删除 `ttl`，恢复五分钟 retention。当 `PI_CACHE_RETENTION=none` 时，Pi 不提供 marker，因此 Cache Long 不会创建 marker，并会静默无效。provider payload hook 按顺序执行，所以 OMPS hook 之后的 writer 会覆盖前面的结果。

只有 future child `create` 与 `resume` launch 会继承当前 Long 或 Short 的 OMPS 内部 snapshot。launch snapshot 不会重写 `PI_CACHE_RETENTION`，也不会修改运行中 supervisor process 的 `process.env`。running child 不会热切换。每个 child 都会再次执行完整的 Anthropic OAuth gate。在 Pi 当前实现下，compaction 与 branch summary model call 保持不变。OMPS 不主动 prewarm cache，也不复制 context-cache header、OAuth 处理或 transport 行为。更长 retention 可能增加 Anthropic cache write 成本，实际价格取决于当前 model 与账户。

## Runtime、UI 与持久化

- compaction 与 tree operation 期间，package notification 会安全排队，之后正常交付，不丢失用户可见结果。
- transcript tool call、tool result 与 notification 使用 Ctrl+O 切换 collapsed/expanded。展开只改变显示，不改变工具数据或持久化状态。
- Monitor notification 是增量的。每个 Monitor 最多保留一条已经交给 Pi 的 notification，以及一条 pending aggregate。新的 stdout event 会在 Pi 确认前一条 notification 前聚合。`monitor check` 返回有界的最近 stdout 与 stderr。
- 清空 Monitor 会立即丢弃 queued notification。已经交给 Pi 的副本最多仍可能显示一次，但 OMPS 不会重试，晚到确认也会被忽略。
- 前台 TUI 为 retained subagent、Todo、Monitor 与 active Goal 提供紧凑 widget；RPC session 不注册这些 widget。
- Todo、Agents 与 Monitor foreground widget 永久保持紧凑模式，且绝不显示 Ctrl+O expand 提示。Todo 始终隐藏 completed 行。Agents 与 Monitor 始终隐藏 terminal 行。它们的 heading 仍按完整 retained 集合计数。
- Goal widget 仍读取 Pi 共享的 tool-output 展开状态。折叠时，completed Goal 隐藏 detail 行，其他 Goal 状态仍保留两行。
- Subagent、Todo 与 Goal 会按各自 session 或 branch 范围恢复。尤其是成功执行的 subagent `clear` 在 reload 后仍保持清空。
- Monitor 是 runtime service，不是 durable process manager。session transition 会关闭它。
- child process 是隔离的 Pi RPC session。session shutdown 时，active run 会被中断，而不会被后续 session 静默接管；retained terminal session 可用 `resume` 继续，但会创建新 run。

### Subagent viewer

`ctrl+shift+left` 与 `ctrl+shift+right` 打开只读全屏 viewer，查看任意 retained subagent run 的 child transcript。viewer 只展示：没有 reply、steer 或 interrupt，也不会写入 session entry、control 文件或 run 文件。

- 存在被隐藏的 retained terminal run 时，Agents heading 会追加固定的 `ctrl+shift+←/→ viewer` 提示。宽度不足以容纳完整提示时会将其省略。heading 绝不显示 Ctrl+O expand 提示。
- Main 是循环中的第 0 项。`ctrl+shift+right` 从 Main 进入第一个 retained run，逐个前进，最后回到 Main；`ctrl+shift+left` 沿同一个环反向移动。
- 循环范围与 Agents widget 的 retained 集合及总数一致。`starting`、`running`、`waiting`、`completed`、`failed`、`interrupted` 六种状态全部可达，也包括被永久紧凑策略隐藏或超出行预算的 run。viewer 导航按 `createdAt` 从早到晚排列，同一时间按 ID 排序，非法时间稳定放在合法时间之后并按 ID 排序。状态与 `updatedAt` 变化不会移动 run，resume 产生的新 run 则按自己的新创建时间加入后方。`subagent delete` 删除一个 terminal run，`subagent clear` 删除全部 terminal history。最后一个 retained run 消失时自动回到 Main。
- 在 viewer 内，普通 `Left`/`Right` 与 `ctrl+shift+left`/`ctrl+shift+right` 的循环方向一致；`Escape` 或 `q` 回到 Main。
- transcript 从屏幕第一行开始；其余信息全部位于底部，顺序与 Main 自己的底部区域一致：live/waiting 区、`Read-Only` 输入占位栏、run 状态行、导航提示。
- transcript 由 Pi 自己的 transcript 组件渲染，因此 user 消息、assistant Markdown、thinking 块、tool call、tool result、compaction summary 与 branch summary 都保持 Main 的配色、间距与框架。
- `Up`/`Down` 滚动一行，`PageUp`/`PageDown` 翻页，`Home` 跳到顶部，`End` 跳到底部并开启 follow，`f` 切换 follow，`r` 立即重新读取 transcript。
- follow 是"到底感知"的：向上滚动会关闭它；用滚动、翻页或滚轮重新回到最后一行会重新开启。在底部用 `f` 显式关闭后会进入 suppressed 状态：此后新输出、终端 resize，以及在最后一行继续按 `Down`/`PageDown` 或向下滚轮，都不会重新开启 follow，只有再次按 `f`，或用 `End` 显式回到底部才会恢复。若你主动向上滚动离开底部，suppression 即被清除，之后再滚回底部会照常重新开启 follow。
- 鼠标滚轮每格滚动一行 transcript。viewer 打开期间会启用最小滚轮上报，并在每一条退出路径上关闭它，因此离开 viewer 后 Main 的原生 scrollback 与终端选择立即恢复正常。viewer 打开时按住 `Shift` 拖动即可使用终端原生选择（Ghostty、iTerm2 等）。快捷键与滚轮都是普通终端字节序列，SSH 下同样可用。
- `Ctrl+O`（或你为 `app.tools.expand` 绑定的实际键）切换 tool 输出的折叠与展开。Main 与所有 subagent transcript 共用该状态，Goal foreground widget 也会读取它。在 viewer 内切换后回到 Main 即已生效，反之亦然。折叠隐藏 tool result 正文与冗长参数。展开显示完整且有界的内容。底部提示始终显示你的实际按键与当前状态。Todo、Agents 与 Monitor 永久保持紧凑模式。
- viewer 每秒刷新约四次：activity 计数按该频率更新，elapsed 时钟只在其显示值真正变化的那一次刷新时重绘，两者都不会重建 transcript。
- 展示相关设置（thinking 块、输出内边距、Markdown 代码块缩进）直接从全局 settings 文件读取；项目受信任时再叠加项目 settings 文件。viewer 只读取它们，绝不创建、加锁或写入 settings 文件。
- 每个 run 各自保留自己的滚动位置、follow 状态与 suppression。
- 正在查看的 run 被 clear 时，视图交给相邻的 retained run；retained 集合为空时自动回到 Main。新 run 加入循环不会移动当前选择。
- 已结束的 run 是冻结的：transcript 停在它自己的最后一条 entry，elapsed 固定为它真实运行的时长，也不再声称 live。`subagent resume` 会继续写同一个 child session 文件，因此 source run 与每一代 resumed run 即使共用一个磁盘文件，也各自只显示属于自己的轮次。
- 已结束的 run 还会在 transcript 下方显示 `[completed]`、`[failed]` 或 `[interrupted]` 块。失败或中断原因始终可见；与最后一条 assistant 消息重复的最终答案不会重复打印。即使没有可读的 session 文件，retained 结果仍会显示。
- `starting` run 在 child session 文件出现前显示为等待状态，等待期间不会反复重绘。
- transcript 取自 child session 文件中 compaction-aware 的当前分支。非法条目行会被跳过；分支元数据不可用（父链成环或 entry id 重复）时，降级为有界的文件顺序 tail 并在 footer 给出 warning，而不是继续信任它。符号链接、目录以及本 session child session 目录之外的路径一律拒绝；文件尚未创建时显示为 waiting；超大文件降级为有界只读文件顺序 tail 并给出 warning。图片只渲染占位符，绝不渲染原始数据，也绝不执行 child extension 自己的消息 renderer。
- 长 block 保留真实结尾。普通 transcript block（消息正文、thinking、tool result、bash 输出、custom message、summary 以及 outcome 块）在 64K 字符以内完整显示；超过该预算时，在同一预算内同时保留头部与尾部，中间插入 `… N characters omitted …` 标记，因此 child 真正说的最后一句总是可见。只有 tool 调用参数仍使用短的只取头部摘要。整份 transcript 仍受行数预算限制，被裁掉的总是最旧的行。
- viewer 打开期间占据整个屏幕，并自带 `Read-Only` 输入占位栏，退出后原样交还 Main UI。viewer 从不替换 editor，因此你的草稿、光标与 undo 历史都不会被修改。
- 问卷始终优先占屏：`ask_user_question` 会先关闭 viewer 并等待其真正消失，再打开自己的 overlay。
- 关闭只移除 viewer 自己的那一个 overlay，按 handle 而不是按栈位置。位于 viewer 之上的其他 package overlay 不会被误关，viewer 也不会以隐藏全屏层的形式残留并在对方关闭后重新出现。关闭在任何情况下都是立即完成的，且不依赖键盘焦点在哪个组件上。
- 已知限制：宿主已经绘制的终端内联图片是由宿主合成的原始转义序列，因此它仍可能透过 overlay 行显示。viewer 自身渲染的内容不会产生这种情况。
- 快捷键是普通的带修饰方向键，SSH 会原样转发。只要终端本身会上报方向键上的 Ctrl+Shift 组合，它就能工作；丢弃或改绑该组合的终端不会把它交给 Pi，因此这不是对所有终端的保证。package 只注册 `ctrl+shift+left` 与 `ctrl+shift+right`，不提供任何 fallback 快捷键，也不提供 slash command。

## 运行行为

- 并行能力来自多个独立的 `subagent create` 调用。
- Monitor 在独立 process group 中运行前台命令，并保留其 terminal state 直到清空。
- active Goal 期间 Ask 有意不可用，避免自主执行因新的用户问题停住。

## 开发

```bash
npm test
npm run validate
git diff --check
```

## License

MIT
