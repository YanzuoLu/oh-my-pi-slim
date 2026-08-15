# oh-my-pi-slim

`oh-my-pi-slim`（OMPS）是 Pi 主会话的轻量编排层。0.6 使用原生 [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) 后端；主 Pi 负责理解、调度和验收，子 Pi 只使用以下五个精确的 bare agent 名称：

- `explorer`：只读代码库侦察
- `librarian`：只读外部文档与依赖研究
- `oracle`：只读架构、调试、风险与审查
- `designer`：UI/UX 设计与实现
- `fixer`：边界明确的实现与验证

`orchestrator` 只代表主会话的 preset 角色，不是可启动的 agent。

## 0.7.0 preset migration

0.7.0 包含 breaking preset 配置变更：运行时仅从用户文件 `~/.pi/agent/oh-my-pi-slim.json` 读取 preset，并移除 project/package overlay。用户文件缺失时，bootstrap 会从 bundled 示例 `config/oh-my-pi-slim.example.json` seed；已有文件不会被覆盖，也不会自动获得 `balanced`、`economy` 或 `openai`，需要时请从 bundled 示例手工合并。

升级命令：

```bash
pi install git:github.com/YanzuoLu/oh-my-pi-slim@v0.7.0
```

升级后请重启 Pi，或执行 `/reload`。

## 0.6.0 breaking migration

0.6.0 直接且精确依赖 `pi-subagents@0.49.0`，不兼容 0.5.x 使用的 tintinweb backend/facade。升级前先移除旧后端（若已安装），再安装 OMPS：

```bash
pi remove npm:@tintinweb/pi-subagents
pi install git:github.com/YanzuoLu/oh-my-pi-slim
```

OMPS 在启动和激活时检查原生工具。如果检测到旧 facade，或原生后端没有先加载，OMPS 会拒绝激活，而不是混用两套生命周期。

package manifest 按以下顺序加载扩展：

1. `./node_modules/pi-subagents/index.ts`
2. `./extensions/oh-my-pi-slim/index.ts`

五个 agent 通过 package-scoped `pi.subagents.agents: ["./agents"]` 发现，`pi-documentation` 通过 package-scoped `pi.skills` 暴露。安装过程不会把 agent 复制到 `~/.pi/agent/agents`，也没有 asset-copy 安装脚本。

首次安装或升级后，请退出并重新启动 Pi，或执行 `/reload`，使已经加载的 backend 读取新配置。

## 要求

- Pi 可加载 TypeScript package extensions。
- 所选 preset 的六个 provider/model 都存在且已配置认证。
- 使用 Anthropic OAuth 时，正常 child Pi 会继承已安装的认证扩展；请确保 `@gotgenes/pi-anthropic-auth` 已安装并配置。OMPS 不读取、复制或记录认证文件路径和 token。
- 0.6 发布验证包含真实 child smoke；仓库内的静态 `npm run validate` 不依赖网络、认证或用户 profile。

## 激活与命令

使用默认 preset：

```bash
pi --omps
```

启动时选择 preset：

```bash
pi --omps --omps-preset balanced
```

会话内启用、切换或查询：

```text
/omps on
/omps on economy
/preset openai
/preset
/omps status
/omps presets
/omps off
/omps uninstall
```

- `--omps-preset <name>` 会选择并激活该 preset。
- `/preset <name>` 会启用 OMPS（若尚未启用）并切换 preset；`/preset` 列出可用 preset。
- `/omps off` 只关闭当前会话的 OMPS 编排，并恢复激活前的主模型与 thinking。
- `/omps uninstall` 只执行可逆设置恢复；真正移除 package 见[卸载](#卸载)。
- `/reload` 会重建全部扩展，但 OMPS 会通过进程内的一次性槽位恢复激活状态和当前 preset；`/new`、resume 和 fork 不继承，重启 Pi 后回到 flag/env/默认行为。

## 原生调用合同

### Fresh runs

启动一个新的 specialist：

```js
subagent({ agent: "explorer", task: "定位认证入口、数据流和相关测试。" })
```

调用默认异步，在后台执行。只有结果很小且后续工作必须立即依赖它时才使用前台阻塞：

```js
subagent({
  agent: "oracle",
  task: "审查这个局部 API 决策。",
  async: false
})
```

并行工作使用多个独立、结构化的 `subagent({ agent, task })` 调用。OMPS 禁止直接 arbitrary `workflowScript`，不要用脚本拼接 chain、fanout 或并行流程。

Fresh 调用只接受以下五个精确 bare 名称：

```text
explorer, librarian, oracle, designer, fixer
```

当 OMPS 激活时，它会：

- 用当前 preset 替换 caller 提供的 `model`；实际传给 backend 的值是 `provider/model:thinking` suffix。
- 删除 caller 的 `thinking`、`turnBudget`、`usageBudget` 和 `toolBudget`。
- 强制 `context: "fresh"`。
- 拒绝其他 agent 名、alias 或 namespaced 名称。

`fresh` 只控制会话上下文。agent frontmatter 仍通过 backend 原生机制设置 `systemPromptMode: replace`、`inheritProjectContext: true` 和 `inheritSkills: true`，因此 child 仍继承项目指令与 skills catalog。

五个 agent 都不声明 `tools` allowlist，所以普通 Pi 工具和已加载 extension tools 不会被 OMPS allowlist 收窄。`explorer`、`librarian`、`oracle` 的只读属性靠角色 prompt 约束；`acceptanceRole` 只影响 backend 的验收推断，不授予或撤销工具。这不是操作系统 sandbox。

### Completion、barrier 与控制

后台完成会由 backend 自动通知主会话。优先继续不冲突的工作并消费通知；不要 sleep，也不要循环调用 status 轮询。

当当前请求确实必须等待一个或多个结果时，使用 `subagent_wait` 作为 barrier：

```js
subagent_wait({ id: "run-id" })
```

原生生命周期控制保持可用：

```js
subagent({ action: "status", id: "run-id" })
subagent({ action: "steer", id: "run-id", message: "只检查 parser 回归。" })
subagent({ action: "interrupt", id: "run-id" })
subagent({ action: "stop", id: "run-id" })
subagent({ action: "resume", id: "source-run-id", message: "应用后续修正。" })
```

原生 `resume` 从持久化 session 创建新的 child process 和新的 run ID，同时保留 source run 的 model、thinking 与工具合同。后续 status/control/follow-up 必须使用返回的新 ID。resume 时不要传 `agent`、`model`、`thinking`、`turnBudget`、`usageBudget` 或 `toolBudget`；OMPS 会拒绝这些 launch override。

### Native actions policy

OMPS 激活时，以下管理动作被精确阻止：

```text
create, update, delete, eject, enable, append-step,
refine, refine.show, refine.rollback
```

`disable` 与 `reset` 不在 OMPS denylist。其他原生 status/control、`children.*`、`mission.*`、`worktree.*`、`schedule.*` 和 backend 支持的动作保持可用。此 gate 是主会话工具策略，不是通用权限系统。

## Schedules

OMPS 只允许一种 `schedule.create` 输入：canonical strict-JSON、单个 `runs.run` child。示例：

```js
subagent({
  action: "schedule.create",
  every: "6h",
  workflowScript: 'return runs.run("trusted-scan", {"agent":"explorer","task":"检查近期改动并报告风险。"});'
})
```

要求：

- `workflowScript` 必须严格匹配一个 `return runs.run(<JSON string>, <strict JSON object>);`。
- key trim 后非空。
- fresh child 必须使用五个 bare role 之一；创建时会把当前 preset 的 model suffix 烘焙进 schedule。
- retained resume child 保留 source 合同，不能附加 launch override。
- 其他 schedule 生命周期操作直接使用 backend 原生 `schedule.*` action。

安全边界必须诚实理解：已经存在的 schedule、OMPS 关闭时创建的 schedule，或用户直接修改 schedule store 得到的条目，由 backend timer 直接执行，不经过 OMPS 的 `tool_call` gate。仅靠 OMPS 无法追溯重写这些记录，也不是完整 sandbox。只运行你信任的 schedule，并保护其 store 不受不可信修改。

## 持久化、结果与恢复

0.6 直接采用 `pi-subagents@0.49.0` 的原生 persistence、status、result、events 和 restart recovery。它不实现旧 facade 的短期 in-memory 补救，也不根据历史错误字符串猜测结果。运行状态和恢复能力以 backend 的持久化记录为准。

resume 是物理上的新运行：source session 被恢复为新的 child process，并返回新的 run ID；它不会复用 source run ID。

## Tool-batch checkpoint compaction

仅在主 OMPS 会话已激活时，OMPS 会在 `turn_end` 的完整 tool batch 边界检查 checkpoint。阈值和开关直接来自 Pi `SettingsManager` 按当前 cwd、agent directory 与 project trust 合并出的原生 compaction settings，并由 Pi 的 `shouldCompact` 判定；OMPS 不复制阈值公式，也不写这些 settings。

只有 assistant 以 `toolUse` 结束、全部 tool call 都有一一对应且名称匹配的 tool result、没有已有 checkpoint、没有 pending message，并且 Pi 能提供 token/context-window usage 时才会触发。失败的 tool result 也表示该调用已完成；OMPS 只保留有序的 `id: tool-name`，不会复制 tool output。batch 不完整、对应关系不明、usage 未知、compaction 已禁用或已有 pending 工作时都会跳过。

在完整 batch 且原生阈值命中时，OMPS 调用 public `ctx.abort()` 结束旧的 low-level run；随后由 Pi 自己的 post-run `_checkCompaction` / threshold auto path 生成标准 compaction，而不是由 OMPS 发起 manual compaction。只有对应的 `reason === "threshold"` compaction 以 `willRetry === false` 完成并进入 `agent_settled` 后，OMPS 才以新的 extension user turn best-effort 恢复，并列出压缩前已完成的调用；如果 Pi 没有完成该 threshold compaction，OMPS 不会自动恢复或重试。它不是 transparent continuation，也不是透明 continuation，模型仍可能重复调用；恢复文本只要求不要仅因 turn 重启而重做，验证状态或补回缺失信息时仍可重新获取。新的非 extension 输入、session switch、关闭 OMPS 或 shutdown 会取消待发送的恢复 turn。

该机制不注册 `context` hook，不裁剪或改写 context request 副本，不做 emergency truncation，也不修改 Pi compaction settings。

## Bootstrap 与设置影响

每次父会话 `session_start`，OMPS 会先验证 native backend，再执行幂等 setup。除一次性 seed 用户 preset 文件外，setup 只维护两个原生字段：

用户 Pi settings：

```json
{
  "subagents": {
    "disableBuiltins": true
  }
}
```

backend config：

```json
{
  "maxSubagentDepth": 1
}
```

目标分别是用户 agent 目录下的 `settings.json` 和 `extensions/subagent/config.json`。OMPS 在 backend config 的 migration state 中备份这些字段是否存在及其原值，`/omps uninstall` 可逆恢复；无关字段保持不变。

这些是**用户级**设置，会影响该 Pi agent directory 下的所有会话，不只影响 OMPS。Pi/backend 的原生 precedence 仍然适用：

- trusted project settings 可以覆盖用户级 `subagents.disableBuiltins`。
- 同名 user/project agent 可以 shadow package agent，且 project 优先级更高。
- OMPS 不复制 package agents，也不绕过这些原生优先级。

此外，setup 只在 `~/.pi/agent/oh-my-pi-slim.json` 不存在时，从 bundled 示例 `config/oh-my-pi-slim.example.json` 排他创建一次；并发创建遇到 `EEXIST` 会安全保留胜出的文件。已有 preset 文件不会被覆盖，升级也不会刷新它。

因此修改 setup 后需要 restart 或 `/reload`，让先加载的 backend 重新读取配置。

## Child 行为与边界

backend 为 child 设置 `PI_SUBAGENT_CHILD=1`。OMPS extension 在任何 flag、command、event 或 tool gate 注册前立即返回，因此 child 中完全 inert：不会二次激活、改模型、注册命令或递归执行 setup。

项目上下文与 skills 由 backend 原生继承：五个 agent 使用 `inheritProjectContext: true` 和 `inheritSkills: true`。每个 agent prompt 明确禁止调用 `subagent`、`subagent_wait` 和 `subagent_supervisor`，并禁止直接询问用户。遇到阻塞决策时，child 使用 `contact_supervisor` 把问题交还主会话。

角色 prompt 不依赖具体外部 extension 工具名；实际外部研究与抓取能力由 native child 环境当前加载的工具决定。

`maxSubagentDepth=1`、tool gate 与 prompt 都是编排约束，不是 OS/container sandbox。child 拥有的实际文件、shell、网络和 extension 能力仍由 Pi、所加载工具及运行用户的系统权限决定。

## Presets

运行时 preset 的唯一来源是用户文件：

```text
~/.pi/agent/oh-my-pi-slim.json
```

OMPS 不读取 package 内的 preset 配置，也不读取任何 `<project>/.pi/oh-my-pi-slim.json`；不存在 package/user/project overlay 或 preset 合并语义。用户文件中的 `defaultPreset` 与 `presets` 就是完整运行时配置。

package bundled 示例位于 `config/oh-my-pi-slim.example.json`，自带完整的 `balanced`、`economy`、`openai`，默认是 `balanced`。setup 仅在用户文件尚不存在时，以 exclusive create（`wx`）从该示例 seed 一次；若并发 setup 已先创建文件，`EEXIST` 会被安全忽略。已有用户文件始终保留：安装或升级不会覆盖或刷新，`/omps uninstall` 也不会删除。该文件由用户拥有；如需采用新版示例，请自行比较并编辑。

从旧 overlay 语义升级时，已有的用户 JSON 现在会成为完整真源，setup 不会自动补入缺少的 `balanced`、`economy` 或 `openai`；需要这些 preset 时，请参考 `config/oh-my-pi-slim.example.json` 手工合并。也可以先备份再删除用户 JSON 并重启 Pi，让已启用的 bootstrap 重新 seed bundled 示例；直接删除会永久丢失原有自定义，未备份时无法恢复。

每个 preset 必须完整定义六个角色：`orchestrator` 加五个 specialist。每个角色都需要非空 `provider`、非空 `model` 和合法 `thinking`：

```text
off, minimal, low, medium, high, xhigh, max
```

bundled 示例自带 `balanced`、`economy`、`openai`。简化结构如下：

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

激活时 OMPS 校验六个模型及认证；任一缺失都会拒绝激活。使用 `pi --list-models` 获取准确 provider/model ID。

## 卸载

卸载分两步。先在 Pi 内恢复 setup 前的用户设置：

```text
/omps uninstall
```

然后退出 Pi，再移除 package：

```bash
pi remove git:github.com/YanzuoLu/oh-my-pi-slim
```

OMPS 不删除用户拥有的 `~/.pi/agent/oh-my-pi-slim.json`，也不删除共享认证、搜索、questionnaire 或其他独立 package；例如 `@gotgenes/pi-anthropic-auth` 仍由用户自行管理。

## Architecture 与限制

```text
main Pi
  └─ oh-my-pi-slim: preset、主 prompt、native tool_call policy
       └─ pi-subagents@0.49.0: child process、持久化、事件、通知、控制、恢复
            └─ package-scoped explorer/librarian/oracle/designer/fixer
```

OMPS 有意保持窄职责：不实现第二套 run manager/RPC，不动态注册替代工具，不复制 agent 资产，只在用户 preset 文件缺失时 seed bundled 示例，不模拟 backend persistence，也不承诺 OS sandbox。schedule timer 绕过主会话 `tool_call` gate 的限制见上文。

## Development

静态验证只读取仓库文件并执行无写检查：

```bash
npm run validate
git diff --check
```

`npm run validate` 检查 package/lock/backend 版本与加载顺序、五个 agent frontmatter、bundled preset 示例完整性、用户 preset 一次性 seed 合同、bootstrap 可逆设置合同、运行时单一用户配置来源、child early return、native policy gate、schedule canonicalization、resume 新 ID 合同、README/orchestrator 文档关键字，以及已删除的 0.5 资产和符号。它不会动态 import extension，也不会访问网络、认证、用户 home 或 sibling repository。

真实 child 启动、认证继承、通知/恢复、schedule timer 与 checkpoint 的端到端行为属于集成 smoke；本静态验证不声称覆盖这些运行时路径。

## License

MIT
