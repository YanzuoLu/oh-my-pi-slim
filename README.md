# oh-my-pi-slim

> A preset-driven orchestration package for Pi, with background specialists, session todos, runtime loops, process monitors, structured questions, and durable Goals.

**English** | [中文](./README.zh-CN.md)

Run Pi with the configured orchestrator preset:

```bash
pi --omps
```

## Highlights

- Dispatch six focused specialists as isolated background runs.
- Keep session work organized with a dependency-aware Todo list.
- Schedule fixed-delay prompts with `/loop`.
- Supervise long-running foreground Bash commands with Monitor.
- Ask structured questions when a decision needs user input.
- Pursue branch-local durable Goals with explicit completion evidence.
- Choose provider, model, and thinking level per role through presets.

The main session plans, delegates, and verifies. Child sessions do focused work and can pause to contact the main orchestrator.

## Six specialists

| Specialist | Best for |
| --- | --- |
| `explorer` | Finding relevant code, tests, and execution paths |
| `librarian` | Official documentation, APIs, and public source examples |
| `oracle` | Architecture, debugging strategy, risk, simplification, and review |
| `designer` | UI/UX implementation, visual review, and polish |
| `fixer` | Bounded implementation and assigned verification |
| `observer` | Images, screenshots, PDFs, and diagrams |

`orchestrator` is the main-session role. Each preset configures it plus all six specialists.

## Requirements and package management

### Requirements

- A Pi version compatible with the 0.84.2 package and RPC APIs.
- Configured authentication for every provider/model used by the selected preset.
- An image-capable model for the explicitly configured `observer` role.
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

Also remove `ask_user_question` from user specialist deny lists. This package never automatically uninstalls external packages, runs `pi remove`, edits package settings, or rewrites deny lists.

### Update

```bash
pi update --extension git:github.com/YanzuoLu/oh-my-pi-slim
```

### Remove

In Pi, run `/omps uninstall`, then exit Pi and run:

```bash
pi remove git:github.com/YanzuoLu/oh-my-pi-slim
```

The user preset file is preserved.

## Tool availability

The package exposes an intentionally small tool surface:

| Environment | Package tools |
| --- | --- |
| Main | Exactly `subagent`, `todo`, `loop`, `monitor`, `ask_user_question`, and `goal` |
| Child | Exactly `contact_supervisor` and `todo` |

`ask_user_question`, `goal`, `loop`, `monitor`, and `subagent` are main-only. Todo works in both environments. `contact_supervisor` is child-only. RPC sessions receive the supported tools but no package widgets; JSON and print modes cannot use Ask.

## Main tools

### `subagent`

Runs specialists in isolated background child sessions and returns control immediately.

| Action | Effect |
| --- | --- |
| `create` | Start a new specialist run with an agent, short abstract, task, and optional cwd |
| `list` | Return compact public state for every retained run in retained-run order |
| `status` | Return one retained run's public state and its terminal result when available |
| `interrupt` | Stop a non-terminal run without rolling back file changes and return its final result |
| `steer` | Send guidance to a running run |
| `resume` | Continue a terminal run's saved child session as a new run with a new ID and optionally override its cwd. Omitted cwd inherits the source run's working directory |
| `reply` | Answer a waiting child and continue that same run |
| `clear` | Remove all retained terminal history |

`list` includes `starting`, `running`, `waiting`, `completed`, `failed`, and `interrupted` runs, but never includes terminal `output` or `error`. Use `status` with one retained run ID to inspect the same public fields and recover its terminal result when present. The subagent widget uses the same retained set and ordering, so terminal runs remain visible until `clear`.

`interrupt` is synchronous. It waits for the targeted run to reach a terminal status and returns that complete final result, including any stored `output` or `error`. When an explicit `interrupt` call takes over delivery for a live run, that terminal event is not sent separately and is not replayed after reload. Interruptions caused by shutdown, reload, tree navigation, or session replacement still arrive as ordinary terminal notifications. A run that already reached a terminal status before the call keeps its own terminal notification, receives no interrupt control, and returns only a compact status line. When the detached runner cannot be verified as stopped, the result says so explicitly and the run directory is retained.

`clear` is refused while any run is `starting`, `running`, or `waiting`. Once every retained run is terminal, it can clear the complete history; the cleared state remains empty after reload and restoration. Clearing Subagent history never changes Goal statistics.

A child uses `contact_supervisor` with `need_decision`, `interview_request`, or `progress_update`. Every request moves the child to `waiting`; the main session uses `reply` to continue the same run.

### `todo`

Tracks session tasks, dependencies, and progress in main and child sessions.

| Action | Effect |
| --- | --- |
| `list` | Return the complete current Todo list |
| `update` | Apply a non-empty batch of operations |

| Update operation | Effect |
| --- | --- |
| `append` | Add a unique subject, abstract, and optional dependencies |
| `modify` | Rename or update abstract, status, or dependencies |
| `delete` | Delete an exact subject |
| `clear` | Clear an empty or completed task set within the batch |

Subjects are case-sensitive and matched exactly. Multiple items may be `in_progress`. Dependencies must form an acyclic graph. `delete` is refused when another task still names the target in `blockedBy`. `clear` requires an empty or fully completed current group. An `update` batch is atomic: if any operation or the final dependency graph is invalid, nothing is committed.

### `loop`

Schedules self-contained prompts on a runtime-only fixed-delay timer.

| Action | Effect |
| --- | --- |
| `create` | Create a loop with interval, abstract, and prompt |
| `delete` | Remove a loop |
| `modify` | Change interval, abstract, or prompt |
| `list` | List loops and their current state |
| `pause` | Pause a loop |
| `resume` | Resume after one full interval |

Intervals are inclusive from `10s` through `7d`. Creation and resume wait one full interval. Each later delay begins after the previous tick finishes, so slow work does not build an overlapping schedule.

Loops survive compaction and tree navigation, but not reload, new session, session resume, fork, or quit. Those transitions clear every loop.

### `monitor`

Runs and observes long-running foreground Bash commands on POSIX systems.

| Action | Effect |
| --- | --- |
| `create` | Start a command with an abstract, a required `checkAfter` silence threshold, optional cwd, and optional `notifyOn` literals |
| `delete` | Stop if needed, then remove the monitor and its retained record |
| `list` | List compact monitor states |
| `status` | Inspect current state and retained combined output |

`notifyOn` uses case-sensitive literal matching. Commands must remain in the foreground: do not use `nohup`, `setsid`, `disown`, trailing `&`, or another detach escape.

`checkAfter` is required on `create` and is inclusive from `10s` through `7d`, written as one positive integer plus `s`, `m`, `h`, or `d`. Silence is measured from a successful `create` and restarts at the last raw stdout or stderr chunk, so partial lines and output without a newline both count as activity. Whenever a running command stays silent that long, a silence reminder asks you to call `monitor status` for that ID. Only one reminder per monitor is queued at a time: later intervals update the same reminder with the accumulated silent time instead of stacking new ones. `status` reports the canonical `checkAfter` and `lastOutputAt`, which stays `null` until the command writes its first output.

Matcher and terminal notifications share one shape, and each states the monitor's current status. A matcher notification carries only the new lines that matched a `notifyOn` literal, one entry per line even when several literals hit it, while the delivered position still advances past every ordinary line so nothing unmatched is repeated later. A terminal notification always reports the final status, exit code, signal, and error. A completed command adds only the matched lines no earlier notification delivered, so a clean exit with ordinary output alone carries no lines. A failed or killed command adds a bounded diagnostic tail of the last twenty new lines, merged with any still undelivered matches by sequence number and deduplicated. Every payload stays within the same byte bounds, and `omitted` reports what was left behind. `status` is the single entry point for a record's full retained state and combined output.

Terminal records and retained output remain available until `delete`. Use `status` to inspect the result, then `delete` when the record is no longer needed.

### `ask_user_question`

Opens a structured main-session questionnaire with one to four questions.

| Feature | Behavior |
| --- | --- |
| Selection | Supports single-select and multi-select questions |
| Custom input | Accepts custom responses |
| Preview | Shows previews for single-select options |
| Partial results | Returns partial or cancelled answers as structured results |
| Goal guard | Is unavailable while a Goal is active |

Ask is main-only and requires an interactive UI; it is not offered in JSON or print modes.

### `goal`

Manages one branch-local durable Goal with explicit criteria and evidence.

| Action | Effect |
| --- | --- |
| `create` | Create and activate a Goal |
| `modify` | Replace the nonterminal Goal contract and activate it |
| `status` | Read the current Goal |
| `pause` | Pause with a reason |
| `resume` | Explicitly reactivate a paused Goal |
| `complete` | Complete with evidence aligned to the criteria |
| `cancel` | Cancel with a reason |

A Goal is durable on its branch. Reload, session resume, fork, and tree restoration restore unfinished work as paused; it never silently resumes. Provider failures retry automatically, repeated no-progress runs pause the Goal, and user aborts pause instead of cancelling. Completion requires exactly one non-empty evidence item for each criterion.

Autonomous continuation waits until blocking work is gone, including active or waiting subagents, Monitor work and pending terminal delivery, and a waiting Ask dialog. Use `status`, `pause`, `resume`, or `cancel` to stay in control.

## `/loop` and `/goal`

`/loop <interval> <prompt>` asks the model to create or manage runtime loops. A bare `/loop` lists current loops and explains the command.

Examples: `/loop 30m review the latest test failures` or `/loop pause the dependency audit loop`.

`/goal <objective>` asks the model to create or manage the durable Goal on the current branch. A bare `/goal` reports the current Goal and explains the command.

Examples: `/goal finish the parser migration with passing validation` or `/goal pause because the required credentials are unavailable`.

Both commands forward natural language to the model; they are not rigid command parsers.

## Presets and configuration

The runtime preset file is `~/.pi/agent/oh-my-pi-slim.json`. On first use, the package seeds it from `config/oh-my-pi-slim.example.json`; existing presets are not overwritten or removed.

The basic structure is:

- `defaultPreset`: preset selected by default.
- `presets.<name>`: configuration for `orchestrator` and all six specialists.
- Each role: `provider`, `model`, and `thinking`.
- `deny.<specialist>`: exact tool names excluded for that specialist.

Provider, model, and thinking level are independently configurable per role. Authentication and model availability are checked when a preset is activated. The `observer` model must support image input.

| Command | Effect |
| --- | --- |
| `/omps on [preset]` | Enable orchestration, optionally with a preset |
| `/omps off` | Disable orchestration and restore the previous main model/thinking |
| `/omps status` | Show activation state |
| `/omps presets` | List presets |
| `/preset [name]` | Switch preset; omit the name to list presets |

## Runtime, UI, and persistence

- Package notifications are safely queued during compaction and tree operations, then delivered without losing the user-visible result.
- Package tool rows and notifications use Ctrl+O for collapsed and expanded views. Expansion changes presentation only, never tool data or persisted state.
- Monitor notifications are incremental. Every one names the current status and shows only new output, so `monitor status` stays the single place to read full retained state and logs.
- Foreground TUI sessions show compact widgets for retained subagents, Todos, Loops, Monitors, and the active Goal. RPC sessions do not register these widgets.
- The subagent, Todo, and Monitor widgets follow the same Ctrl+O state as tool rows. Collapsed hides finished rows and adds a dim hint with your configured key; expanded shows the full body. Loop and Goal widgets always show their full body.
- Subagent, Todo, and Goal state restore on their documented session or branch scope. In particular, a successful subagent `clear` remains clear after reload.
- Loop and Monitor are runtime services rather than durable schedules. Session transitions shut them down; Loop follows the explicit clearing rules above.
- Child processes are isolated Pi RPC sessions. On session shutdown, active runs are interrupted rather than adopted silently by a later session; retained terminal sessions can be continued with `resume`, which creates a new run.

### Subagent viewer

`ctrl+shift+left` and `ctrl+shift+right` open a read-only, full-screen viewer for the child transcript of any retained subagent run. The viewer only shows: it has no reply, steer, or interrupt, and it never writes a session entry, a control file, or a run file.

- Main is item 0 of one cycle. `ctrl+shift+right` moves Main to the first retained run, then run by run, then back to Main. `ctrl+shift+left` moves the same ring in reverse.
- The cycle is the retained set the Agents widget shows, in the same order and with the same total: every `starting`, `running`, `waiting`, `completed`, `failed`, and `interrupted` run is reachable, including the ones the widget hides when it is collapsed or over its row budget. A status change only reorders the ring, so a run you are watching stays on screen when it finishes. Only `subagent clear` removes runs, and clearing everything returns you to Main.
- Inside the viewer, plain `Left`/`Right` and `ctrl+shift+left`/`ctrl+shift+right` cycle the same way. `Escape` or `q` returns to Main.
- The transcript starts on the first row of the screen. Everything else lives at the bottom, in the order Main uses for its own dock: the live or waiting block, the `Read-Only` input placeholder, the run status rows, and the navigation hints.
- The transcript itself is rendered by Pi's own transcript components, so user messages, assistant Markdown, thinking blocks, tool calls, tool results, compaction summaries, and branch summaries keep Main's colors, spacing, and framing.
- `Up`/`Down` scroll one line, `PageUp`/`PageDown` scroll one page, `Home` jumps to the top, `End` jumps to the bottom and turns follow on, `f` toggles follow, and `r` re-reads the transcript immediately.
- Follow is bottom-aware: scrolling up leaves it, and scrolling, paging, or wheeling back to the last line turns it on again. Turning follow off with `f` while already at the end suppresses that: from then on new output, a resize, and even another `Down`, `PageDown`, or wheel notch at the last line all leave follow off, until you turn it back on with `f` or ask for the end explicitly with `End`. Deliberately scrolling up and away from the end lifts the suppression, so a later trip back down follows again.
- The mouse wheel scrolls the transcript one row per notch. While the viewer is open it turns on minimal wheel reporting and turns it off again on every exit, so the Main scrollback and the terminal's own selection behave normally the moment you leave. Hold `Shift` while dragging to use the terminal's native selection (Ghostty, iTerm2, and most emulators) while the viewer is open. The shortcut and the wheel both work over SSH, because both are ordinary terminal byte sequences.
- `Ctrl+O` (or whatever you bound `app.tools.expand` to) toggles collapsed and expanded tool output. There is only one such state in Pi: Main, every subagent transcript, and the package widgets share it, so a toggle inside the viewer is already applied when you return to Main and the reverse is true as well. Collapsed hides tool result bodies and long arguments; expanded shows the full, bounded content. The bottom hint always names your real key and the current state.
- The viewer refreshes about four times a second. Activity counters update at that rate, the elapsed clock repaints on the first refresh where the value it shows actually changes, and neither ever rebuilds the transcript.
- Presentation settings (thinking blocks, output padding, and Markdown code-block indent) are read straight from your global settings file and, for a trusted project, the project one. The viewer reads them; it never creates, locks, or writes a settings file.
- Every run keeps its own scroll position, follow state, and suppression.
- A run cleared while you watch it hands the view to a neighbouring retained run, or returns to Main when the retained set is empty. A new run joins the cycle without moving your current selection.
- A finished run is frozen: its transcript stops at its own last entry, its elapsed time stays at the duration it actually ran, and it claims no liveness. `subagent resume` continues the same child session file, so the original run and every continuation of it show exactly their own turns even though all of them share one file on disk.
- A finished run also shows a `[completed]`, `[failed]`, or `[interrupted]` block under its transcript. A failure or interruption reason is always visible there, and a final answer that simply repeats the last assistant message is not printed twice. A run that kept no readable session file still shows that retained result.
- A `starting` run reads as pending until its child session file appears, without churning the screen while it waits.
- The transcript is the child session file's active, compaction-aware branch. Rows that are not well-formed entries are skipped, and a session file whose branch metadata is unusable (a parent cycle or a duplicate entry id) falls back to a bounded file-order tail with a footer warning instead of being trusted. Symbolic links, directories, and paths outside this session's own child session directory are refused, a file that does not exist yet reads as waiting, and an oversized file degrades to a bounded read-only file-order tail with a footer warning. Images render as a placeholder and never as raw data, and a child extension's own message renderer is never executed.
- The viewer takes the whole screen while it is open, including its own `Read-Only` input placeholder, and hands the untouched Main UI back on exit. Your draft, cursor, and undo history are never modified, because the viewer never replaces the editor.
- A questionnaire always wins the screen: `ask_user_question` closes the viewer and waits for it to be gone before it opens its own overlay.
- Closing removes exactly the viewer's own overlay, by handle rather than by stack position. Another package's overlay on top of the viewer is never dismissed, and the viewer never survives as a hidden full-screen layer that reappears when that overlay closes. Closing is immediate in every case, and it never depends on which component holds keyboard focus.
- Known limitation: an inline terminal image the host already drew is a raw escape sequence the host composites, so it can still show through an overlay row. Nothing the viewer itself renders can do that.
- The shortcut is an ordinary modified arrow key, so an SSH session forwards it unchanged. It works wherever the terminal emulator itself reports the combined Ctrl and Shift modifiers on an arrow key. A terminal that drops or rebinds that combination will not reach Pi, so this is not a claim about every terminal. The package registers only `ctrl+shift+left` and `ctrl+shift+right`, with no fallback shortcut and no slash command.

## Deliberate scope

- No nested child orchestration: specialists cannot create subagents.
- No workflow DSL, missions, fleets, authored agent profiles, worktree manager, or aggregate chain/parallel API.
- Parallelism comes from multiple independent `subagent create` calls.
- Specialist deny lists reduce model-visible tools; they are not an operating-system sandbox.
- Monitor supervises foreground commands; it is not a daemon manager or interactive terminal.
- Ask is intentionally unavailable during an active Goal so autonomous work does not stop for new user questions.

## Development

```bash
npm test
npm run validate
git diff --check
```

## License

MIT
