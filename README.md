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
| `list` | Return running and waiting runs by creation time, then starting runs, then terminal runs by latest update |
| `interrupt` | Request interruption of a non-terminal run |
| `steer` | Send guidance to a running run |
| `resume` | Continue a terminal run's saved child session as a new run with a new ID |
| `reply` | Answer a waiting child and continue that same run |
| `clear` | Remove all retained terminal history |

`list` includes `starting`, `running`, `waiting`, `completed`, `failed`, and `interrupted` runs. Terminal entries include their final `output` and `error`. The subagent widget uses this same retained set, so terminal runs remain visible until `clear`.

`clear` is refused while any run is `starting`, `running`, or `waiting`. Once every retained run is terminal, it can clear the complete history; the cleared state remains empty after reload and restoration.

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

Subjects are case-sensitive and matched exactly. `delete` is refused when another task still names the target in `blockedBy`. An `update` batch is atomic: if any operation or the final dependency graph is invalid, nothing is committed.

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

Intervals are inclusive from `10s` through `7d`. The next delay begins after the previous tick finishes, so slow work does not build an overlapping schedule.

Loops survive compaction and tree navigation, but not reload, new session, session resume, fork, or quit. Those transitions clear every loop.

### `monitor`

Runs and observes long-running foreground Bash commands on POSIX systems.

| Action | Effect |
| --- | --- |
| `create` | Start a command with an abstract, optional cwd, and optional `notifyOn` literals |
| `delete` | Stop if needed, then remove the monitor and its retained record |
| `list` | List compact monitor states |
| `status` | Inspect current state and retained combined output |

`notifyOn` uses case-sensitive literal matching. Commands must remain in the foreground: do not use `nohup`, `setsid`, `disown`, trailing `&`, or another detach escape.

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

A Goal is durable on its branch. Reload, session resume, fork, and tree restoration restore unfinished work as paused; it never silently resumes. Completion requires exactly one non-empty evidence item for each criterion.

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
- Foreground TUI sessions show compact widgets for retained subagents, Todos, Loops, Monitors, and the active Goal. RPC sessions do not register these widgets.
- Subagent, Todo, and Goal state restore on their documented session or branch scope. In particular, a successful subagent `clear` remains clear after reload.
- Loop and Monitor are runtime services rather than durable schedules. Session transitions shut them down; Loop follows the explicit clearing rules above.
- Child processes are isolated Pi RPC sessions. On session shutdown, active runs are interrupted rather than adopted silently by a later session; retained terminal sessions can be continued with `resume`, which creates a new run.

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
