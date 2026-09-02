import {
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { registerAskRuntime } from "./ask/runtime.js";
import { AskTuiDriver } from "./ask/tui.js";
import {
  applyCacheRetentionForRequest,
  CACHE_STATE_ENTRY_TYPE,
  makeCacheState,
  replayCacheState,
  type CacheRetention,
} from "./cache-retention.js";
import {
  applyFastServiceTier,
  FAST_STATE_ENTRY_TYPE,
  makeFastState,
  replayFastState,
} from "./fast-mode.js";
import {
  GOAL_CONTINUATION_MESSAGE_TYPE,
  registerGoalRuntime,
  type GoalRuntime,
} from "./goal/runtime.js";
import { MONITOR_NOTIFICATION_TYPE, registerMonitorRuntime } from "./monitor/runtime.js";
import { registerSubagentRuntime } from "./subagent/runtime.js";
import { SUBAGENT_NOTIFICATION_TYPE } from "./subagent/transcript-renderer.js";
import { createSubagentViewer } from "./subagent/viewer.js";
import { registerTodoRuntime } from "./todo/runtime.js";
import { widgetStackHost } from "./widget-stack-host.js";
import type { WidgetStackSectionId } from "./widget-stack.js";

const WIDGET_STACK_OWNER = "oh-my-pi-slim:extension";
const PACKAGE_VERSION = (JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string }).version;
const OWNED_WIDGET_SECTIONS: readonly WidgetStackSectionId[] = ["goal", "agents", "monitors"];

interface TreeNotificationHold {
  generation: number;
  signal: AbortSignal;
  abortListener: () => void;
  shutdownComplete: boolean;
  abortPending: boolean;
}

type ImmediateScheduler = (callback: () => void) => unknown;

export class NotificationDeliveryPauseGate {
  private generation = 0;
  private paused = false;
  private readonly setPaused: (paused: boolean) => void;
  private readonly defer: ImmediateScheduler;

  constructor(setPaused: (paused: boolean) => void, defer: ImmediateScheduler = (callback) => setImmediate(callback)) {
    this.setPaused = setPaused;
    this.defer = defer;
  }

  pause(): number {
    this.generation += 1;
    this.paused = true;
    this.setPaused(true);
    return this.generation;
  }

  currentGeneration(): number {
    return this.generation;
  }

  isPaused(): boolean {
    return this.paused;
  }

  isCurrent(generation: number): boolean {
    return this.paused && this.generation === generation;
  }

  release(generation: number): boolean {
    if (!this.isCurrent(generation)) return false;
    this.paused = false;
    this.setPaused(false);
    return true;
  }

  releaseDeferred(generation: number): void {
    this.defer(() => this.release(generation));
  }

  invalidate(): void {
    this.generation += 1;
  }

  clearWithoutDelivery(): void {
    this.generation += 1;
    this.paused = false;
  }
}

function toolSourceText(tool: unknown): string {
  if (!tool || typeof tool !== "object") return "";
  const object = tool as Record<string, unknown>;
  const sourceInfo = object.sourceInfo;
  const info = sourceInfo && typeof sourceInfo === "object" ? sourceInfo as Record<string, unknown> : {};
  return [object.provenance, info.provenance, info.path, info.source, info.baseDir]
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

function assertNoLegacyBackend(pi: ExtensionAPI): void {
  const legacy = pi.getAllTools().find((tool) => /(?:^|[/\\])pi-subagents(?:[/\\]|$)/.test(toolSourceText(tool)));
  if (legacy) {
    throw new Error(`oh-my-pi-slim refuses legacy pi-subagents tool "${legacy.name}" from ${toolSourceText(legacy) || "unknown source"}. Remove the old package before starting Pi.`);
  }
}

export default function ohMyPiSlim(pi: ExtensionAPI): void {
  if (process.env.PI_SUBAGENT_CHILD === "1" || process.env.OMPS_SUBAGENT_CHILD === "1") return;
  registerTodoRuntime(pi);

  // A reload evaluates this module again: drop the previous instance's sections before the new
  // widgets publish, so a dead closure can never keep rendering rows for an unloaded extension.
  for (const id of OWNED_WIDGET_SECTIONS) widgetStackHost().publish(id, undefined);

  let goal: GoalRuntime | undefined;
  let sessionCtx: ExtensionContext | undefined;
  const asks = registerAskRuntime(pi);
  const monitors = registerMonitorRuntime(pi);
  const subagents = registerSubagentRuntime(pi);
  let fastEnabled = false;
  let cacheRetention: CacheRetention = "short";
  subagents.setFastModeResolver(() => fastEnabled);
  subagents.setCacheRetentionResolver(() => cacheRetention);
  pi.on("before_provider_request", (event, ctx) => {
    const model = ctx.model;
    const fastPayload = fastEnabled ? applyFastServiceTier(event.payload, model) : undefined;
    const cachePayload = applyCacheRetentionForRequest(
      fastPayload ?? event.payload,
      model,
      cacheRetention,
      () => model !== undefined && ctx.modelRegistry.isUsingOAuth(model),
    );
    return cachePayload ?? fastPayload;
  });
  // Read-only viewer: it owns no session state, writes nothing, and only reads cloned snapshots.
  const subagentViewer = createSubagentViewer({ snapshot: () => subagents.viewerSnapshot() });
  const notificationGate = new NotificationDeliveryPauseGate((paused) => {
    monitors?.setDeliveryPaused(paused);
    subagents.setNotificationDeliveryPaused(paused);
    goal?.setDeliveryPaused(paused);
  });
  goal = registerGoalRuntime(pi, {
    isNotificationDeliveryPaused: () => notificationGate.isPaused(),
    hasActiveSubagents: () => subagents.hasActiveRuns(),
    hasPendingSubagentNotifications: () => subagents.hasPendingNotifications(),
    hasBlockingMonitors: () => monitors?.hasBlockingWork() ?? false,
    askWaitingCount: () => asks.waitingCount(),
    childStats: (runIds) => subagents.goalStats(runIds),
  });
  asks.setGoalActiveResolver(() => goal?.isActive() ?? false);
  subagents.subscribeRunCreated((runId) => goal?.ownRun(runId));
  subagents.registry.subscribe(() => goal?.notePackageLifecycleChange());
  asks.subscribe(() => goal?.notePackageLifecycleChange());
  let monitorGoalUnsubscribe: (() => void) | undefined;
  let sessionEpoch = 0;
  let treeNotificationHold: TreeNotificationHold | undefined;

  for (const [shortcut, direction] of [["ctrl+shift+left", -1], ["ctrl+shift+right", 1]] as const) {
    pi.registerShortcut(shortcut, {
      description: direction === 1
        ? "Open the read-only Subagent viewer and cycle forward through running or waiting runs"
        : "Open the read-only Subagent viewer and cycle backward through running or waiting runs",
      handler: async (ctx) => {
        // The viewer reads Main's own presentation settings from this context and never writes them.
        await subagentViewer.handleShortcut(ctx.ui, direction, {
          enabled: ctx.hasUI && ctx.mode === "tui",
          cwd: ctx.cwd,
          projectTrusted: ctx.isProjectTrusted(),
        });
      },
    });
  }

  function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.error(`[oh-my-pi-slim] ${message}`);
  }

  function bindAskDriver(ctx?: ExtensionContext): void {
    // The questionnaire owns the screen while it is up, so the read-only viewer closes first and
    // the driver awaits that close before it opens its own overlay.
    asks.setTuiDriver(
      ctx?.hasUI === true && ctx.mode === "tui"
        ? new AskTuiDriver(ctx.ui, { beforeOpen: () => subagentViewer.closeAsync() })
        : undefined,
    );
  }

  function updateStatus(ctx: ExtensionContext, model = ctx.model): void {
    if (!ctx.hasUI) return;
    const mode = model?.provider === "openai" || model?.provider === "openai-codex"
      ? ` · OpenAI Fast Mode: ${fastEnabled ? "on" : "off"}`
      : model?.provider === "anthropic" && model.api === "anthropic-messages" &&
          model.compat?.supportsLongCacheRetention !== false && ctx.modelRegistry.isUsingOAuth(model)
        ? ` · Anthropic Cache Mode: ${cacheRetention}`
        : "";
    ctx.ui.setStatus(
      "oh-my-pi-slim",
      ctx.ui.theme.fg("accent", ` · OMPS Version: v${PACKAGE_VERSION}${mode}`),
    );
  }

  function takeTreeNotificationHold(): TreeNotificationHold | undefined {
    const hold = treeNotificationHold;
    if (!hold) return;
    hold.signal.removeEventListener("abort", hold.abortListener);
    treeNotificationHold = undefined;
    return hold;
  }

  function clearTreeNotificationHold(): void {
    takeTreeNotificationHold();
  }

  function releaseTreeNotificationHoldDeferred(hold: TreeNotificationHold): void {
    if (treeNotificationHold !== hold) return;
    takeTreeNotificationHold();
    notificationGate.releaseDeferred(hold.generation);
    const ctx = sessionCtx;
    if (ctx) setImmediate(() => goal?.reevaluateAfterHostOperation(ctx));
  }

  function releaseCurrentNotificationsDeferred(): void {
    const generation = notificationGate.currentGeneration();
    if (treeNotificationHold?.generation === generation) clearTreeNotificationHold();
    notificationGate.releaseDeferred(generation);
  }

  function invalidateDeferredSessionState(): void {
    sessionEpoch += 1;
    goal?.invalidateDeferred();
    notificationGate.invalidate();
  }

  pi.registerCommand("fast", {
    description: "Toggle OpenAI Fast Mode for this Pi session.",
    handler: async (args, ctx) => {
      if (args.trim()) {
        report(ctx, "Usage: /fast", "warning");
        return;
      }
      const next = !fastEnabled;
      try {
        pi.appendEntry(FAST_STATE_ENTRY_TYPE, makeFastState(next));
      } catch (error) {
        report(ctx, `Could not update Fast Mode: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      fastEnabled = next;
      updateStatus(ctx);
      report(ctx, `OpenAI Fast Mode: ${fastEnabled ? "on" : "off"}`, "info");
    },
  });

  pi.registerCommand("cache", {
    description: "Toggle Anthropic cache retention for this Pi session.",
    handler: async (args, ctx) => {
      if (args.trim()) {
        report(ctx, "Usage: /cache", "warning");
        return;
      }
      const next: CacheRetention = cacheRetention === "long" ? "short" : "long";
      try {
        pi.appendEntry(CACHE_STATE_ENTRY_TYPE, makeCacheState(next));
      } catch (error) {
        report(ctx, `Could not update Cache Mode: ${error instanceof Error ? error.message : String(error)}`, "error");
        return;
      }
      cacheRetention = next;
      updateStatus(ctx);
      report(ctx, `Cache Mode ${next === "long" ? "Long" : "Short"} requested for this Pi session. Cache policy applies only to eligible Anthropic OAuth requests and does not guarantee a cache hit.`, "info");
    },
  });

  pi.on("session_start", async (event, ctx) => {
    invalidateDeferredSessionState();
    clearTreeNotificationHold();
    widgetStackHost().bind(WIDGET_STACK_OWNER, ctx.mode === "tui" ? ctx.ui : undefined);
    asks.reset();
    subagentViewer.reset();
    bindAskDriver(ctx);
    asks.reconcileHostMode(ctx);
    await monitors?.reset();
    monitorGoalUnsubscribe?.();
    monitorGoalUnsubscribe = monitors?.subscribe(() => goal?.notePackageLifecycleChange());
    monitors?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined);
    monitors?.refreshUI();
    goal?.setUICtx(undefined);
    notificationGate.clearWithoutDelivery();
    goal?.setDeliveryPaused(false);
    sessionCtx = ctx;
    // Request modes are session-wide across every branch, so replay the full entry log.
    const entries = ctx.sessionManager.getEntries();
    fastEnabled = replayFastState(entries);
    cacheRetention = replayCacheState(entries);
    updateStatus(ctx);
    goal?.restore(ctx, event.reason === "startup" || event.reason === "reload" || event.reason === "resume" || event.reason === "fork");
    goal?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined);
    try {
      assertNoLegacyBackend(pi);
      await subagents.restore(ctx);
    } catch (error) {
      report(ctx, error instanceof Error ? error.message : String(error), "error");
    }
  });

  pi.on("session_before_switch", async () => {
    invalidateDeferredSessionState();
    clearTreeNotificationHold();
    // Ask aborts first: its overlay sits above the viewer, and the viewer refuses to resolve while
    // a foreign overlay is on top, so closing it first would only queue a pending close.
    asks.abortAll("Session switch aborted the questionnaire.");
    subagentViewer.close();
    bindAskDriver();
    goal?.setUICtx(undefined);
    await monitors?.shutdown();
  });

  pi.on("session_before_fork", async () => {
    invalidateDeferredSessionState();
    clearTreeNotificationHold();
    asks.abortAll("Session fork aborted the questionnaire.");
    subagentViewer.close();
    bindAskDriver();
    goal?.setUICtx(undefined);
    await monitors?.shutdown();
  });

  pi.on("session_before_tree", async (event) => {
    invalidateDeferredSessionState();
    clearTreeNotificationHold();
    asks.abortAll("Session tree navigation aborted the questionnaire.");
    subagentViewer.close();
    bindAskDriver();
    goal?.setUICtx(undefined);
    const generation = notificationGate.pause();
    let hold: TreeNotificationHold;
    const abortListener = () => {
      if (treeNotificationHold !== hold) return;
      hold.abortPending = true;
      if (hold.shutdownComplete) releaseTreeNotificationHoldDeferred(hold);
    };
    hold = {
      generation,
      signal: event.signal,
      abortListener,
      shutdownComplete: false,
      abortPending: false,
    };
    treeNotificationHold = hold;
    event.signal.addEventListener("abort", abortListener, { once: true });
    if (event.signal.aborted) abortListener();
    try {
      await subagents.shutdown();
      hold.shutdownComplete = true;
      if (hold.abortPending) releaseTreeNotificationHoldDeferred(hold);
    } catch (error) {
      hold.shutdownComplete = true;
      releaseTreeNotificationHoldDeferred(hold);
      throw error;
    }
  });

  pi.on("session_tree", async (_event, ctx) => {
    sessionCtx = ctx;
    widgetStackHost().bind(WIDGET_STACK_OWNER, ctx.mode === "tui" ? ctx.ui : undefined);
    bindAskDriver(ctx);
    asks.reconcileHostMode(ctx);
    monitors?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined);
    monitors?.refreshUI();
    updateStatus(ctx);
    const hold = takeTreeNotificationHold();
    try {
      await subagents.restore(ctx, notificationGate.isPaused());
      goal?.restore(ctx, true);
      goal?.setUICtx(ctx.mode === "tui" ? ctx.ui : undefined);
    } catch (error) {
      report(ctx, error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (hold) notificationGate.releaseDeferred(hold.generation);
    }
  });

  pi.on("input", (event) => {
    if (event.source !== "extension" && notificationGate.isPaused()) {
      releaseCurrentNotificationsDeferred();
    }
    if (event.source !== "extension") goal?.onExternalUserInput();
  });

  pi.on("model_select", (event, ctx) => {
    updateStatus(ctx, event.model);
  });

  pi.on("session_before_compact", (event, ctx) => {
    const generation = notificationGate.pause();
    const releaseAfterAbort = () => {
      setImmediate(() => {
        if (notificationGate.release(generation)) goal?.reevaluateAfterHostOperation(ctx);
      });
    };
    if (event.signal.aborted) releaseAfterAbort();
    else event.signal.addEventListener("abort", releaseAfterAbort, { once: true });
  });

  pi.on("agent_start", (_event, ctx) => {
    goal?.onAgentStart(ctx);
  });

  pi.on("agent_end", (event) => {
    goal?.onAgentEnd(event);
  });

  pi.on("turn_start", () => {
    subagents.onTurnStart();
  });

  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "custom") return;
    const message = event.message;
    if (message.customType === GOAL_CONTINUATION_MESSAGE_TYPE) {
      const deliveryEpoch = sessionEpoch;
      const deliverySessionId = ctx.sessionManager.getSessionId();
      setImmediate(() => {
        if (deliveryEpoch !== sessionEpoch || sessionCtx?.sessionManager.getSessionId() !== deliverySessionId) return;
        goal?.acknowledgeContinuationMessage(message);
      });
      return;
    }
    if (event.message.customType !== SUBAGENT_NOTIFICATION_TYPE && event.message.customType !== MONITOR_NOTIFICATION_TYPE) return;
    // Bind acknowledgement to this session so delayed message_end events cannot acknowledge a new runtime's private key.
    const deliveryEpoch = sessionEpoch;
    const deliverySessionId = ctx.sessionManager.getSessionId();
    setImmediate(() => {
      if (deliveryEpoch !== sessionEpoch || sessionCtx?.sessionManager.getSessionId() !== deliverySessionId) return;
      if (message.customType === SUBAGENT_NOTIFICATION_TYPE) subagents.acknowledgeNotificationMessage(message);
      else monitors?.acknowledgeNotificationMessage(message);
    });
  });

  pi.on("tool_execution_start", () => {
    goal?.onToolExecutionStart();
  });

  pi.on("session_compact", (_event, ctx) => {
    goal?.refreshFromBranch(ctx);
    if (notificationGate.isPaused()) {
      releaseCurrentNotificationsDeferred();
      setImmediate(() => goal?.reevaluateAfterHostOperation(ctx));
    }
  });

  pi.on("agent_settled", (_event, ctx) => {
    // Retry only while this session/runtime still owns the queued private delivery keys.
    const deliveryEpoch = sessionEpoch;
    const deliverySessionId = ctx.sessionManager.getSessionId();
    setImmediate(() => {
      if (deliveryEpoch !== sessionEpoch || sessionCtx?.sessionManager.getSessionId() !== deliverySessionId) return;
      subagents.retryQueuedNotificationsAfterAgentSettled();
      monitors?.retryQueuedNotificationsAfterAgentSettled();
    });

    if (notificationGate.isPaused()) releaseCurrentNotificationsDeferred();
    goal?.onAgentSettled(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    invalidateDeferredSessionState();
    clearTreeNotificationHold();
    // Release only this extension's claim on this session's UI; Todo may still own the aggregate.
    widgetStackHost().unbind(WIDGET_STACK_OWNER, ctx.mode === "tui" ? ctx.ui : undefined);
    asks.abortAll("Session shutdown aborted the questionnaire.");
    subagentViewer.dispose();
    bindAskDriver();
    goal?.shutdown();
    monitorGoalUnsubscribe?.();
    monitorGoalUnsubscribe = undefined;
    await Promise.all([subagents.shutdown(), monitors?.shutdown()]);
    notificationGate.clearWithoutDelivery();
    if (ctx.hasUI) ctx.ui.setStatus("oh-my-pi-slim", undefined);
    sessionCtx = undefined;
  });
}
