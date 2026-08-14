export const MAIN_PI_IDENTITY = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
export const PI_DOCUMENTATION_START = "\n\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
export const PI_DOCUMENTATION_END = "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";

export function removeMainPiDocumentation(prompt: string): string {
  const start = prompt.indexOf(PI_DOCUMENTATION_START);
  if (start < 0) return prompt;

  const end = prompt.indexOf(
    PI_DOCUMENTATION_END,
    start + PI_DOCUMENTATION_START.length,
  );
  if (end < 0) return prompt;

  return prompt.slice(0, start) + prompt.slice(end + PI_DOCUMENTATION_END.length);
}

export function removeMainPiIdentity(prompt: string): string {
  return prompt.startsWith(MAIN_PI_IDENTITY)
    ? prompt.slice(MAIN_PI_IDENTITY.length)
    : prompt;
}
