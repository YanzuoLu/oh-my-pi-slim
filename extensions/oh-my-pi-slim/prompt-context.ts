export const TOOL_GUIDANCE_MARKER = "<omps-tool-guidance/>";
export const SHARED_CONTEXT_MARKER = "<omps-shared-context/>";
export const MAIN_PI_IDENTITY = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
export const CHILD_PI_IDENTITY_LINE = "You are a pi coding agent sub-agent.\n";
export const PI_DOCUMENTATION_START = "\n\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):";
export const PI_DOCUMENTATION_END = "- Always read pi .md files completely and follow links to related docs (e.g., tui.md for TUI API details)";
const CURRENT_WORKING_DIRECTORY = "\nCurrent working directory: ";
const TOOL_GUIDANCE_OPEN = "<omps-tool-guidance>";
const TOOL_GUIDANCE_CLOSE = "</omps-tool-guidance>";
const CHILD_PROMPT_PREFIX = /^(<active_agent\s+name="[^"]+"\s*\/>\n\n)You are a pi coding agent sub-agent\.\n/;

export interface ToolGuidanceOptions {
  selectedTools?: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
}

export interface ProjectContextFile {
  path: string;
  content: string;
}

export function renderToolGuidance(options: ToolGuidanceOptions): string {
  const tools = options.selectedTools || ["read", "bash", "edit", "write"];
  const visibleTools = tools.filter((name) => !!options.toolSnippets?.[name]);
  const toolsList = visibleTools.length > 0
    ? visibleTools.map((name) => `- ${name}: ${options.toolSnippets![name]}`).join("\n")
    : "(none)";

  const guidelinesList: string[] = [];
  const guidelinesSet = new Set<string>();
  const addGuideline = (guideline: string): void => {
    if (guidelinesSet.has(guideline)) return;
    guidelinesSet.add(guideline);
    guidelinesList.push(guideline);
  };

  if (
    tools.includes("bash") &&
    !tools.includes("grep") &&
    !tools.includes("find") &&
    !tools.includes("ls")
  ) {
    addGuideline("Use bash for file operations like ls, rg, find");
  }
  for (const guideline of options.promptGuidelines ?? []) {
    const normalized = guideline.trim();
    if (normalized.length > 0) addGuideline(normalized);
  }
  addGuideline("Be concise in your responses");
  addGuideline("Show file paths clearly when working with files");

  const guidelines = guidelinesList.map((guideline) => `- ${guideline}`).join("\n");
  return `Available tools:\n${toolsList}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.\n\nGuidelines:\n${guidelines}`;
}

export function injectToolGuidance(prompt: string, guidance: string): string {
  const wrapped = `${TOOL_GUIDANCE_OPEN}\n${guidance}\n${TOOL_GUIDANCE_CLOSE}`;
  if (prompt.includes(TOOL_GUIDANCE_MARKER)) {
    return prompt.replace(TOOL_GUIDANCE_MARKER, wrapped);
  }

  const wrapperStart = prompt.indexOf(TOOL_GUIDANCE_OPEN);
  const wrapperEnd = wrapperStart >= 0
    ? prompt.indexOf(TOOL_GUIDANCE_CLOSE, wrapperStart + TOOL_GUIDANCE_OPEN.length)
    : -1;
  if (wrapperEnd >= 0) {
    return prompt.slice(0, wrapperStart) + wrapped +
      prompt.slice(wrapperEnd + TOOL_GUIDANCE_CLOSE.length);
  }
  return `${prompt}\n\n${wrapped}`;
}

export function renderProjectContext(files: ProjectContextFile[]): string {
  if (files.length === 0) return "";

  let context = "\n\n<project_context>\n\nProject-specific instructions and guidelines:\n\n";
  for (const file of files) {
    context += `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>\n\n`;
  }
  return `${context}</project_context>\n`;
}

export function injectSharedProjectContext(prompt: string, context: string): string {
  if (prompt.includes(SHARED_CONTEXT_MARKER)) {
    return prompt.replace(
      SHARED_CONTEXT_MARKER,
      context && !prompt.includes(context) ? context : "",
    );
  }
  if (!context || prompt.includes(context)) return prompt;
  return `${prompt}${context}`;
}

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

export function injectPiDocumentationSkill(
  prompt: string,
  currentSkillsBlock: string,
  nextSkillsBlock: string,
): string {
  if (!nextSkillsBlock || currentSkillsBlock === nextSkillsBlock) return prompt;

  if (currentSkillsBlock) {
    const cwdStart = prompt.lastIndexOf(CURRENT_WORKING_DIRECTORY);
    const searchEnd = cwdStart >= 0 ? cwdStart : prompt.length;
    const currentStart = prompt.lastIndexOf(currentSkillsBlock, searchEnd);
    if (currentStart >= 0) {
      return prompt.slice(0, currentStart) + nextSkillsBlock +
        prompt.slice(currentStart + currentSkillsBlock.length);
    }
  }

  const cwdStart = prompt.lastIndexOf(CURRENT_WORKING_DIRECTORY);
  if (cwdStart >= 0) {
    return prompt.slice(0, cwdStart) + nextSkillsBlock + prompt.slice(cwdStart);
  }
  return `${prompt}${nextSkillsBlock}`;
}

export function removeMainPiIdentity(prompt: string): string {
  return prompt.startsWith(MAIN_PI_IDENTITY)
    ? prompt.slice(MAIN_PI_IDENTITY.length)
    : prompt;
}

export function removeChildPiIdentity(prompt: string): string {
  return prompt.replace(CHILD_PROMPT_PREFIX, "$1");
}
