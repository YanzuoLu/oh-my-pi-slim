# oh-my-pi-slim

> Preset-driven main-session orchestration for Pi with a built-in one-child-per-run background runtime.

**English** | [中文](./README.zh-CN.md)

The main Pi session plans, dispatches, supervises, and verifies. Each child is an isolated Pi RPC process with its own persisted session. A preset selects the model and thinking level for the main orchestrator and all six specialist roles.

```bash
pi --omps
```

## The six specialists

| Specialist | Use it for |
| --- | --- |
| `explorer` | Codebase reconnaissance and locating relevant code/tests |
| `librarian` | Official docs, library behavior, version-specific APIs, and public source examples |
| `oracle` | Architecture, risk, debugging strategy, simplification, and review |
| `designer` | UI/UX implementation, review, and visual polish |
| `fixer` | Bounded implementation and verification |
| `observer` | Visual analysis of images, screenshots, PDFs, and diagrams |

`orchestrator` is the preset role for the main session only. Specialists are loaded only from this package's root `agents/` directory with Pi's `parseFrontmatter`; user/project agent manifests do not participate. Role frontmatter contains only `name` and `description`; capabilities are controlled at launch rather than through per-role positive tool allowlists.

## Requirements and install

- Pi 0.84.2-compatible package and RPC APIs.
- All seven provider/model pairs in the selected preset must exist and have configured authentication. The explicitly configured `observer` model must declare image input support.

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

The bundled `config/oh-my-pi-slim.example.json` seeds that file once when it is absent. Existing user presets are never overwritten or removed. Every current preset defines `orchestrator`, `explorer`, `librarian`, `oracle`, `designer`, `fixer`, and `observer`, each with `provider`, `model`, and a thinking level from `off, minimal, low, medium, high, xhigh, max`.

For compatibility, an older preset without `observer` temporarily copies that preset's `explorer` configuration and emits a warning. Activation may continue even when that fallback model lacks image support, but an actual Observer create is rejected until the effective Observer model declares image input. An explicit non-image Observer configuration is rejected during preset activation.

Top-level `deny` configures exact, case-sensitive tool names independently for each specialist:

```json
{
  "deny": {
    "explorer": ["example_extension_tool"],
    "observer": ["example_extension_tool"]
  }
}
```

The object may contain any subset of the six specialists; missing roles mean `[]`. Unknown or uninstalled tool names are valid and silently ignored, which keeps configs portable. Unknown role keys, duplicate names, empty names, comma-containing names, and the lifecycle-reserved names `subagent`, `subagent_supervisor`, and `contact_supervisor` are rejected.

Activation validates every configured model and its authentication. The main session model is switched to the orchestrator role. For `create`, OMPS injects the specialist's `provider/model:thinking`; the model-facing schema does not expose model, thinking, context, or tool-policy overrides.

## Runtime contract

### Create runs

```js
subagent({ action: "create", agent: "explorer", task: "Locate the auth flow and related tests." })
subagent({ action: "create", agent: "observer", task: "Analyze /absolute/path/to/screenshot.png." })
```

Create input is exactly `{ action: "create", agent, task, cwd? }`; `action` is mandatory and action-less launches are rejected. Every create writes a launch config, starts a detached background runner, and immediately returns a run ID. There is no wait tool and the parent never owns an in-process child client. The runner alone owns the Pi RPC child and exchanges lifecycle data with the parent through files.

Child startup uses a complete Pi invocation containing:

- `--mode rpc` and the preset-selected `--model`;
- persistent `--session-dir` under the parent Pi session directory;
- the package specialist body as `--system-prompt`;
- `--exclude-tools <comma-separated exact names>` only when the current role deny list is non-empty;
- a child-only `--extension` that registers `contact_supervisor`;
- `--approve` only for a trusted contained cwd, otherwise `--no-approve`;
- `PI_SUBAGENT_CHILD=1`, `OMPS_SUBAGENT_CHILD=1`, and the run ID, which keep the main OMPS extension inert in children.

At child `session_start`, OMPS activates every tool remaining in Pi's configured registry: all built-in tools plus trusted extension tools discovered for that child session, including global and trusted project-level extensions. The launch-time deny list is applied before this activation, so denied tools remain absent from the active registry, provider schema, and Pi-generated tool prompt metadata. OMPS does not attempt to sandbox unknown future extension capabilities; installed and project-level extensions remain part of the user's trust boundary.

`subagent` and `subagent_supervisor` are main-session-only because the main extension returns before registering them in children. `contact_supervisor` is child-only and is loaded explicitly. None of these lifecycle tools can be configured through deny. Deny is reread before every create and resume; already-active children retain the policy captured at launch.

### List, status, notifications, and control

```js
subagent({ action: "list" })
subagent({ action: "steer", id: "run-id", message: "Focus on the parser test." })
subagent({ action: "interrupt", id: "run-id" })
```

Completion, supervisor waiting, failure, and interruption enqueue one custom message with `display: true`, `deliverAs: "steer"`, and `triggerTurn: true`. Pi delivers that same message after the current assistant/tool batch at the next safe model boundary, where it appears in the TUI and enters model context; orchestration does not need to yield or wait for idle. The message content contains the complete request, output, or error, while delivery metadata stays in `details` and does not enter model context. No second TUI entry or model message is created. `list` is status-only: each retained item contains only run ID, agent, status, liveness, optional source run ID, and—while waiting—the request ID and reason. It never returns task, cwd, model/deniedTools, timestamps, session file, activity, output, error, or other historical results. Use `subagent_supervisor({ action: "pending" })` for the complete waiting request. Dependent progress resumes from lifecycle notifications rather than repeated `list` calls.

`steer`, `interrupt`, and supervisor replies atomically enqueue token-authenticated files under the run's `control/` directory and return without waiting. `steer` is best-effort. `interrupt` sends an interruption request, while the final notification reports the actual terminal status. The runner applies controls it can accept and publishes the actual transition. Before a terminal state is written, the runner captures final metadata, stops timers/watchers, and fully stops its RPC child, so a saved `sessionFile` is safe to resume.

### Minimal supervisor

A child calls `contact_supervisor` with `need_decision`, `interview_request`, or `progress_update`. Each call yields the child in `waiting`, including progress updates, so the main orchestrator must reply to continue it. Its terminating tool result carries the request in `details`; background runs send a visible main-session notification.

```js
subagent_supervisor({ action: "pending" })
subagent_supervisor({ action: "reply", replyTo: "request-id", message: "Proceed with option A." })
```

Reply writes a control message to the still-live detached runner and optimistically returns the journal status to `running`. The runner's next state confirms the transition. A subsequent waiting or terminal transition reaches the orchestrator through another single lifecycle custom message at the next safe model boundary.

### Resume

```js
subagent({ action: "resume", id: "source-run-id", message: "Apply the follow-up." })
```

Resume is allowed only for a terminal retained run with a saved child session file. It starts a new detached background run with `--session <saved sessionFile>`, preserves the source agent, model/thinking contract, cwd, and child-session context, creates a new run ID with `sourceRunId`, and returns immediately. It does not inherit the source run's denied-tool snapshot: the current top-level deny config is reread for the resumed specialist. The source run's launch-time model/thinking string remains a snapshot and is not reread from an edited preset. Resume exposes no launch overrides and refuses a session file already used by an active run.

## Persistence, run files, and shutdown

OMPS reads legacy custom entries with `customType: "oh-my-pi-slim:subagents"` and `version: 1` full-registry snapshots. It then folds later `version: 2` single-run upserts in branch order, replacing a run by ID and skipping malformed entries. Every new logical state write appends only one complete run as a v2 entry. Heartbeats and UI activity stay in `state.json` and never inflate the journal.

Each run is isolated by owner session at `<parent-session-dir>/omps-subagent-runs/<ownerSessionId>/<runId>/`, containing mode-0600 `launch.json`, `runner.json`, and `state.json`, a mode-0700 `control/` inbox, and `runner.log`. `runner.json` binds the run token and PID to a verifiable OS process identity. The parent polls these files at a short interval, validates owner/run/token/process identity before signaling persisted PIDs, and drives notification-based orchestration without blocking waits.

Persisted metadata includes the run ID, role, task, cwd, model contract, launch-time `deniedTools`, timestamps, status, final output/error, source run ID, supervisor request, and child `sessionFile`. The removed launch-mode field from old v1 data is ignored and not retained.

Detached execution lasts only for the current owner session. Every `session_shutdown`—including reload, new/resume/fork session transitions, and quit—sends interrupt controls to all active owner runs, waits briefly, force-terminates stragglers, and journals `interrupted` while preserving `sessionFile`. Restore never adopts an old live runner: an abnormal leftover is terminated and marked `interrupted`; an already-terminal state remains terminal. Continue later with `resume`, which always creates a new run ID.

## Background-agent UI

TUI sessions show a widget above the editor adapted from `gotgenes/pi-packages`' `packages/pi-subagents` UI. It uses the same tree layout, 80 ms spinner, 12-line cap, active-first overflow policy, status bar, and short finished-run linger. Each active run is an atomic three-line tree entry: the first line shows its spinner or waiting marker, agent, run ID, waiting state, and task; the dim second line starts with `(provider) model • thinking` and then shows turns, tool uses, token/context/compaction stats, and elapsed time; the third line shows current activity or the warning-colored supervisor request. Keeping task text on the first line prevents it from crowding out the higher-priority model and stats line. The 12-line budget never shows a partial active entry, so at most three complete active runs are visible; overflow remains accurately summarized. `starting` runs still appear as a one-line queued summary, and terminal runs still briefly show one-line outcome entries. The widget is never registered in RPC mode.

The TUI transcript also has package-owned renderers for `subagent` and `subagent_supervisor` calls and results. Calls show complete action-specific input, including full task, continuation, guidance, reply text, IDs, and cwd. Nonterminal immediate results use compact one-line acknowledgements; an already-terminal or failed result may append its complete final output/error. A retained-run `list` renders only its title and one compact status header per run; a waiting item may add only its request ID and reason. It never renders historical task, activity, output, error, message, or interview data. Each lifecycle notification is the same custom message used for model delivery, not a second TUI-only entry: waiting notifications show the complete request, terminal notifications show complete output/error, and active notifications may show explicitly labeled live response/tool activity. Terminal notifications never repeat stale live response text. Rendering is independent of tool expansion state and does not copy message `details` into model context.

## Deliberate scope

The built-in runtime manages one child per run and only the public surfaces documented above. It does not include scripted workflows, schedules, missions, fleets, watchdogs, authored profiles, worktree management, aggregate chain/parallel inputs, or nested child orchestration. Parallelism comes from issuing multiple independent background `subagent` calls from the main session.

Deny/`--exclude-tools` reduces Pi's model-visible tools; it is not an OS sandbox. In particular, `bash` remains as capable as the running user and environment permit.

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
