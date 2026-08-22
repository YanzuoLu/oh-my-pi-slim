import { getMarkdownTheme, type ExtensionUIContext, type Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  Key,
  Markdown,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type Focusable,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  ASK_CUSTOM_LABEL,
  ASK_NEXT_LABEL,
  ASK_RPC_CANCEL_LABEL,
  ASK_RPC_SUBMIT_LABEL,
  type AskDriverAnswer,
  type AskDriverResult,
  type AskQuestion,
  type AskTuiDriver as AskDriver,
  type ValidatedQuestionnaire,
} from "./ask-runtime.js";

const ABORTED = Symbol("ask-tui-aborted");
const CUSTOM_DESCRIPTION = "Write a custom response in the inline editor.";
const NEXT_DESCRIPTION = "Confirm this question and continue. Empty selections are allowed.";
const WIDE_PREVIEW_MIN_WIDTH = 100;
const BODY_CONTROL_PATTERN = /[\u0000-\u0009\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

type AskOverlayResult = AskDriverResult | typeof ABORTED;

function safeAuthoredBody(value: string): string {
  return stripTerminalSequences(value)
    .replace(/\r\n?/g, "\n")
    .replace(BODY_CONTROL_PATTERN, " ");
}

function safeAuthoredInline(value: string): string {
  return safeAuthoredBody(value).replace(/\n/g, " ");
}

function abortError(reason?: unknown): Error {
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string" && reason.trim()
      ? reason
      : "The questionnaire was aborted.";
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function answerSnapshot(answers: ReadonlyMap<number, AskDriverAnswer>): AskDriverAnswer[] {
  return [...answers.values()]
    .map((answer) => ({ ...answer, answer: Array.isArray(answer.answer) ? [...answer.answer] : answer.answer }))
    .sort((left, right) => left.questionIndex - right.questionIndex);
}

function paddedLine(line: string, width: number): string {
  const safe = truncateToWidth(line, Math.max(0, width), "");
  return `${safe}${" ".repeat(Math.max(0, width - visibleWidth(safe)))}`;
}

function mergeColumns(left: string[], right: string[], leftWidth: number, rightWidth: number, gap: number, width: number): string[] {
  const lines: string[] = [];
  const count = Math.max(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const line = `${paddedLine(left[index] ?? "", leftWidth)}${" ".repeat(gap)}${truncateToWidth(right[index] ?? "", rightWidth, "")}`;
    lines.push(truncateToWidth(line, width, ""));
  }
  return lines;
}

export interface AskQuestionnaireComponentOptions {
  questionnaire: ValidatedQuestionnaire;
  tui: TUI;
  theme: Theme;
  onDone: (result: AskDriverResult) => void;
}

export class AskQuestionnaireComponent implements Component, Focusable {
  private readonly questionnaire: ValidatedQuestionnaire;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly onDone: (result: AskDriverResult) => void;
  private readonly answers = new Map<number, AskDriverAnswer>();
  private readonly optionIndexes: number[];
  private readonly multiSelections: Array<Set<string>>;
  private readonly customDrafts: string[];
  private readonly editor: Editor;
  /**
   * A single question owns the whole questionnaire, so confirming it is the only decision left and
   * a Submit tab would be a second, empty step. The tab exists only from two questions upward, and
   * every index computation below derives from this flag so no ghost tab can ever be reached.
   */
  private readonly hasSubmitTab: boolean;
  private currentTab = 0;
  private submitIndex = 0;
  private customQuestionIndex: number | undefined;
  private finished = false;
  private _focused = false;

  constructor(options: AskQuestionnaireComponentOptions) {
    this.questionnaire = options.questionnaire;
    this.tui = options.tui;
    this.theme = options.theme;
    this.onDone = options.onDone;
    this.hasSubmitTab = this.questionnaire.questions.length > 1;
    this.optionIndexes = this.questionnaire.questions.map(() => 0);
    this.multiSelections = this.questionnaire.questions.map(() => new Set<string>());
    this.customDrafts = this.questionnaire.questions.map(() => "");
    const editorTheme: EditorTheme = {
      borderColor: (text) => this.theme.fg("borderAccent", text),
      selectList: {
        selectedPrefix: (text) => this.theme.fg("accent", text),
        selectedText: (text) => this.theme.fg("accent", text),
        description: (text) => this.theme.fg("muted", text),
        scrollInfo: (text) => this.theme.fg("dim", text),
        noMatch: (text) => this.theme.fg("warning", text),
      },
    };
    this.editor = new Editor(this.tui, editorTheme, { paddingX: 0 });
    this.editor.onChange = (value) => {
      if (this.customQuestionIndex !== undefined) this.customDrafts[this.customQuestionIndex] = value;
    };
    this.editor.onSubmit = (value) => {
      const questionIndex = this.customQuestionIndex;
      if (questionIndex === undefined) return;
      this.customDrafts[questionIndex] = value;
      this.customQuestionIndex = undefined;
      this.editor.focused = false;
      this.answers.set(questionIndex, {
        questionIndex,
        kind: "custom",
        answer: value.length === 0 ? null : value,
      });
      this.advance(questionIndex);
    };
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value && this.customQuestionIndex !== undefined;
  }

  private requestRender(): void {
    this.tui.requestRender();
  }

  private question(): AskQuestion | undefined {
    return this.questionnaire.questions[this.currentTab];
  }

  private totalTabs(): number {
    return this.questionnaire.questions.length + (this.hasSubmitTab ? 1 : 0);
  }

  private onSubmitTab(): boolean {
    return this.hasSubmitTab && this.currentTab === this.questionnaire.questions.length;
  }

  private finish(cancelled: boolean): void {
    if (this.finished) return;
    this.finished = true;
    // Cancelling is a full withdrawal: nothing the user confirmed earlier survives it.
    this.onDone(cancelled ? { answers: [], cancelled: true } : { answers: answerSnapshot(this.answers) });
  }

  private moveTab(delta: number): void {
    this.currentTab = (this.currentTab + delta + this.totalTabs()) % this.totalTabs();
    this.requestRender();
  }

  private advance(questionIndex: number): void {
    if (!this.hasSubmitTab) {
      this.finish(false);
      return;
    }
    this.currentTab = questionIndex < this.questionnaire.questions.length - 1
      ? questionIndex + 1
      : this.questionnaire.questions.length;
    this.requestRender();
  }

  private enterCustom(questionIndex: number): void {
    const question = this.questionnaire.questions[questionIndex];
    if (question.multiSelect === true) this.multiSelections[questionIndex].clear();
    this.customQuestionIndex = questionIndex;
    this.editor.setText(this.customDrafts[questionIndex]);
    this.editor.focused = this._focused;
    this.requestRender();
  }

  private cancelCustom(): void {
    const questionIndex = this.customQuestionIndex;
    if (questionIndex === undefined) return;
    this.customDrafts[questionIndex] = this.editor.getExpandedText();
    this.customQuestionIndex = undefined;
    this.editor.focused = false;
    this.requestRender();
  }

  private activateSingle(questionIndex: number): void {
    const question = this.questionnaire.questions[questionIndex];
    const optionIndex = this.optionIndexes[questionIndex];
    if (optionIndex === question.options.length) {
      this.enterCustom(questionIndex);
      return;
    }
    const option = question.options[optionIndex];
    this.answers.set(questionIndex, { questionIndex, kind: "option", answer: option.label });
    this.advance(questionIndex);
  }

  private activateMulti(questionIndex: number): void {
    const question = this.questionnaire.questions[questionIndex];
    const optionIndex = this.optionIndexes[questionIndex];
    const selections = this.multiSelections[questionIndex];
    if (optionIndex < question.options.length) {
      const label = question.options[optionIndex].label;
      if (selections.has(label)) selections.delete(label);
      else selections.add(label);
      this.requestRender();
      return;
    }
    if (optionIndex === question.options.length) {
      this.enterCustom(questionIndex);
      return;
    }
    const selected = question.options.map((option) => option.label).filter((label) => selections.has(label));
    this.answers.set(questionIndex, { questionIndex, kind: "multi", answer: selected });
    this.advance(questionIndex);
  }

  handleInput(data: string): void {
    if (this.finished) return;
    if (this.customQuestionIndex !== undefined) {
      if (matchesKey(data, Key.escape)) {
        this.cancelCustom();
        return;
      }
      this.editor.handleInput(data);
      this.requestRender();
      return;
    }

    if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
      this.moveTab(1);
      return;
    }
    if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
      this.moveTab(-1);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.finish(true);
      return;
    }

    if (this.onSubmitTab()) {
      if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
        this.submitIndex = (this.submitIndex + 1) % 2;
        this.requestRender();
      } else if (matchesKey(data, Key.enter) || matchesKey(data, Key.space)) {
        this.finish(this.submitIndex === 1);
      }
      return;
    }

    const question = this.question();
    if (!question) return;
    const itemCount = question.options.length + (question.multiSelect === true ? 2 : 1);
    if (matchesKey(data, Key.up)) {
      this.optionIndexes[this.currentTab] = (this.optionIndexes[this.currentTab] - 1 + itemCount) % itemCount;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.optionIndexes[this.currentTab] = (this.optionIndexes[this.currentTab] + 1) % itemCount;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter) || (question.multiSelect === true && matchesKey(data, Key.space))) {
      if (question.multiSelect === true) this.activateMulti(this.currentTab);
      else this.activateSingle(this.currentTab);
    }
  }

  private addWrapped(lines: string[], text: string, width: number, prefix = ""): void {
    const safeWidth = Math.max(1, width);
    const prefixWidth = visibleWidth(prefix);
    if (prefixWidth >= safeWidth) {
      lines.push(...wrapTextWithAnsi(`${prefix}${text}`, safeWidth));
      return;
    }
    const wrapped = wrapTextWithAnsi(text, Math.max(1, safeWidth - prefixWidth));
    const continuation = " ".repeat(prefixWidth);
    if (wrapped.length === 0) lines.push(truncateToWidth(prefix, safeWidth, ""));
    else wrapped.forEach((line, index) => lines.push(truncateToWidth(`${index === 0 ? prefix : continuation}${line}`, safeWidth, "")));
  }

  private renderTabs(width: number): string[] {
    const parts: string[] = [];
    for (let index = 0; index < this.questionnaire.questions.length; index += 1) {
      const question = this.questionnaire.questions[index];
      const answered = this.answers.has(index);
      const text = ` ${answered ? "■" : "□"} ${safeAuthoredInline(question.header)} `;
      parts.push(index === this.currentTab
        ? this.theme.bg("selectedBg", this.theme.fg("text", text))
        : this.theme.fg(answered ? "success" : "muted", text));
    }
    if (this.hasSubmitTab) {
      const submitText = " ✓ Submit ";
      parts.push(this.currentTab === this.questionnaire.questions.length
        ? this.theme.bg("selectedBg", this.theme.fg("text", submitText))
        : this.theme.fg("accent", submitText));
    }
    const lines: string[] = [];
    this.addWrapped(lines, parts.join(" "), width, " ");
    return lines;
  }

  private optionLines(questionIndex: number, width: number): string[] {
    const question = this.questionnaire.questions[questionIndex];
    const focus = this.optionIndexes[questionIndex];
    const lines: string[] = [];
    const selections = this.multiSelections[questionIndex];
    for (let index = 0; index < question.options.length; index += 1) {
      const option = question.options[index];
      const active = focus === index;
      const checkbox = question.multiSelect === true ? (selections.has(option.label) ? "[x] " : "[ ] ") : "";
      const prefix = active ? this.theme.fg("accent", "> ") : "  ";
      this.addWrapped(lines, this.theme.fg(active ? "accent" : "text", `${checkbox}${index + 1}. ${safeAuthoredInline(option.label)}`), width, prefix);
      this.addWrapped(lines, this.theme.fg("muted", safeAuthoredBody(option.description)), width, "     ");
    }
    const customIndex = question.options.length;
    const customActive = focus === customIndex;
    const customPrefix = customActive ? this.theme.fg("accent", "> ") : "  ";
    this.addWrapped(lines, this.theme.fg(customActive ? "accent" : "text", `${question.options.length + 1}. ${ASK_CUSTOM_LABEL}`), width, customPrefix);
    this.addWrapped(lines, this.theme.fg("muted", CUSTOM_DESCRIPTION), width, "     ");
    if (question.multiSelect === true) {
      const nextIndex = customIndex + 1;
      const nextActive = focus === nextIndex;
      const nextPrefix = nextActive ? this.theme.fg("accent", "> ") : "  ";
      this.addWrapped(lines, this.theme.fg(nextActive ? "accent" : "text", `${question.options.length + 2}. ${ASK_NEXT_LABEL}`), width, nextPrefix);
      this.addWrapped(lines, this.theme.fg("muted", NEXT_DESCRIPTION), width, "     ");
    }
    return lines;
  }

  private focusedPreview(questionIndex: number): string | undefined {
    const question = this.questionnaire.questions[questionIndex];
    const optionIndex = this.optionIndexes[questionIndex];
    return optionIndex < question.options.length ? question.options[optionIndex].preview : undefined;
  }

  private previewLines(questionIndex: number, width: number): string[] {
    const preview = this.focusedPreview(questionIndex);
    const lines: string[] = [this.theme.fg("dim", "Preview")];
    if (preview === undefined) {
      this.addWrapped(lines, this.theme.fg("muted", "No preview for this option."), width);
      return lines;
    }
    const markdown = new Markdown(
      safeAuthoredBody(preview),
      0,
      0,
      getMarkdownTheme(),
      { color: (text) => this.theme.fg("text", text) },
      { preserveOrderedListMarkers: true, preserveBackslashEscapes: true, renderLatex: false },
    );
    lines.push(...markdown.render(Math.max(1, width)));
    return lines;
  }

  private renderQuestion(questionIndex: number, width: number): string[] {
    const question = this.questionnaire.questions[questionIndex];
    const lines: string[] = [];
    this.addWrapped(lines, this.theme.fg("accent", this.theme.bold(safeAuthoredInline(question.header))), width, " ");
    this.addWrapped(lines, this.theme.fg("text", safeAuthoredBody(question.question)), width, " ");
    lines.push("");

    if (this.customQuestionIndex === questionIndex) {
      lines.push(...this.optionLines(questionIndex, width));
      lines.push("");
      this.addWrapped(lines, this.theme.fg("accent", ASK_CUSTOM_LABEL), width, " ");
      this.addWrapped(lines, this.theme.fg("muted", "Enter submits · Shift+Enter adds a line · Esc keeps the draft and returns"), width, " ");
      lines.push("");
      const editorWidth = Math.max(1, width - 2);
      for (const line of this.editor.render(editorWidth)) lines.push(truncateToWidth(` ${line}`, width, ""));
      return lines;
    }

    const hasPreview = question.options.some((option) => option.preview !== undefined);
    if (!hasPreview) {
      lines.push(...this.optionLines(questionIndex, width));
      return lines;
    }
    if (width >= WIDE_PREVIEW_MIN_WIDTH) {
      const gap = 3;
      const leftWidth = Math.max(42, Math.floor((width - gap) * 0.46));
      const rightWidth = Math.max(1, width - gap - leftWidth);
      return [...lines, ...mergeColumns(
        this.optionLines(questionIndex, leftWidth),
        this.previewLines(questionIndex, rightWidth),
        leftWidth,
        rightWidth,
        gap,
        width,
      )];
    }
    lines.push(...this.optionLines(questionIndex, width));
    lines.push("");
    lines.push(...this.previewLines(questionIndex, width));
    return lines;
  }

  private renderSubmit(width: number): string[] {
    const answered = this.answers.size;
    const total = this.questionnaire.questions.length;
    const missing = this.questionnaire.questions
      .map((question, index) => ({ question, index }))
      .filter(({ index }) => !this.answers.has(index));
    const lines: string[] = [];
    this.addWrapped(lines, this.theme.fg("accent", this.theme.bold("Submit questionnaire")), width, " ");
    this.addWrapped(lines, this.theme.fg("text", `${answered}/${total} answered`), width, " ");
    if (missing.length > 0) {
      this.addWrapped(lines, this.theme.fg("warning", `Unanswered: ${missing.map(({ question }) => safeAuthoredInline(question.header)).join(", ")}`), width, " ");
      this.addWrapped(lines, this.theme.fg("muted", "Partial and zero-answer submission are allowed."), width, " ");
    } else {
      this.addWrapped(lines, this.theme.fg("success", "All questions have confirmed answers."), width, " ");
    }
    lines.push("");
    for (let index = 0; index < 2; index += 1) {
      const active = this.submitIndex === index;
      const label = index === 0 ? ASK_RPC_SUBMIT_LABEL : ASK_RPC_CANCEL_LABEL;
      const description = index === 0
        ? "Return every confirmed answer, including a partial or empty questionnaire."
        : "Discard every confirmed answer and cancel the questionnaire.";
      this.addWrapped(lines, this.theme.fg(active ? "accent" : index === 0 ? "text" : "warning", label), width, active ? this.theme.fg("accent", "> ") : "  ");
      this.addWrapped(lines, this.theme.fg("muted", description), width, "    ");
    }
    return lines;
  }

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    const lines: string[] = [this.theme.fg("borderAccent", "─".repeat(renderWidth))];
    lines.push(...this.renderTabs(renderWidth));
    lines.push("");
    if (this.onSubmitTab()) lines.push(...this.renderSubmit(renderWidth));
    else lines.push(...this.renderQuestion(this.currentTab, renderWidth));
    lines.push("");
    const help = this.customQuestionIndex !== undefined
      ? "Inline editor active"
      : this.hasSubmitTab
        ? "Tab/Right next tab · Shift-Tab/Left previous tab · ↑↓ move · Enter confirm · Esc cancel and discard"
        : "↑↓ move · Enter confirm · Esc cancel and discard";
    this.addWrapped(lines, this.theme.fg("dim", help), renderWidth, " ");
    lines.push(this.theme.fg("borderAccent", "─".repeat(renderWidth)));
    return lines.map((line) => truncateToWidth(line, renderWidth, ""));
  }

  invalidate(): void {
    this.editor.invalidate();
  }
}

export interface AskTuiDriverOptions {
  /**
   * Awaited immediately before the questionnaire overlay opens.
   *
   * The package uses it to close its own full-screen overlay first, so a questionnaire can never
   * land behind one. It is awaited rather than fired off, which is what keeps the close and the new
   * overlay out of a microtask race. A hook that throws is ignored: Ask still opens.
   */
  beforeOpen?: () => void | Promise<void>;
}

export class AskTuiDriver implements AskDriver {
  private readonly ui: Pick<ExtensionUIContext, "custom">;
  private readonly beforeOpen?: () => void | Promise<void>;

  constructor(ui: Pick<ExtensionUIContext, "custom">, options: AskTuiDriverOptions = {}) {
    this.ui = ui;
    this.beforeOpen = options.beforeOpen;
  }

  async ask(questionnaire: ValidatedQuestionnaire, signal: AbortSignal): Promise<AskDriverResult> {
    if (signal.aborted) throw abortError(signal.reason);
    let closeOverlay: ((result: AskOverlayResult) => void) | undefined;
    let aborted = false;
    let closed = false;
    const closeOnce = (result: AskOverlayResult) => {
      if (closed) return;
      closed = true;
      closeOverlay?.(result);
    };
    const abortListener = () => {
      aborted = true;
      closeOnce(ABORTED);
    };
    signal.addEventListener("abort", abortListener, { once: true });
    try {
      if (this.beforeOpen) {
        try { await this.beforeOpen(); }
        catch { /* a coordination failure must never block the questionnaire */ }
        if (aborted || signal.aborted) throw abortError(signal.reason);
      }
      const result = await this.ui.custom<AskOverlayResult>((tui, theme, _keybindings, done) => {
        closeOverlay = done;
        if (closed) queueMicrotask(() => done(ABORTED));
        return new AskQuestionnaireComponent({
          questionnaire,
          tui,
          theme,
          onDone: (driverResult) => closeOnce(driverResult),
        });
      }, {
        overlay: true,
        overlayOptions: {
          width: "100%",
          maxHeight: "90%",
          anchor: "bottom-center",
          margin: { top: 0, right: 0, bottom: 0, left: 0 },
        },
      });
      if (aborted || result === ABORTED || signal.aborted) throw abortError(signal.reason);
      return result;
    } catch (error) {
      if (aborted || signal.aborted) throw abortError(signal.reason);
      throw error;
    } finally {
      signal.removeEventListener("abort", abortListener);
      closeOverlay = undefined;
    }
  }
}
