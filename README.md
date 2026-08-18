# oh-my-pi-slim

> Preset-driven Pi orchestration with built-in background runs, loops, monitors, structured questions, durable goals, and session todos.

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

## Tool availability

On supported POSIX systems, a main session gets exactly the six package tools `ask_user_question`, `goal`, `loop`, `monitor`, `subagent`, and `todo`. A detached child gets exactly `contact_supervisor` and `todo` from this package. Ask, Goal, Monitor, Loop, and subagent are main-only because the main extension returns before registration in child environments; Todo is an independent entry loaded in both environments, and `contact_supervisor` is loaded only by the child launcher. Monitor is omitted on Windows.

Ask, Goal, and Monitor register as soon as the package loads; they do not depend on `/omps on`, `--omps`, or an active preset. Loop has the same load-time independence. Goal's phase reminder can therefore appear for an active Goal even while the orchestrator preset is inactive; it is an invisible per-run message, not Goal-specific dynamic system-prompt rewriting or a `context` hook. RPC sessions expose the same supported tools but never register package widgets. JSON and print modes remove Ask from the active tool set because they cannot service dialogs.

Every package-owned expandable tool row or custom notification uses the same data invariant: collapsed rendering includes a `(ctrl+o to expand)` hint, expanded rendering reveals the complete public detail, and Ctrl+O never changes tool arguments, model-visible content, result details, or persisted state.

## Migration from external packages

The built-in Ask registers the same tool name as `npm:@juicesharp/rpiv-ask-user-question`, so the two packages cannot coexist. Built-in Monitor replaces `npm:@aliou/pi-processes`; it does not import or call that package. Before a local install, remove the external packages in separate Pi operations:

```bash
pi remove npm:@juicesharp/rpiv-ask-user-question
pi remove npm:@aliou/pi-processes
```

Also remove `ask_user_question` from any user specialist deny lists. Detached children do not register Ask at all, so denying that name in child policy is obsolete. These are explicit user migration steps: this package never runs `pi remove`, edits user package settings, or rewrites user deny lists automatically.

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

Todo call and result renderers follow the same Ctrl+O contract as subagent transcripts. Collapsed list and update calls show only the title and action. Expanded update calls show every operation in input order with complete fields, abstracts, and dependency lists. Collapsed update results show the operation summary `Applied <append> append · <modify> modify · <clear> clear → <changed> changed · <no-change> no-change`; expanded results add stable numbered receipts. Collapsed list results show only `● Todos (completed/total)`; expanded results show each task's subject, abstract, status, and dependencies. Fallbacks collapse to a safe first line and expand to complete text. Ctrl+O changes only TUI rendering and never changes list JSON, update receipt content, or tool-result details.

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

## Built-in Monitor

Monitor is a main-session-only POSIX tool with four sequential actions:

```ts
{ action: "create", abstract, command, cwd?, notifyOn? }
{ action: "delete", id }
{ action: "list" }
{ action: "status", id, start?, end? }
```

`create` requires a trimmed human-readable `abstract` and one foreground Bash `command`; `cwd` defaults to the session cwd. `notifyOn` accepts at most 20 unique, non-empty, case-sensitive literal strings, each at most 500 characters. Monitor IDs are exact eight-character lowercase hexadecimal strings. There is no monitor-count limit.

The runtime resolves an absolute executable Bash, starts `bash -lc <command>` in a new detached POSIX process group, owns that group, ignores stdin, and captures stdout and stderr through pipes. It never provides stdin, a PTY, or interactive terminal semantics. The model guidelines require a foreground command and prohibit `nohup`, `setsid`, `disown`, a trailing `&`, or another daemon escape. This is guidance, not a shell parser or sandbox: a command can still deliberately detach descendants, and bounded TERM/KILL cleanup may return a warning that such a descendant remains.

`list` is compact and returns only `{ id, status, abstract }`. Running monitors come first in creation order; terminal monitors follow in reverse end-time order. `status` returns the complete bounded operational record, including command, cwd, PID, lifecycle timestamps, exit/signal/error, match and notification counters, log rollover counters, and combined stdout/stderr lines. Pagination is reverse-offset based: `start` skips that many newest retained records, `end` is the exclusive reverse offset, the default window is `0..100`, the maximum window is 2,000 lines, and returned lines are restored to chronological order.

Monitor state is runtime-owned and never enters the Pi session journal. Logs live in a mode-0700 directory created under the OS temporary directory, with mode-0600 JSONL files. Each combined log rolls at 64 MiB and keeps approximately the newest 32 MiB of complete records plus a rollover marker; counters report dropped bytes and lines. A partial line is bounded to 64 KiB before a truncation suffix. Tool content is bounded to 50 KiB, notification content to 50 KiB, notification details to 96 KiB, and status line collection is additionally bounded before serialization.

Literal matches are collected into 100 ms batches. A batch can carry at most 100 new combined lines. Matcher delivery is globally limited to 20 batches per rolling minute; suppressed batches are summarized after the window reopens. Match, rate-summary, and terminal events use visible custom messages with `deliverAs: "steer"` and `triggerTurn: true`, share the package notification pause gate, retry safely after agent settlement, and remain pending until the delivered message is acknowledged. Terminal records and logs remain available for `status` until explicit `delete` or session teardown. `delete` cancels still-gated notifications for that monitor, sends bounded process-group TERM then KILL when needed, removes the record and log, and reports forced-cleanup warnings. Once a notification has already been handed to Pi, deleting the monitor cannot retract that message.

A running monitor or an unacknowledged terminal monitor notification blocks Goal continuation. This prevents Goal from racing past background work before its terminal evidence is delivered. Reload, new/resumed/forked session transitions, and quit shut down every monitor, remove the temporary log root, and clear all Monitor state.

Foreground TUI sessions show `● Monitors (running/total)` above the editor. Running entries sort before terminal entries, the widget shows at most ten monitors and twelve total lines, and output-driven refreshes are throttled/coalesced. RPC sessions have no widget. Monitor call, result, matcher, summary, and terminal renderers are package-owned: collapsed views include the Ctrl+O hint, while expanded views show action fields, operational state, combined lines, matches, omissions, truncation, and forced-delete warnings without mutating model-facing data.

## Built-in Ask

Ask is the main-session-only `ask_user_question` sequential tool. Its strict provider-portable schema is compatible with one through four questions and two through four authored options per question:

```ts
{
  questions: [{
    question,
    header,          // at most 16 characters
    options: [{
      label,         // at most 60 characters
      description,
      preview?       // single-select only
    }],
    multiSelect?
  }]
}
```

Questions and option labels must be exact-unique within their scopes. `Other`, `Type something.`, and `Next` are reserved option labels. A recommended option is authored first and appends `(Recommended)` to its label. `preview` is rejected on a multi-select question.

The foreground TUI uses one bottom-centered full-width overlay with tabs for all questions. Tabs wrap in both directions and preserve per-question drafts. A single-select question accepts one authored option or a custom inline response. A multi-select question toggles authored options in authored order, permits an empty selection, or replaces the selection with one custom response. Single-select previews render beside the option list on wide terminals and stack below it on narrow terminals. The questionnaire can return complete, partial, cancelled-with-partial, empty multi-select, empty custom, or zero-answer/empty-submit outcomes; an empty submit is represented as a cancelled partial result with `cancelReason: "empty_submit"` rather than as a tool error.

RPC mode uses Pi's native `select` and `input` extension UI requests, including explicit Submit, Cancel, and Done controls; it never tries to instantiate the TUI overlay. JSON and print modes deactivate Ask and retain a no-UI execution backstop. There is no paid or nested model call inside Ask.

Ask is single-flight: at most one dialog is active, later calls queue, and only the active dialog counts as waiting. Tool abort, session switch/fork/tree navigation, reset, and shutdown reject active and queued calls with `AbortError` exactly once. User cancellation is a normal result, not an abort. A validated call is hard-rejected before opening UI whenever a Goal is active, because active Goal prompts prohibit user questions.

Ask has no persistence, notification message, widget, slash command, configuration, i18n layer, notes field, or Ask-specific answer-collapse feature. It only owns its call/result transcript renderers. Collapsed rows include the Ctrl+O expansion hint; expanded rows show all questions, options, descriptions, single-select previews, confirmed answers, unanswered questions, and cancellation reason without changing the tool envelope.

## Built-in Goal

Goal is a main-session-only durable scheduler surface consisting of the raw-forwarding `/goal` command and one sequential `goal` tool with exactly seven actions:

```ts
{ action: "create", abstract, objective, criteria }
{ action: "modify", abstract, objective, criteria }
{ action: "status" }
{ action: "pause", reason }
{ action: "resume" }
{ action: "complete", evidence }
{ action: "cancel", reason }
```

`/goal ...` does not parse the request. It forwards the exact text as a real user message with prompt-template expansion disabled, using `deliverAs: "steer"` only when Pi is busy. Model guidance permits `create` only when the latest user message starts with `/goal`; a bare `/goal` calls `status` and explains `/goal <objective>`.

There is zero or one Goal on the current branch. `create` requires a short abstract, a complete objective, and one through eight non-empty completion criteria. It is allowed only when no Goal exists or the previous Goal is terminal. `modify` replaces the complete contract of any nonterminal Goal and makes it active. `complete` is valid only while active and requires exactly one non-empty evidence item for every criterion. The public Goal status contains the contract, lifecycle timestamps, retry/no-progress fields, pause or cancel reason, and completion evidence; it exposes no public Goal ID, revision, ownership list, continuation count, or execution statistics.

Goal state uses strict version-1 branch-local snapshots appended as non-context custom entries. Replay selects the latest valid snapshot on the active branch and skips malformed records. Reload/startup, resumed/forked sessions, and tree restoration convert an `active` or `retry_wait` Goal to `paused` with reason `session_restored`; Goal never silently resumes after host restoration. Completion and cancellation are terminal, although a later explicit `/goal` create may replace a terminal Goal.

The public state transitions are:

- `create` → `active`; `modify` and effective `resume` → `active`.
- `pause` moves `active` or `retry_wait` to `paused`; repeated pause is a successful no-change.
- Repeated resume while active is a successful no-change. Resume from paused or retry wait clears retry/no-progress metadata.
- `complete` moves only `active` to `completed`; `cancel` moves any nonterminal state to `cancelled`.
- A provider error moves a pursuing Goal to `retry_wait`. Frozen backoff delays are 10 s, 30 s, 1 min, 5 min, 15 min, then 1 hour for every later attempt. A successful later run clears retry metadata.
- A user abort pauses with `user_abort`; OMPS's own checkpoint abort does not. Three automatic continuation runs with no tool call, package lifecycle change, or external user input pause with `no_progress`.

Goal continuation is the lowest-priority package scheduler. It waits until Pi is idle with no pending messages, no checkpoint, no tree/compaction notification pause, no active subagent, no pending subagent notification, no running Monitor, no unacknowledged terminal Monitor notification, and no waiting Ask. It also binds deferred work to the current session, branch leaf, Goal snapshot, and external-input generation. The continuation itself is one visible custom message with `deliverAs: "steer"` and `triggerTurn: true`; acknowledgement prevents duplicate delivery.

The frozen activation and continuation prompts always restate the abstract, objective, and numbered criteria, followed by these rules:

```text
Pursue this Goal now.                         # activation only
Do not ask the user questions while this Goal is active.
Continue until every criterion has concrete evidence.  # activation
Continue making concrete progress toward every criterion.  # continuation
Use Todo, Monitor, and Subagents when useful.
If safe progress is blocked, call `goal pause` with a concrete reason.
Call `goal complete` only with one evidence entry for every criterion.
```

Before every run for an active Goal, the package adds a separate invisible phase message containing `You are pursuing the active Goal: <abstract>` and a concrete-progress reminder. This Goal phase reminder can appear even when OMPS orchestration is inactive. Goal does not dynamically rewrite the system prompt for this reminder and does not register a `context` mutation hook. The older file-tool nudge mechanism has been removed completely.

Every subagent created while a Goal is active becomes Goal-owned. Main statistics are derived from branch assistant/tool-result/compaction usage during pursuing states. Child token/tool/turn/compaction totals are aggregated from private, session-owned mode-0600 sidecar records and survive terminal run-directory cleanup; writes are best-effort and never affect child lifecycle. Ownership and statistics drive only the Goal widget and scheduler bookkeeping, never `goal status`.

The foreground widget is exactly two lines and keeps this order. Line one is `● Goal · <status glyph> <status> · <abstract>`. Line two is elapsed time, continuation count, owned run count, optional retry countdown or pause reason, then main token/tool/turn/compaction totals, then child totals. It refreshes countdown/elapsed text once per second, uses `↻`, `◷`, `Ⅱ`, `✓`, and `×` for active, retry wait, paused, completed, and cancelled, and disappears when no Goal exists. RPC and print sessions have no widget.

Goal call/result, continuation, and automatic-state notifications are package-owned expandable renderers. Collapsed rows include the Ctrl+O hint; expanded rows show the complete contract, criteria, evidence, retry fields, reasons, and model-visible continuation content. Ctrl+O never reveals private scheduler keys or changes snapshots. Known risks are deliberate: provider backoff is unbounded at the one-hour ceiling until success or explicit pause/cancel, no-progress is a conservative activity heuristic, child statistics are observational best-effort data, and restoration always requires an explicit resume.

## Commands

| Command | Effect |
| --- | --- |
| `/omps on [preset]` | Enable orchestration, optionally selecting a preset |
| `/omps off` | Disable orchestration and restore the prior main model/thinking |
| `/omps status` | Show activation state |
| `/omps presets` | List presets |
| `/preset [name]` | Switch preset; bare command lists presets |
| `/loop [request]` | Forward the unchanged request to the model for runtime loop management |
| `/goal [request]` | Forward the unchanged request to the model for durable Goal management |
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
