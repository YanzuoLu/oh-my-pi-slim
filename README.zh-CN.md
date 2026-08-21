# oh-my-pi-slim

> 面向 Pi 的 preset 驱动编排包：内置后台 specialist、session Todo、runtime Loop、进程 Monitor、结构化提问与 durable Goal。

[English](./README.md) | **中文**

使用已配置的 orchestrator preset 启动 Pi：

```bash
pi --omps
```

## 核心特性

- 将任务交给六个职责明确、彼此隔离的后台 specialist。
- 用支持依赖关系的 Todo 管理 session 工作。
- 通过 `/loop` 按 fixed-delay 周期触发提示。
- 用 Monitor 监督长时间运行的前台 Bash 命令。
- 需要用户决策时发起结构化提问。
- 以明确 criteria 和 evidence 推进 branch-local durable Goal。
- 通过 preset 为每个角色分别配置 provider、model 与 thinking。

main session 负责规划、委派和验收；child session 专注执行，并可暂停工作联系主 orchestrator。

## 六个 specialist

| Specialist | 适合场景 |
| --- | --- |
| `explorer` | 定位相关代码、测试与执行路径 |
| `librarian` | 官方文档、API 与公开源码示例 |
| `oracle` | 架构、调试策略、风险、简化与审查 |
| `designer` | UI/UX 实现、视觉审查与打磨 |
| `fixer` | 边界明确的实现与指定验证 |
| `observer` | 图片、截图、PDF 与图表分析 |

`orchestrator` 是 main session 角色。每个 preset 都会配置它和全部六个 specialist。

## 要求与包管理

### 要求

- 与 Pi 0.84.2 package 和 RPC API 兼容的 Pi 版本。
- 所选 preset 使用的每个 provider/model 都已配置认证。
- 显式配置的 `observer` model 支持 image input。
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

同时从用户 specialist deny list 中移除 `ask_user_question`。本 package 不会自动卸载外部 package、执行 `pi remove`、编辑 package settings 或重写 deny list。

### 更新

```bash
pi update --extension git:github.com/YanzuoLu/oh-my-pi-slim
```

### 移除

先在 Pi 中运行 `/omps uninstall`，退出 Pi 后再执行：

```bash
pi remove git:github.com/YanzuoLu/oh-my-pi-slim
```

用户 preset 文件会保留。

## 工具可用性

本 package 有意保持很小的工具面：

| 环境 | Package 工具 |
| --- | --- |
| Main | 精确为 `subagent`、`todo`、`loop`、`monitor`、`ask_user_question`、`goal` |
| Child | 精确为 `contact_supervisor` 与 `todo` |

`ask_user_question`、`goal`、`loop`、`monitor` 和 `subagent` 仅 main 可用；Todo 在 main 与 child 都可用；`contact_supervisor` 仅 child 可用。RPC session 可使用对应工具，但不注册 package widget；JSON 与 print mode 无法使用 Ask。

## Main 工具

### `subagent`

在隔离的后台 child session 中运行 specialist，并立即把控制权交还 main。

| Action | 作用 |
| --- | --- |
| `create` | 用 agent、简短 abstract、task 和可选 cwd 创建新 run |
| `list` | 按 retained-run 顺序返回全部 retained run 的精简公开状态 |
| `status` | 返回单个 retained run 的公开状态，并在 terminal 时返回已有结果 |
| `interrupt` | 停止未结束的 run，但不回滚文件修改，并返回其最终结果 |
| `steer` | 向 running run 发送补充指导 |
| `resume` | 从 terminal run 保存的 child session 创建新 run，并生成新 ID。可选覆盖 cwd，省略时继承 source run 的工作目录 |
| `reply` | 回复 waiting child，并继续同一个 run |
| `clear` | 删除全部 retained terminal history |

`list` 包含 `starting`、`running`、`waiting`、`completed`、`failed` 与 `interrupted` run，但绝不包含 terminal `output` 或 `error`。使用单个 retained run ID 调用 `status`，可查看相同公开字段，并在结果存在时取回 terminal 结果。subagent widget 使用相同的 retained 集合与排序，因此 terminal run 会一直显示到 `clear`。

`interrupt` 是同步的：它会等待目标 run 进入 terminal 状态，并直接返回完整最终结果，包括已保存的 `output` 或 `error`。当显式 `interrupt` 调用取得某个 live run 的结果交接权时，该 terminal event 不会再单独发送，reload 后也不会重放；而由 shutdown、reload、tree navigation 或 session 替换导致的中断，仍然按普通 terminal notification 送达。若 run 在调用前就已是 terminal，它保留自己的 terminal notification，不会收到 interrupt control，并且只返回精简回执。若无法确认 detached runner 已停止，结果会显式说明，并保留该 run 目录。

只要存在 `starting`、`running` 或 `waiting` run，`clear` 就会被拒绝。全部 retained run 都进入 terminal 后才可清理完整历史；清理结果在 reload 和 restore 后仍保持为空。清理 Subagent history 不会改变 Goal statistics。

child 可用 `contact_supervisor` 发送 `need_decision`、`interview_request` 或 `progress_update`。每次请求都会让 child 进入 `waiting`；main 用 `reply` 继续同一个 run。

### `todo`

在 main 与 child session 中管理任务、依赖关系和进度。

| Action | 作用 |
| --- | --- |
| `list` | 返回当前完整 Todo list |
| `update` | 应用一批非空 operations |

| Update operation | 作用 |
| --- | --- |
| `append` | 添加唯一 subject、abstract 与可选依赖 |
| `modify` | 重命名，或修改 abstract、status、依赖 |
| `delete` | 按 exact subject 删除任务 |
| `clear` | 在 batch 内清空空任务集或已完成任务集 |

subject 区分大小写并使用 exact match。多个 item 可以同时处于 `in_progress`。依赖必须构成无环图。如果其他任务仍在 `blockedBy` 中引用目标，`delete` 会被拒绝。`clear` 要求当前组为空或全部 completed。`update` batch 是原子的：任一 operation 或最终依赖图非法，都不会提交任何修改。

### `loop`

通过 runtime-only fixed-delay timer 周期执行自包含 prompt。

| Action | 作用 |
| --- | --- |
| `create` | 用 interval、abstract 与 prompt 创建 loop |
| `delete` | 删除 loop |
| `modify` | 修改 interval、abstract 或 prompt |
| `list` | 列出 loop 及其当前状态 |
| `pause` | 暂停 loop |
| `resume` | 恢复后等待一个完整 interval |

interval 闭区间为 `10s` 到 `7d`。创建和恢复后都会先等待一个完整 interval。此后每次 tick 完成才开始下一段 delay，因此慢任务不会形成重叠调度。

Loop 会跨 compaction 与 tree navigation 保留，但 reload、new session、session resume、fork 或 quit 都会清空全部 loop。

### `monitor`

在 POSIX 系统上运行并观察长时间执行的前台 Bash 命令。

| Action | 作用 |
| --- | --- |
| `create` | 用 abstract、必填 `checkAfter` 静默阈值、可选 cwd 与可选 `notifyOn` literal 启动命令 |
| `delete` | 必要时停止进程，再删除 monitor 与 retained record |
| `list` | 列出精简的 monitor 状态 |
| `status` | 查看当前状态与保留的合并输出 |

`notifyOn` 使用区分大小写的 literal match。命令必须保持前台运行：不要使用 `nohup`、`setsid`、`disown`、尾随 `&` 或其他 detach escape。

`checkAfter` 在 `create` 时必填，闭区间从 `10s` 到 `7d`，格式为一个正整数加 `s`、`m`、`h` 或 `d`。静默时长从 `create` 成功开始计时，并在最近一次原始 stdout/stderr chunk 处重新起算，因此半行输出与没有换行的输出同样算作活动。运行中的命令只要静默达到该阈值，就会收到一条 silence reminder，要求你用该 ID 调用 `monitor status`。每个 monitor 同时最多只排队一条 reminder：后续 interval 只会就地更新同一条 reminder 的累计静默时长，不会堆积。`status` 会返回 canonical 的 `checkAfter` 与 `lastOutputAt`，在命令产生第一段输出前 `lastOutputAt` 为 `null`。

matcher 与 terminal notification 共用同一种形式，每条都说明 monitor 当前状态。matcher notification 只携带命中 `notifyOn` literal 的新增行，同一行即使命中多个 literal 也只出现一次，而已交付位置仍会越过全部普通行，因此未命中的输出不会在之后被重放。terminal notification 始终报告最终状态、exit code、signal 与 error。completed 的命令只追加此前没有交付过的命中行，因此一次只有普通输出的正常退出不携带任何行。failed 或 killed 的命令还会追加最近二十条新增行作为有界诊断尾部，并按 seq 与尚未交付的命中行合并去重。所有 payload 都遵守同一套字节上限，`omitted` 会说明被留下的部分。要看一个 record 的完整 retained state 与合并输出，`status` 是唯一入口。

terminal record 与相关输出会一直保留到 `delete`。先用 `status` 检查结果，不再需要时再 `delete`。

### `ask_user_question`

在 main session 打开包含一到四个 question 的结构化问卷。

| Feature | 行为 |
| --- | --- |
| Selection | 支持 single-select 与 multi-select |
| Custom input | 支持 custom response |
| Preview | single-select option 支持 preview |
| Partial result | partial 或 cancelled answer 也会作为结构化结果返回 |
| Goal guard | Goal active 时不可用 |

Ask 仅 main 可用，并要求交互式 UI；JSON 与 print mode 不提供该工具。

### `goal`

管理一个 branch-local durable Goal，并用明确 criteria 与 evidence 验收。

| Action | 作用 |
| --- | --- |
| `create` | 创建并激活 Goal |
| `modify` | 替换 nonterminal Goal 合同并激活 |
| `status` | 读取当前 Goal |
| `pause` | 带 reason 暂停 |
| `resume` | 显式重新激活 paused Goal |
| `complete` | 提交与 criteria 对应的 evidence 并完成 |
| `cancel` | 带 reason 取消 |

Goal 在当前 branch 上持久化。reload、session resume、fork 与 tree restore 会把未完成 Goal 恢复为 paused，绝不会静默继续。provider failure 会自动重试，重复无进展会暂停 Goal，用户 abort 也会暂停而不是取消。完成时，每条 criterion 必须精确对应一条非空 evidence。

自主 continuation 会等待阻塞工作消失，包括 active 或 waiting subagent、Monitor 工作与 pending terminal delivery，以及 waiting Ask dialog。你可以随时用 `status`、`pause`、`resume` 或 `cancel` 控制推进。

## `/loop` 与 `/goal`

`/loop <interval> <prompt>` 让模型创建或管理 runtime loop。裸 `/loop` 会列出当前 loop 并说明用法。

例如：`/loop 30m review the latest test failures`，或 `/loop pause the dependency audit loop`。

`/goal <objective>` 让模型创建或管理当前 branch 上的 durable Goal。裸 `/goal` 会报告当前 Goal 并说明用法。

例如：`/goal finish the parser migration with passing validation`，或 `/goal pause because the required credentials are unavailable`。

这两个 command 都把自然语言交给模型处理，不是固定参数解析器。

## Preset 与配置

运行时 preset 文件位于 `~/.pi/agent/oh-my-pi-slim.json`。首次使用时，package 会从 `config/oh-my-pi-slim.example.json` 生成它；已有 preset 不会被覆盖或删除。

基本结构如下：

- `defaultPreset`：默认选择的 preset。
- `presets.<name>`：`orchestrator` 与六个 specialist 的配置。
- 每个角色包含 `provider`、`model` 与 `thinking`。
- `deny.<specialist>`：为对应 specialist 排除的 exact tool name。

每个角色都可独立配置 provider、model 与 thinking。激活 preset 时会检查认证和 model 可用性；`observer` model 必须支持 image input。

| Command | 作用 |
| --- | --- |
| `/omps on [preset]` | 启用编排，可选指定 preset |
| `/omps off` | 停用编排并恢复原 main model/thinking |
| `/omps status` | 查看激活状态 |
| `/omps presets` | 列出 preset |
| `/preset [name]` | 切换 preset；省略名称时列出 preset |

## Runtime、UI 与持久化

- compaction 与 tree operation 期间，package notification 会安全排队，之后正常交付，不丢失用户可见结果。
- package tool row 与 notification 使用 Ctrl+O 切换 collapsed/expanded；展开只改变显示，不改变工具数据或持久化状态。
- Monitor notification 是增量的：每条都标明当前状态并只展示新增输出，因此 `monitor status` 始终是读取完整 retained state 与日志的唯一入口。
- 前台 TUI 为 retained subagent、Todo、Loop、Monitor 与 active Goal 提供紧凑 widget；RPC session 不注册这些 widget。
- subagent、Todo 与 Monitor widget 跟随与 tool row 相同的 Ctrl+O 状态：collapsed 隐藏已结束的行，并在标题末尾追加使用当前配置键位的 dim 提示；expanded 显示完整内容。Loop 与 Goal widget 始终显示完整内容。
- Subagent、Todo 与 Goal 会按各自 session 或 branch 范围恢复。尤其是成功执行的 subagent `clear` 在 reload 后仍保持清空。
- Loop 与 Monitor 是 runtime service，不是 durable schedule。session transition 会关闭它们；Loop 按上文列出的规则清空。
- child process 是隔离的 Pi RPC session。session shutdown 时，active run 会被中断，而不会被后续 session 静默接管；retained terminal session 可用 `resume` 继续，但会创建新 run。

### Subagent viewer

`ctrl+shift+left` 与 `ctrl+shift+right` 打开只读全屏 viewer，查看任意 retained subagent run 的 child transcript。viewer 只展示：没有 reply、steer 或 interrupt，也不会写入 session entry、control 文件或 run 文件。

- Main 是循环中的第 0 项。`ctrl+shift+right` 从 Main 进入第一个 retained run，逐个前进，最后回到 Main；`ctrl+shift+left` 沿同一个环反向移动。
- 循环范围就是 Agents widget 展示的 retained 集合，顺序与总数完全一致：`starting`、`running`、`waiting`、`completed`、`failed`、`interrupted` 六种状态全部可达，包括 widget 折叠或超出行预算时隐藏的那些。状态变化只会重排，正在查看的 run 结束后仍留在屏幕上。只有 `subagent clear` 才会移除 run；全部清空后自动回到 Main。
- 在 viewer 内，普通 `Left`/`Right` 与 `ctrl+shift+left`/`ctrl+shift+right` 的循环方向一致；`Escape` 或 `q` 回到 Main。
- transcript 从屏幕第一行开始；其余信息全部位于底部，顺序与 Main 自己的底部区域一致：live/waiting 区、`Read-Only` 输入占位栏、run 状态行、导航提示。
- transcript 由 Pi 自己的 transcript 组件渲染，因此 user 消息、assistant Markdown、thinking 块、tool call、tool result、compaction summary 与 branch summary 都保持 Main 的配色、间距与框架。
- `Up`/`Down` 滚动一行，`PageUp`/`PageDown` 翻页，`Home` 跳到顶部，`End` 跳到底部并开启 follow，`f` 切换 follow，`r` 立即重新读取 transcript。
- follow 是"到底感知"的：向上滚动会关闭它；用滚动、翻页或滚轮重新回到最后一行会重新开启。在底部用 `f` 显式关闭后会进入 suppressed 状态：此后新输出、终端 resize，以及在最后一行继续按 `Down`/`PageDown` 或向下滚轮，都不会重新开启 follow，只有再次按 `f`，或用 `End` 显式回到底部才会恢复。若你主动向上滚动离开底部，suppression 即被清除，之后再滚回底部会照常重新开启 follow。
- 鼠标滚轮每格滚动一行 transcript。viewer 打开期间会启用最小滚轮上报，并在每一条退出路径上关闭它，因此离开 viewer 后 Main 的原生 scrollback 与终端选择立即恢复正常。viewer 打开时按住 `Shift` 拖动即可使用终端原生选择（Ghostty、iTerm2 等）。快捷键与滚轮都是普通终端字节序列，SSH 下同样可用。
- `Ctrl+O`（或你为 `app.tools.expand` 绑定的实际键）切换 tool 输出的折叠与展开。Pi 中这个状态只有一份：Main、所有 subagent transcript 与 package widget 共用，因此在 viewer 内切换后回到 Main 即已生效，反之亦然。折叠隐藏 tool result 正文与冗长参数，展开显示完整（有界）内容。底部提示始终显示你的实际按键与当前状态。
- viewer 每秒刷新约四次：activity 计数按该频率更新，elapsed 时钟只在其显示值真正变化的那一次刷新时重绘，两者都不会重建 transcript。
- 展示相关设置（thinking 块、输出内边距、Markdown 代码块缩进）直接从全局 settings 文件读取；项目受信任时再叠加项目 settings 文件。viewer 只读取它们，绝不创建、加锁或写入 settings 文件。
- 每个 run 各自保留自己的滚动位置、follow 状态与 suppression。
- 正在查看的 run 被 clear 时，视图交给相邻的 retained run；retained 集合为空时自动回到 Main。新 run 加入循环不会移动当前选择。
- 已结束的 run 是冻结的：transcript 停在它自己的最后一条 entry，elapsed 固定为它真实运行的时长，也不再声称 live。`subagent resume` 会继续写同一个 child session 文件，因此 source run 与每一代 resumed run 即使共用一个磁盘文件，也各自只显示属于自己的轮次。
- 已结束的 run 还会在 transcript 下方显示 `[completed]`、`[failed]` 或 `[interrupted]` 块。失败或中断原因始终可见；与最后一条 assistant 消息重复的最终答案不会重复打印。即使没有可读的 session 文件，retained 结果仍会显示。
- `starting` run 在 child session 文件出现前显示为等待状态，等待期间不会反复重绘。
- transcript 取自 child session 文件中 compaction-aware 的当前分支。非法条目行会被跳过；分支元数据不可用（父链成环或 entry id 重复）时，降级为有界的文件顺序 tail 并在 footer 给出 warning，而不是继续信任它。符号链接、目录以及本 session child session 目录之外的路径一律拒绝；文件尚未创建时显示为 waiting；超大文件降级为有界只读文件顺序 tail 并给出 warning。图片只渲染占位符，绝不渲染原始数据，也绝不执行 child extension 自己的消息 renderer。
- viewer 打开期间占据整个屏幕，并自带 `Read-Only` 输入占位栏，退出后原样交还 Main UI。viewer 从不替换 editor，因此你的草稿、光标与 undo 历史都不会被修改。
- 问卷始终优先占屏：`ask_user_question` 会先关闭 viewer 并等待其真正消失，再打开自己的 overlay。
- 关闭只移除 viewer 自己的那一个 overlay，按 handle 而不是按栈位置。位于 viewer 之上的其他 package overlay 不会被误关，viewer 也不会以隐藏全屏层的形式残留并在对方关闭后重新出现。关闭在任何情况下都是立即完成的，且不依赖键盘焦点在哪个组件上。
- 已知限制：宿主已经绘制的终端内联图片是由宿主合成的原始转义序列，因此它仍可能透过 overlay 行显示。viewer 自身渲染的内容不会产生这种情况。
- 快捷键是普通的带修饰方向键，SSH 会原样转发。只要终端本身会上报方向键上的 Ctrl+Shift 组合，它就能工作；丢弃或改绑该组合的终端不会把它交给 Pi，因此这不是对所有终端的保证。package 只注册 `ctrl+shift+left` 与 `ctrl+shift+right`，不提供任何 fallback 快捷键，也不提供 slash command。

## 有意限制

- 不支持 nested child orchestration：specialist 不能再创建 subagent。
- 不提供 workflow DSL、mission、fleet、agent profile authoring、worktree manager 或聚合 chain/parallel API。
- 并行能力来自多个独立的 `subagent create` 调用。
- specialist deny list 只减少模型可见工具，不是操作系统 sandbox。
- Monitor 只监督前台命令，不是 daemon manager，也不提供 interactive terminal。
- active Goal 期间 Ask 有意不可用，避免自主执行因新的用户问题停住。

## 开发

```bash
npm test
npm run validate
git diff --check
```

## License

MIT
