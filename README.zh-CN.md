# oh-my-pi-slim

> Pi 主会话的 preset 驱动编排层，构建在原生 [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) 后端之上。

[English](./README.md) | **中文**

主 Pi 负责理解、调度和验收，子会话负责边界明确的执行。preset 决定每个角色跑在哪个模型和 thinking 档位上，因此切换整套配置只需一条命令，不必逐个调用去调参。

```bash
pi --omps
```

## 五个 agent

子会话只使用以下五个精确的 bare 名称：

| Agent | 权限 | 用途 |
| --- | --- | --- |
| `explorer` | 只读 | 代码库侦察，定位文件、符号与相关测试 |
| `librarian` | 只读 | 外部文档、库行为、版本相关 API |
| `oracle` | 只读 | 架构、风险、调试策略、独立审查 |
| `designer` | 读写 | UI/UX 设计、实现与打磨 |
| `fixer` | 读写 | 边界明确的实现与验证 |

`orchestrator` 只是主会话的 preset 角色，不是可启动的 agent。

## 要求

- Pi 可加载 TypeScript package extensions。
- 所选 preset 的六个 provider/model 都存在且已配置认证。
- 使用 Anthropic OAuth 时，请确保 `@gotgenes/pi-anthropic-auth` 已安装并配置。OMPS 不读取、复制或记录认证文件路径和 token。

## 安装

```bash
pi install git:github.com/YanzuoLu/oh-my-pi-slim
```

安装后请重启 Pi，或执行 `/reload`，使已经加载的 backend 读取新配置。

package manifest 按以下顺序加载扩展：

1. `./node_modules/pi-subagents/index.ts`
2. `./extensions/oh-my-pi-slim/index.ts`

五个 agent 通过 package-scoped `pi.subagents.agents: ["./agents"]` 发现。安装过程不会把 agent 复制到 `~/.pi/agent/agents`，也没有 asset-copy 安装脚本。OMPS 在启动时检查原生 backend，如果它没有先加载，OMPS 会拒绝激活，而不是混用两套生命周期。

## 快速开始

```bash
pi --omps                              # 使用默认 preset
pi --omps --omps-preset balanced       # 启动时指定 preset
```

## 命令

| 命令 | 作用 |
| --- | --- |
| `/omps on [preset]` | 启用编排，可同时指定 preset |
| `/omps off` | 关闭当前会话的编排，并恢复激活前的主模型与 thinking |
| `/omps status` | 查看当前状态 |
| `/omps presets` | 列出可用 preset |
| `/preset [name]` | 切换 preset（必要时会先启用 OMPS）；不带参数则列出 |
| `/omps uninstall` | 只执行可逆的设置恢复 —— 见[卸载](#卸载) |

`/reload` 会重建全部扩展，但 OMPS 通过进程内的一次性槽位恢复激活状态和当前 preset。`/new`、resume 和 fork 不继承；重启 Pi 后回到 flag/env/默认行为。

## Presets

运行时 preset 的唯一来源是用户文件：

```text
~/.pi/agent/oh-my-pi-slim.json
```

不存在 package/project overlay，也没有合并语义 —— 该文件中的 `defaultPreset` 与 `presets` 就是完整的运行时配置。

每个 preset 必须完整定义六个角色（`orchestrator` 加五个 specialist）。每个角色都需要非空 `provider`、非空 `model`，以及取自 `off, minimal, low, medium, high, xhigh, max` 的 `thinking`：

```json
{
  "defaultPreset": "balanced",
  "presets": {
    "balanced": {
      "orchestrator": { "provider": "anthropic", "model": "claude-opus-4-6", "thinking": "max" },
      "explorer": { "provider": "anthropic", "model": "claude-haiku-4-5", "thinking": "medium" },
      "librarian": { "provider": "anthropic", "model": "claude-haiku-4-5", "thinking": "medium" },
      "oracle": { "provider": "anthropic", "model": "claude-opus-4-6", "thinking": "max" },
      "designer": { "provider": "anthropic", "model": "claude-sonnet-4-6", "thinking": "high" },
      "fixer": { "provider": "anthropic", "model": "claude-sonnet-4-6", "thinking": "high" }
    }
  }
}
```

激活时会校验六个模型及其认证，任一缺失都会拒绝激活。使用 `pi --list-models` 获取准确的 provider/model ID。

package 内的示例位于 `config/oh-my-pi-slim.example.json`，自带 `balanced`、`economy`、`openai`。它只在用户文件不存在时，以 exclusive create 方式 seed 一次。已有文件永远不会被覆盖，升级不会刷新它，`/omps uninstall` 也不会删除它 —— 该文件归你所有。需要采用新版示例时，请自行比较并合并。

## 调用合同

### Fresh runs

```js
subagent({ agent: "explorer", task: "定位认证入口、数据流和相关测试。" })
```

调用默认异步，在后台执行。只有结果很小且下一步确实依赖它时才使用前台阻塞：

```js
subagent({ agent: "oracle", task: "审查这个局部 API 决策。", async: false })
```

并行工作使用多个独立的结构化调用。OMPS 禁止直接 arbitrary `workflowScript`，不要用脚本拼接 chain、fanout 或并行流程。

当 OMPS 激活时，它会：

- 用当前 preset 替换 caller 提供的 `model`，传给 backend 的形式是 `provider/model:thinking`。
- 删除 caller 的 `thinking`、`turnBudget`、`usageBudget` 和 `toolBudget`。
- 强制 `context: "fresh"`。
- 拒绝其他 agent 名、alias 或 namespaced 名称。

`fresh` 只控制会话上下文。agent frontmatter 仍通过原生机制设置 `systemPromptMode: replace`、`inheritProjectContext: true` 和 `inheritSkills: true`，因此 child 仍继承项目指令与 skills catalog。

### 等待与控制

后台完成会自动通知主会话。优先继续不冲突的工作并消费通知 —— 不要 sleep，也不要循环轮询 `status`。当前请求确实无法推进时，才使用 barrier：

```js
subagent_wait({ id: "run-id" })
```

```js
subagent({ action: "status",  id: "run-id" })
subagent({ action: "steer",   id: "run-id", message: "只检查 parser 回归。" })
subagent({ action: "interrupt", id: "run-id" })
subagent({ action: "stop",    id: "run-id" })
subagent({ action: "resume",  id: "source-run-id", message: "应用后续修正。" })
```

原生 `resume` 把持久化 session 恢复为新的 child process，并返回**新的 run ID** —— 它不会复用 source run ID。后续 status/control/follow-up 必须使用返回的新 ID。resume 时不要传 `agent`、`model`、`thinking`、`turnBudget`、`usageBudget` 或 `toolBudget`，OMPS 会拒绝这些 launch override。

### 被阻止的动作

OMPS 激活时，以下管理动作被精确阻止：

```text
create, update, delete, eject, enable, append-step,
refine, refine.show, refine.rollback
```

`disable` 与 `reset` 不在 denylist。其他原生 status/control、`children.*`、`mission.*`、`worktree.*`、`schedule.*` 和 backend 支持的动作保持可用。此 gate 是主会话工具策略，不是通用权限系统。

## Schedules

`schedule.create` 只接受一种输入：canonical strict-JSON、单个 `runs.run` child。

```js
subagent({
  action: "schedule.create",
  every: "6h",
  workflowScript: 'return runs.run("trusted-scan", {"agent":"explorer","task":"检查近期改动并报告风险。"});'
})
```

`workflowScript` 必须严格匹配一个 `return runs.run(<JSON string>, <strict JSON object>);`，key trim 后非空，fresh child 必须使用五个 bare role 之一 —— 创建时会把当前 preset 的 model suffix 烘焙进 schedule。其他 schedule 生命周期操作直接使用 backend 原生 `schedule.*` action。

安全边界必须诚实理解：已经存在的 schedule、OMPS 关闭时创建的 schedule，以及直接写入 schedule store 的条目，都由 backend timer 直接执行，不经过 OMPS 的 `tool_call` gate。OMPS 无法追溯重写这些记录。只运行你信任的 schedule，并保护其 store 不受不可信修改。

<details>
<summary><b>持久化、结果与恢复</b></summary>

OMPS 直接采用 backend 的原生 persistence、status、result、events 和 restart recovery。它不实现 in-memory 补救，也不根据历史错误字符串猜测结果。运行状态和恢复能力以 backend 的持久化记录为准。

</details>

<details>
<summary><b>Tool-batch checkpoint compaction</b></summary>

仅在主 OMPS 会话已激活时，OMPS 会在 `turn_end` 的完整 tool batch 边界检查 checkpoint。阈值直接来自 Pi 的原生 compaction settings —— 由 `SettingsManager` 按当前 cwd、agent directory 与 project trust 合并得出，并由 Pi 的 `shouldCompact` 判定。OMPS 不复制阈值公式，也不写这些 settings。

只有 assistant 以 `toolUse` 结束、全部 tool call 都有一一对应且名称匹配的 tool result、没有已有 checkpoint、没有 pending message，并且 Pi 能提供 token/context-window usage 时才会触发。失败的 tool result 也表示该调用已完成；OMPS 只保留有序的 `id: tool-name`，不会复制 tool output。batch 不完整、对应关系不明、usage 未知、compaction 已禁用或已有 pending 工作时都会跳过。

在完整 batch 且原生阈值命中时，OMPS 调用 public `ctx.abort()` 结束旧的 low-level run，随后由 Pi 自己的 post-run threshold path 生成标准 compaction，而不是由 OMPS 发起 manual compaction。只有对应的 `reason === "threshold"` compaction 以 `willRetry === false` 完成并进入 `agent_settled` 后，OMPS 才以新的 extension user turn best-effort 恢复，并列出压缩前已完成的调用。

它不是 transparent continuation。模型仍可能重复调用；恢复文本只要求不要仅因 turn 重启而重做，验证状态或补回缺失信息时仍可重新获取。新的非 extension 输入、session switch、关闭 OMPS 或 shutdown 都会取消待发送的恢复 turn。

该机制不注册 `context` hook，不裁剪或改写 context request 副本，不做 emergency truncation，也不修改 Pi compaction settings。

</details>

<details>
<summary><b>Bootstrap 与设置影响</b></summary>

每次父会话 `session_start`，OMPS 会先验证原生 backend，再执行幂等 setup。除一次性 seed 用户 preset 文件外，它只维护两个原生字段 —— 用户 Pi settings 中的 `subagents.disableBuiltins: true`，以及 backend config 中的 `maxSubagentDepth: 1`，分别写入用户 agent 目录下的 `settings.json` 和 `extensions/subagent/config.json`。

OMPS 在 backend config 的 migration state 中备份这些字段是否存在及其原值，因此 `/omps uninstall` 可逆恢复；无关字段保持不变。

这些是**用户级**设置，会影响该 Pi agent directory 下的所有会话，不只影响 OMPS。原生 precedence 仍然适用：trusted project settings 可以覆盖 `subagents.disableBuiltins`，同名 user/project agent 可以 shadow package agent 且 project 优先级更高。OMPS 不复制 package agents，也不绕过这些原生优先级。

修改 setup 后需要 restart 或 `/reload`，让先加载的 backend 重新读取配置。

</details>

<details>
<summary><b>Child 行为与边界</b></summary>

backend 为 child 设置 `PI_SUBAGENT_CHILD=1`。OMPS extension 在任何 flag、command、event 或 tool gate 注册前立即返回，因此在 child 中完全 inert：不会二次激活、改模型、注册命令或递归执行 setup。

每个 agent prompt 明确禁止调用 `subagent`、`subagent_wait` 和 `subagent_supervisor`，并禁止直接询问用户。遇到阻塞决策时，child 使用 `contact_supervisor` 把问题交还主会话。

五个 agent 都不声明 `tools` allowlist，所以普通 Pi 工具和已加载的 extension tools 不会被 OMPS 收窄。`explorer`、`librarian`、`oracle` 的只读属性靠角色 prompt 约束；`acceptanceRole` 只影响 backend 的验收推断，不授予或撤销任何工具。

`maxSubagentDepth=1`、tool gate 与 prompt 都是编排约束，**不是** OS 或 container sandbox。child 拥有的实际文件、shell、网络和 extension 能力，仍由 Pi、所加载的工具及运行用户的系统权限决定。

</details>

<details>
<summary><b>架构与限制</b></summary>

```text
main Pi
  └─ oh-my-pi-slim: preset、主 prompt、native tool_call policy
       └─ pi-subagents: child process、持久化、事件、通知、控制、恢复
            └─ package-scoped explorer/librarian/oracle/designer/fixer
```

职责有意保持窄：不实现第二套 run manager 或 RPC 层，不动态注册替代工具，不复制 agent 资产，不模拟 backend persistence，也不承诺 OS sandbox。bundled 示例只在用户 preset 文件缺失时 seed。上文描述的 schedule timer 缺口是真实存在的限制。

</details>

## 卸载

分两步。先在 Pi 内恢复 setup 前的用户设置：

```text
/omps uninstall
```

然后退出 Pi，再移除 package：

```bash
pi remove git:github.com/YanzuoLu/oh-my-pi-slim
```

你的 `~/.pi/agent/oh-my-pi-slim.json` 不会被删除，共享认证、搜索、questionnaire 或其他独立 package 也不会 —— 例如 `@gotgenes/pi-anthropic-auth` 仍由你自行管理。

## 开发

```bash
npm run validate
git diff --check
```

静态验证只读取仓库文件，不执行任何写操作。它检查 package/lock/backend 版本与加载顺序、五个 agent frontmatter、bundled preset 示例完整性、一次性 seed 合同、可逆 bootstrap 合同、单一来源运行时配置、child early return、native policy gate、schedule canonicalization，以及 resume 新 ID 合同。它不会动态 import extension，也不会访问网络、认证、用户 home 或 sibling repository。

真实 child 启动、认证继承、通知与恢复、schedule timer 与 checkpoint 的端到端行为属于集成测试范畴；本静态验证不声称覆盖这些运行时路径。

## License

MIT
