---
name: pi-documentation
description: "Use for work about Pi itself: extensions, themes, skills, prompts, TUI, keybindings, SDK, providers, models, packages, or environment variables."
---

# Pi Documentation

Use this skill only when the task concerns Pi itself, its SDK, extensions, themes, skills, prompts, TUI, keybindings, providers, models, packages, or environment variables.

## Locate the installed documentation

Do not resolve `docs/...` or `examples/...` relative to the current project.

1. If `PI_PACKAGE_DIR` is set, test it first.
2. Otherwise resolve the `pi` executable and test plausible package roots rather than assuming one installation layout:

   ```bash
   pi_entry="$(realpath "$(command -v pi)")"
   for candidate in \
     "${PI_PACKAGE_DIR:-}" \
     "$(dirname "$pi_entry")" \
     "$(dirname "$(dirname "$pi_entry")")"
   do
     if [ -n "$candidate" ] && [ -f "$candidate/README.md" ] && [ -d "$candidate/docs" ]; then
       pi_root="$candidate"
       break
     fi
   done
   ```

3. If no candidate contains both `README.md` and `docs/`, inspect the active Pi installation layout; do not guess paths or use similarly named project files.

The main locations are:

```text
${pi_root}/README.md
${pi_root}/docs
${pi_root}/examples
```

## Choose the relevant documentation

- Main overview: `README.md`
- Extensions: `docs/extensions.md` and `examples/extensions/`
- Themes: `docs/themes.md`
- Skills: `docs/skills.md`
- Prompt templates: `docs/prompt-templates.md`
- TUI components: `docs/tui.md`
- Keybindings: `docs/keybindings.md`
- SDK integrations: `docs/sdk.md`
- Custom providers: `docs/custom-provider.md`
- Adding models: `docs/models.md`
- Pi packages: `docs/packages.md`
- Environment variables: `docs/environment-variables.md`

Read each relevant Markdown file completely and follow its Markdown cross-references before answering or implementing. When an example is relevant, resolve `examples/...` under `${pi_root}/examples`, not under the current working directory.
