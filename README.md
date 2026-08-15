# oh-my-pi-slim

> Preset-driven main-session orchestration for Pi, on a native [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) backend.

**English** | [中文](./README.zh-CN.md)

The main Pi session plans, dispatches and verifies. Child sessions do the bounded work. A preset decides which model and thinking level every role runs on, so you switch the whole fleet with one command instead of tuning calls one by one.

```bash
pi --omps
```

## The five agents

Child sessions use exactly these five bare names:

| Agent | Access | Use it for |
| --- | --- | --- |
| `explorer` | read-only | Codebase reconnaissance, locating files, symbols, tests |
| `librarian` | read-only | External docs, library behavior, version-specific APIs |
| `oracle` | read-only | Architecture, risk, debugging strategy, independent review |
| `designer` | read + write | UI/UX design, implementation and polish |
| `fixer` | read + write | Bounded implementation and verification |

`orchestrator` is the preset role for the main session only. It is not a launchable agent.

## Requirements

- Pi able to load TypeScript package extensions.
- All six provider/model pairs in your chosen preset exist and have configured auth.
- On Anthropic OAuth, make sure `@gotgenes/pi-anthropic-auth` is installed and configured. OMPS never reads, copies or logs credential paths or tokens.

## Install

```bash
pi install git:github.com/YanzuoLu/oh-my-pi-slim
```

Restart Pi, or run `/reload`, so the already-loaded backend picks up the configuration.

The package manifest loads extensions in this order:

1. `./node_modules/pi-subagents/index.ts`
2. `./extensions/oh-my-pi-slim/index.ts`

The five agents are discovered through package-scoped `pi.subagents.agents: ["./agents"]`. Nothing is copied into `~/.pi/agent/agents`, and there is no asset-copy install script. OMPS verifies the native backend at startup and refuses to activate if it did not load first, rather than mixing two lifecycles.

## Quick start

```bash
pi --omps                              # default preset
pi --omps --omps-preset balanced       # pick one at launch
```

## Commands

| Command | Effect |
| --- | --- |
| `/omps on [preset]` | Enable orchestration, optionally with a preset |
| `/omps off` | Disable for this session, restoring the pre-activation model and thinking |
| `/omps status` | Show current state |
| `/omps presets` | List available presets |
| `/preset [name]` | Switch preset (enables OMPS if needed); bare `/preset` lists them |
| `/omps uninstall` | Reversible settings restore only — see [Uninstall](#uninstall) |

`/reload` rebuilds every extension, but OMPS restores its active state and current preset through a one-shot in-process slot. `/new`, resume and fork do not inherit it; after a Pi restart you are back to flag/env/default behavior.

## Presets

The single runtime source is your user file:

```text
~/.pi/agent/oh-my-pi-slim.json
```

There is no package/project overlay and no merge semantics — `defaultPreset` and `presets` in that file are the complete runtime configuration.

Every preset defines six roles (`orchestrator` plus the five specialists). Each role needs a non-empty `provider`, a non-empty `model`, and a `thinking` value from `off, minimal, low, medium, high, xhigh, max`:

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

Activation validates all six models and their auth; any miss refuses activation. Use `pi --list-models` for exact provider/model IDs.

The bundled example at `config/oh-my-pi-slim.example.json` ships `balanced`, `economy` and `openai`. It seeds your user file exactly once, via exclusive create, when that file does not exist. An existing file is never overwritten, never refreshed on upgrade, and never deleted by `/omps uninstall` — it is yours. To adopt a newer example, diff and merge it yourself.

## Calling contract

### Fresh runs

```js
subagent({ agent: "explorer", task: "Locate the auth entry points, data flow and related tests." })
```

Calls are async and run in the background. Use foreground only when the result is small and the next step truly depends on it:

```js
subagent({ agent: "oracle", task: "Review this local API decision.", async: false })
```

Run work in parallel with multiple independent structured calls. OMPS blocks arbitrary `workflowScript`, so do not script chains, fanout or parallel flows.

While OMPS is active it will:

- Replace the caller's `model` with the current preset's, passed to the backend as `provider/model:thinking`.
- Delete the caller's `thinking`, `turnBudget`, `usageBudget` and `toolBudget`.
- Force `context: "fresh"`.
- Reject any other agent name, alias or namespaced name.

`fresh` controls session context only. Agent frontmatter still sets `systemPromptMode: replace`, `inheritProjectContext: true` and `inheritSkills: true` natively, so children keep project instructions and the skills catalog.

### Waiting and control

Completions notify the main session automatically. Prefer continuing non-conflicting work and consuming the notification — do not sleep, and do not poll `status` in a loop. When the current request genuinely cannot proceed, use a barrier:

```js
subagent_wait({ id: "run-id" })
```

```js
subagent({ action: "status",  id: "run-id" })
subagent({ action: "steer",   id: "run-id", message: "Only check the parser regression." })
subagent({ action: "interrupt", id: "run-id" })
subagent({ action: "stop",    id: "run-id" })
subagent({ action: "resume",  id: "source-run-id", message: "Apply the follow-up fix." })
```

Native `resume` restores the persisted session as a new child process and returns a **new run ID** — it never reuses the source ID. Use the returned ID for later status, control and follow-up. Do not pass `agent`, `model`, `thinking`, `turnBudget`, `usageBudget` or `toolBudget` to resume; OMPS rejects those launch overrides.

### Blocked actions

While OMPS is active these management actions are blocked:

```text
create, update, delete, eject, enable, append-step,
refine, refine.show, refine.rollback
```

`disable` and `reset` are not on the denylist. Other native status/control, `children.*`, `mission.*`, `worktree.*`, `schedule.*` and backend-supported actions stay available. This gate is main-session tool policy, not a general permission system.

## Scheduling

`schedule.create` accepts exactly one shape: canonical strict-JSON with a single `runs.run` child.

```js
subagent({
  action: "schedule.create",
  every: "6h",
  workflowScript: 'return runs.run("trusted-scan", {"agent":"explorer","task":"Check recent changes and report risks."});'
})
```

The script must match one `return runs.run(<JSON string>, <strict JSON object>);`, the key must be non-empty after trimming, and a fresh child must use one of the five bare roles — the current preset's model suffix is baked in at creation. Use the backend's native `schedule.*` actions for every other lifecycle operation.

Understand the boundary honestly: schedules that already exist, schedules created while OMPS is off, and entries written directly into the schedule store are executed by the backend timer without passing through the OMPS `tool_call` gate. OMPS cannot retroactively rewrite them. Run only schedules you trust, and protect the store from untrusted modification.

<details>
<summary><b>Persistence, results and recovery</b></summary>

OMPS uses the backend's native persistence, status, results, events and restart recovery directly. It does not implement in-memory remediation and does not guess outcomes from historical error strings. Run state and recoverability are whatever the backend's persisted records say.

</details>

<details>
<summary><b>Tool-batch checkpoint compaction</b></summary>

Only while the main OMPS session is active, OMPS checks for a checkpoint at complete tool-batch boundaries on `turn_end`. Thresholds come from Pi's native compaction settings, merged by `SettingsManager` across cwd, agent directory and project trust, and judged by Pi's own `shouldCompact`. OMPS neither reimplements the threshold formula nor writes those settings.

It triggers only when the assistant ended on `toolUse`, every tool call has a one-to-one name-matching result, no checkpoint exists, no message is pending, and Pi can report token/context-window usage. Failed results still count as completed calls; OMPS keeps only the ordered `id: tool-name` list and never copies tool output. Incomplete batches, ambiguous pairing, unknown usage, disabled compaction or pending work are all skipped.

On a complete batch with the native threshold hit, OMPS calls public `ctx.abort()` to end the low-level run. Pi's own post-run threshold path then produces a standard compaction — OMPS does not start a manual one. Only after the matching `reason === "threshold"` compaction finishes with `willRetry === false` and reaches `agent_settled` does OMPS resume best-effort with a new extension user turn listing the calls completed before compaction.

This is not a transparent continuation. The model may still repeat calls; the resume text only asks it not to redo work purely because the turn restarted, while allowing re-fetching to verify state or recover missing information. New non-extension input, a session switch, disabling OMPS or shutdown all cancel the pending resume turn.

The mechanism registers no `context` hook, never trims or rewrites context request copies, does no emergency truncation, and does not modify Pi compaction settings.

</details>

<details>
<summary><b>Bootstrap and settings impact</b></summary>

On each parent `session_start`, OMPS verifies the native backend and then runs an idempotent setup. Beyond the one-time preset seed it maintains exactly two native fields — `subagents.disableBuiltins: true` in user Pi settings, and `maxSubagentDepth: 1` in backend config — targeting `settings.json` and `extensions/subagent/config.json` in your user agent directory.

OMPS records whether those fields existed and their original values in the backend config's migration state, so `/omps uninstall` restores them reversibly. Unrelated fields are untouched.

These are **user-level** settings and affect every session under that Pi agent directory, not just OMPS. Native precedence still applies: trusted project settings can override `subagents.disableBuiltins`, and same-named user or project agents can shadow the package agents with project taking priority. OMPS does not copy package agents and does not bypass that precedence.

Changing setup requires a restart or `/reload` so the earlier-loaded backend re-reads configuration.

</details>

<details>
<summary><b>Child behavior and boundaries</b></summary>

The backend sets `PI_SUBAGENT_CHILD=1`. The OMPS extension returns immediately — before registering any flag, command, event or tool gate — so it is fully inert inside children: no re-activation, no model changes, no command registration, no recursive setup.

Every agent prompt forbids calling `subagent`, `subagent_wait` and `subagent_supervisor`, and forbids questioning the user directly. A blocked child uses `contact_supervisor` to hand the decision back to the main session.

None of the five agents declare a `tools` allowlist, so ordinary Pi tools and loaded extension tools are not narrowed by OMPS. The read-only nature of `explorer`, `librarian` and `oracle` is enforced by role prompt; `acceptanceRole` only affects backend acceptance inference and grants or revokes nothing.

`maxSubagentDepth=1`, the tool gate and the prompts are orchestration constraints, **not** an OS or container sandbox. A child's real file, shell, network and extension capabilities are still determined by Pi, the loaded tools and the running user's system permissions.

</details>

<details>
<summary><b>Architecture and limits</b></summary>

```text
main Pi
  └─ oh-my-pi-slim: preset, main prompt, native tool_call policy
       └─ pi-subagents: child processes, persistence, events, notification, control, recovery
            └─ package-scoped explorer/librarian/oracle/designer/fixer
```

The scope is deliberately narrow: no second run manager or RPC layer, no dynamically registered replacement tools, no copied agent assets, no simulated backend persistence, and no promise of an OS sandbox. The bundled example seeds only when the user preset file is absent. The schedule-timer gap described above is a real limit.

</details>

## Uninstall

Two steps. First restore your pre-setup settings from inside Pi:

```text
/omps uninstall
```

Then quit Pi and remove the package:

```bash
pi remove git:github.com/YanzuoLu/oh-my-pi-slim
```

Your `~/.pi/agent/oh-my-pi-slim.json` is not deleted, and neither are shared auth, search, questionnaire or other independent packages — `@gotgenes/pi-anthropic-auth`, for example, stays under your management.

## Development

```bash
npm run validate
git diff --check
```

Static validation reads repository files and performs no writes. It checks package/lock/backend versions and load order, the five agent frontmatters, bundled preset completeness, the one-time seed contract, the reversible bootstrap contract, the single-source runtime config, child early return, the native policy gate, schedule canonicalization and the resume new-ID contract. It does not dynamically import the extension and does not touch the network, credentials, your home directory or sibling repositories.

Real child startup, auth inheritance, notification and recovery, schedule timers and checkpoint behavior are integration concerns; this static validation makes no claim to cover those runtime paths.

## License

MIT
