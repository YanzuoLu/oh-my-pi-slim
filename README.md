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
| Redirect a running specialist | `steer_subagent({ agent_id, message })` |
| Continue a completed specialist session | `Agent({ resume: agent_id, ... })` |
| Stop a running specialist | `stop_subagent({ agent_id })`, implemented over pi-subagents' `subagents:rpc:stop` RPC |
| Ask a blocking clarification | `ask_user_question({ questions })`, supplied by `@juicesharp/rpiv-ask-user-question` |
| Custom agent type | Bare Markdown filename such as `explorer`, not a namespaced type |

Background completions use pi-subagents' automatic follow-up notifications. The orchestrator is instructed not to poll running agents.

## Requirements

- Pi `>= 0.80.0`; this repository was validated with Pi `0.84.1`
- Node.js available to run the installation scripts
- Authentication configured for every provider/model used by the selected preset
- A clean specialist namespace:
  - project `.pi/agents/`
  - project `.agents/agents/`
  - global `$PI_CODING_AGENT_DIR/agents/`, normally `~/.pi/agent/agents/`

The installer refuses unrelated global Markdown agent definitions by default. The orchestration extension also blocks every `Agent` type except the five names above.

## Installation

### Recommended installation

Clone and install:

```bash
git clone https://github.com/YanzuoLu/oh-my-pi-slim.git
cd oh-my-pi-slim
npm run validate
npm run install:user
```

`npm run install:user` does all of the following:

1. Installs `npm:@tintinweb/pi-subagents` through Pi.
2. Installs the optional `npm:pi-web-search` package used by Librarian.
3. Installs `npm:@juicesharp/rpiv-ask-user-question` for main-session clarification questions.
4. Copies exactly five definitions from this repository's `agents/` directory to:

   ```text
   $PI_CODING_AGENT_DIR/agents/
   ```

   or, when `PI_CODING_AGENT_DIR` is unset:

   ```text
   ~/.pi/agent/agents/
   ```

5. Installs the main-session extension at:

   ```text
   ~/.pi/agent/extensions/oh-my-pi-slim/
   ```

6. Installs a global preset configuration at `~/.pi/agent/oh-my-pi-slim.json` if that file does not already exist.
7. Safely merges these values into `~/.pi/agent/subagents.json`:

   ```json
   {
     "disableDefaultAgents": true,
     "fallbackSubagent": "none",
     "maxSubagentDepth": 1,
     "defaultJoinMode": "smart"
   }
   ```

8. Writes `~/.pi/agent/.oh-my-pi-slim-install.json`, recording installed hashes, backups, and prior settings for reversible uninstallation.

Existing files with the five managed agent names or extension paths are backed up before replacement. An existing global `oh-my-pi-slim.json` is treated as user configuration and is preserved rather than overwritten.

### Manual installation

Set the Pi agent directory and install dependencies:

```bash
export PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
pi install npm:@tintinweb/pi-subagents
pi install npm:pi-web-search
pi install npm:@juicesharp/rpiv-ask-user-question
```

Copy the five agent definitions explicitly:

```bash
mkdir -p "$PI_AGENT_DIR/agents"
cp agents/explorer.md "$PI_AGENT_DIR/agents/explorer.md"
cp agents/librarian.md "$PI_AGENT_DIR/agents/librarian.md"
cp agents/oracle.md "$PI_AGENT_DIR/agents/oracle.md"
cp agents/designer.md "$PI_AGENT_DIR/agents/designer.md"
cp agents/fixer.md "$PI_AGENT_DIR/agents/fixer.md"
```

Install the orchestration extension:

```bash
mkdir -p "$PI_AGENT_DIR/extensions/oh-my-pi-slim"
cp extensions/oh-my-pi-slim/index.ts \
  "$PI_AGENT_DIR/extensions/oh-my-pi-slim/index.ts"
cp extensions/oh-my-pi-slim/orchestrator.md \
  "$PI_AGENT_DIR/extensions/oh-my-pi-slim/orchestrator.md"
```

Install the default global presets if you do not already have a global preset file:

```bash
if [ ! -e "$PI_AGENT_DIR/oh-my-pi-slim.json" ]; then
  cp .pi/oh-my-pi-slim.json "$PI_AGENT_DIR/oh-my-pi-slim.json"
fi
```

Before changing `subagents.json`, record whether it exists and back it up:

```bash
if [ -e "$PI_AGENT_DIR/subagents.json" ]; then
  cp -p "$PI_AGENT_DIR/subagents.json" \
    "$PI_AGENT_DIR/subagents.json.oh-my-pi-slim.manual-backup"
else
  : > "$PI_AGENT_DIR/.oh-my-pi-slim-subagents-was-absent"
fi
```

If `subagents.json` does not exist, copy the strict configuration:

```bash
cp config/subagents.json "$PI_AGENT_DIR/subagents.json"
```

If it already exists, merge the four fields instead of replacing unrelated settings:

```bash
node - "$PI_AGENT_DIR/subagents.json" config/subagents.json <<'NODE'
const fs = require("node:fs");
const [target, source] = process.argv.slice(2);
const current = fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, "utf8")) : {};
const required = JSON.parse(fs.readFileSync(source, "utf8"));
fs.writeFileSync(target, JSON.stringify({ ...current, ...required }, null, 2) + "\n");
NODE
```

The recommended installer is safer because it records backups and prior values for uninstallation.

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

Inside an existing Pi session:

```text
/omps on
/omps on balanced
/omps preset economy
/omps presets
/omps status
/omps off
```

`/omps off` disables the orchestration prompt and restores the model and thinking level that were active before the preset was enabled. The extension also restores that pre-preset state during session shutdown, so a startup preset does not permanently replace Pi's normal default model.

Changing a preset affects the main orchestrator and new specialist launches. Already-running and resumed specialist sessions retain the model with which their Pi session was created.

## Preset enforcement

When a preset is active:

- The extension applies the configured `orchestrator` provider/model and thinking level to the main Pi session.
- It does not modify Pi's active tool list; the orchestrator prompt works with the tools actually available in the current session.
- A dynamic preset contract is appended to the orchestrator system prompt.
- Every fresh or scheduled `Agent` call must include the exact configured `provider/modelId` and thinking value for the selected specialist.
- The extension blocks missing or mismatched specialist model settings and tells the orchestrator the exact required values.
- Resume calls omit model and thinking because pi-subagents resumes the existing in-memory session and ignores those overrides.

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

All specialists inherit available Pi extension tools except the main-session-only `oh-my-pi-slim` extension, which is excluded to prevent child sessions from applying the orchestrator preset or prompt.

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

If you do not want web research, omit the package installation:

```bash
pi install npm:@tintinweb/pi-subagents
pi install npm:@juicesharp/rpiv-ask-user-question
node scripts/install.mjs
```

Librarian will still be able to inspect already-present documentation and external repository checkouts, but it will have no network retrieval tool and its external-research capability will be degraded.

## Updating

Because installation records exact managed files, update by uninstalling managed files, updating the clone, and reinstalling:

```bash
cd /path/to/oh-my-pi-slim
npm run uninstall:user
git pull --ff-only
npm run validate
npm run install:user
```

The normal uninstall leaves shared Pi packages installed, so updating does not repeatedly remove and reinstall them.

Keep long-lived custom presets in a project `.pi/oh-my-pi-slim.json` or in an existing global preset file. The installer preserves an existing global preset file.

## Uninstallation

### Remove managed files but keep shared Pi packages

```bash
cd /path/to/oh-my-pi-slim
npm run uninstall:user
```

This uses the installation manifest to:

- remove files whose contents still match the installed versions
- restore files that existed before installation
- restore only the `subagents.json` fields changed by the installer
- preserve unrelated settings
- leave user-modified installed files in place and report them
- retain backups when a conflict requires manual review

It intentionally leaves `@tintinweb/pi-subagents`, `pi-web-search`, and `@juicesharp/rpiv-ask-user-question` installed because other Pi workflows may share them.

### Remove managed files and all three Pi packages

Only use this when none of the packages is needed elsewhere:

```bash
npm run uninstall:all
```

Equivalent commands:

```bash
node scripts/uninstall.mjs --remove-dependencies
```

Individual package-removal flags are also available:

```bash
node scripts/uninstall.mjs --remove-dependency
node scripts/uninstall.mjs --remove-web-search
node scripts/uninstall.mjs --remove-ask-user
```

### Uninstall a manual installation

If you used the manual installation steps, no installation manifest exists. Remove only the five named definitions and this extension:

```bash
export PI_AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
rm -f "$PI_AGENT_DIR/agents/explorer.md"
rm -f "$PI_AGENT_DIR/agents/librarian.md"
rm -f "$PI_AGENT_DIR/agents/oracle.md"
rm -f "$PI_AGENT_DIR/agents/designer.md"
rm -f "$PI_AGENT_DIR/agents/fixer.md"
rm -rf "$PI_AGENT_DIR/extensions/oh-my-pi-slim"
```

Restore the settings backup created by the manual installation instructions:

```bash
if [ -e "$PI_AGENT_DIR/subagents.json.oh-my-pi-slim.manual-backup" ]; then
  mv "$PI_AGENT_DIR/subagents.json.oh-my-pi-slim.manual-backup" \
    "$PI_AGENT_DIR/subagents.json"
elif [ -e "$PI_AGENT_DIR/.oh-my-pi-slim-subagents-was-absent" ]; then
  rm -f "$PI_AGENT_DIR/subagents.json"
fi
rm -f "$PI_AGENT_DIR/.oh-my-pi-slim-subagents-was-absent"
```

The global `oh-my-pi-slim.json` is user-editable configuration. Leave it in place by default; remove it only if you created it solely for this project and no longer need its presets:

```bash
rm -f "$PI_AGENT_DIR/oh-my-pi-slim.json"
```

Optionally remove packages when they are not shared:

```bash
pi remove npm:@tintinweb/pi-subagents
pi remove npm:pi-web-search
pi remove npm:@juicesharp/rpiv-ask-user-question
```

Do not delete the whole `~/.pi/agent/agents`, `extensions`, or settings directories: they may contain unrelated user resources.

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
- Pi resume, steering, stop RPC, and user-question mappings are present
- preset model/thinking enforcement exists
- strict pi-subagents settings are present
- Pi can load the TypeScript extension
- installation and uninstallation restore prior files and settings in an isolated temporary Pi directory

## Repository layout

```text
.pi/oh-my-pi-slim.json                 Example multi-preset project config
agents/                                Five pi-subagents Markdown definitions
config/subagents.json                  Strict pi-subagents settings
extensions/oh-my-pi-slim/index.ts      Main-session extension and policy gates
extensions/oh-my-pi-slim/orchestrator.md
scripts/install.mjs
scripts/uninstall.mjs
scripts/validate.mjs
```

## License

MIT
