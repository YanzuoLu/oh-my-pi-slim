import { getMarkdownTheme, type Theme } from "@earendil-works/pi-coding-agent";
import { Container, Markdown, Spacer, Text, stripTerminalSequences, type Component } from "@earendil-works/pi-tui";
import type { AskPublicAnswer, AskResult } from "./ask-runtime.js";

type UnknownRecord = Record<string, unknown>;
type ToolResultLike = { content?: unknown; details?: unknown };
type ToolRenderContextLike = { args?: unknown; expanded?: boolean };
type ToolResultRenderOptionsLike = { isPartial?: boolean; expanded?: boolean; isError?: boolean };

function asRecord(value: unknown): UnknownRecord | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as UnknownRecord : undefined;
}

function sanitizeText(value: unknown): string {
  const text = typeof value === "string"
    ? value
    : value === undefined || value === null
      ? ""
      : (() => { try { return JSON.stringify(value, null, 2) ?? String(value); } catch { return String(value); } })();
  return stripTerminalSequences(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, " ");
}

function contentText(content: unknown): string {
  if (!Array.isArray(content)) return sanitizeText(content);
  return content.map((item) => {
    const block = asRecord(item);
    return block?.type === "text" && typeof block.text === "string" ? sanitizeText(block.text) : sanitizeText(item);
  }).join("\n");
}

function safeFirstLine(text: string): string {
  return sanitizeText(text).split(/\r?\n/).find((line) => line.trim())?.trim() ?? "";
}

function questionCount(args: UnknownRecord): number {
  return Array.isArray(args.questions) ? args.questions.length : 0;
}

function questionLabel(count: number): string {
  return `${count} question${count === 1 ? "" : "s"}`;
}

function addField(container: Container, theme: Theme, label: string, value: unknown, indent = 0, fallback = "—"): void {
  const displayed = sanitizeText(value) || fallback;
  container.addChild(new Text(`${theme.fg("dim", `${label}:`)} ${theme.fg("toolOutput", displayed)}`, indent, 0));
}

function addSection(container: Container, theme: Theme, label: string, value: unknown, indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  container.addChild(new Text(theme.fg("toolOutput", sanitizeText(value) || "—"), indent + 2, 0));
}

function addList(container: Container, theme: Theme, label: string, values: readonly string[], indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  if (values.length === 0) {
    container.addChild(new Text(theme.fg("dim", "(none)"), indent + 2, 0));
    return;
  }
  values.forEach((value) => container.addChild(new Text(`${theme.fg("dim", "-")} ${theme.fg("toolOutput", sanitizeText(value))}`, indent + 2, 0)));
}

function addMarkdown(container: Container, theme: Theme, label: string, value: string, indent = 0): void {
  container.addChild(new Text(theme.fg("dim", `${label}:`), indent, 0));
  container.addChild(new Markdown(
    sanitizeText(value),
    indent + 2,
    0,
    getMarkdownTheme(),
    { color: (text) => theme.fg("toolOutput", text) },
    { preserveOrderedListMarkers: true, preserveBackslashEscapes: true, renderLatex: false },
  ));
}

function spaced(component: Component): Container {
  const container = new Container();
  container.addChild(new Spacer(1));
  container.addChild(component);
  return container;
}

function callQuestions(args: UnknownRecord): UnknownRecord[] {
  return Array.isArray(args.questions) ? args.questions.map(asRecord).filter(Boolean) as UnknownRecord[] : [];
}

function authoredOptions(question: UnknownRecord): UnknownRecord[] {
  return Array.isArray(question.options) ? question.options.map(asRecord).filter(Boolean) as UnknownRecord[] : [];
}

function renderExpandedQuestion(container: Container, theme: Theme, question: UnknownRecord, index: number): void {
  container.addChild(new Spacer(1));
  const header = sanitizeText(question.header) || `Question ${index + 1}`;
  container.addChild(new Text(`${theme.fg("dim", `${index + 1}.`)} ${theme.fg("toolTitle", theme.bold(header))}`, 0, 0));
  addSection(container, theme, "Question", question.question, 2);
  addField(container, theme, "Header", question.header, 2);
  addField(container, theme, "Multi-select", question.multiSelect === true, 2);
  container.addChild(new Text(theme.fg("dim", "Options:"), 2, 0));
  const options = authoredOptions(question);
  if (options.length === 0) {
    container.addChild(new Text(theme.fg("dim", "(none)"), 4, 0));
    return;
  }
  options.forEach((option, optionIndex) => {
    container.addChild(new Text(
      `${theme.fg("dim", `${optionIndex + 1}.`)} ${theme.fg("toolOutput", sanitizeText(option.label) || "—")}`,
      4,
      0,
    ));
    addSection(container, theme, "Description", option.description, 6);
    if (option.preview !== undefined) addMarkdown(container, theme, "Preview", sanitizeText(option.preview), 6);
  });
}

export function renderAskCall(argsValue: unknown, theme: Theme, context: ToolRenderContextLike = {}): Component {
  const args = asRecord(argsValue) ?? {};
  const questions = callQuestions(args);
  const count = questionCount(args);
  const expanded = context.expanded === true;
  const container = new Container();
  container.addChild(new Text(
    `${theme.fg("toolTitle", theme.bold("ask_user_question"))} ${theme.fg("muted", `· ${questionLabel(count)}${expanded ? "" : " (ctrl+o to expand)"}`)}`,
    0,
    0,
  ));
  if (!expanded) {
    questions.forEach((question, index) => addField(container, theme, `${index + 1}`, question.header));
    return container;
  }
  questions.forEach((question, index) => renderExpandedQuestion(container, theme, question, index));
  return container;
}

function publicAnswer(value: unknown): AskPublicAnswer | undefined {
  const answer = asRecord(value);
  if (!answer || !Number.isInteger(answer.questionIndex) || typeof answer.question !== "string" || typeof answer.header !== "string") return;
  if (answer.kind !== "option" && answer.kind !== "multi" && answer.kind !== "custom") return;
  if (answer.kind === "multi") {
    if (!Array.isArray(answer.answer) || !answer.answer.every((item) => typeof item === "string")) return;
  } else if (answer.kind === "option") {
    if (typeof answer.answer !== "string") return;
  } else if (answer.answer !== null && typeof answer.answer !== "string") return;
  const selected = Array.isArray(answer.selected) && answer.selected.every((item) => typeof item === "string")
    ? [...answer.selected] as string[]
    : undefined;
  const preview = typeof answer.preview === "string" ? answer.preview : undefined;
  return {
    questionIndex: Number(answer.questionIndex),
    question: answer.question,
    header: answer.header,
    kind: answer.kind,
    answer: Array.isArray(answer.answer) ? [...answer.answer] : answer.answer,
    ...(selected ? { selected } : {}),
    ...(preview !== undefined ? { preview } : {}),
  } as AskPublicAnswer;
}

function askResult(value: unknown): AskResult | undefined {
  const details = asRecord(value);
  if (!details || !Array.isArray(details.answers) || typeof details.cancelled !== "boolean" || typeof details.partial !== "boolean") return;
  const answers = details.answers.map(publicAnswer);
  if (answers.some((answer) => !answer)) return;
  const cancelReason = details.cancelReason === "user_cancelled" || details.cancelReason === "empty_submit"
    ? details.cancelReason
    : undefined;
  if (details.cancelReason !== undefined && cancelReason === undefined) return;
  return {
    answers: answers as AskPublicAnswer[],
    cancelled: details.cancelled,
    partial: details.partial,
    ...(cancelReason ? { cancelReason } : {}),
  };
}

function compactSummary(result: AskResult, total: number, theme: Theme): Component {
  const answered = result.answers.length;
  if (result.cancelled) {
    const reason = result.cancelReason === "empty_submit" ? "empty submit" : "user cancelled";
    return new Text(
      `${theme.fg("warning", "!")} ${theme.fg("toolOutput", `Cancelled · ${answered}/${total} answered · ${reason}`)}`,
      0,
      0,
    );
  }
  const status = result.partial ? "partial" : "complete";
  return new Text(
    `${theme.fg(result.partial ? "warning" : "success", result.partial ? "◐" : "✓")} ${theme.fg("toolOutput", `Answered ${answered}/${total} · ${status}`)}`,
    0,
    0,
  );
}

function answerDisplay(answer: AskPublicAnswer): string {
  if (answer.kind === "multi") {
    const selected = answer.answer as string[];
    return selected.length === 0 ? "(no options selected)" : selected.join(", ");
  }
  if (answer.kind === "custom" && answer.answer === null) return "(empty custom response)";
  return String(answer.answer);
}

function renderExpandedResult(result: AskResult, args: UnknownRecord, theme: Theme): Component {
  const questions = callQuestions(args);
  const total = questions.length || Math.max(result.answers.length, 0);
  const container = new Container();
  container.addChild(compactSummary(result, total, theme));
  addField(container, theme, "Cancelled", result.cancelled);
  addField(container, theme, "Partial", result.partial);
  if (result.cancelReason) addField(container, theme, "Cancel reason", result.cancelReason);
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("toolTitle", theme.bold("Answers")), 0, 0));
  if (result.answers.length === 0) {
    container.addChild(new Text(theme.fg("dim", "No answers were confirmed."), 2, 0));
  }
  result.answers.forEach((answer) => {
    container.addChild(new Spacer(1));
    container.addChild(new Text(
      `${theme.fg("dim", `${answer.questionIndex + 1}.`)} ${theme.fg("toolTitle", theme.bold(sanitizeText(answer.header)))}`,
      2,
      0,
    ));
    addSection(container, theme, "Question", answer.question, 4);
    addField(container, theme, "Kind", answer.kind, 4);
    addSection(container, theme, "Answer", answerDisplay(answer), 4);
    if (answer.selected !== undefined) addList(container, theme, "Selected", answer.selected, 4);
    if (answer.preview !== undefined) addMarkdown(container, theme, "Selected preview", answer.preview, 4);
  });

  const answeredIndexes = new Set(result.answers.map((answer) => answer.questionIndex));
  const unanswered = questions
    .map((question, index) => ({ question, index }))
    .filter(({ index }) => !answeredIndexes.has(index));
  container.addChild(new Spacer(1));
  container.addChild(new Text(theme.fg("toolTitle", theme.bold("Unanswered")), 0, 0));
  if (unanswered.length === 0) {
    container.addChild(new Text(theme.fg("dim", "(none)"), 2, 0));
  } else {
    unanswered.forEach(({ question, index }) => {
      const header = sanitizeText(question.header) || `Question ${index + 1}`;
      container.addChild(new Text(`${theme.fg("dim", `${index + 1}.`)} ${theme.fg("toolOutput", header)}`, 2, 0));
      addSection(container, theme, "Question", question.question, 4);
    });
  }
  return container;
}

function fallbackResult(result: ToolResultLike, options: ToolResultRenderOptionsLike, theme: Theme): Component {
  const text = contentText(result.content);
  if (text) {
    return new Text(
      theme.fg(options.isError ? "error" : "toolOutput", options.expanded === true ? sanitizeText(text) : safeFirstLine(text)),
      0,
      0,
    );
  }
  return new Text(theme.fg(options.isPartial ? "warning" : "dim", options.isPartial ? "Result pending…" : "No result content."), 0, 0);
}

export function renderAskResult(
  resultValue: ToolResultLike,
  options: ToolResultRenderOptionsLike = {},
  theme: Theme,
  context: ToolRenderContextLike = {},
): Component {
  const result = askResult(resultValue.details);
  if (!result) return spaced(fallbackResult(resultValue, options, theme));
  const args = asRecord(context.args) ?? {};
  const total = questionCount(args) || result.answers.length;
  return spaced(options.expanded === true
    ? renderExpandedResult(result, args, theme)
    : compactSummary(result, total, theme));
}
