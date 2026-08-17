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

The package manifest loads `./extensions/oh-my-pi-slim/index.ts` and the independent built-in Todo entry at `./extensions/todo/index.ts`. There is no `pi-subagents` dependency or extension entry.

## Built-in Todo

The package always registers one model tool named `todo` in main and child sessions. Todo does not depend on OMPS activation or preset selection. It adds no command, shortcut, or configuration.

```ts
{ action: "list" }
{ action: "update", operations: [
  { op: "append", subject, abstract, blockedBy? },
  { op: "modify", target, newSubject?, abstract?, status?, addBlockedBy?, removeBlockedBy? },
  { op: "clear" }
] }
```

Each task is exactly `{ subject, abstract, status, blockedBy }`. Subjects are trimmed, case-sensitive, globally unique within the session, and matched exactly. `list` returns the complete current-session array in append order, including completed items. It never creates a persistence snapshot.

`update` applies its non-empty operation array to a draft in order and commits once. Any invalid operation cancels the whole update. Dependencies may reference only subjects that already exist at that operation. Renames update every dependency reference atomically. The final graph must have no missing reference, self-dependency, or cycle. Every dependency of an `in_progress` or `completed` item must be completed. Multiple items may be `in_progress` when their dependencies satisfy this rule.

`clear` may appear once anywhere in a batch. At that point, the draft must be empty or contain only completed items. One batch can complete the old group, clear it, and append a new group. Completed items otherwise remain visible until clear.

State belongs to each Pi session and persists only through versioned successful `todo update` tool-result details. Reload, tree navigation, and compaction restore the latest valid snapshot on the current branch. RPC children register the tool but never register the widget.

Foreground TUI sessions show a tree widget above the editor. Each item shows only its subject, followed by `⛓ subject1, subject2` when dependencies exist. Abstracts remain available only in the complete model-facing `list` JSON. The widget displays `Todos (completed/total)`, status glyphs, and at most 12 total lines. Overflow hides completed items first and reports exact hidden status counts. An empty state removes the widget.

An external package that also registers `todo` cannot coexist with the built-in tool. For a local migration, run `pi remove` for that external package separately before loading OMPS. This package never removes or uninstalls external packages automatically.

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

The object may contain any subset of the six specialists; missing roles mean `[]`. Unknown or uninstalled tool names are valid and silently ignored, which keeps configs portable. Unknown role keys, duplicate names, empty names, comma-containing names, and the lifecycle-reserved names `subagent` and `contact_supervisor` are rejected. The old unknown name `subagent_supervisor` is accepted like any other portable deny entry.

Activation validates every configured model and its authentication. The main session model is switched to the orchestrator role. For `create`, OMPS injects the specialist's `provider/model:thinking`; the model-facing schema does not expose model, thinking, context, or tool-policy overrides.

## Runtime contract

### Create runs

```js
subagent({ action: "create", agent: "explorer", abstract: "Map the auth flow", task: "Locate the auth flow and related tests." })
subagent({ action: "create", agent: "observer", abstract: "Analyze the screenshot", task: "Analyze /absolute/path/to/screenshot.png." })
```

Create input is exactly `{ action: "create", agent, abstract, task, cwd? }`; `abstract` is required, trimmed, and stored with the run; `action` is mandatory and action-less launches are rejected. Every create writes a launch config, starts a detached background runner, and immediately returns a run ID. There is no wait tool and the parent never owns an in-process child client. The runner alone owns the Pi RPC child and exchanges lifecycle data with the parent through files.

Child startup uses a complete Pi invocation containing:

- `--mode rpc` and the preset-selected `--model`;
- persistent `--session-dir` under the parent Pi session directory;
- the package specialist body as `--system-prompt`;
- `--exclude-tools <comma-separated exact names>` only when the current role deny list is non-empty;
- a child-only `--extension` that registers `contact_supervisor`;
- `--approve` only for a trusted contained cwd, otherwise `--no-approve`;
- `PI_SUBAGENT_CHILD=1`, `OMPS_SUBAGENT_CHILD=1`, and the run ID, which keep the main OMPS extension inert in children.

At child `session_start`, OMPS activates every tool remaining in Pi's configured registry: all built-in tools plus trusted extension tools discovered for that child session, including global and trusted project-level extensions. The launch-time deny list is applied before this activation, so denied tools remain absent from the active registry, provider schema, and Pi-generated tool prompt metadata. OMPS does not attempt to sandbox unknown future extension capabilities; installed and project-level extensions remain part of the user's trust boundary.

`subagent` is main-session-only because the main extension returns before registering it in children. `contact_supervisor` is child-only and is loaded explicitly. These two lifecycle tools cannot be configured through deny. Deny is reread before every create and resume; already-active children retain the policy captured at launch.

### List, status, notifications, and control

```js
subagent({ action: "list" })
subagent({ action: "steer", id: "run-id", message: "Focus on the parser test." })
subagent({ action: "interrupt", id: "run-id" })
subagent({ action: "reply", id: "waiting-run-id", message: "Proceed with option A." })
```

Completion, supervisor waiting, failure, and interruption enqueue one custom message with `display: true`, `deliverAs: "steer"`, and `triggerTurn: true`. Pi delivers that same message after the current assistant/tool batch at the next safe model boundary, where it appears in the TUI and enters model context; orchestration does not need to yield or wait for idle. The message content contains the complete request, output, or error, while delivery metadata stays in `details` and does not enter model context. No second TUI entry or model message is created. `list` is active-only and status-only: it returns only starting, running, and waiting runs with run ID, agent, abstract, status, liveness, optional source run ID, and waiting reason. It never returns task, the complete request, cwd, model/deniedTools, timestamps, session file, activity, output, error, or terminal history. The waiting lifecycle notification already contains the complete ID-free request; there is no pending query. Dependent progress resumes from lifecycle notifications rather than repeated `list` calls.

`steer`, `interrupt`, and `subagent reply` atomically enqueue token-authenticated files under the run's `control/` directory and return without waiting. `steer` is best-effort. `interrupt` sends an interruption request, while the final notification reports the actual terminal status. The runner applies controls it can accept and publishes the actual transition. Before a terminal state is written, the runner captures final metadata, stops timers/watchers, and fully stops its RPC child, so a saved `sessionFile` is safe to resume.

### Minimal supervisor

A child calls `contact_supervisor` with `need_decision`, `interview_request`, or `progress_update`. Each call yields the child in `waiting`, including progress updates, so the main orchestrator must reply to continue it. Its terminating tool result carries the request in `details`; background runs send a visible main-session notification.

Reply with `subagent({ action: "reply", id: "waiting-run-id", message: "Proceed with option A." })` using the same run ID carried by the waiting request. Reply writes a control message to the still-live detached runner and optimistically returns the journal status to `running`. The runner's next state confirms the transition. A subsequent waiting or terminal transition reaches the orchestrator through another single lifecycle custom message at the next safe model boundary.

### Resume

```js
subagent({ action: "resume", id: "source-run-id", abstract: "Apply follow-up changes", message: "Apply the follow-up." })
```

Resume requires exactly the terminal source run `id`, a new `abstract`, and the continuation `message`; the abstract follows the create contract and must be non-empty after trimming. It is allowed only for a terminal retained run with a saved child session file. It starts a new detached background run with `--session <saved sessionFile>`, preserves the source agent, model/thinking contract, cwd, and child-session context, creates a new run ID with `sourceRunId`, persists the supplied new abstract instead of inheriting the source abstract, and returns immediately. It does not inherit the source run's denied-tool snapshot: the current top-level deny config is reread for the resumed specialist. The source run's launch-time model/thinking string remains a snapshot and is not reread from an edited preset. Resume exposes no launch overrides and refuses a session file already used by an active run.

## Persistence, run files, and shutdown

OMPS reads legacy custom entries with `customType: "oh-my-pi-slim:subagents"` and `version: 1` full-registry snapshots. It then folds later `version: 2` single-run upserts in branch order, replacing a run by ID and skipping malformed entries. Every new logical state write appends only one complete run as a v2 entry. Heartbeats and UI activity stay in `state.json` and never inflate the journal.

Each run is isolated by owner session at `<parent-session-dir>/omps-subagent-runs/<ownerSessionId>/<runId>/`, containing mode-0600 `launch.json`, `runner.json`, and `state.json`, a mode-0700 `control/` inbox, and `runner.log`. `runner.json` binds the run token and PID to a verifiable OS process identity. The parent polls these files at a short interval, validates owner/run/token/process identity before signaling persisted PIDs, and drives notification-based orchestration without blocking waits.

Persisted metadata includes the run ID, role, abstract, task, cwd, model contract, launch-time `deniedTools`, timestamps, status, final output/error, source run ID, supervisor request, and child `sessionFile`. A legacy journal or `launch.json` with a task but no abstract receives the same deterministic fallback: the first 100 Unicode code points of task plus `...`; a present abstract must remain non-blank after trimming. The removed launch-mode field from old v1 data is ignored and not retained.

Detached execution lasts only for the current owner session. Every `session_shutdown`—including reload, new/resume/fork session transitions, and quit—sends interrupt controls to all active owner runs, waits briefly, force-terminates stragglers, and journals `interrupted` while preserving `sessionFile`. Restore never adopts an old live runner: an abnormal leftover is terminated and marked `interrupted`; an already-terminal state remains terminal. Continue later with `resume`, which always creates a new run ID.

## Background-agent UI

TUI sessions show a widget above the editor adapted from `gotgenes/pi-packages`' `packages/pi-subagents` UI. It uses the same tree layout, 80 ms spinner, 12-line cap, active-first overflow policy, status bar, and short finished-run linger. Each active run is an atomic three-line tree entry: the first line shows its spinner or waiting marker, agent, run ID, waiting state, and abstract; the dim second line starts with `(provider) model • thinking` and then shows turns, tool uses, token/context/compaction stats, and elapsed time; the third line shows current activity or the warning-colored supervisor request. The compaction count is observational only and increments exclusively from successful Pi `compaction_end` RPC events; the runner never uses widget usage or compaction counters to trigger checkpoints. Keeping abstract text on the first line prevents it from crowding out the higher-priority model and stats line. The 12-line budget never shows a partial active entry, so at most three complete active runs are visible; overflow remains accurately summarized. `starting` runs still appear as a one-line queued summary, and terminal runs still briefly show one-line outcome entries. The widget is never registered in RPC mode.

The TUI transcript also has package-owned renderers for `subagent` calls and results. Calls show complete action-specific input, including full task, continuation, guidance, reply text, IDs, and cwd. Nonterminal immediate results use compact one-line acknowledgements; an already-terminal or failed result may append its complete final output/error. A new active-run `list` carries and renders only its title and one compact status header with abstract per run; a waiting item may add only its reason, so the new list path never exposes task, activity, output, error, message, or interview data. When replaying an old transcript row that predates abstract, the renderer applies the same 100-code-point fallback from its legacy task field, or shows an explicit unavailable-summary placeholder if neither field exists; it never renders the full task as a separate field. Each lifecycle notification is the same custom message used for model delivery, not a second TUI-only entry. Its collapsed TUI view shows only the compact run header. Press Ctrl+O to expand waiting requests, terminal output/errors, or active live activity. Terminal notifications never repeat stale live response text. Ctrl+O changes only TUI rendering and never changes the custom message content or copies `details` into model context.

## Deliberate scope

The built-in runtime manages one child per run and only the public surfaces documented above. It does not include scripted workflows, schedules, missions, fleets, watchdogs, authored profiles, worktree management, aggregate chain/parallel inputs, or nested child orchestration. Parallelism comes from issuing multiple independent background `subagent` calls from the main session.

Deny/`--exclude-tools` reduces Pi's model-visible tools; it is not an OS sandbox. In particular, `bash` remains as capable as the running user and environment permit.

## Tool-batch checkpoint compaction

The main session and every detached child share the same completed-tool-batch validator, fixed continuation text, and threshold boundary. Each process reads Pi's current `ctx.getContextUsage()` effective context window plus the merged trusted-project `SettingsManager` compaction settings, then applies `shouldCompact`; OMPS does not inspect runner totals, guess provider windows, or hard-code a window size. The mechanism respects Pi's compaction `enabled` switch, so neither main nor child proactively checkpoints while compaction is disabled.

While OMPS is active, the main session keeps its existing behavior: after a complete assistant tool batch crosses that threshold with no queued messages, it calls public `ctx.abort()`, waits for Pi's matching threshold compaction and `agent_settled`, then schedules the fixed prompt as a follow-up continuation turn. A detached child instead queues that same follow-up synchronously inside the matching `session_compact` event (`reason: "threshold"`, `willRetry: false`), so Pi's own post-run queued-message continuation delays the child's single `agent_settled`; no runner marker or terminal protocol is involved. This can repeat across multiple compaction cycles. Any turn that called `contact_supervisor` is skipped completely, preserving the waiting boundary, and a later unrelated compaction cannot resume it. Wrong-reason/retry compactions and aborted runs that settle without the matching compaction are warn-only and do not resume. Tool call IDs and names are not included in the model-visible prompt, and OMPS does not rewrite context copies or compaction settings.

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
