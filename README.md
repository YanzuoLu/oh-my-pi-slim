# oh-my-pi-slim

A slim, main-session orchestration layer for [Pi](https://pi.dev), powered by [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents).

The main Pi session remains the **orchestrator**. It delegates only to five specialist types:

- `explorer` — read-only repository reconnaissance
- `librarian` — read-only external documentation and upstream research
- `oracle` — read-only architecture, debugging, risk, and review
- `designer` — user-facing UI/UX design and implementation
- `fixer` — bounded, already-decided implementation

`orchestrator` is intentionally **not** a subagent definition. A Pi extension injects its instructions into the main session, selects its preset, and enforces dispatch policy.

## What this port changes from Claude Code

This repository uses Pi and pi-subagents semantics rather than retaining Claude Code harness names:

| Capability | Pi implementation |
|---|---|
| Launch a specialist | `Agent({ subagent_type, ... })` |
| Retrieve a background result | `get_subagent_result({ agent_id })` |
| Redirect or reuse a specialist | `steer_subagent({ agent_id, message })`; running sessions steer normally, while completed/steered sessions auto-resume and return the old and new results in the same call |
| Explicitly continue a completed specialist session | `Agent({ resume: agent_id, ... })`, still available as Pi's general-purpose resume operation |
| Stop a running specialist | `stop_subagent({ agent_id })`, implemented over pi-subagents' `subagents:rpc:stop` RPC |
| Ask a blocking clarification | `ask_user_question({ questions })`, supplied by `@juicesharp/rpiv-ask-user-question` |
| Custom agent type | Bare Markdown filename such as `explorer`, not a namespaced type |

Background completions use pi-subagents' automatic follow-up notifications. The orchestrator is instructed not to poll running agents.

When orchestration is active, oh-my-pi-slim adds a `tool_result` compatibility layer around pi-subagents `steer_subagent`, validated against pi-subagents 0.15.0/current cross-package registry shape. A normal running-agent steer is left untouched. If upstream reports that the target is already `completed` or `steered`, the layer uses the cross-package manager registry, preserves the old result, prompts the same idle session with the original steering message as literal text, waits for that resumed turn, updates the shared record, and replaces the same tool result with the completion status plus the old and new outputs. This tool result is therefore blocking for the resumed turn. A completed steer and an explicit `Agent({ resume })` targeting the same ID use first-wins conflict handling, so the second concurrent operation is blocked. The main orchestrator should not make a follow-up `get_subagent_result` or `Agent({ resume })` call for this fallback.

This compatibility path is not a stable public resume API. It requires the original live record and session: pi-subagents normally cleans terminal records after about 10 minutes, and a session replacement/switch can make them unavailable sooner. In those cases the same steer result preserves the old output when available and reports that no resume occurred; it never creates a fresh agent. The configured `maxSubagentDepth=1` means resumed specialists cannot create nested agents, so no additional nested-child cleanup is needed under this repository's supported configuration.

## Requirements

- Pi `>= 0.80.0`; this repository was validated with Pi `0.84.1`
- [`@tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents), installed separately by the user
- [`@juicesharp/rpiv-ask-user-question`](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) for main-session clarification questions, installed separately by the user
- Node.js `>= 22` when using the questionnaire package
- Authentication configured for every provider/model used by the selected preset
- No conflicting files named `explorer.md`, `librarian.md`, `oracle.md`, `designer.md`, or `fixer.md` in the global Pi agent directory

`pi-web-search` is optional and remains a separate user choice. The orchestration extension blocks every `Agent` type except the five names above.

## Installation

Install the required third-party packages explicitly:

```bash
pi install npm:@tintinweb/pi-subagents
pi install npm:@juicesharp/rpiv-ask-user-question
```

Optionally install additional workflow support:

```bash
# Web research
pi install npm:pi-web-search

# Long-running process management
pi install npm:@aliou/pi-processes

# Main-session task tracking
pi install npm:@juicesharp/rpiv-todo
```

Then install `oh-my-pi-slim` itself:

```bash
pi install git:github.com/YanzuoLu/oh-my-pi-slim
```

To pin the current release instead of tracking `main`:

```bash
pi install git:github.com/YanzuoLu/oh-my-pi-slim@v0.5.2
```

`oh-my-pi-slim` does **not** declare, install, bundle, enable, update, or remove third-party Pi packages. Every dependency remains independently visible and user-managed through `pi list`, `pi install`, `pi update`, and `pi remove`.

On the next Pi startup, this package only:

1. Loads the `oh-my-pi-slim` main-session orchestration extension.
2. Keeps the bundled `pi-documentation` skill private until OMPS is active or the session is a managed specialist child.
3. Materializes exactly five pi-subagents definitions in `$PI_CODING_AGENT_DIR/agents/` (normally `~/.pi/agent/agents/`).
4. Installs a default global preset only when one does not already exist.
5. Merges the strict pi-subagents settings without replacing unrelated settings.
6. Records package-created assets in `$PI_CODING_AGENT_DIR/.oh-my-pi-slim-package-assets.json` for reversible cleanup.

`pi-documentation` is intentionally absent from the package's global `pi.skills` manifest and from the package root's conventional `skills/` directory, and it is not copied into the global skills directory. It lives under `extensions/oh-my-pi-slim/skills/`, where Pi cannot auto-discover it as a package skill. The extension loads that private `SKILL.md` with Pi's skill APIs and merges the standard skill entry into the normal `<available_skills>` block only for active main orchestrators and pi-subagents child sessions managed by the OMPS extension.

Then launch with the default preset:

```bash
pi --omps
```

Or select one explicitly:

```bash
pi --omps-preset openai
```

If one of the five agent filenames already exists with different contents, startup fails closed rather than overwriting it. Move the conflicting file aside and restart Pi.

The repository still contains `scripts/install.mjs` for source-checkout development and migration from the earlier standalone layout, but it no longer installs third-party packages unless the user supplies explicit dependency flags.

## Presets: configure all six roles independently

Models are **not** hard-coded in the specialist Markdown frontmatter. This is deliberate: pi-subagents gives an agent definition's frontmatter precedence over `Agent({ model, thinking })`, which would prevent runtime preset selection.

Preset files configure provider, exact model ID, and thinking level independently for:

1. `orchestrator`
2. `explorer`
3. `librarian`
4. `oracle`
5. `designer`
6. `fixer`

Configuration is loaded in this order:

1. Global: `$PI_CODING_AGENT_DIR/oh-my-pi-slim.json`
2. Project: `<cwd>/.pi/oh-my-pi-slim.json`

Project presets override global presets with the same name, and a project `defaultPreset` overrides the global default. Each preset is a complete unit: every preset must define all six roles.

Project configuration is honored only when Pi considers the project trusted, because it can select models and therefore affect cost and provider access.

### Example configuration

```json
{
  "defaultPreset": "balanced",
  "presets": {
    "balanced": {
      "orchestrator": {
        "provider": "anthropic",
        "model": "claude-opus-4-6",
        "thinking": "max"
      },
      "explorer": {
        "provider": "anthropic",
        "model": "claude-haiku-4-5",
        "thinking": "medium"
      },
      "librarian": {
        "provider": "anthropic",
        "model": "claude-haiku-4-5",
        "thinking": "medium"
      },
      "oracle": {
        "provider": "anthropic",
        "model": "claude-opus-4-6",
        "thinking": "max"
      },
      "designer": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "thinking": "high"
      },
      "fixer": {
        "provider": "anthropic",
        "model": "claude-sonnet-4-6",
        "thinking": "high"
      }
    }
  }
}
```

Preset names may contain letters, numbers, dots, underscores, and hyphens. Provider and model fields must be exact catalogue identifiers rather than free-form prompt text.

Valid thinking values are:

```text
off, minimal, low, medium, high, xhigh, max
```

Pi clamps a requested thinking level when a model does not support that level.

Use exact model IDs from:

```bash
pi --list-models
```

At activation, the extension validates all six configured models and their authentication. It fails closed if any configured provider/model is missing or unauthenticated.

### Create a project preset file

Start from the installed global configuration:

```bash
mkdir -p .pi
cp "${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/oh-my-pi-slim.json" \
  .pi/oh-my-pi-slim.json
```

Then edit `.pi/oh-my-pi-slim.json`. The repository includes `balanced`, `economy`, and `openai` examples.

## Launching

Use the configured default preset:

```bash
pi --omps
```

Select a preset at startup. `--omps-preset` implies orchestration, so no separate `--omps` flag is needed:

```bash
pi --omps-preset balanced
pi --omps-preset economy
pi --omps-preset openai
```

Environment-variable activation is also supported:

```bash
OMPS_ENABLE=1 OMPS_PRESET=balanced pi
```

Switch the current session directly:

```text
/preset economy
```

`/preset` without a name lists the available preset names, the configured default, and `Usage: /preset <name>`; it does not activate a preset.

Naming a preset enables oh-my-pi-slim when it is inactive, then immediately updates the main orchestrator model, thinking level, active preset prompt, and status. New specialist sessions use the newly selected preset; existing and resumed specialist sessions retain the model with which their Pi session was created.

The broader management command remains available:

```text
/omps on
/omps on balanced
/omps presets
/omps status
/omps off
```

`/omps preset economy` remains supported as a compatibility entry point, but `/preset economy` is the recommended in-session form.

`/omps off` disables the orchestration prompt and restores the model and thinking level that were active before the preset was first enabled. Switching between presets does not replace that original snapshot. The extension also restores the pre-preset state during session shutdown, so a startup preset does not permanently replace Pi's normal default model.

## Preset enforcement

When a preset is active:

- The extension applies the configured `orchestrator` provider/model and thinking level to the main Pi session.
- It does not modify Pi's active tool list; the orchestrator prompt works with the tools actually available in the current session.
- A dynamic preset contract is appended to the orchestrator system prompt.
- Every fresh or scheduled `Agent` call must include the exact configured `provider/modelId` and thinking value for the selected specialist.
- The extension blocks missing or mismatched specialist model settings and tells the orchestrator the exact required values.
- Resume calls omit model and thinking because pi-subagents resumes the existing in-memory session and ignores those overrides.
- `steer_subagent` automatically falls back from an upstream completed/steered rejection to resuming that same in-memory session. The one steer call waits and returns both the preserved prior result and the new result; running steers remain unchanged.

This makes the six role assignments configurable without generating or mutating shared agent definition files at startup, so concurrent Pi sessions can safely use different presets.

## Agent isolation and permissions

### Exactly five launchable specialist types

The strict pi-subagents settings disable built-in types and fallback dispatch:

```json
{
  "disableDefaultAgents": true,
  "fallbackSubagent": "none"
}
```

The main extension additionally blocks any `Agent` call whose `subagent_type` is not one of:

```text
explorer, librarian, oracle, designer, fixer
```

### No nested agents

All five Markdown definitions omit `allowed_subagents`, and the global setting is:

```json
{
  "maxSubagentDepth": 1
}
```

Specialists therefore receive no nested `Agent`, `get_subagent_result`, or `steer_subagent` tools. Their definitions also explicitly disallow orchestration tools.

### Prompt separation

Every specialist uses:

```yaml
prompt_mode: replace
```

All specialists load the full available Pi extension set, including `oh-my-pi-slim`. On `session_start`, OMPS detects the pi-subagents `<active_agent>` marker and keeps orchestrator activation, preset/model gates, status, and phase reminders inert in that child session. Its child-only behavior is to load global and project `AGENTS.md`/`CLAUDE.md` context with Pi's normal context-file selection rules for the child's effective working directory, then inject that shared context before the specialist role. `SYSTEM.md` and `APPEND_SYSTEM.md` are not inherited.

Each child dynamically renders Pi-style `Available tools` and `Guidelines` from its own active tool view instead of copying the main session's tools. Tools without a `promptSnippet` remain usable through their provider tool definition but do not appear in the short list. Tools registered late are reflected from the next turn after `turn_end` re-narrows the active set and rebuilds the prompt.

For active main orchestrator and specialist child sessions using Anthropic Messages models with OAuth, the provider's official Claude Code identity is authoritative: OMPS removes only the exact conflicting Pi identity text while preserving tools and the rest of the prompt. Inactive main sessions and other providers retain Pi's identity text.

For every active main orchestrator, OMPS also removes Pi's built-in documentation index from the always-on system prompt. The same navigation instructions are provided through the bundled `pi-documentation` skill instead. OMPS uses Pi's official skill loader and formatter, then merges only the skill's standard name, description, and `SKILL.md` location into the existing `<available_skills>` block; it creates that standard block before the working directory when no other skills are visible. Managed child sessions receive the same conditional skill entry. Inactive main sessions do not see it, and `/omps off` removes it from subsequent turns. Agents read the full skill on demand when a task concerns Pi extensions, themes, skills, prompts, TUI, keybindings, SDK, providers, models, packages, or environment variables. The exact documentation-removal boundary preserves append-system content, project context, other skills, and the working directory.

No specialist defines a `tools:` allowlist. Their only explicit tool denylist is:

```yaml
disallowed_tools: Agent, get_subagent_result, steer_subagent, stop_subagent, ask_user_question
```

This prevents nested orchestration and prevents a subagent from opening a questionnaire directly to the user. A subagent must report any blocking question to the main orchestrator. Explorer, Librarian, and Oracle remain read-only by their copied role instructions rather than by denying general-purpose tools.

## Librarian web research

Pi has no built-in web search. Specialists inherit [`pi-web-search`](https://github.com/ttttmr/pi-web-search) when it is installed; Librarian's copied instructions direct it to use that extension for external research.

It provides:

- `web_search` for supported Google, OpenAI, OpenAI Codex, and Anthropic models
- `url_context` for supported Gemini models

The selected Librarian preset model must support the extension's provider-native search API. If web search is unavailable, Librarian must state the limitation instead of pretending that broad external research was performed.

If you do not want web research, do not install `pi-web-search`, or disable/remove that standalone package yourself. Librarian can still inspect already-present documentation and external repository checkouts, but its network research capability will be degraded.

## Updating

For an unpinned GitHub install:

```bash
pi update git:github.com/YanzuoLu/oh-my-pi-slim
```

Or update all installed Pi packages:

```bash
pi update --extensions
```

Pinned refs do not move automatically. Install the new release ref explicitly:

```bash
pi install git:github.com/YanzuoLu/oh-my-pi-slim@v0.5.2
```

On the next startup, the package bootstrap updates unchanged managed agent files and preserves user-edited preset configuration. The extension reads the updated private `pi-documentation` skill from the package checkout when OMPS is active.

## Uninstallation

First remove the package-created agent files and restore the prior `subagents.json` values:

```bash
pi -p '/omps uninstall'
```

Then remove the Pi package itself:

```bash
pi remove git:github.com/YanzuoLu/oh-my-pi-slim
```

The cleanup command removes only files whose hashes still match the package-installed versions. It preserves pre-existing files, keeps user-modified files, and reports conflicts instead of deleting them.

Third-party packages are deliberately unaffected. Remove any of them separately only when you choose to:

```bash
pi remove npm:@tintinweb/pi-subagents
pi remove npm:@juicesharp/rpiv-ask-user-question
pi remove npm:pi-web-search
```

If the package was installed from a source checkout with the legacy script, the installer keeps `pi-documentation` under `$PI_CODING_AGENT_DIR/extensions/oh-my-pi-slim/skills/pi-documentation/SKILL.md`, so it is still invisible outside OMPS; use that checkout's `npm run uninstall:user` command to remove it or restore the prior file.

## Validation

Run:

```bash
npm run validate
```

Validation checks:

- exactly five repository agent definitions
- no specialist `tools:` allowlists
- the exact specialist denylist for orchestration and direct user questions
- no nested delegation configuration
- no hard-coded specialist model or thinking values
- complete six-role preset definitions
- Claude Code-only orchestration names are absent
- Pi explicit resume, automatic completed-steer resume fallback, normal running steering, stop RPC, and user-question mappings are present
- preset model/thinking enforcement exists
- strict pi-subagents settings are present
- Pi can load the TypeScript extension
- the Pi package has no third-party runtime dependencies and globally loads only its own extension
- `pi-documentation` is absent while OMPS is inactive and merges through Pi's standard skills block for active main and managed child sessions
- active main prompt trimming removes only Pi's built-in documentation index while preserving later append-system, context, skills, and cwd content
- package bootstrap and reversible asset cleanup are present
- legacy installation and uninstallation restore prior private extension files, the documentation skill, and settings in an isolated temporary Pi directory

## Repository layout

```text
.pi/oh-my-pi-slim.json                 Example multi-preset project config
agents/                                Five pi-subagents Markdown definitions
config/subagents.json                  Strict pi-subagents settings
extensions/oh-my-pi-slim/index.ts      Main-session extension and policy gates
extensions/oh-my-pi-slim/bootstrap.ts  Direct-package asset bootstrap and cleanup
extensions/oh-my-pi-slim/prompt-context.ts  Shared context and precise Pi prompt trimming helpers
extensions/oh-my-pi-slim/orchestrator.md
extensions/oh-my-pi-slim/skills/pi-documentation/SKILL.md  OMPS-private Pi docs navigation
package-lock.json                      Dependency-free package lock
scripts/install.mjs
scripts/uninstall.mjs
scripts/validate.mjs
```

## License

MIT
