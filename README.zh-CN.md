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
| `interrupt` | 请求中断未结束的 run，但不回滚文件修改 |
| `steer` | 向 running run 发送补充指导 |
| `resume` | 从 terminal run 保存的 child session 创建新 run，并生成新 ID |
| `reply` | 回复 waiting child，并继续同一个 run |
| `clear` | 删除全部 retained terminal history |

`list` 包含 `starting`、`running`、`waiting`、`completed`、`failed` 与 `interrupted` run，但绝不包含 terminal `output` 或 `error`。使用单个 retained run ID 调用 `status`，可查看相同公开字段，并在结果存在时取回 terminal 结果。subagent widget 使用相同的 retained 集合与排序，因此 terminal run 会一直显示到 `clear`。

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
| `create` | 用 abstract、可选 cwd 与可选 `notifyOn` literal 启动命令 |
| `delete` | 必要时停止进程，再删除 monitor 与 retained record |
| `list` | 列出精简的 monitor 状态 |
| `status` | 查看当前状态与保留的合并输出 |

`notifyOn` 使用区分大小写的 literal match。命令必须保持前台运行：不要使用 `nohup`、`setsid`、`disown`、尾随 `&` 或其他 detach escape。

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
- 前台 TUI 为 retained subagent、Todo、Loop、Monitor 与 active Goal 提供紧凑 widget；RPC session 不注册这些 widget。
- Subagent、Todo 与 Goal 会按各自 session 或 branch 范围恢复。尤其是成功执行的 subagent `clear` 在 reload 后仍保持清空。
- Loop 与 Monitor 是 runtime service，不是 durable schedule。session transition 会关闭它们；Loop 按上文列出的规则清空。
- child process 是隔离的 Pi RPC session。session shutdown 时，active run 会被中断，而不会被后续 session 静默接管；retained terminal session 可用 `resume` 继续，但会创建新 run。

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
