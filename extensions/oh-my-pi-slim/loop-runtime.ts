import { randomBytes } from "node:crypto";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { renderLoopCall, renderLoopFire, renderLoopResult } from "./loop-transcript-renderer.js";
import { LoopWidget } from "./loop-widget.js";

export const LOOP_ACTIONS = ["create", "delete", "clear", "modify", "list", "pause", "resume"] as const;
export const LOOP_PUBLIC_FIELDS = ["action", "id", "interval", "abstract", "prompt"] as const;
export const LOOP_MESSAGE_TYPE = "oh-my-pi-slim:loop-fire";
export const LOOP_MIN_INTERVAL_MS = 10_000;
export const LOOP_MAX_INTERVAL_MS = 7 * 24 * 60 * 60 * 1_000;

export type LoopAction = (typeof LOOP_ACTIONS)[number];
export type LoopStatus = "active" | "paused";

export interface PublicLoop {
  id: string;
  abstract: string;
  prompt: string;
  interval: string;
  status: LoopStatus;
  createdAt: string;
  updatedAt: string;
  nextFireAt: string | null;
  fireCount: number;
  failureCount: number;
  lastFiredAt: string | null;
  lastFailedAt: string | null;
  lastError: string | null;
}

export interface ParsedLoopInterval {
  interval: string;
  milliseconds: number;
}

export interface LoopInput {
  action?: unknown;
  id?: unknown;
  interval?: unknown;
  abstract?: unknown;
  prompt?: unknown;
}

interface LoopRecord extends PublicLoop {
  intervalMs: number;
  timer?: LoopTimerHandle;
  timerToken: number;
}

interface PreparedLoopSchedule {
  timer: LoopTimerHandle;
  token: number;
  nextFireAt: string;
  activate(): void;
}

export interface LoopFireDetails {
  id: string;
  abstract: string;
  interval: string;
  fireCount: number;
  firedAt: string;
  prompt: string;
}

interface LoopFireSnapshot {
  readonly generation: number;
  readonly id: string;
  readonly abstract: string;
  readonly interval: string;
  readonly firedAt: string;
  readonly prompt: string;
}

type LoopTimerHandle = ReturnType<typeof setTimeout>;
type LoopSend = (
  message: {
    customType: string;
    content: string;
    display: boolean;
    details: LoopFireDetails;
  },
  options: { deliverAs: "steer"; triggerTurn: true },
) => void;

export interface LoopRuntimeOptions {
  nowMs?: () => number;
  setTimeout?: (callback: () => void, milliseconds: number) => LoopTimerHandle;
  clearTimeout?: (timer: LoopTimerHandle) => void;
  defer?: (callback: () => void) => void;
  sendMessage?: LoopSend;
  randomHex?: () => string;
}

const ACTION_FIELDS: Record<LoopAction, readonly string[]> = {
  create: ["action", "interval", "abstract", "prompt"],
  delete: ["action", "id"],
  clear: ["action"],
  modify: ["action", "id", "interval", "abstract", "prompt"],
  list: ["action"],
  pause: ["action", "id"],
  resume: ["action", "id"],
};

const UNIT_MILLISECONDS = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

const CANONICAL_UNITS = [
  ["d", 86_400_000],
  ["h", 3_600_000],
  ["m", 60_000],
  ["s", 1_000],
] as const;

function toolText(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details };
}

function recordValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("loop input must be an object.");
  return value as Record<string, unknown>;
}

function trimmedString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function loopId(value: unknown): string {
  const id = trimmedString(value, "id");
  if (!/^[0-9a-f]{8}$/.test(id)) throw new Error("id must be an exact 8-character lowercase hexadecimal loop ID.");
  return id;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function canonicalizeLoopInterval(milliseconds: number): string {
  if (!Number.isSafeInteger(milliseconds) || milliseconds <= 0) throw new Error("interval milliseconds must be a positive safe integer.");
  for (const [unit, unitMs] of CANONICAL_UNITS) {
    if (milliseconds % unitMs === 0) return `${milliseconds / unitMs}${unit}`;
  }
  throw new Error("interval milliseconds must resolve to whole seconds.");
}

export function parseLoopInterval(value: unknown): ParsedLoopInterval {
  const interval = trimmedString(value, "interval");
  const match = /^([1-9][0-9]*)([smhd])$/.exec(interval);
  if (!match) throw new Error("interval must use one positive integer and one unit: s, m, h, or d.");
  const amount = BigInt(match[1]);
  const unitMs = BigInt(UNIT_MILLISECONDS[match[2] as keyof typeof UNIT_MILLISECONDS]);
  const milliseconds = amount * unitMs;
  if (milliseconds < BigInt(LOOP_MIN_INTERVAL_MS) || milliseconds > BigInt(LOOP_MAX_INTERVAL_MS)) {
    throw new Error("interval must be between 10s and 7d inclusive.");
  }
  const numericMilliseconds = Number(milliseconds);
  return {
    interval: canonicalizeLoopInterval(numericMilliseconds),
    milliseconds: numericMilliseconds,
  };
}

export const loopParameters = Type.Object({
  action: Type.Union(LOOP_ACTIONS.map((action) => Type.Literal(action)), {
    description: "Choose an action. create requires interval, abstract, and prompt. modify requires id and at least one changed field. delete, pause, and resume require id. clear and list accept no other fields.",
  }),
  id: Type.Optional(Type.String({
    description: "Exact eight-character lowercase hexadecimal loop ID for delete, modify, pause, or resume.",
  })),
  interval: Type.Optional(Type.String({
    description: "Fixed delay for create or modify, from 10s through 7d. Format: one positive integer plus s, m, h, or d.",
  })),
  abstract: Type.Optional(Type.String({
    description: "Short loop summary for create or modify.",
  })),
  prompt: Type.Optional(Type.String({
    description: "Complete future-turn prompt for create or modify.",
  })),
}, { additionalProperties: false });

if (JSON.stringify(Object.keys(loopParameters.properties).sort()) !== JSON.stringify([...LOOP_PUBLIC_FIELDS].sort())) {
  throw new Error("OMPS loop tool schema drifted from its public field contract.");
}

export class LoopRuntime {
  private readonly pi: ExtensionAPI;
  private readonly nowMs: () => number;
  private readonly setTimeoutFn: (callback: () => void, milliseconds: number) => LoopTimerHandle;
  private readonly clearTimeoutFn: (timer: LoopTimerHandle) => void;
  private readonly defer: (callback: () => void) => void;
  private readonly sendMessage: LoopSend;
  private readonly randomHex: () => string;
  private readonly loops = new Map<string, LoopRecord>();
  private readonly widget: LoopWidget;
  private gatedFires: LoopFireSnapshot[] = [];
  private generation = 0;
  private deliveryPaused = false;
  private shuttingDown = false;

  constructor(pi: ExtensionAPI, options: LoopRuntimeOptions = {}) {
    this.pi = pi;
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.setTimeoutFn = options.setTimeout ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this.clearTimeoutFn = options.clearTimeout ?? ((timer) => clearTimeout(timer));
    this.defer = options.defer ?? ((callback) => queueMicrotask(callback));
    this.sendMessage = options.sendMessage ?? ((message, sendOptions) => this.pi.sendMessage(message, sendOptions));
    this.randomHex = options.randomHex ?? (() => randomBytes(4).toString("hex"));
    this.widget = new LoopWidget(() => this.list(), { nowMs: this.nowMs });
  }

  registerTool(): void {
    this.pi.registerMessageRenderer(LOOP_MESSAGE_TYPE, renderLoopFire);
    this.pi.registerTool({
      name: "loop",
      label: "Loop",
      executionMode: "sequential",
      description: "Create and manage runtime-only fixed-delay loops from 10s through 7d. Creation and resume wait one full interval before firing. Each later delay starts only after the previous tick finishes. Each fire delivers the stored prompt for a future turn. Active loops must be paused before deletion or clearing. Loop state survives compaction and tree navigation within the current runtime. Reload, session replacement, and shutdown clear every loop. Actions return current loop state, change receipts, clear receipts, or the retained loop list.",
      promptSnippet: "Manage fixed-delay prompt loops.",
      promptGuidelines: [
        "Call `loop create` only for a user message beginning with `/loop`.",
        "For bare `/loop`, call `loop list` and explain `/loop <interval> <prompt>`.",
        "Make every `loop create` prompt self-contained and repeatable for future turns.",
      ],
      parameters: loopParameters,
      execute: async (_toolCallId, params) => this.execute(params as LoopInput),
      renderCall: renderLoopCall,
      renderResult: renderLoopResult,
    });
  }

  setUICtx(ui: ExtensionUIContext | undefined): void {
    this.widget.setContext(ui);
  }

  refreshUI(): void {
    this.widget.update();
  }

  setDeliveryPaused(paused: boolean): void {
    if (this.deliveryPaused === paused) return;
    this.deliveryPaused = paused;
    if (!paused && !this.shuttingDown) this.flushGatedFires();
  }

  reset(): void {
    this.clearRuntime();
    this.shuttingDown = false;
    this.deliveryPaused = false;
    this.widget.update();
  }

  shutdown(): void {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.clearRuntime();
    this.deliveryPaused = false;
    this.widget.dispose();
  }

  list(): PublicLoop[] {
    return [...this.loops.values()].map((loop) => this.publicLoop(loop));
  }

  async execute(inputValue: LoopInput): Promise<ReturnType<typeof toolText>> {
    const input = recordValue(inputValue);
    const action = trimmedString(input.action, "action") as LoopAction;
    if (!LOOP_ACTIONS.includes(action)) throw new Error(`Unsupported loop action: ${action}`);
    this.validateActionFields(input, action);

    if (action === "list") {
      const loops = this.list();
      return toolText(JSON.stringify(loops, null, 2), { loops });
    }
    if (this.shuttingDown) throw new Error("Loop runtime is shutting down.");
    if (action === "create") return this.create(input);
    if (action === "clear") return this.clear();

    const id = loopId(input.id);
    const current = this.loops.get(id);
    if (!current) throw new Error(`Loop ${id} was not found.`);
    if (action === "delete") return this.delete(current);
    if (action === "pause") return this.pause(current);
    if (action === "resume") return this.resume(current);
    return this.modify(current, input);
  }

  private validateActionFields(input: Record<string, unknown>, action: LoopAction): void {
    const allowed = ACTION_FIELDS[action];
    const unknown = Object.keys(input).filter((field) => !allowed.includes(field));
    if (unknown.length > 0) throw new Error(`${action} does not accept field(s): ${unknown.join(", ")}.`);
    for (const required of action === "create"
      ? ["interval", "abstract", "prompt"]
      : action === "list" || action === "clear" ? [] : ["id"]) {
      if (input[required] === undefined) throw new Error(`${action} requires ${required}.`);
    }
    if (action === "modify" && input.interval === undefined && input.abstract === undefined && input.prompt === undefined) {
      throw new Error("modify requires at least one of interval, abstract, or prompt.");
    }
  }

  private create(input: Record<string, unknown>): ReturnType<typeof toolText> {
    const parsedInterval = parseLoopInterval(input.interval);
    const abstract = trimmedString(input.abstract, "abstract");
    const prompt = trimmedString(input.prompt, "prompt");
    const nowMs = this.nowMs();
    const now = new Date(nowMs).toISOString();
    const loop: LoopRecord = {
      id: this.newId(),
      abstract,
      prompt,
      interval: parsedInterval.interval,
      intervalMs: parsedInterval.milliseconds,
      status: "active",
      createdAt: now,
      updatedAt: now,
      nextFireAt: null,
      fireCount: 0,
      failureCount: 0,
      lastFiredAt: null,
      lastFailedAt: null,
      lastError: null,
      timerToken: 0,
    };
    const scheduled = this.prepareSchedule(loop, nowMs, loop.intervalMs);
    this.loops.set(loop.id, loop);
    this.applySchedule(loop, scheduled);
    this.widget.update();
    const result = this.publicLoop(loop);
    return toolText(JSON.stringify(result, null, 2), { loop: result, changed: true });
  }

  private delete(loop: LoopRecord): ReturnType<typeof toolText> {
    if (loop.status === "active") {
      throw new Error(`Loop ${loop.id} has status ${loop.status} and cannot be deleted. Ask the user whether to pause this loop, then retry delete only if they agree.`);
    }
    this.cancelTimer(loop);
    this.cancelGatedFires(loop.id);
    this.loops.delete(loop.id);
    this.widget.update();
    return toolText(`Deleted loop ${loop.id}.`, { id: loop.id, deleted: true });
  }

  private clear(): ReturnType<typeof toolText> {
    const active = [...this.loops.values()].filter((loop) => loop.status === "active");
    if (active.length > 0) {
      const listed = active.map((loop) => `${loop.id} (${loop.abstract})`).join("\n");
      throw new Error(`Cannot clear loops while active loops remain:\n${listed}\nAsk the user whether to pause these loops, then retry clear only if they agree.`);
    }

    const ids = [...this.loops.keys()];
    if (ids.length === 0) {
      return toolText("No loops to clear.", { cleared: true, changed: false, clearedCount: 0, ids });
    }
    for (const loop of this.loops.values()) this.cancelTimer(loop);
    this.loops.clear();
    this.gatedFires = [];
    this.widget.update();
    return toolText(`Cleared ${ids.length} loops.`, {
      cleared: true,
      changed: true,
      clearedCount: ids.length,
      ids,
    });
  }

  private pause(loop: LoopRecord): ReturnType<typeof toolText> {
    if (loop.status === "paused") {
      const result = this.publicLoop(loop);
      return toolText(JSON.stringify(result, null, 2), { loop: result, changed: false });
    }
    const now = new Date(this.nowMs()).toISOString();
    this.cancelTimer(loop);
    this.cancelGatedFires(loop.id);
    loop.status = "paused";
    loop.nextFireAt = null;
    loop.updatedAt = now;
    this.widget.update();
    const result = this.publicLoop(loop);
    return toolText(JSON.stringify(result, null, 2), { loop: result, changed: true });
  }

  private resume(loop: LoopRecord): ReturnType<typeof toolText> {
    if (loop.status === "active") {
      const result = this.publicLoop(loop);
      return toolText(JSON.stringify(result, null, 2), { loop: result, changed: false });
    }
    const nowMs = this.nowMs();
    const scheduled = this.prepareSchedule(loop, nowMs, loop.intervalMs);
    loop.status = "active";
    loop.updatedAt = new Date(nowMs).toISOString();
    this.applySchedule(loop, scheduled);
    this.widget.update();
    const result = this.publicLoop(loop);
    return toolText(JSON.stringify(result, null, 2), { loop: result, changed: true });
  }

  private modify(loop: LoopRecord, input: Record<string, unknown>): ReturnType<typeof toolText> {
    const parsedInterval = input.interval === undefined ? undefined : parseLoopInterval(input.interval);
    const abstract = input.abstract === undefined ? undefined : trimmedString(input.abstract, "abstract");
    const prompt = input.prompt === undefined ? undefined : trimmedString(input.prompt, "prompt");
    const intervalChanged = parsedInterval !== undefined && parsedInterval.milliseconds !== loop.intervalMs;
    const abstractChanged = abstract !== undefined && abstract !== loop.abstract;
    const promptChanged = prompt !== undefined && prompt !== loop.prompt;
    if (!intervalChanged && !abstractChanged && !promptChanged) {
      const result = this.publicLoop(loop);
      return toolText(JSON.stringify(result, null, 2), { loop: result, changed: false });
    }

    const nowMs = this.nowMs();
    const scheduled = intervalChanged && parsedInterval && loop.status === "active"
      ? this.prepareSchedule(loop, nowMs, parsedInterval.milliseconds)
      : undefined;
    const oldTimer = loop.timer;
    if (abstractChanged) loop.abstract = abstract as string;
    if (promptChanged) loop.prompt = prompt as string;
    if (intervalChanged && parsedInterval) {
      loop.interval = parsedInterval.interval;
      loop.intervalMs = parsedInterval.milliseconds;
    }
    loop.updatedAt = new Date(nowMs).toISOString();
    if (scheduled) {
      this.applySchedule(loop, scheduled);
      if (oldTimer !== undefined) this.clearTimeoutFn(oldTimer);
    }
    this.widget.update();
    const result = this.publicLoop(loop);
    return toolText(JSON.stringify(result, null, 2), { loop: result, changed: true });
  }

  private newId(): string {
    while (true) {
      const id = this.randomHex();
      if (!/^[0-9a-f]{8}$/.test(id)) throw new Error("Loop ID generator must return 8 lowercase hexadecimal characters.");
      if (!this.loops.has(id)) return id;
    }
  }

  private prepareSchedule(
    loop: LoopRecord,
    baseMs: number,
    intervalMs: number,
  ): PreparedLoopSchedule {
    const generation = this.generation;
    const token = loop.timerToken + 1;
    const nextFireAt = new Date(baseMs + intervalMs).toISOString();
    let active = false;
    let fired = false;
    let firedBeforeActivation = false;
    const onTimeout = () => {
      if (fired) return;
      fired = true;
      if (!active) {
        firedBeforeActivation = true;
        return;
      }
      this.acceptScheduledTimeout(loop, token, generation);
    };
    const timer = this.setTimeoutFn(onTimeout, intervalMs);
    (timer as { unref?: () => void }).unref?.();
    return {
      timer,
      token,
      nextFireAt,
      activate: () => {
        active = true;
        if (firedBeforeActivation) this.acceptScheduledTimeout(loop, token, generation);
      },
    };
  }

  private applySchedule(loop: LoopRecord, scheduled: PreparedLoopSchedule): void {
    loop.timer = scheduled.timer;
    loop.timerToken = scheduled.token;
    loop.nextFireAt = scheduled.nextFireAt;
    scheduled.activate();
  }

  private acceptScheduledTimeout(loop: LoopRecord, token: number, generation: number): void {
    const current = this.loops.get(loop.id);
    if (!current || current !== loop || current.timerToken !== token || generation !== this.generation) return;
    current.timer = undefined;
    this.defer(() => this.onTimer(loop.id, token, generation));
  }

  private schedule(loop: LoopRecord, baseMs: number): void {
    this.applySchedule(loop, this.prepareSchedule(loop, baseMs, loop.intervalMs));
  }

  private onTimer(id: string, token: number, generation: number): void {
    const loop = this.loops.get(id);
    if (!loop || loop.status !== "active" || loop.timerToken !== token || generation !== this.generation || this.shuttingDown) return;
    loop.nextFireAt = null;
    const snapshot = Object.freeze({
      generation,
      id: loop.id,
      abstract: loop.abstract,
      interval: loop.interval,
      firedAt: new Date(this.nowMs()).toISOString(),
      prompt: loop.prompt,
    });
    if (this.deliveryPaused) this.gatedFires.push(snapshot);
    else this.deliver(snapshot);

    const current = this.loops.get(id);
    if (!current || current.status !== "active" || current.timerToken !== token || generation !== this.generation || this.shuttingDown) return;
    this.schedule(current, this.nowMs());
    this.widget.update();
  }

  private deliver(snapshot: LoopFireSnapshot): void {
    if (snapshot.generation !== this.generation || this.shuttingDown) return;
    const loop = this.loops.get(snapshot.id);
    if (!loop) return;
    const fireCount = loop.fireCount + 1;
    const details: LoopFireDetails = {
      id: snapshot.id,
      abstract: snapshot.abstract,
      interval: snapshot.interval,
      fireCount,
      firedAt: snapshot.firedAt,
      prompt: snapshot.prompt,
    };
    const content = [
      `Loop ${snapshot.id} fired.`,
      `Abstract: ${snapshot.abstract}`,
      `Interval: ${snapshot.interval}`,
      `Successful fire count: ${fireCount}`,
      "Prompt:",
      snapshot.prompt,
    ].join("\n");
    try {
      this.sendMessage(
        { customType: LOOP_MESSAGE_TYPE, content, display: true, details },
        { deliverAs: "steer", triggerTurn: true },
      );
      const delivered = this.loops.get(snapshot.id);
      if (!delivered) return;
      const deliveredAt = new Date(this.nowMs()).toISOString();
      delivered.fireCount += 1;
      delivered.lastFiredAt = deliveredAt;
      delivered.lastError = null;
      delivered.updatedAt = deliveredAt;
      this.widget.update();
    } catch (error) {
      const failed = this.loops.get(snapshot.id);
      if (!failed) return;
      const failedAt = new Date(this.nowMs()).toISOString();
      failed.failureCount += 1;
      failed.lastFailedAt = failedAt;
      failed.lastError = errorText(error);
      failed.updatedAt = failedAt;
      this.widget.update();
    }
  }

  private flushGatedFires(): void {
    while (!this.deliveryPaused && !this.shuttingDown && this.gatedFires.length > 0) {
      const snapshot = this.gatedFires.shift() as LoopFireSnapshot;
      this.deliver(snapshot);
    }
  }

  private cancelTimer(loop: LoopRecord): void {
    loop.timerToken += 1;
    if (loop.timer !== undefined) this.clearTimeoutFn(loop.timer);
    loop.timer = undefined;
    loop.nextFireAt = null;
  }

  private cancelGatedFires(id: string): void {
    this.gatedFires = this.gatedFires.filter((snapshot) => snapshot.id !== id);
  }

  private clearRuntime(): void {
    this.generation += 1;
    for (const loop of this.loops.values()) this.cancelTimer(loop);
    this.loops.clear();
    this.gatedFires = [];
  }

  private publicLoop(loop: LoopRecord): PublicLoop {
    return {
      id: loop.id,
      abstract: loop.abstract,
      prompt: loop.prompt,
      interval: loop.interval,
      status: loop.status,
      createdAt: loop.createdAt,
      updatedAt: loop.updatedAt,
      nextFireAt: loop.nextFireAt,
      fireCount: loop.fireCount,
      failureCount: loop.failureCount,
      lastFiredAt: loop.lastFiredAt,
      lastFailedAt: loop.lastFailedAt,
      lastError: loop.lastError,
    };
  }
}

export function registerLoopRuntime(pi: ExtensionAPI, options?: LoopRuntimeOptions): LoopRuntime {
  const runtime = new LoopRuntime(pi, options);
  runtime.registerTool();
  pi.registerCommand("loop", {
    description: "Forward a loop request to the model.",
    handler: async (args, ctx) => {
      const raw = args === "" ? "/loop" : `/loop ${args}`;
      pi.sendUserMessage(raw, {
        ...(ctx.isIdle() ? {} : { deliverAs: "steer" as const }),
        expandPromptTemplates: false,
      });
    },
  });
  return runtime;
}
