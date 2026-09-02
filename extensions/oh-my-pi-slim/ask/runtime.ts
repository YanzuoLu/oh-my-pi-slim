import type { ExtensionAPI, ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  ASK_DRIVER_ERRORS,
  askModelResult,
  ASK_TOOL_CONTRACT,
  ASK_TOOL_ERRORS,
  ASK_USER_DECLINED_CONTENT,
  modelJson,
} from "../tool-contracts.js";
import { renderAskCall, renderAskResult } from "./transcript-renderer.js";

export const ASK_CUSTOM_LABEL = "Type something.";
export const ASK_NEXT_LABEL = "Next";
export const ASK_RPC_SUBMIT_LABEL = "Submit questionnaire";
export const ASK_RPC_CANCEL_LABEL = "Cancel questionnaire";
export const ASK_RPC_DONE_LABEL = "Done with this question";
export const ASK_RESERVED_LABELS = ["Other", ASK_CUSTOM_LABEL, ASK_NEXT_LABEL] as const;

export interface AskOption {
  label: string;
  description: string;
  preview?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface ValidatedQuestionnaire {
  questions: AskQuestion[];
}

export type AskAnswerKind = "option" | "multi" | "custom";

export interface AskDriverAnswer {
  questionIndex: number;
  kind: AskAnswerKind;
  answer: string | string[] | null;
}

export interface AskDriverResult {
  answers: AskDriverAnswer[];
  cancelled?: boolean;
}

export interface AskPublicAnswer {
  questionIndex: number;
  question: string;
  header: string;
  kind: AskAnswerKind;
  answer: string | string[] | null;
  selected?: string[];
  preview?: string;
}

export interface AskResult {
  answers: AskPublicAnswer[];
  cancelled: boolean;
  partial: boolean;
  cancelReason?: "user_cancelled" | "empty_submit";
}

export type AskModelDto = Array<string | string[] | null>;

export interface AskTuiDriver {
  ask(questionnaire: ValidatedQuestionnaire, signal: AbortSignal): Promise<AskDriverResult>;
}

export interface AskRuntimeState {
  activeInvocationId?: number;
  queuedCount: number;
  waitingCount: number;
  blockingCount: number;
}

type AskRuntimeListener = (state: AskRuntimeState) => void;

type InvocationStatus = "queued" | "active";

interface AskInvocation {
  id: number;
  questionnaire: ValidatedQuestionnaire;
  driver: AskTuiDriver;
  controller: AbortController;
  externalSignal?: AbortSignal;
  externalAbortListener?: () => void;
  status: InvocationStatus;
  settled: boolean;
  waiting: boolean;
  resolve: (result: AskResult) => void;
  reject: (error: Error) => void;
}

function abortError(reason?: unknown): Error {
  const message = reason instanceof Error
    ? reason.message
    : typeof reason === "string" && reason.trim()
      ? reason
      : ASK_TOOL_ERRORS.aborted;
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal.reason);
}

function expectRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(ASK_TOOL_ERRORS.object(field));
  return value as Record<string, unknown>;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const unknown = Object.keys(record).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(ASK_TOOL_ERRORS.unknownField(field, unknown[0]));
}

function expectString(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== "string") throw new Error(ASK_TOOL_ERRORS.string(field));
  if (maxLength !== undefined && value.length > maxLength) throw new Error(ASK_TOOL_ERRORS.maxCharacters(field, maxLength));
  return value;
}

export function validateQuestionnaire(value: unknown): ValidatedQuestionnaire {
  const root = expectRecord(value, "ask_user_question input");
  rejectUnknownFields(root, ["questions"], "ask_user_question input");
  if (!Array.isArray(root.questions) || root.questions.length < 1 || root.questions.length > 4) {
    throw new Error(ASK_TOOL_ERRORS.questionCount);
  }

  const exactQuestions = new Set<string>();
  const questions = root.questions.map((rawQuestion, questionIndex): AskQuestion => {
    const field = `questions[${questionIndex}]`;
    const questionRecord = expectRecord(rawQuestion, field);
    rejectUnknownFields(questionRecord, ["question", "header", "options", "multiSelect"], field);
    const question = expectString(questionRecord.question, `${field}.question`);
    if (exactQuestions.has(question)) throw new Error(ASK_TOOL_ERRORS.duplicateQuestion(question));
    exactQuestions.add(question);
    const header = expectString(questionRecord.header, `${field}.header`, 16);
    if (!Array.isArray(questionRecord.options) || questionRecord.options.length < 2 || questionRecord.options.length > 4) {
      throw new Error(ASK_TOOL_ERRORS.optionCount(field));
    }
    if (questionRecord.multiSelect !== undefined && typeof questionRecord.multiSelect !== "boolean") {
      throw new Error(ASK_TOOL_ERRORS.multiSelectBoolean(field));
    }

    const exactLabels = new Set<string>();
    let hasPreview = false;
    const options = questionRecord.options.map((rawOption, optionIndex): AskOption => {
      const optionField = `${field}.options[${optionIndex}]`;
      const optionRecord = expectRecord(rawOption, optionField);
      rejectUnknownFields(optionRecord, ["label", "description", "preview"], optionField);
      const label = expectString(optionRecord.label, `${optionField}.label`, 60);
      if (exactLabels.has(label)) throw new Error(ASK_TOOL_ERRORS.duplicateLabel(field, label));
      if ((ASK_RESERVED_LABELS as readonly string[]).includes(label)) {
        throw new Error(ASK_TOOL_ERRORS.reservedLabel(optionField, label));
      }
      exactLabels.add(label);
      const description = expectString(optionRecord.description, `${optionField}.description`);
      const preview = optionRecord.preview === undefined
        ? undefined
        : expectString(optionRecord.preview, `${optionField}.preview`);
      if (preview !== undefined) hasPreview = true;
      return preview === undefined ? { label, description } : { label, description, preview };
    });

    if (questionRecord.multiSelect === true && hasPreview) {
      throw new Error(ASK_TOOL_ERRORS.previewWithMultiSelect(field));
    }
    return questionRecord.multiSelect === undefined
      ? { question, header, options }
      : { question, header, options, multiSelect: questionRecord.multiSelect };
  });
  return { questions };
}

function normalizedDriverAnswer(questionnaire: ValidatedQuestionnaire, raw: AskDriverAnswer): AskPublicAnswer {
  if (!Number.isInteger(raw.questionIndex) || raw.questionIndex < 0 || raw.questionIndex >= questionnaire.questions.length) {
    throw new Error(ASK_DRIVER_ERRORS.invalidQuestionIndex(raw.questionIndex));
  }
  const question = questionnaire.questions[raw.questionIndex];
  const base = {
    questionIndex: raw.questionIndex,
    question: question.question,
    header: question.header,
  };
  if (raw.kind === "option") {
    if (question.multiSelect === true) throw new Error(ASK_DRIVER_ERRORS.optionForMulti(raw.questionIndex));
    if (typeof raw.answer !== "string") throw new Error(ASK_DRIVER_ERRORS.optionString(raw.questionIndex));
    const option = question.options.find((candidate) => candidate.label === raw.answer);
    if (!option) throw new Error(ASK_DRIVER_ERRORS.unknownOption(raw.answer, raw.questionIndex));
    return {
      ...base,
      kind: "option",
      answer: option.label,
      selected: [option.label],
      ...(option.preview === undefined ? {} : { preview: option.preview }),
    };
  }
  if (raw.kind === "multi") {
    if (question.multiSelect !== true) throw new Error(ASK_DRIVER_ERRORS.multiForSingle(raw.questionIndex));
    if (!Array.isArray(raw.answer) || raw.answer.some((label) => typeof label !== "string")) {
      throw new Error(ASK_DRIVER_ERRORS.multiStringArray(raw.questionIndex));
    }
    const selectedSet = new Set(raw.answer as string[]);
    if (selectedSet.size !== raw.answer.length) throw new Error(ASK_DRIVER_ERRORS.duplicateMulti(raw.questionIndex));
    const authoredLabels = new Set(question.options.map((option) => option.label));
    for (const label of selectedSet) {
      if (!authoredLabels.has(label)) throw new Error(ASK_DRIVER_ERRORS.unknownOption(label, raw.questionIndex));
    }
    const selected = question.options.map((option) => option.label).filter((label) => selectedSet.has(label));
    return { ...base, kind: "multi", answer: selected, selected };
  }
  if (raw.kind === "custom") {
    if (raw.answer !== null && typeof raw.answer !== "string") {
      throw new Error(ASK_DRIVER_ERRORS.customString(raw.questionIndex));
    }
    const answer = typeof raw.answer === "string" && raw.answer.length === 0 ? null : raw.answer;
    return { ...base, kind: "custom", answer };
  }
  throw new Error(ASK_DRIVER_ERRORS.unknownKind(raw.kind));
}

export function buildAskResult(questionnaire: ValidatedQuestionnaire, driverResult: AskDriverResult): AskResult {
  if (!driverResult || typeof driverResult !== "object" || !Array.isArray(driverResult.answers)) {
    throw new Error(ASK_DRIVER_ERRORS.answersArray);
  }
  if (driverResult.cancelled !== undefined && typeof driverResult.cancelled !== "boolean") {
    throw new Error(ASK_DRIVER_ERRORS.cancelledBoolean);
  }
  // A user cancellation is a full withdrawal. Driver answers are dropped without being normalized,
  // so no driver, present or future, can smuggle a confirmed answer past a cancel.
  if (driverResult.cancelled === true) {
    return { answers: [], cancelled: true, partial: true, cancelReason: "user_cancelled" as const };
  }
  const seen = new Set<number>();
  const answers = driverResult.answers.map((raw) => {
    if (!raw || typeof raw !== "object") throw new Error(ASK_DRIVER_ERRORS.invalidAnswer);
    if (seen.has(raw.questionIndex)) throw new Error(ASK_DRIVER_ERRORS.duplicateAnswer(raw.questionIndex));
    seen.add(raw.questionIndex);
    return normalizedDriverAnswer(questionnaire, raw);
  }).sort((left, right) => left.questionIndex - right.questionIndex);
  const emptySubmit = answers.length === 0;
  return {
    answers,
    cancelled: emptySubmit,
    partial: answers.length < questionnaire.questions.length,
    ...(emptySubmit ? { cancelReason: "empty_submit" as const } : {}),
  };
}

export function buildAskModelDto(result: AskResult, questionnaire: ValidatedQuestionnaire): AskModelDto {
  const answers = result.answers.map((answer) => ({
    questionIndex: answer.questionIndex,
    answer: Array.isArray(answer.answer) ? [...answer.answer] : answer.answer,
  }));
  return askModelResult(answers, questionnaire.questions.length);
}

export function askResultModelContent(result: AskResult, questionnaire: ValidatedQuestionnaire): string {
  return modelJson(buildAskModelDto(result, questionnaire));
}

function assertSoleAskToolCall(toolCallId: string, ctx: ExtensionContext): void {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry.type !== "message" || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    const toolCalls = entry.message.content.filter((content) => content.type === "toolCall");
    if (!toolCalls.some((toolCall) => toolCall.id === toolCallId)) continue;
    if (toolCalls.length !== 1) {
      throw new Error(ASK_TOOL_ERRORS.soleCall);
    }
    return;
  }
}

function boundedText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function rpcQuestionTitle(question: AskQuestion): string {
  const lines = [`${question.header}: ${question.question}`];
  for (const option of question.options) {
    if (option.description) lines.push(`${option.label}: ${option.description}`);
    if (option.preview !== undefined) lines.push(`Preview for ${option.label}: ${boundedText(option.preview, 600)}`);
  }
  return lines.join("\n");
}

export function createRpcAskDriver(ui: Pick<ExtensionUIContext, "select" | "input">): AskTuiDriver {
  return {
    async ask(questionnaire, signal) {
      const answers: AskDriverAnswer[] = [];
      for (let questionIndex = 0; questionIndex < questionnaire.questions.length; questionIndex += 1) {
        throwIfAborted(signal);
        const question = questionnaire.questions[questionIndex];
        const title = rpcQuestionTitle(question);
        if (question.multiSelect === true) {
          const selected = new Set<string>();
          while (true) {
            const authored = question.options.map((option, optionIndex) =>
              `${selected.has(option.label) ? "[x]" : "[ ]"} Option ${optionIndex + 1}: ${option.label}`);
            const choice = await ui.select(title, [
              ...authored,
              ASK_CUSTOM_LABEL,
              ASK_RPC_DONE_LABEL,
              ASK_RPC_SUBMIT_LABEL,
              ASK_RPC_CANCEL_LABEL,
            ], { signal });
            throwIfAborted(signal);
            if (choice === undefined || choice === ASK_RPC_CANCEL_LABEL) return { answers: [], cancelled: true };
            if (choice === ASK_RPC_SUBMIT_LABEL) return { answers, cancelled: false };
            if (choice === ASK_RPC_DONE_LABEL) {
              answers.push({
                questionIndex,
                kind: "multi",
                answer: question.options.map((option) => option.label).filter((label) => selected.has(label)),
              });
              break;
            }
            if (choice === ASK_CUSTOM_LABEL) {
              const custom = await ui.input(`${question.header}: ${question.question}`, ASK_CUSTOM_LABEL, { signal });
              throwIfAborted(signal);
              if (custom === undefined) return { answers: [], cancelled: true };
              selected.clear();
              answers.push({ questionIndex, kind: "custom", answer: custom });
              break;
            }
            const optionIndex = authored.indexOf(choice);
            if (optionIndex < 0) throw new Error(ASK_DRIVER_ERRORS.rpcChoice(choice));
            const label = question.options[optionIndex].label;
            if (selected.has(label)) selected.delete(label);
            else selected.add(label);
          }
          continue;
        }

        const authored = question.options.map((option, optionIndex) => `Option ${optionIndex + 1}: ${option.label}`);
        const choice = await ui.select(title, [
          ...authored,
          ASK_CUSTOM_LABEL,
          ASK_RPC_SUBMIT_LABEL,
          ASK_RPC_CANCEL_LABEL,
        ], { signal });
        throwIfAborted(signal);
        if (choice === undefined || choice === ASK_RPC_CANCEL_LABEL) return { answers: [], cancelled: true };
        if (choice === ASK_RPC_SUBMIT_LABEL) return { answers, cancelled: false };
        if (choice === ASK_CUSTOM_LABEL) {
          const custom = await ui.input(`${question.header}: ${question.question}`, ASK_CUSTOM_LABEL, { signal });
          throwIfAborted(signal);
          if (custom === undefined) return { answers: [], cancelled: true };
          answers.push({ questionIndex, kind: "custom", answer: custom });
          continue;
        }
        const optionIndex = authored.indexOf(choice);
        if (optionIndex < 0) throw new Error(ASK_DRIVER_ERRORS.rpcChoice(choice));
        answers.push({ questionIndex, kind: "option", answer: question.options[optionIndex].label });
      }
      return { answers };
    },
  };
}

export interface AskRuntimeOptions {
  tuiDriver?: AskTuiDriver;
  goalActiveResolver?: () => boolean;
}

export class AskRuntime {
  private readonly pi: ExtensionAPI;
  private tuiDriver?: AskTuiDriver;
  private goalActiveResolver: () => boolean;
  private nextInvocationId = 1;
  private readonly queue: AskInvocation[] = [];
  private active?: AskInvocation;
  private readonly listeners = new Set<AskRuntimeListener>();
  private removedFromActiveTools = false;
  private cancelledAskSettling = false;
  private cancelledAskRpcAbortNotified = false;

  constructor(pi: ExtensionAPI, options: AskRuntimeOptions = {}) {
    this.pi = pi;
    this.tuiDriver = options.tuiDriver;
    this.goalActiveResolver = options.goalActiveResolver ?? (() => false);
  }

  registerTool(): void {
    this.pi.on("agent_start", (_event, ctx) => {
      if (!this.cancelledAskSettling) return;
      this.notifyCancelledAskRpcAbort(ctx);
      ctx.abort();
    });
    this.pi.on("input", (event, ctx) => {
      if (event.source !== "rpc" || (!this.isWaiting() && !this.cancelledAskSettling)) return;
      ctx.ui.notify("Ask is blocking new RPC prompts. Retry after Pi is idle.", "warning");
      return { action: "handled" };
    });
    this.pi.on("session_before_compact", (event) => {
      if (!this.cancelledAskSettling || event.reason !== "threshold" || event.willRetry !== false) return;
      return { cancel: true };
    });
    this.pi.on("agent_settled", () => {
      this.cancelledAskSettling = false;
      this.cancelledAskRpcAbortNotified = false;
      this.emit();
    });
    this.pi.registerTool({
      name: ASK_TOOL_CONTRACT.name,
      label: "Ask User Question",
      executionMode: "sequential",
      description: ASK_TOOL_CONTRACT.description,
      parameters: ASK_TOOL_CONTRACT.parameters,
      execute: async (toolCallId, params, signal, _onUpdate, ctx) => {
        throwIfAborted(signal);
        const questionnaire = validateQuestionnaire(params);
        assertSoleAskToolCall(toolCallId, ctx);
        if (ctx.hasPendingMessages()) {
          throw new Error(ASK_TOOL_ERRORS.pendingMessages);
        }
        const result = await this.executeValidated(questionnaire, signal, ctx);
        if (result.cancelReason === "user_cancelled") {
          if (ctx.mode === "rpc" && ctx.hasPendingMessages()) this.notifyCancelledAskRpcAbort(ctx);
          ctx.abort();
          return {
            content: [{ type: "text", text: ASK_USER_DECLINED_CONTENT }],
            details: result,
            terminate: true,
          };
        }
        return {
          content: [{ type: "text", text: askResultModelContent(result, questionnaire) }],
          details: result,
        };
      },
      renderCall: renderAskCall,
      renderResult: renderAskResult,
    });
  }

  private notifyCancelledAskRpcAbort(ctx: Pick<ExtensionContext, "mode" | "ui">): void {
    if (ctx.mode !== "rpc" || this.cancelledAskRpcAbortNotified) return;
    this.cancelledAskRpcAbortNotified = true;
    ctx.ui.notify("Queued RPC messages were aborted with Ask. Retry after Pi is idle.", "warning");
  }

  setTuiDriver(driver?: AskTuiDriver): void {
    this.tuiDriver = driver;
  }

  setGoalActiveResolver(resolver?: () => boolean): void {
    this.goalActiveResolver = resolver ?? (() => false);
  }

  waitingCount(): number {
    return this.active?.waiting ? 1 : 0;
  }

  isWaiting(): boolean {
    return this.waitingCount() > 0;
  }

  state(): AskRuntimeState {
    const waitingCount = this.waitingCount();
    return {
      ...(this.active ? { activeInvocationId: this.active.id } : {}),
      queuedCount: this.queue.length,
      waitingCount,
      blockingCount: waitingCount > 0 || this.cancelledAskSettling ? 1 : 0,
    };
  }

  subscribe(listener: AskRuntimeListener): () => void {
    this.listeners.add(listener);
    listener(this.state());
    return () => this.listeners.delete(listener);
  }

  reconcileHostMode(ctx: Pick<ExtensionContext, "mode">): void {
    if (typeof this.pi.getActiveTools !== "function" || typeof this.pi.setActiveTools !== "function") return;
    const activeTools = this.pi.getActiveTools();
    if (ctx.mode === "json" || ctx.mode === "print") {
      if (activeTools.includes(ASK_TOOL_CONTRACT.name)) {
        this.pi.setActiveTools(activeTools.filter((name) => name !== ASK_TOOL_CONTRACT.name));
        this.removedFromActiveTools = true;
      }
      return;
    }
    if (!this.removedFromActiveTools) return;
    if (!activeTools.includes(ASK_TOOL_CONTRACT.name) && this.pi.getAllTools().some((tool) => tool.name === ASK_TOOL_CONTRACT.name)) {
      this.pi.setActiveTools([...activeTools, ASK_TOOL_CONTRACT.name]);
    }
    this.removedFromActiveTools = false;
  }

  reset(): void {
    this.cancelledAskSettling = false;
    this.cancelledAskRpcAbortNotified = false;
    this.abortAll("Ask runtime reset.");
    this.tuiDriver = undefined;
    this.nextInvocationId = 1;
  }

  abortAll(reason?: unknown): void {
    const queued = this.queue.splice(0);
    for (const invocation of queued) {
      invocation.controller.abort(reason);
      this.settle(invocation, undefined, abortError(reason));
    }
    const active = this.active;
    if (active) {
      active.controller.abort(reason);
      this.setWaiting(active, false);
      this.settle(active, undefined, abortError(reason));
      if (this.active === active) this.active = undefined;
    }
    this.emit();
  }

  async execute(params: unknown, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<AskResult> {
    throwIfAborted(signal);
    const questionnaire = validateQuestionnaire(params);
    return this.executeValidated(questionnaire, signal, ctx);
  }

  private async executeValidated(questionnaire: ValidatedQuestionnaire, signal: AbortSignal | undefined, ctx: ExtensionContext): Promise<AskResult> {
    throwIfAborted(signal);
    if (this.goalActiveResolver()) {
      throw new Error(ASK_TOOL_ERRORS.goalActive);
    }
    const driver = this.driverFor(ctx);
    return new Promise<AskResult>((resolve, reject) => {
      const invocation: AskInvocation = {
        id: this.nextInvocationId,
        questionnaire,
        driver,
        controller: new AbortController(),
        externalSignal: signal,
        status: "queued",
        settled: false,
        waiting: false,
        resolve,
        reject,
      };
      this.nextInvocationId += 1;
      const abortListener = () => this.abortInvocation(invocation, signal?.reason);
      invocation.externalAbortListener = abortListener;
      signal?.addEventListener("abort", abortListener, { once: true });
      if (signal?.aborted) {
        abortListener();
        return;
      }
      this.queue.push(invocation);
      this.emit();
      this.pump();
    });
  }

  private driverFor(ctx: ExtensionContext): AskTuiDriver {
    if (!ctx.hasUI || ctx.mode === "json" || ctx.mode === "print") {
      throw new Error(ASK_TOOL_ERRORS.uiUnavailable(ctx.mode));
    }
    if (ctx.mode === "rpc") return createRpcAskDriver(ctx.ui);
    if (ctx.mode === "tui" && this.tuiDriver) return this.tuiDriver;
    throw new Error(ASK_TOOL_ERRORS.tuiUnavailable);
  }

  private abortInvocation(invocation: AskInvocation, reason?: unknown): void {
    if (invocation.settled) return;
    invocation.controller.abort(reason);
    if (invocation.status === "queued") {
      const index = this.queue.indexOf(invocation);
      if (index >= 0) this.queue.splice(index, 1);
    } else {
      this.setWaiting(invocation, false);
    }
    this.settle(invocation, undefined, abortError(reason));
    this.emit();
  }

  private pump(): void {
    if (this.active) return;
    const invocation = this.queue.shift();
    if (!invocation) {
      this.emit();
      return;
    }
    if (invocation.settled) {
      this.pump();
      return;
    }
    invocation.status = "active";
    this.active = invocation;
    this.emit();
    void this.runActive(invocation);
  }

  private async runActive(invocation: AskInvocation): Promise<void> {
    this.setWaiting(invocation, true);
    try {
      const driverResult = await invocation.driver.ask(invocation.questionnaire, invocation.controller.signal);
      throwIfAborted(invocation.controller.signal);
      const result = buildAskResult(invocation.questionnaire, driverResult);
      if (result.cancelReason === "user_cancelled") {
        this.cancelledAskSettling = true;
        this.emit();
      }
      this.settle(invocation, result);
    } catch (error) {
      this.settle(
        invocation,
        undefined,
        invocation.controller.signal.aborted ? abortError(invocation.controller.signal.reason) : error instanceof Error ? error : new Error(String(error)),
      );
    } finally {
      this.setWaiting(invocation, false);
      if (this.active === invocation) this.active = undefined;
      this.emit();
      this.pump();
    }
  }

  private setWaiting(invocation: AskInvocation, waiting: boolean): void {
    if (invocation.waiting === waiting) return;
    invocation.waiting = waiting;
    this.emit();
  }

  private settle(invocation: AskInvocation, result?: AskResult, error?: Error): void {
    if (invocation.settled) return;
    invocation.settled = true;
    if (invocation.externalSignal && invocation.externalAbortListener) {
      invocation.externalSignal.removeEventListener("abort", invocation.externalAbortListener);
    }
    if (error) invocation.reject(error);
    else invocation.resolve(result as AskResult);
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }
}

export function registerAskRuntime(pi: ExtensionAPI, options?: AskRuntimeOptions): AskRuntime {
  const runtime = new AskRuntime(pi, options);
  runtime.registerTool();
  return runtime;
}
