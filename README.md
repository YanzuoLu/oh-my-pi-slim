# oh-my-pi-slim

> Preset-driven Pi orchestration with built-in background runs, runtime loops, and session todos.

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

Foreground TUI sessions show a tree widget above the editor. Each item shows only its subject, followed by `⛓ subject1, subject2` when dependencies exist. Abstracts stay out of the widget and remain in the complete model-facing `list` JSON. The widget displays `● Todos (completed/total)`, status glyphs, and at most 12 total lines. Overflow hides completed items first and reports exact hidden status counts. An empty state removes the widget.

Todo call and result renderers follow the same Ctrl+O contract as subagent transcripts. Collapsed list calls show only the title and action. Collapsed update calls show the operation total and append/modify/clear counts. Expanded update calls show every operation in input order with complete fields, abstracts, and dependency lists. Collapsed update results show changed and no-change counts without repeating input. Expanded results show stable numbered receipts. Collapsed list results show only `● Todos (completed/total)`; expanded results show each task's subject, abstract, status, and dependencies. Fallbacks collapse to a safe first line and expand to complete text. Ctrl+O changes only TUI rendering and never changes list JSON, update receipt content, or tool-result details.

An external package that also registers `todo` cannot coexist with the built-in tool. For a local migration, run `pi remove` for that external package separately before loading OMPS. This package never removes or uninstalls external packages automatically.

## Built-in Loop

The package owns one `/loop` command and one model tool named `loop`. Both register whenever the package loads in a main session, even when OMPS orchestration is inactive. The existing child-environment early return prevents both surfaces from registering in child sessions; there is no child replay path.

The command does not parse requests. It forwards any natural-language `/loop ...` invocation unchanged as a real user message with prompt-template expansion disabled. When Pi is busy, that message uses `deliverAs: "steer"`. Model guidance allows `create` only when the latest user message starts with `/loop`; ordinary natural-language requests may list, modify, pause, resume, or delete loops, but may not create one. For a bare `/loop`, the model calls `list` and explains `/loop <interval> <prompt>`.

The single sequential tool has six actions and strict action-specific fields:

```ts
{ action: "create", interval, abstract, prompt }
{ action: "delete", id }
{ action: "modify", id, interval?, abstract?, prompt? }
{ action: "list" }
{ action: "pause", id }
{ action: "resume", id }
```

`modify` requires at least one changed-field input. IDs are exact eight-character lowercase hexadecimal values; a missing or unknown ID is an error. Duplicate loop configurations are allowed. `abstract` is the short human-readable summary used by compact UI surfaces. `prompt` is the complete self-contained instruction delivered to every future model turn; it may be arbitrarily long and is not a shorthand for the abstract.

Intervals use exactly one positive integer and one lowercase unit from `s`, `m`, `h`, or `d`. The inclusive range is `10s` through `7d`. Stored values use the largest exactly divisible unit, so `60s` becomes `1m`, `120m` becomes `2h`, and `48h` becomes `2d`.

Each loop uses repeating fixed-delay scheduling with recursive one-shot timeouts. Create waits one complete interval before the first fire. Resume also waits one complete interval. Each later timeout starts only after the prior tick finishes. There is no maximum fire count, expiry, loop-count limit, backlog limit, or coalescing.

`pause` clears the timer, sets `nextFireAt` to `null`, and cancels that loop's undelivered compaction-gated fires. Repeating pause is a successful no-change. `resume` restarts from the resume time and repeating resume is a successful no-change. Paused loops may be modified. An effective interval change on an active loop restarts the full delay; an equivalent canonical interval is a no-change. Abstract-only or prompt-only changes preserve the active `nextFireAt`. A fire already captured by the delivery gate keeps its immutable old abstract, interval, and prompt. `delete` removes the loop without a tombstone or history.

Loop state is runtime-only. It never uses `appendEntry`, a journal, files, or snapshot persistence. Compaction and tree navigation preserve loops, timers, and gated fire records. Reload, new session, resumed session, fork, and quit clear every loop. Tree and compaction host operations use the shared notification pause gate, then release matching records in FIFO order without changing subagent notification content or delivery semantics.

Every tick creates an independent package custom message with `deliverAs: "steer"` and `triggerTurn: true`. Content and details include the ID, abstract, canonical interval, successful fire count, fire time, and complete prompt. Every queued fire remains distinct; delivery never merges or coalesces records. `fireCount` increases only after `sendMessage` succeeds. A thrown send increments `failureCount`, `lastFailedAt`, and `lastError`; a later success clears `lastError` without erasing failure history.

`list` returns creation order and the complete public JSON for every loop:

```json
{
  "id": "1a2b3c4d",
  "abstract": "Review the latest project state",
  "prompt": "Read the complete state and report relevant changes.",
  "interval": "1m",
  "status": "active",
  "createdAt": "2026-05-01T00:00:00.000Z",
  "updatedAt": "2026-05-01T00:00:00.000Z",
  "nextFireAt": "2026-05-01T00:01:00.000Z",
  "fireCount": 0,
  "failureCount": 0,
  "lastFiredAt": null,
  "lastFailedAt": null,
  "lastError": null
}
```

Foreground TUI sessions show a package-owned widget above the editor. Its heading is `● Loops (active/total)`. Each visible loop uses an atomic two-line tree entry: the first line shows `↻` for active, `!` after a delivery error, or `Ⅱ` for paused, followed by abstract and ID; the second shows `Every <interval>`, a once-per-second countdown or paused state, fire count, and current failure text. Active loops sort first by `nextFireAt`; paused loops follow by `createdAt`. The widget uses at most 12 lines, shows at most five loops, and reports `… n more` overflow. RPC sessions never register it.

Package-owned call, result, and fire renderers follow the Ctrl+O data invariant. Collapsed views stay compact and show the expansion hint. Expanded views show complete action-specific input, all public list fields, full errors, and complete prompts. Ctrl+O changes only TUI rendering; it never changes tool-call arguments, model-facing content, custom-message details, list JSON, or mutation receipts.

## Commands

| Command | Effect |
| --- | --- |
| `/omps on [preset]` | Enable orchestration, optionally selecting a preset |
| `/omps off` | Disable orchestration and restore the prior main model/thinking |
| `/omps status` | Show activation state |
| `/omps presets` | List presets |
| `/preset [name]` | Switch preset; bare command lists presets |
| `/loop [request]` | Forward the unchanged request to the model for runtime loop management |
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

During manual, threshold, or overflow compaction, main-session lifecycle notifications pause like text already queued in Pi's input box. Release after `session_compact` or compaction abort is deferred with `setImmediate`, so Pi can publish `compaction_end` and the interactive host can start any queued user turn first. The unchanged steer notification then enters that active turn; if no user turn starts, unchanged `triggerTurn: true` starts one. OMPS checkpoint compaction keeps the gate closed until its fixed continuation turn starts, then applies the same deferred release. Notifications remain pending until their normal delivered-message acknowledgement.

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

The TUI transcript also has package-owned renderers for `subagent` calls and results. Collapsed calls retain the styled title, action, and identifying fields while hiding long task, continuation, guidance, and reply bodies. Create retains agent and abstract; resume retains source run and abstract; steer, interrupt, and reply retain the run ID. Press Ctrl+O to show the complete action-specific input, including cwd and full bodies. Nonterminal immediate results remain compact one-line acknowledgements in both views. Collapsed terminal results show only their compact acknowledgement; expanded terminal results add complete final output/error. Collapsed active-run lists show the title, count, and compact status headers with abstracts. Expanded lists also show waiting reasons, while both views exclude task, activity, output, error, message, and interview data. Result fallbacks collapse to a safe first line and expand to complete text. When replaying an old transcript row that predates abstract, the renderer applies the same 100-code-point fallback from its legacy task field, or shows an explicit unavailable-summary placeholder if neither field exists; it never renders the full task as a separate field. Each lifecycle notification is the same custom message used for model delivery, not a second TUI-only entry. Its collapsed TUI view shows only the compact run header. Ctrl+O expands waiting requests, terminal output/errors, or active live activity. Terminal notifications never repeat stale live response text. Ctrl+O changes only TUI rendering and never changes tool or custom-message content/details or copies `details` into model context.

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
