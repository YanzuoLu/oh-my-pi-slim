# oh-my-pi-slim

> Pi 主会话的 preset 驱动编排层，内置每个 run 一个 child 的后台运行时。

[English](./README.md) | **中文**

主 Pi 会话负责规划、调度、监督与验收。每个 child 都是独立的 Pi RPC 进程，并拥有可持久化的 session。preset 统一选择主 orchestrator 与五个 specialist 的模型和 thinking 档位。

```bash
pi --omps
```

## 五个 agent

| Agent | 工具 allowlist | 用途 |
| --- | --- | --- |
| `explorer` | `read`, `grep`, `find`, `ls`, `bash`, `contact_supervisor` | 代码库侦察，定位相关代码与测试 |
| `librarian` | `read`, `grep`, `find`, `ls`, `bash`, `web_search`, `web_fetch`, `batch_web_fetch`, `contact_supervisor` | 官方文档、库行为、版本相关 API |
| `oracle` | `read`, `grep`, `find`, `ls`, `bash`, `contact_supervisor` | 架构、风险、调试策略、审查 |
| `designer` | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, `contact_supervisor` | UI/UX 实现与打磨 |
| `fixer` | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, `contact_supervisor` | 边界明确的实现与验证 |

`orchestrator` 只是主会话 preset 角色。agent 只从 package 根目录的 `agents/` 加载，并使用 Pi 的 `parseFrontmatter`；用户或项目 agent manifest 不参与发现。

## 要求与安装

- 与 Pi 0.84.2 的 package 和 RPC API 兼容。
- 所选 preset 的六个 provider/model 必须存在并已配置认证。

```bash
pi install git:github.com/YanzuoLu/oh-my-pi-slim
```

package manifest 只加载 `./extensions/oh-my-pi-slim/index.ts`，不再包含 `pi-subagents` dependency 或 extension entry。

## 命令

| 命令 | 作用 |
| --- | --- |
| `/omps on [preset]` | 启用编排，可指定 preset |
| `/omps off` | 停用编排并恢复原主模型/thinking |
| `/omps status` | 查看激活状态 |
| `/omps presets` | 列出 preset |
| `/preset [name]` | 切换 preset；不带参数时列出 |
| `/omps uninstall` | 清理旧 OMPS backend migration state，并显示 package 删除命令 |

`/reload` 通过一次性进程内槽位恢复 active preset。新建、恢复或 fork 的 parent session 不继承该槽位。

## Presets

唯一运行时 preset 来源是：

```text
~/.pi/agent/oh-my-pi-slim.json
```

`config/oh-my-pi-slim.example.json` 只在用户文件缺失时 seed 一次。已有 preset 不会被覆盖或删除。每个 preset 定义 `orchestrator`、`explorer`、`librarian`、`oracle`、`designer`、`fixer`，每个角色包含 `provider`、`model` 和 `off, minimal, low, medium, high, xhigh, max` 之一的 thinking。

激活会验证全部模型与认证，并把主会话切到 orchestrator 配置。fresh child 的 `provider/model:thinking` 在 tool schema 校验后由 OMPS 注入；模型可见 schema 不暴露 model、thinking、context 或 tool override。

## 运行时合同

### Fresh runs

```js
subagent({ agent: "explorer", task: "定位认证流程和相关测试。" })
subagent({ agent: "oracle", task: "审查这个局部 API 决策。" })
```

fresh 输入严格为 `{ agent, task, cwd? }`。每次调用都会先写 launch config，再启动 detached background runner，并立即返回 run ID。没有 wait tool，parent runtime 也不持有进程内 child client；只有 runner 持有 Pi RPC child，parent 与 runner 完全通过文件交换生命周期数据。

child 启动使用完整 Pi invocation：

- preset 选择的 `--model` 与 `--mode rpc`；
- parent Pi session 目录下的持久化 `--session-dir`；
- package agent body 作为 `--system-prompt`；
- agent frontmatter 中的严格 `--tools` allowlist；
- 只在 child 加载、注册 `contact_supervisor` 的 `--extension`；
- trusted 且 cwd 位于 parent project 内时使用 `--approve`，否则使用 `--no-approve`；
- `PI_SUBAGENT_CHILD=1`、`OMPS_SUBAGENT_CHILD=1` 与 run ID，使主 OMPS extension 在 child 中完全不注册。

ambient extensions 仍可发现，因此 librarian 的 web tools 可以加载，但模型只能看到 allowlist 中的名称。所有 child allowlist 都排除 `subagent` 与 `subagent_supervisor`。

### List、status、通知与控制

```js
subagent({ action: "list" })
subagent({ action: "steer", id: "run-id", message: "只检查 parser 测试。" })
subagent({ action: "interrupt", id: "run-id" })
```

completed、waiting、failed 与 interrupted 都会发送在 TUI 中可见的 `followUp` 通知并设置 `triggerTurn: true`，从而唤醒主 orchestrator。通知包含完整 request、output 或 error。`list` 会返回全部 retained run（含 status 与完整 output），用于一次性检查与 reconciliation。依赖结果的后续进度由 follow-up 通知恢复，而不是重复调用 `list`。

`steer`、`interrupt` 与 supervisor reply 都会向 run 的 `control/` 目录原子写入带 token 的控制文件，并立即返回而不等待。`steer` 是 best-effort。`interrupt` 发出 interruption request，最终通知报告实际 terminal status。runner 会应用可接受的控制并发布真实状态。写 terminal state 之前，runner 会先收集最终元数据、停止 timer/watcher，并完整停止 RPC child，因此保存的 `sessionFile` 可安全 resume。

### 最小 supervisor

child 可通过 `contact_supervisor` 提交 `need_decision`、`interview_request` 或 `progress_update`。每次调用都会让 child 进入 `waiting`，progress update 也一样，因此主 orchestrator 必须 reply 才会继续。terminating tool result 的 `details` 携带 request；后台 run 会向主会话发送可见通知。

```js
subagent_supervisor({ action: "pending" })
subagent_supervisor({ action: "reply", replyTo: "request-id", message: "采用方案 A。" })
```

reply 会向仍存活的 detached runner 写 control message，并乐观地把 journal 状态恢复为 `running`；runner 下一次 state 会确认该状态。之后再次 waiting 或进入 terminal 状态时，会用新的可见通知唤醒 orchestrator。

### Resume

```js
subagent({ action: "resume", id: "source-run-id", message: "应用后续修改。" })
```

resume 只允许拥有已保存 child session file 的 terminal retained run。它以 `--session <saved sessionFile>` 启动新的 detached background run，保留 agent/model/thinking/tools/cwd，创建新的 run ID，并立即返回。resume 不暴露 launch override，也拒绝复用正被 active run 使用的 session file。

## 持久化、run files 与 shutdown

OMPS 兼容读取 `customType: "oh-my-pi-slim:subagents"`、`version: 1` 的旧全量 registry snapshot，再按当前 branch 顺序 fold 后续 `version: 2` 单 run upsert：相同 ID 以后者覆盖，坏 entry 跳过。每次新的逻辑状态写入只追加一个完整 run 的 v2 entry；heartbeat 与 UI activity 只保存在 `state.json`，不会膨胀 journal。

每个 run 按 owner session 隔离在 `<parent-session-dir>/omps-subagent-runs/<ownerSessionId>/<runId>/`，其中包括 mode-0600 的 `launch.json`、`runner.json`、`state.json`，mode-0700 的 `control/` inbox，以及 `runner.log`。`runner.json` 将 run token 与 PID 绑定到可验证的 OS process identity。parent 以短周期 poll 这些文件，并在 signal 持久化 PID 前验证 owner/run/token/process identity，再通过通知驱动 orchestration，不做阻塞等待。

持久化元数据包括 run ID、role、task、cwd、model contract、tool allowlist、时间戳、状态、最终输出/error、source run ID、supervisor request 与 child `sessionFile`。旧 v1 中已存在的 launch-mode 字段会被忽略，不再保留。

Detached execution 只持续到当前 owner session 结束。所有 `session_shutdown`（包括 reload、new/resume/fork session 切换与 quit）都会向当前 owner 的 active run 写 interrupt control，短暂有界等待，强制终止超时进程，并把 `interrupted` 写入 journal，同时保留 `sessionFile`。restore 从不接管旧 live runner：异常遗留进程会先被终止并标记 `interrupted`；已是 terminal 的 state 保持 terminal。之后可用 `resume` 继续，但一定创建新的 run ID。

## 后台 agent UI

TUI 会在 editor 上方显示一个适配自 `gotgenes/pi-packages` 中 `packages/pi-subagents` 的 widget。它保留原 UI 的 tree layout、80 ms spinner、最多 12 行、active 优先 overflow、status bar 与 finished 短暂 linger。每个 active run 是不可拆分的三行 tree entry：第一行显示 spinner 或 waiting 标记、agent、run ID、waiting 状态与 task；dim 的第二行以 `(provider) model • thinking` 开头，随后显示 turn、tool use、token/context/compaction 与 elapsed；第三行显示当前 activity，或以 warning 色显示 supervisor request。task 只占第一行并随该行截断，不再挤掉优先可见的 model/stats 行。12 行预算绝不显示半个 active entry，因此最多完整显示 3 个 active run，overflow 会准确汇总；`starting` 仍是一行 queued summary，terminal run 仍短暂显示一行 outcome。RPC mode 绝不注册 widget。

TUI transcript 还为 `subagent` 与 `subagent_supervisor` 的 call/result 提供 package 自有 renderer。call 会完整显示对应 action 的 task、continuation、guidance、ID 与 cwd；结构化单 run 结果、retained run list、pending request 和 reply 结果不受 tool expansion 状态影响，始终显示所有持久化字段，包括完整 task、request、activity、output 与 error。waiting 和 terminal 生命周期通知会把同一条 custom follow-up 显示出来，并渲染完整结构化 run；renderer 只影响显示，不会创建重复消息，也不会把显示数据复制进 model context。

## 有意限制的范围

内置 runtime 每个 run 只管理一个 child，仅提供本文记录的极小公开面。不包含脚本 workflow、schedule、mission、fleet、watchdog、agent/profile authoring、worktree 管理、聚合 chain/parallel 输入或 nested child orchestration。并发由主会话发起多个独立后台 `subagent` 调用实现。

工具 allowlist 只限制 Pi 模型可见工具，并不是 OS sandbox。尤其是 `bash` 的真实能力仍取决于当前用户和运行环境。

## Tool-batch checkpoint compaction

保留现有主会话 checkpoint 行为。OMPS active 时，完整 assistant tool batch 可通过 `SettingsManager` 与 `shouldCompact` 触发 Pi 原生 threshold compaction。OMPS 在内部校验 completed batch，调用 public `ctx.abort()`，等待匹配的 threshold compaction 与 `agent_settled`，然后把 package 固定的 auto-continue prompt 作为 follow-up continuation turn 发送。model-visible prompt 不包含 tool call ID 或名称。它不改写 context 副本或 compaction settings。

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
