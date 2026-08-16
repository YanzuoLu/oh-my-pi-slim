# oh-my-pi-slim

> Preset-driven main-session orchestration for Pi with a built-in one-child-per-run background runtime.

**English** | [中文](./README.zh-CN.md)

The main Pi session plans, dispatches, supervises, and verifies. Each child is an isolated Pi RPC process with its own persisted session. A preset selects the model and thinking level for the main orchestrator and all five specialist roles.

```bash
pi --omps
```

## The five agents

| Agent | Tool allowlist | Use it for |
| --- | --- | --- |
| `explorer` | `read`, `grep`, `find`, `ls`, `bash`, `contact_supervisor` | Codebase reconnaissance and locating relevant code/tests |
| `librarian` | `read`, `grep`, `find`, `ls`, `bash`, `web_search`, `web_fetch`, `batch_web_fetch`, `contact_supervisor` | Official docs, library behavior, version-specific APIs |
| `oracle` | `read`, `grep`, `find`, `ls`, `bash`, `contact_supervisor` | Architecture, risk, debugging strategy, review |
| `designer` | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, `contact_supervisor` | UI/UX implementation and polish |
| `fixer` | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`, `contact_supervisor` | Bounded implementation and verification |

`orchestrator` is the preset role for the main session only. Agents are loaded only from this package's root `agents/` directory with Pi's `parseFrontmatter`; user/project agent manifests do not participate.

## Requirements and install

- Pi 0.84.2-compatible package and RPC APIs.
- All six provider/model pairs in the selected preset must exist and have configured authentication.

```bash
pi install git:github.com/YanzuoLu/oh-my-pi-slim
```

The package manifest loads only `./extensions/oh-my-pi-slim/index.ts`. There is no `pi-subagents` dependency or extension entry.

## Commands

| Command | Effect |
| --- | --- |
| `/omps on [preset]` | Enable orchestration, optionally selecting a preset |
| `/omps off` | Disable orchestration and restore the prior main model/thinking |
| `/omps status` | Show activation state |
| `/omps presets` | List presets |
| `/preset [name]` | Switch preset; bare command lists presets |
| `/omps uninstall` | Clean old OMPS backend migration state, then show the package removal command |

`/reload` restores the active preset through a one-shot in-process slot. New, resumed, or forked parent sessions do not inherit that slot.

## Presets

The only runtime preset source is:

```text
~/.pi/agent/oh-my-pi-slim.json
```

The bundled `config/oh-my-pi-slim.example.json` seeds that file once when it is absent. Existing user presets are never overwritten or removed. Every preset defines `orchestrator`, `explorer`, `librarian`, `oracle`, `designer`, and `fixer`, each with `provider`, `model`, and a thinking level from `off, minimal, low, medium, high, xhigh, max`.

Activation validates every configured model and its authentication. The main session model is switched to the orchestrator role. For fresh child calls, OMPS injects the specialist's `provider/model:thinking` after tool-schema validation; the model-facing schema does not expose model, thinking, context, or tool overrides.

## Runtime contract

### Fresh runs

```js
subagent({ agent: "explorer", task: "Locate the auth flow and related tests." })
subagent({ agent: "oracle", task: "Review this narrow API decision." })
```

Fresh input is exactly `{ agent, task, cwd? }`. Every fresh call writes a launch config, starts a detached background runner, and immediately returns a run ID. There is no wait tool and the parent never owns an in-process child client. The runner alone owns the Pi RPC child and exchanges lifecycle data with the parent through files.

Child startup uses a complete Pi invocation containing:

- `--mode rpc` and the preset-selected `--model`;
- persistent `--session-dir` under the parent Pi session directory;
- the package agent body as `--system-prompt`;
- `--tools` with the agent frontmatter's strict allowlist;
- a child-only `--extension` that registers `contact_supervisor`;
- `--approve` only for a trusted contained cwd, otherwise `--no-approve`;
- `PI_SUBAGENT_CHILD=1`, `OMPS_SUBAGENT_CHILD=1`, and the run ID, which keep the main OMPS extension inert in children.

Ambient extensions remain discoverable, so librarian web tools can load, but only allowlisted names are model-visible. `subagent` and `subagent_supervisor` are absent from every child allowlist.

### List, status, notifications, and control

```js
subagent({ action: "list" })
subagent({ action: "steer", id: "run-id", message: "Focus on the parser test." })
subagent({ action: "interrupt", id: "run-id" })
```

Completion, supervisor waiting, failure, and interruption send hidden `followUp` notifications with `triggerTurn: true`, waking the main orchestrator. Notifications contain the complete request, output, or error. `list` returns every retained run, including its status and complete output, and supports one-time inspection and reconciliation. Dependent progress resumes from follow-up notifications rather than repeated `list` calls.

`steer`, `interrupt`, and supervisor replies atomically enqueue token-authenticated files under the run's `control/` directory and return without waiting. `steer` is best-effort. `interrupt` sends an interruption request, while the final notification reports the actual terminal status. The runner applies controls it can accept and publishes the actual transition. Before a terminal state is written, the runner captures final metadata, stops timers/watchers, and fully stops its RPC child, so a saved `sessionFile` is safe to resume.

### Minimal supervisor

A child calls `contact_supervisor` with `need_decision`, `interview_request`, or `progress_update`. Each call yields the child in `waiting`, including progress updates, so the main orchestrator must reply to continue it. Its terminating tool result carries the request in `details`; background runs send a hidden main-session notification.

```js
subagent_supervisor({ action: "pending" })
subagent_supervisor({ action: "reply", replyTo: "request-id", message: "Proceed with option A." })
```

Reply writes a control message to the still-live detached runner and optimistically returns the journal status to `running`. The runner's next state confirms the transition. A subsequent waiting or terminal transition wakes the orchestrator through another hidden notification.

### Resume

```js
subagent({ action: "resume", id: "source-run-id", message: "Apply the follow-up." })
```

Resume is allowed only for a terminal retained run with a saved child session file. It starts a new detached background run with `--session <saved sessionFile>`, preserves agent/model/thinking/tools/cwd, creates a new run ID, and returns immediately. Resume exposes no launch overrides and refuses a session file already used by an active run.

## Persistence, run files, and shutdown

OMPS reads legacy custom entries with `customType: "oh-my-pi-slim:subagents"` and `version: 1` full-registry snapshots. It then folds later `version: 2` single-run upserts in branch order, replacing a run by ID and skipping malformed entries. Every new logical state write appends only one complete run as a v2 entry. Heartbeats and UI activity stay in `state.json` and never inflate the journal.

Each run is isolated by owner session at `<parent-session-dir>/omps-subagent-runs/<ownerSessionId>/<runId>/`, containing mode-0600 `launch.json`, `runner.json`, and `state.json`, a mode-0700 `control/` inbox, and `runner.log`. `runner.json` binds the run token and PID to a verifiable OS process identity. The parent polls these files at a short interval, validates owner/run/token/process identity before signaling persisted PIDs, and drives hidden notification-based orchestration without blocking waits.

Persisted metadata includes the run ID, role, task, cwd, model contract, tool allowlist, timestamps, status, final output/error, source run ID, supervisor request, and child `sessionFile`. The removed launch-mode field from old v1 data is ignored and not retained.

Detached execution lasts only for the current owner session. Every `session_shutdown`—including reload, new/resume/fork session transitions, and quit—sends interrupt controls to all active owner runs, waits briefly, force-terminates stragglers, and journals `interrupted` while preserving `sessionFile`. Restore never adopts an old live runner: an abnormal leftover is terminated and marked `interrupted`; an already-terminal state remains terminal. Continue later with `resume`, which always creates a new run ID.

## Background-agent UI

TUI sessions show a widget above the editor adapted from `gotgenes/pi-packages`' `packages/pi-subagents` UI. It uses the same tree layout, 80 ms spinner, 12-line cap, active-first overflow policy, status bar, and short finished-run linger. Each active run is an atomic three-line tree entry: the first line shows its spinner or waiting marker, agent, run ID, waiting state, and task; the dim second line starts with `(provider) model • thinking` and then shows turns, tool uses, token/context/compaction stats, and elapsed time; the third line shows current activity or the warning-colored supervisor request. Keeping task text on the first line prevents it from crowding out the higher-priority model and stats line. The 12-line budget never shows a partial active entry, so at most three complete active runs are visible; overflow remains accurately summarized. `starting` runs still appear as a one-line queued summary, and terminal runs still briefly show one-line outcome entries. The widget is never registered in RPC mode.

## Deliberate scope

The built-in runtime manages one child per run and only the public surfaces documented above. It does not include scripted workflows, schedules, missions, fleets, watchdogs, authored profiles, worktree management, aggregate chain/parallel inputs, or nested child orchestration. Parallelism comes from issuing multiple independent background `subagent` calls from the main session.

Tool allowlists constrain Pi's model-visible tools; they are not an OS sandbox. In particular, `bash` remains as capable as the running user and environment permit.

## Tool-batch checkpoint compaction

The existing main-session checkpoint behavior is retained. While OMPS is active, a complete assistant tool batch can trigger Pi's native threshold compaction using `SettingsManager` and `shouldCompact`. OMPS validates the completed batch internally, calls public `ctx.abort()`, waits for Pi's matching threshold compaction and `agent_settled`, then sends the package's fixed auto-continue prompt as a follow-up continuation turn. Tool call IDs and names are not included in that model-visible prompt. It does not rewrite context copies or compaction settings.

## Bootstrap and uninstall

Bootstrap now seeds only the user preset. It no longer maintains `settings.subagents.disableBuiltins` or `extensions/subagent/config.json`. On startup it performs a one-time safe cleanup for migration state left by older OMPS releases, restoring old values only when the still-present value matches what OMPS previously applied.

To uninstall:

```text
/omps uninstall
```

Then exit Pi and run:

```bash
pi remove git:github.com/YanzuoLu/oh-my-pi-slim
```

The user preset is preserved.

## Development

```bash
npm test
npm run validate
git diff --check
```

Tests cover detached launch configs, runner survival, control files, journal reconciliation, shutdown interruption, resume, grace windows, terminal ordering, notification wakeups, and exact activity UI formatting. Static validation rejects in-process runtime client code and requires the detached runner, launch, poller, and control protocol. A real authenticated model run is intentionally not required by the automated suite.

## License

MIT
