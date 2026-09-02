# oh-my-pi-slim

> A focused Pi tool package with background subagents, session todos, process monitors, structured questions, and durable Goals.

**English** | [中文](./README.zh-CN.md)

## Highlights

- Dispatch isolated background subagent runs.
- Keep session work organized with a dependency-aware Todo list.
- Run long Bash commands in the background with Monitor.
- Ask structured questions when a decision needs user input.
- Pursue branch-local durable Goals with explicit completion evidence.
- Toggle priority service for matching OpenAI requests with `/fast`.
- Keep the main and child sessions on Pi's native system prompt.
- Inherit the main session's current model and thinking level when each child launches.

Child sessions do focused work, use Pi's native system prompt, and can pause to contact the main session.

## Requirements and package management

### Requirements

- A Pi version compatible with the 0.84.4 package and RPC APIs. Pi 0.84.4 is the compatibility boundary because OMPS depends on its native threshold compaction after tool results.
- A supported POSIX system for Monitor; Monitor is unavailable on Windows.

Pi packages run with the current user's permissions. Review the source and treat installed extensions as trusted code.

### Install

```bash
pi install git:github.com/YanzuoLu/oh-my-pi-slim
```

### Migrate from external Ask and Process packages

The built-in Ask conflicts with `npm:@juicesharp/rpiv-ask-user-question`, and Monitor replaces `npm:@aliou/pi-processes`. Remove them before loading this package:

```bash
pi remove npm:@juicesharp/rpiv-ask-user-question
pi remove npm:@aliou/pi-processes
```

This package never automatically uninstalls external packages or runs `pi remove`.

### Update

```bash
pi update --extension git:github.com/YanzuoLu/oh-my-pi-slim
```

### Remove

Exit Pi, then run:

```bash
pi remove git:github.com/YanzuoLu/oh-my-pi-slim
```

## Tool availability

The package exposes an intentionally small tool surface:

| Environment | Package tools |
| --- | --- |
| Main | Exactly `subagent`, `todo`, `monitor`, `ask_user_question`, and `goal` |
| Child | Exactly `contact_supervisor` |

`ask_user_question`, `goal`, `monitor`, `subagent`, and `todo` are main-only. `contact_supervisor` is child-only. RPC sessions receive the supported tools but no package widgets; JSON and print modes cannot use Ask.

Every successful result from `goal`, `monitor`, `subagent`, `contact_supervisor`, and `todo` places one compact single-line JSON value in `content`. Complete, partial, and empty-submit results from `ask_user_question` use the same contract. A user-cancelled Ask instead returns the natural-language content `The user declined to answer.`, keeps the empty `AskResult` in `details`, terminates the current agent run, and skips every non-retrying threshold compaction until the agent settles idle. For JSON results, the JSON is the model-facing body. `details` remains the complete UI and internal contract, and normal transcript rendering reads `details` first before falling back to `content`. Errors and proactive custom notifications remain natural language, including Goal continuations, Monitor notifications, and Subagent waiting or terminal notifications.

## Main tools

The four lifecycle surfaces below expose no `confirmed` or `force` field. When protected work blocks deletion, the main model first inspects status when useful and asks the user. After agreement, it uses `pause`, `stop`, `interrupt`, Todo `modify`, or Goal `cancel` as appropriate, then retries the rejected action.

### `subagent`

Runs work in isolated background child sessions and returns control immediately.

| Action | Effect |
| --- | --- |
| `create` | Start a run with a short abstract, message, optional cwd, and optional `fork` |
| `list` | Return compact public state for every retained run in retained-run order |
| `check` | Return one retained run's public state and its terminal result when available |
| `steer` | Send guidance to a running run |
| `interrupt` | Stop a non-terminal run without rolling back file changes and return its final result |
| `reply` | Answer a waiting child and continue that same run |
| `resume` | Continue a terminal run's saved child session as a new run with a new ID and optionally override its cwd. Omitted cwd inherits the source run's working directory |
| `delete` | Remove one retained terminal run |
| `clear` | Remove all retained history when every run is terminal |

`list` includes `starting`, `running`, `waiting`, `completed`, `failed`, and `interrupted` runs, but never includes terminal `output` or `error`. Use `check` with one retained run ID to inspect the same public fields and recover its terminal result when present. The subagent widget uses the same retained set and ordering for counts and lifecycle, but its foreground body permanently hides terminal rows. Those runs remain retained until `delete` or `clear` removes them and remain reachable in the Subagent viewer.

Each active or waiting widget entry is an atomic two-line block. The first line keeps identity and abstract ahead of trailing activity. The second line carries model, turn, tool, token, context, compaction, and elapsed statistics. The 12-line widget budget never splits an active entry.

`fork` defaults to `true`. A forked run inherits conversation context through the point before the current tool-call batch. Every `create` in the same batch forks from that same point. With `fork: false`, the run starts an independent session and receives only its `message`.

`interrupt` is synchronous. It waits for the targeted run to reach a terminal status and returns that complete final result, including any stored `output` or `error`. When an explicit `interrupt` call takes over delivery for a live run, that terminal event is not sent separately and is not replayed after reload. Interruptions caused by shutdown, reload, tree navigation, or session replacement still arrive as ordinary terminal notifications. A run that already reached a terminal status before the call keeps its own terminal notification, receives no interrupt control, and returns only a compact status line. When the detached runner cannot be verified as stopped, the result says so explicitly and the run directory is retained.

Every `create` or `resume` launch inherits the main session's current model and thinking level. When `resume` crosses a provider or model ID, the reused child session is compacted once before the resumed run is prompted. A change of thinking level alone reuses the session unchanged. The run stays `starting` for the whole preflight, an already compacted or too small session simply continues, and any other compaction failure fails the run instead of prompting it.

Main and child sessions use Pi's native system prompt.

`delete` is refused for a `starting`, `running`, or `waiting` run, and `clear` is refused while any such run remains. The main model must ask before calling `interrupt`, then retry only after the run becomes terminal. A successful single delete or full clear persists across reload and restoration. Neither operation changes Goal statistics.

A child uses `contact_supervisor` with `need_decision`, `interview_request`, or `progress_update`. Every request moves the child to `waiting`; the main session uses `reply` to continue the same run.

### `todo`

Tracks main-session tasks, dependencies, and progress.

| Action | Effect |
| --- | --- |
| `list` | Return the complete current Todo list |
| `update` | Apply a non-empty batch of operations |

| Update operation | Effect |
| --- | --- |
| `append` | Add a unique subject, abstract, and optional dependencies |
| `modify` | Rename or update abstract, status, or dependencies |
| `delete` | Delete an exact pending or completed subject |
| `clear` | Remove every pending and completed item when none is in progress |

Subjects are case-sensitive and matched exactly. Multiple items may be `in_progress`. Dependencies must form an acyclic graph. `delete` is refused for the target's draft-relative `in_progress` status and when another task still names it in `blockedBy`. `clear` checks the draft produced by earlier operations in the same batch and rejects if any item there is `in_progress`. The model asks whether to change protected items to `pending` or `completed` with `modify`, then retries only after agreement. Every `update` batch is atomic.

### `monitor`

Runs long-running Bash commands on POSIX systems while the agent continues other work.

| Action | Effect |
| --- | --- |
| `create` | Start a command with an abstract and optional cwd |
| `list` | List compact monitor states |
| `check` | Return status, bounded recent stdout and stderr, and terminal diagnostics |
| `stop` | Stop one running command and return its final state |
| `clear` | Remove all terminal monitor records when none is running |

Each stdout line is an event. Lines produced within 200 ms may be delivered together. Stderr remains available through `check` and failed terminal diagnostics. Exit ends the monitor and produces one final status notification. Commands can filter and line-buffer their output when each line should represent a distinct event.

`stop` preserves the terminal record and retained log. The tool result owns terminal delivery, so the same stop does not send another terminal notification. A running monitor blocks `clear`. The main model must ask before stopping it and retry only afterward. Terminal records and output remain available until `clear`.

### `ask_user_question`

Opens a structured main-session questionnaire with one to four questions.

| Feature | Behavior |
| --- | --- |
| Selection | Supports single-select and multi-select questions |
| Custom input | Accepts custom responses |
| Preview | Shows previews for single-select options |
| Tool batch | Must be the only tool call in its assistant message |
| Pending messages | Opens only when Pi has no pending messages |
| Partial results | Submitting returns every confirmed answer, even a partial or empty set, and lets the run continue |
| Cancelling | Discards every answer, terminates the current agent run, skips all non-retrying threshold compaction until settle, and leaves Pi idle |
| Goal guard | Is unavailable while a Goal is active |

A single question has no separate Submit step: confirming an option, a multi-select `Next` row, or a custom response finishes the questionnaire right there. Two or more questions keep the `Submit` tab, where you can submit a partial or empty set of answers, or cancel. The provider must call `ask_user_question` alone as the only tool call in that assistant message, and Pi must have no pending messages. A mixed tool batch or pre-existing pending message is rejected before the questionnaire opens. Retry Ask alone after Pi is idle.

While Ask is waiting for questionnaire input, and after a user cancellation until the agent fully settles, ordinary RPC prompts pass through the input hook and are rejected with `Ask is blocking new RPC prompts. Retry after Pi is idle.` Direct RPC `steer` or `follow_up` messages can bypass that hook. If they do, they are discarded with the Ask abort and receive the one-time warning `Queued RPC messages were aborted with Ask. Retry after Pi is idle.` The caller must retry after Pi becomes idle.

Submit and cancel mean different things. Submitting hands back exactly what you confirmed as compact JSON, so a partial submit is a real answer to some questions and silence on the rest. An empty submit is also an ordinary result and allows the provider run to continue. Cancelling is a user refusal and a full withdrawal. Every answer is discarded, the tool result records an empty `AskResult` with `user_cancelled`, and the fixed natural-language content says `The user declined to answer.` The current agent run then terminates. Pi cancels every non-retrying threshold compaction until the agent settles, avoiding those summary provider requests, and then becomes idle. Manual and overflow compaction remain unaffected. Every cancel entry behaves the same way in both the TUI questionnaire and the RPC dialog. Historical transcript replay keeps using the existing `details`-first rendering behavior.

Ask is main-only and requires an interactive UI. It is not offered in JSON or print modes.

### `goal`

Manages one branch-local durable Goal with explicit criteria and evidence.

| Action | Effect |
| --- | --- |
| `create` | Create and activate a Goal |
| `check` | Read the current Goal |
| `modify` | Replace the nonterminal Goal contract and activate it |
| `pause` | Pause with a reason |
| `resume` | Explicitly reactivate a paused Goal |
| `complete` | Complete with evidence aligned to the criteria |
| `clear` | Remove the current Goal from the branch |

A Goal is durable on its branch. Reload, session resume, fork, and tree restoration restore unfinished work as paused; it never silently resumes. Provider failures retry automatically, and repeated no-progress runs pause the Goal. A user abort pauses only when Goal continuation is immediately safe to deliver. If any continuation gate is blocked, the Goal remains active for later scheduler reevaluation. Completion requires exactly one non-empty evidence item for each criterion.

Autonomous continuation waits until blocking work is gone, including active or waiting subagents, Monitor work and pending terminal delivery, and a waiting Ask dialog. Use `check`, `pause`, `resume`, or `clear` to stay in control.

A completed Goal's detail row joins the shared Ctrl+O collapse. With tool output collapsed the widget keeps only the Goal heading, and every other status keeps both rows in either state.

`goal clear` removes the current Goal from the branch. A cleared branch reports no Goal and drops that Goal's statistics while leaving retained subagent runs untouched.

## `/goal`

`/goal <objective>` asks the model to create or manage the durable Goal on the current branch. A bare `/goal` reports the current Goal and explains the command.

Examples: `/goal finish the parser migration with passing validation` or `/goal pause because the required credentials are unavailable`.

The command forwards natural language to the model. It is not a rigid command parser.

## OpenAI Fast Mode

OpenAI Fast Mode belongs to the current Pi session and defaults to `off` for a new session. Bare `/fast` accepts no arguments and toggles between `on` and `off`. The latest state persists in session history across branches, reloads, process restarts, and session resume. A fork inherits the last state copied to its target path.

When enabled, matching ordinary requests whose provider is exactly `openai` or `openai-codex` receive `service_tier: "priority"`. Requests for every other provider remain unchanged.

Only future child `create` and `resume` launches inherit the current Fast Mode snapshot. Running children do not hot-switch. The OMPS footer shows `OpenAI Fast Mode: on` or `OpenAI Fast Mode: off` only while an OpenAI model is selected.

## Cache Mode

Cache Mode belongs to the current Pi session and defaults to Short for a new session. Bare `/cache` toggles between Long and Short. The latest toggle applies across every branch. Reload, process restart, and session resume recover it from session history. A fork inherits the last Cache Mode state on the target path copied into the fork. With `--no-session`, the state lasts only for the current process and cannot survive a restart.

The OMPS footer shows `Anthropic Cache Mode: short` or `Anthropic Cache Mode: long` only while an eligible Anthropic OAuth model is selected.

Cache Mode handles only ordinary Claude requests where the provider is exactly `anthropic`, the API is exactly `anthropic-messages`, the payload model matches the active Pi model, the model does not explicitly disable long cache retention, and Pi reports Anthropic OAuth authentication. API-key requests, compatible endpoints, OpenAI, and `openai-codex` payloads are unchanged.

Long upgrades only existing legal `{ type: "ephemeral" }` cache breakpoints by cloning them with `ttl: "1h"`. Short removes `ttl` from those breakpoints to restore the implicit five-minute retention. This covers existing top-level, system-block, tool, and message-content markers, including tool-result content. Transformation is all-or-nothing. The target surfaces must contain one to four markers, and every marker must be exactly `{ type: "ephemeral" }` or include only a valid `ttl` of `"5m"` or `"1h"`. Any malformed marker, zero markers, or more than four markers leaves the whole payload unchanged. OMPS creates no breakpoint, preserves every unrelated field, and never mutates the original payload. Later provider shaping preserves these fields.

`PI_CACHE_RETENTION` controls Pi's upstream marker policy. OMPS does not set it or mutate `process.env`. With `PI_CACHE_RETENTION=long`, Cache Short removes `ttl` from Pi's existing markers and restores five-minute retention. With `PI_CACHE_RETENTION=none`, Pi supplies no markers, so Cache Long creates nothing and is a silent no-op. Provider payload hooks are ordered, so a writer after the OMPS hook wins.

Only future child `create` and `resume` launches inherit the current Long or Short OMPS-internal snapshot. The launch snapshot does not rewrite `PI_CACHE_RETENTION` or mutate the running supervisor process's `process.env`. Running children do not hot-switch. Each child applies the complete Anthropic OAuth gate again. Compaction and branch-summary model calls remain unchanged under Pi's current implementation. OMPS does not prewarm caches and does not copy context-cache headers, OAuth handling, or transport behavior. Longer retention can increase Anthropic cache-write cost, and current pricing depends on the model and account.

## Runtime, UI, and persistence

- Package notifications are safely queued during compaction and tree operations, then delivered without losing the user-visible result.
- Transcript tool calls, tool results, and notifications use Ctrl+O for collapsed and expanded views. Expansion changes presentation only, never tool data or persisted state.
- Monitor notifications are incremental. Each Monitor keeps at most one notification already handed to Pi and one pending aggregate. New stdout events coalesce until Pi confirms the prior notification. `monitor check` returns bounded recent stdout and stderr.
- Clearing Monitors drops queued notifications immediately. A copy already handed to Pi may still appear once, but OMPS will not retry it and a late confirmation is ignored.
- Foreground TUI sessions show compact widgets for retained subagents, Todos, Monitors, and the active Goal. RPC sessions do not register these widgets.
- The Todo, Agents, and Monitor foreground widgets are permanently compact and never show a Ctrl+O expand hint. Todo always hides completed rows. Agents and Monitor always hide terminal rows. Their headings still count the full retained set.
- The Goal widget still reads Pi's shared tool-output expansion state. A collapsed completed Goal hides its detail row, while every other Goal status keeps both rows.
- Subagent, Todo, and Goal state restore on their documented session or branch scope. In particular, a successful subagent `clear` remains clear after reload.
- Monitor is a runtime service rather than a durable process manager. Session transitions shut it down.
- Child processes are isolated Pi RPC sessions. On session shutdown, active runs are interrupted rather than adopted silently by a later session; retained terminal sessions can be continued with `resume`, which creates a new run.

### Subagent viewer

`ctrl+shift+left` and `ctrl+shift+right` open a read-only, full-screen viewer for the child transcript of any retained subagent run. The viewer only shows: it has no reply, steer, or interrupt, and it never writes a session entry, a control file, or a run file.

- The Agents heading appends the fixed `ctrl+shift+←/→ viewer` hint when retained terminal runs are hidden. If the width cannot fit the complete hint, it omits it. The heading never shows a Ctrl+O expand hint.
- Main is item 0 of one cycle. `ctrl+shift+right` moves Main to the first retained run, then run by run, then back to Main. `ctrl+shift+left` moves the same ring in reverse.
- The cycle contains the same retained set and total as the Agents widget: every `starting`, `running`, `waiting`, `completed`, `failed`, and `interrupted` run is reachable, including runs hidden by the permanent compact policy or the row budget. Viewer navigation is oldest-created first, with ID tie-breaking and invalid creation times placed last in ID order. Status and update-time changes never move a run, while a resumed run joins at its own new creation position. `subagent delete` removes one terminal run, while `subagent clear` removes all terminal history; losing the last retained run returns you to Main.
- Inside the viewer, plain `Left`/`Right` and `ctrl+shift+left`/`ctrl+shift+right` cycle the same way. `Escape` or `q` returns to Main.
- The transcript starts on the first row of the screen. Everything else lives at the bottom, in the order Main uses for its own dock: the live or waiting block, the `Read-Only` input placeholder, the run status rows, and the navigation hints.
- The transcript itself is rendered by Pi's own transcript components, so user messages, assistant Markdown, thinking blocks, tool calls, tool results, compaction summaries, and branch summaries keep Main's colors, spacing, and framing.
- `Up`/`Down` scroll one line, `PageUp`/`PageDown` scroll one page, `Home` jumps to the top, `End` jumps to the bottom and turns follow on, `f` toggles follow, and `r` re-reads the transcript immediately.
- Follow is bottom-aware: scrolling up leaves it, and scrolling, paging, or wheeling back to the last line turns it on again. Turning follow off with `f` while already at the end suppresses that: from then on new output, a resize, and even another `Down`, `PageDown`, or wheel notch at the last line all leave follow off, until you turn it back on with `f` or ask for the end explicitly with `End`. Deliberately scrolling up and away from the end lifts the suppression, so a later trip back down follows again.
- The mouse wheel scrolls the transcript one row per notch. While the viewer is open it turns on minimal wheel reporting and turns it off again on every exit, so the Main scrollback and the terminal's own selection behave normally the moment you leave. Hold `Shift` while dragging to use the terminal's native selection (Ghostty, iTerm2, and most emulators) while the viewer is open. The shortcut and the wheel both work over SSH, because both are ordinary terminal byte sequences.
- `Ctrl+O` (or whatever you bound `app.tools.expand` to) toggles collapsed and expanded tool output. Main and every subagent transcript share this state, and the Goal foreground widget reads it too. A toggle inside the viewer is already applied when you return to Main, and the reverse is true as well. Collapsed hides tool result bodies and long arguments. Expanded shows the full, bounded content. The bottom hint always names your real key and the current state. Todo, Agents, and Monitor remain permanently compact.
- The viewer refreshes about four times a second. Activity counters update at that rate, the elapsed clock repaints on the first refresh where the value it shows actually changes, and neither ever rebuilds the transcript.
- Presentation settings (thinking blocks, output padding, and Markdown code-block indent) are read straight from your global settings file and, for a trusted project, the project one. The viewer reads them; it never creates, locks, or writes a settings file.
- Every run keeps its own scroll position, follow state, and suppression.
- A run cleared while you watch it hands the view to a neighbouring retained run, or returns to Main when the retained set is empty. A new run joins the cycle without moving your current selection.
- A finished run is frozen: its transcript stops at its own last entry, its elapsed time stays at the duration it actually ran, and it claims no liveness. `subagent resume` continues the same child session file, so the original run and every continuation of it show exactly their own turns even though all of them share one file on disk.
- A finished run also shows a `[completed]`, `[failed]`, or `[interrupted]` block under its transcript. A failure or interruption reason is always visible there, and a final answer that simply repeats the last assistant message is not printed twice. A run that kept no readable session file still shows that retained result.
- A `starting` run reads as pending until its child session file appears, without churning the screen while it waits.
- The transcript is the child session file's active, compaction-aware branch. Rows that are not well-formed entries are skipped, and a session file whose branch metadata is unusable (a parent cycle or a duplicate entry id) falls back to a bounded file-order tail with a footer warning instead of being trusted. Symbolic links, directories, and paths outside this session's own child session directory are refused, a file that does not exist yet reads as waiting, and an oversized file degrades to a bounded read-only file-order tail with a footer warning. Images render as a placeholder and never as raw data, and a child extension's own message renderer is never executed.
- A long block keeps its real ending. Every ordinary transcript block (message text, thinking, tool result, bash output, custom message, summary, and the outcome block) is shown whole up to 64K characters. A block past that budget keeps its head and its tail inside the same budget, with a `… N characters omitted …` marker between them, so the last thing the child actually said is always on screen. Only tool-call arguments keep a short head-only summary. The whole transcript still stops at its own line budget, and the oldest lines are the ones that go.
- The viewer takes the whole screen while it is open, including its own `Read-Only` input placeholder, and hands the untouched Main UI back on exit. Your draft, cursor, and undo history are never modified, because the viewer never replaces the editor.
- A questionnaire always wins the screen: `ask_user_question` closes the viewer and waits for it to be gone before it opens its own overlay.
- Closing removes exactly the viewer's own overlay, by handle rather than by stack position. Another package's overlay on top of the viewer is never dismissed, and the viewer never survives as a hidden full-screen layer that reappears when that overlay closes. Closing is immediate in every case, and it never depends on which component holds keyboard focus.
- Known limitation: an inline terminal image the host already drew is a raw escape sequence the host composites, so it can still show through an overlay row. Nothing the viewer itself renders can do that.
- The shortcut is an ordinary modified arrow key, so an SSH session forwards it unchanged. It works wherever the terminal emulator itself reports the combined Ctrl and Shift modifiers on an arrow key. A terminal that drops or rebinds that combination will not reach Pi, so this is not a claim about every terminal. The package registers only `ctrl+shift+left` and `ctrl+shift+right`, with no fallback shortcut and no slash command.

## Runtime behavior

- Parallelism comes from multiple independent `subagent create` calls.
- Monitor runs foreground commands in its own process group and keeps their terminal state until it is cleared.
- Ask is intentionally unavailable during an active Goal so autonomous work does not stop for new user questions.

## Development

```bash
npm test
npm run validate
git diff --check
```

## License

MIT
