import { Type } from "typebox";

/**
 * Canonical model-facing contracts for every OMPS tool.
 *
 * Each tool starts with one review block containing every authored string the model can receive.
 * Input and result schemas, result builders, and examples follow. Runtime-only details stay in feature modules.
 */

// Shared wire helpers

const markdown = (...lines: string[]) => lines.join("\n");
const stringArray = Type.Array(Type.String());

export function modelJson(value: unknown): string {
  return JSON.stringify(value);
}

export function modelJsonResult(value: unknown, details?: unknown) {
  return { content: [{ type: "text" as const, text: modelJson(value) }], details };
}

export const COMMON_TOOL_ERRORS = {
  object: (field: string) => `${field} must be an object.`,
  unknownField: (field: string, name: string) => `${field} does not accept field "${name}".`,
  unknownFields: (action: string, fields: readonly string[]) => `${action} does not accept field(s): ${fields.join(", ")}.`,
  required: (action: string, field: string) => `${action} requires ${field}.`,
  string: (field: string) => `${field} must be a string.`,
  nonEmptyString: (field: string) => `${field} must be a non-empty string.`,
  maxCharacters: (field: string, maximum: number) => `${field} must contain at most ${maximum} characters.`,
  stringArrayRange: (field: string, minimum: number, maximum: number) => `${field} must contain from ${minimum} through ${maximum} non-empty strings.`,
  unsupportedAction: (tool: string, action: unknown) => `Unsupported action "${String(action)}" for ${tool}.`,
} as const;

// Ask User Question
// 1. Name and description

export const ASK_TOOL_NAME = "ask_user_question";
export const ASK_TOOL_DESCRIPTIONS = {
  tool: markdown(
    "Ask the user one to four questions in a single questionnaire.",
    "",
    "Use this only when the work cannot continue without user input. Do not use it while a Goal is active.",
    "",
    "## Rules",
    "",
    "- Call this as the only tool in the assistant message and only when Pi has no pending messages.",
    "- Give each question two to four distinct options. Put the recommended option first and mark its label with `(Recommended)`.",
    "- The UI always lets the user enter a custom answer. Do not add `Other`, `Type something.`, or `Next` as options.",
    "- Use `multiSelect: true` when more than one option may be chosen. Previews are available only for single-select questions.",
    "- A submitted questionnaire returns the confirmed answers as JSON.",
  ),
  input: {
    questions: {
      description: "Questions shown in order (1-4).",
      items: {
        question: "Question shown to the user.",
        header: "Short label shown above the question (max 16 characters).",
        options: {
          description: "Choices shown in order (2-4). Put the recommended option first.",
          items: {
            label: "Short unique label shown to the user (max 60 characters). Append `(Recommended)` to the recommended option. Do not use `Other`, `Type something.`, or `Next`.",
            description: "One-sentence explanation of what this option means.",
            preview: "Optional preview of the result this option would produce. Single-select only.",
          },
        },
        multiSelect: "Set to true to allow multiple selections. Defaults to false. Cannot be combined with option previews.",
      },
    },
  },
  result: {
    items: "Confirmed answers in the same order as `questions`. Each item is a string, an array of strings, or null when unanswered.",
    declined: "The user declined to answer.",
  },
  errors: {
    object: COMMON_TOOL_ERRORS.object,
    unknownField: COMMON_TOOL_ERRORS.unknownField,
    string: COMMON_TOOL_ERRORS.string,
    maxCharacters: COMMON_TOOL_ERRORS.maxCharacters,
    questionCount: "questions must contain from 1 through 4 questions.",
    duplicateQuestion: (question: string) => `questions contains duplicate exact question "${question}".`,
    optionCount: (field: string) => `${field}.options must contain from 2 through 4 options.`,
    multiSelectBoolean: (field: string) => `${field}.multiSelect must be a boolean.`,
    duplicateLabel: (field: string, label: string) => `${field}.options contains duplicate exact label "${label}".`,
    reservedLabel: (field: string, label: string) => `${field}.label uses reserved label "${label}".`,
    previewWithMultiSelect: (field: string) => `${field} cannot combine multiSelect:true with option preview; preview is single-select only.`,
    soleCall: "`ask_user_question` must be the only tool call in its assistant message. Retry `ask_user_question` alone.",
    pendingMessages: "`ask_user_question` requires Pi to have no pending messages. Retry `ask_user_question` alone after Pi is idle.",
    goalActive: "`ask_user_question` is unavailable while a Goal is active.",
    uiUnavailable: (mode: string) => `\`ask_user_question\` is unavailable in ${mode} mode.`,
    tuiUnavailable: "`ask_user_question` is unavailable because no TUI driver is configured.",
    aborted: "The questionnaire was aborted.",
  },
  driverErrors: {
    invalidQuestionIndex: (index: unknown) => `Driver returned invalid questionIndex ${String(index)}.`,
    optionForMulti: (index: number) => `Driver returned an option answer for multi-select question ${index}.`,
    optionString: (index: number) => `Driver option answer ${index} must be a string.`,
    unknownOption: (option: unknown, index: number) => `Driver returned unknown option "${String(option)}" for question ${index}.`,
    multiForSingle: (index: number) => `Driver returned a multi answer for single-select question ${index}.`,
    multiStringArray: (index: number) => `Driver multi answer ${index} must be a string array.`,
    duplicateMulti: (index: number) => `Driver returned duplicate multi selections for question ${index}.`,
    customString: (index: number) => `Driver custom answer ${index} must be a string or null.`,
    unknownKind: (kind: unknown) => `Driver returned unknown answer kind ${String(kind)}.`,
    answersArray: "Ask driver must return an answers array.",
    cancelledBoolean: "Ask driver cancelled must be a boolean.",
    invalidAnswer: "Ask driver returned an invalid answer.",
    duplicateAnswer: (index: unknown) => `Ask driver returned duplicate answer for question ${String(index)}.`,
    rpcChoice: (choice: unknown) => `RPC select returned unknown choice "${String(choice)}".`,
  },
} as const;

export const ASK_TOOL_DESCRIPTION = ASK_TOOL_DESCRIPTIONS.tool;
export const ASK_TOOL_ERRORS = ASK_TOOL_DESCRIPTIONS.errors;
export const ASK_DRIVER_ERRORS = ASK_TOOL_DESCRIPTIONS.driverErrors;

// 2. Input schema

const askOptionSchema = Type.Object({
  label: Type.String({
    maxLength: 60,
    description: ASK_TOOL_DESCRIPTIONS.input.questions.items.options.items.label,
  }),
  description: Type.String({ description: ASK_TOOL_DESCRIPTIONS.input.questions.items.options.items.description }),
  preview: Type.Optional(Type.String({ description: ASK_TOOL_DESCRIPTIONS.input.questions.items.options.items.preview })),
}, { additionalProperties: false });

const askQuestionSchema = Type.Object({
  question: Type.String({ description: ASK_TOOL_DESCRIPTIONS.input.questions.items.question }),
  header: Type.String({ maxLength: 16, description: ASK_TOOL_DESCRIPTIONS.input.questions.items.header }),
  options: Type.Array(askOptionSchema, {
    minItems: 2,
    maxItems: 4,
    description: ASK_TOOL_DESCRIPTIONS.input.questions.items.options.description,
  }),
  multiSelect: Type.Optional(Type.Boolean({
    description: ASK_TOOL_DESCRIPTIONS.input.questions.items.multiSelect,
  })),
}, { additionalProperties: false });

export const askUserQuestionParameters = Type.Object({
  questions: Type.Array(askQuestionSchema, {
    minItems: 1,
    maxItems: 4,
    description: ASK_TOOL_DESCRIPTIONS.input.questions.description,
  }),
}, { additionalProperties: false });

// 3. Successful results

export const ASK_USER_DECLINED_CONTENT = ASK_TOOL_DESCRIPTIONS.result.declined;

interface AskModelAnswer {
  questionIndex: number;
  answer: string | readonly string[] | null;
}

export function askModelResult(
  answers: readonly AskModelAnswer[],
  totalQuestions: number,
) {
  const result: Array<string | string[] | null> = Array.from({ length: totalQuestions }, () => null);
  for (const { questionIndex, answer } of answers) {
    result[questionIndex] = Array.isArray(answer) ? [...answer] : answer;
  }
  return result;
}

export const askResultSchema = Type.Union([
  Type.Array(Type.Union([Type.String(), stringArray, Type.Null()])),
  Type.Literal(ASK_USER_DECLINED_CONTENT),
]);

// 4. Example

/**
 * Call
 * `{"questions":[{"question":"Which path?","header":"Path","options":[{"label":"Safe (Recommended)","description":"Prefer correctness."},{"label":"Fast","description":"Prefer speed."}]}]}`
 *
 * Result
 * `["Safe (Recommended)"]`
 */

export const ASK_TOOL_CONTRACT = {
  name: ASK_TOOL_NAME,
  description: ASK_TOOL_DESCRIPTION,
  parameters: askUserQuestionParameters,
} as const;

// Goal
// 1. Name and description

export const GOAL_TOOL_NAME = "goal";
export const GOAL_TOOL_DESCRIPTIONS = {
  tool: markdown(
    "Create and manage one durable objective on the current branch.",
    "",
    "Use a Goal only when the user explicitly wants work to continue autonomously until a concrete outcome is reached. An active Goal schedules another agent turn after each safe stopping point.",
    "",
    "## Actions",
    "",
    "- `create` starts a Goal with one to eight completion criteria and returns its status.",
    "- `check` returns the current status, objective, and criteria without changing the Goal. It returns status `none` when no Goal exists.",
    "- `modify` replaces the active or paused objective and criteria, resumes work, and returns the resulting status.",
    "- `pause` stops autonomous continuation and returns the resulting status. Use it when safe progress is blocked.",
    "- `resume` reactivates a paused or retrying Goal and returns the resulting status.",
    "- `complete` ends an active Goal and returns the resulting status. Provide exactly one concrete evidence item for each criterion.",
    "- `clear` removes the current Goal and returns status `none`.",
    "",
    "Do not ask the user questions while a Goal is active. Provider failures retry automatically. Repeated turns without progress pause the Goal.",
  ),
  input: {
    action: "Action to perform. `create` and `modify` require `abstract`, `objective`, and `criteria`. `complete` requires `evidence`.",
    abstract: "Short human-readable Goal label. Required for `create` and `modify`.",
    objective: "Outcome the Goal must achieve. Required for `create` and `modify`.",
    criteria: {
      description: "Verifiable completion conditions (1-8). Required for `create` and `modify`.",
      items: "One verifiable completion condition.",
    },
    evidence: {
      description: "Proof that each completion criterion was met. Required for `complete`; pass exactly one item per criterion in the same order.",
      items: "Proof for the completion criterion at the same array index.",
    },
  },
  result: {
    create: { status: "Current Goal status." },
    check: {
      status: "Current Goal status.",
      objective: "Outcome the Goal must achieve.",
      criteria: {
        items: "Completion criterion in its original order.",
      },
    },
    modify: { status: "Current Goal status." },
    pause: { status: "Current Goal status." },
    resume: { status: "Current Goal status." },
    complete: { status: "Current Goal status." },
    clear: { status: "Current Goal status." },
  },
  errors: {
    object: COMMON_TOOL_ERRORS.object,
    nonEmptyString: COMMON_TOOL_ERRORS.nonEmptyString,
    stringArrayRange: COMMON_TOOL_ERRORS.stringArrayRange,
    unknownFields: COMMON_TOOL_ERRORS.unknownFields,
    required: COMMON_TOOL_ERRORS.required,
    unsupportedAction: (action: string) => COMMON_TOOL_ERRORS.unsupportedAction("goal", action),
    missing: "No Goal exists on the current branch.",
    createStatus: (status: string) => `create requires no Goal or a completed Goal; the current Goal is ${status}.`,
    terminalAction: (action: string, status: string) => `${action} is invalid for terminal Goal status ${status}.`,
    completeStatus: (status: string) => `complete requires an active Goal; the current Goal is ${status}.`,
    evidenceCount: (count: number) => `evidence must contain exactly ${count} items, one per completion criterion.`,
    providerFailed: "Provider request failed.",
  },
  notifications: {
    continuation: (goal: GoalContractView) => [
      "Continue pursuing the active Goal.",
      "",
      ...goalContractFields(goal),
      "",
      "Do not ask the user questions while this Goal is active.",
      "Continue making concrete progress toward every criterion.",
      "Use `todo`, `monitor`, and `subagent` when useful.",
      "If safe progress is blocked, call `goal` with `action: \"pause\"`.",
      "Call `goal` with `action: \"complete\"` only with one evidence entry for every criterion.",
    ].join("\n"),
    stateEvent: (event: string, goal: GoalModelState) =>
      `Goal state changed: ${event}.\n${JSON.stringify(goalModelResult("check", goal), null, 2)}`,
  },
} as const;

export const GOAL_TOOL_DESCRIPTION = GOAL_TOOL_DESCRIPTIONS.tool;
export const GOAL_TOOL_ERRORS = GOAL_TOOL_DESCRIPTIONS.errors;
export const goalContinuationContent = GOAL_TOOL_DESCRIPTIONS.notifications.continuation;
export const goalStateEventContent = GOAL_TOOL_DESCRIPTIONS.notifications.stateEvent;

// 2. Input schema

export const GOAL_ACTIONS = ["create", "check", "modify", "pause", "resume", "complete", "clear"] as const;
export const GOAL_PUBLIC_FIELDS = ["action", "abstract", "objective", "criteria", "evidence"] as const;

export const goalParameters = Type.Object({
  action: Type.Union(GOAL_ACTIONS.map((action) => Type.Literal(action)), {
    description: GOAL_TOOL_DESCRIPTIONS.input.action,
  }),
  abstract: Type.Optional(Type.String({ description: GOAL_TOOL_DESCRIPTIONS.input.abstract })),
  objective: Type.Optional(Type.String({ description: GOAL_TOOL_DESCRIPTIONS.input.objective })),
  criteria: Type.Optional(Type.Array(Type.String({ description: GOAL_TOOL_DESCRIPTIONS.input.criteria.items }), {
    minItems: 1,
    maxItems: 8,
    description: GOAL_TOOL_DESCRIPTIONS.input.criteria.description,
  })),
  evidence: Type.Optional(Type.Array(Type.String({ description: GOAL_TOOL_DESCRIPTIONS.input.evidence.items }), {
    minItems: 1,
    maxItems: 8,
    description: GOAL_TOOL_DESCRIPTIONS.input.evidence.description,
  })),
}, { additionalProperties: false });

// 3. Successful results

interface GoalModelState {
  status: string;
  objective: string;
  criteria: readonly string[];
}

export function goalModelResult(action: string, goal: GoalModelState | null) {
  if (!goal) return { status: "none" };
  if (action !== "check") return { status: goal.status };
  return {
    status: goal.status,
    objective: goal.objective,
    criteria: [...goal.criteria],
  };
}

const goalStatusResultSchema = Type.Union([
  Type.Literal("none"),
  ...["active", "retry_wait", "paused", "completed"].map((status) => Type.Literal(status)),
]);

export const goalResultSchema = Type.Union([
  Type.Object({ status: goalStatusResultSchema }, {
    additionalProperties: false,
  }),
  Type.Object({
    status: goalStatusResultSchema,
    objective: Type.String(),
    criteria: Type.Array(Type.String()),
  }, {
    additionalProperties: false,
  }),
]);

// 4. Example

/**
 * Call
 * `{"action":"check"}`
 *
 * Result when no Goal exists
 * `{"status":"none"}`
 *
 * Call
 * `{"action":"check"}`
 *
 * Result when a Goal is active
 * `{"status":"active","objective":"Ship the release.","criteria":["Tests pass"]}`
 *
 * Call
 * `{"action":"pause"}`
 *
 * Result
 * `{"status":"paused"}`
 */

export const GOAL_TOOL_CONTRACT = {
  name: GOAL_TOOL_NAME,
  description: GOAL_TOOL_DESCRIPTION,
  parameters: goalParameters,
} as const;

// 5. Notification helpers

interface GoalContractView {
  abstract: string;
  objective: string;
  criteria: readonly string[];
}

function goalContractFields(goal: GoalContractView): string[] {
  return [
    `Abstract: ${goal.abstract}`,
    "",
    "Objective:",
    goal.objective,
    "",
    "Completion criteria:",
    ...goal.criteria.map((criterion, index) => `${index + 1}. ${criterion}`),
  ];
}

// Monitor
// 1. Name and description

export const MONITOR_TOOL_NAME = "monitor";
export const MONITOR_TOOL_DESCRIPTIONS = {
  tool: markdown(
    "Run a long-running Bash command in the background while continuing other work.",
    "",
    "Each stdout line is an event. Notifications arrive while the command runs, and its final status is reported when it exits. This works for builds, tests, servers, log tails, file watchers, polling loops, and other long-running commands.",
    "",
    "## Actions",
    "",
    "- `create` starts a command and immediately returns its monitor ID and current status.",
    "- `list` returns each retained monitor's ID, status, and description.",
    "- `check` returns one monitor's status, bounded recent output, truncation state, exit code, signal, and error.",
    "- `stop` terminates a running command, waits for completion, and returns its final status, exit code, signal, and error.",
    "- `clear` removes all terminal monitors when none are running and returns the number removed and any cleanup warnings.",
    "",
    "## Notifications",
    "",
    "- Each stdout line becomes an event notification. Lines produced within 200ms may be delivered together.",
    "- Stderr remains available through `check` and terminal failure diagnostics.",
    "- Exit ends the watch and reports the final status.",
    "",
    "## Command constraints",
    "",
    "- Choose the command shape by the notification stream. For one notification, use a bounded command that exits when the condition is met. For repeated notifications, use an unbounded watcher. For a stream with a known end, emit each event and exit when the source reaches a terminal state.",
    "- Do not use an unbounded command for one notification. `tail -f`, `inotifywait -m`, and `while true` remain armed after the event. `tail -f file | grep -m 1 pattern` can also hang when the file becomes quiet after the match because `tail` may never observe the closed pipe.",
    "- Every pipeline stage must flush each line. Use `grep --line-buffered` and call `fflush()` from `awk`. Do not use `head -N` for event delivery because it buffers until all N matches arrive.",
    "- Polling loops should tolerate transient request failures when one failure must not end the monitor. Use intervals of at least 30 seconds for remote APIs and 0.5 to 1 second for local checks.",
    "- Use a specific `abstract` because it appears in every notification.",
    "- Only stdout triggers event notifications. Stderr is retained for `check` and terminal failure diagnostics. When stderr contains events that must be reported, merge it into stdout before filtering, for example with `2>&1`. This does not change a tailed file whose writer already chose its own redirections.",
    "- Silence is not success. Outcome watchers must emit every terminal state that matters, including failure, cancellation, timeout, crashes, and resource exhaustion, rather than matching only progress or success. Broaden the filter when failure signatures cannot be enumerated confidently.",
    "- Keep output selective because every stdout line enters the notification stream. Emit the success and failure signals that require action, never raw high-volume logs. Notifications, status output, and retained logs are bounded, so excessive output may be coalesced, omitted, truncated, or rolled over.",
    "- An unbounded command runs until it exits, is stopped, or the session shuts down. Each monitor inherits the current process environment, runs in its own process group, and is available only on POSIX.",
  ),
  input: {
    action: "Action to perform. `create` requires `abstract` and `command`. `check` and `stop` require `id`.",
    abstract: "Short human-readable description of what is being monitored. Required for `create` and shown in notifications.",
    command: "Long-running Bash command. Required for `create`. Each stdout line becomes an event, and exit ends the monitor.",
    cwd: "Working directory for the command. `create` only; defaults to the current session directory.",
    id: "Monitor ID returned by `create`. Required for `check` and `stop`.",
  },
  result: {
    create: {
      id: "Monitor ID.",
      status: "Current monitor status.",
    },
    list: {
      items: {
        id: "Monitor ID.",
        status: "Current monitor status.",
        abstract: "Short monitor description.",
      },
    },
    check: {
      id: "Monitor ID.",
      status: "Current monitor status.",
      output: "Bounded recent stdout and stderr, prefixed with their stream.",
      truncated: "Whether older or oversized output was omitted.",
      exitCode: "Process exit code; null when unavailable.",
      signal: "Terminating signal; null when unavailable.",
      error: "Bounded runtime diagnostic.",
    },
    stop: {
      id: "Monitor ID.",
      status: "Current monitor status.",
      exitCode: "Process exit code; null when unavailable.",
      signal: "Terminating signal; null when unavailable.",
      error: "Bounded runtime diagnostic.",
    },
    clear: {
      clearedCount: "Number of monitors removed.",
      warnings: "Cleanup warnings keyed by monitor ID.",
    },
  },
  errors: {
    nonEmptyString: COMMON_TOOL_ERRORS.nonEmptyString,
    unknownFields: COMMON_TOOL_ERRORS.unknownFields,
    required: COMMON_TOOL_ERRORS.required,
    inputObject: "monitor input must be an object.",
    exactId: "id must be an exact 8-character lowercase hexadecimal monitor ID.",
    unsupportedAction: (action: string) => COMMON_TOOL_ERRORS.unsupportedAction("monitor", action),
    missing: (id: string) => `Monitor ${id} was not found.`,
    clearRunning: (listed: string) => `Action "clear" requires every monitor to be terminal. Still running: ${listed}. Ask the user whether to stop them before retrying.`,
    posixOnly: "monitor is available only on POSIX.",
    shellMissing: "monitor requires an executable bash on POSIX.",
    shuttingDown: "Monitor runtime is shutting down.",
    invalidPid: "monitor spawn did not return a valid PID.",
    changedDuringStart: "Monitor runtime changed while the command was starting.",
    stopUnconfirmed: "Child close was not observed after bounded TERM and KILL waits. Stop is unconfirmed and a detached descendant may remain.",
    logUnavailable: "monitor log file is unavailable",
    logCap: "monitor log cap is too small for one structured line",
    logWrite: "monitor log write made no progress",
    metadataLimit: "monitor operational metadata exceeds the bounded response limit.",
    changedDuringStop: (id: string) => `Monitor ${id} changed while stop was waiting for terminal state.`,
    shutdownBeforeClose: "Monitor runtime shut down before child close was observed.",
  },
  diagnostics: {
    context: (context: string, error: string) => `${context}: ${error}`,
    stream: (stream: "stdout" | "stderr", error: string) => `${stream}: ${error}`,
    shutdown: (error: string) => `shutdown: ${error}`,
    logStream: (error: string) => `log stream: ${error}`,
    logEof: (error: string) => `log EOF: ${error}`,
    logWrite: (error: string) => `log write: ${error}`,
    logRollover: (error: string) => `log rollover: ${error}`,
    logStatus: (error: string) => `log status: ${error}`,
    logStat: (error: string) => `log stat: ${error}`,
    partialLineTruncated: (bytes: number) => ` … [truncated ${bytes} bytes]`,
    logCapTruncated: " … [log-cap truncated]",
    rollover: (lines: number, bytes: number) => `[monitor log rollover: dropped ${lines} lines and ${bytes} bytes; use monitor check for retained output]`,
    recordWarning: (id: string, warning: string) => `${id}: ${warning}`,
    additionalErrorsTruncated: " … [additional errors truncated]",
    combineErrors: (current: string | null, next: string) => current ? `${current}; ${next}` : next,
  },
  notifications: {
    update: (input: MonitorUpdateContentInput) => {
      const heading = [`Monitor ${input.id} (${input.abstract}) status ${input.terminal ? input.status : "running"}.`];
      if (input.terminal) {
        heading.push(`Exit code: ${input.exitCode ?? "null"}; signal: ${input.signal ?? "null"}; error: ${input.error ?? "null"}.`);
      }
      const truncation = input.truncated
        ? `\n[truncated: omitted ${input.omitted} lines and/or shortened oversized lines; use monitor check]`
        : "";
      return [...heading, ...input.lines.map((line) => `[${line.stream}] ${line.text}`)].join("\n") + truncation;
    },
  },
} as const;

export const MONITOR_TOOL_DESCRIPTION = MONITOR_TOOL_DESCRIPTIONS.tool;
export const MONITOR_TOOL_ERRORS = MONITOR_TOOL_DESCRIPTIONS.errors;
export const MONITOR_DIAGNOSTICS = MONITOR_TOOL_DESCRIPTIONS.diagnostics;
export const monitorUpdateContent = MONITOR_TOOL_DESCRIPTIONS.notifications.update;

// 2. Input schema

export const MONITOR_ACTIONS = ["create", "list", "check", "stop", "clear"] as const;
export const MONITOR_PUBLIC_FIELDS = ["action", "abstract", "command", "cwd", "id"] as const;

export const monitorParameters = Type.Object({
  action: Type.Union(MONITOR_ACTIONS.map((action) => Type.Literal(action)), {
    description: MONITOR_TOOL_DESCRIPTIONS.input.action,
  }),
  abstract: Type.Optional(Type.String({ description: MONITOR_TOOL_DESCRIPTIONS.input.abstract })),
  command: Type.Optional(Type.String({ description: MONITOR_TOOL_DESCRIPTIONS.input.command })),
  cwd: Type.Optional(Type.String({ description: MONITOR_TOOL_DESCRIPTIONS.input.cwd })),
  id: Type.Optional(Type.String({ description: MONITOR_TOOL_DESCRIPTIONS.input.id })),
}, { additionalProperties: false });

// 3. Successful results

interface MonitorModelLine {
  stream: string;
  text: string;
}

interface MonitorModelStatus {
  id: string;
  status: string;
  omitted: number;
  truncated: boolean;
  combined: readonly MonitorModelLine[];
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}

export function monitorStatusModelResult(state: MonitorModelStatus) {
  const output = state.combined.map((line) => `[${line.stream}] ${line.text}`).join("\n");
  return {
    id: state.id,
    status: state.status,
    output,
    ...(state.truncated || state.omitted > 0 ? { truncated: true } : {}),
    ...(state.status === "running" ? {} : { exitCode: state.exitCode, signal: state.signal }),
    ...(state.error ? { error: state.error } : {}),
  };
}

export function monitorStopModelResult(state: {
  id: string;
  status: string;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
}) {
  return {
    id: state.id,
    status: state.status,
    exitCode: state.exitCode,
    signal: state.signal,
    ...(state.error ? { error: state.error } : {}),
  };
}

export const monitorCreateModelResult = (id: string, status: string) => ({ id, status });
export const monitorListModelResult = <T extends { id: string; status: string; abstract: string }>(monitors: readonly T[]) =>
  monitors.map(({ id, status, abstract }) => ({ id, status, abstract }));
export const monitorClearModelResult = (clearedCount: number, warnings: readonly string[]) =>
  ({ clearedCount, ...(warnings.length > 0 ? { warnings: [...warnings] } : {}) });

const monitorResultStatusSchema = Type.Union(
  ["running", "completed", "failed", "killed"].map((status) => Type.Literal(status)),
);

export const monitorResultSchema = Type.Union([
  Type.Object({
    id: Type.String(),
    status: monitorResultStatusSchema,
  }, { additionalProperties: false }),
  Type.Array(Type.Object({
    id: Type.String(),
    status: monitorResultStatusSchema,
    abstract: Type.String(),
  }, { additionalProperties: false })),
  Type.Object({
    id: Type.String(),
    status: monitorResultStatusSchema,
    output: Type.String(),
    truncated: Type.Optional(Type.Literal(true)),
    exitCode: Type.Optional(Type.Union([Type.Integer(), Type.Null()])),
    signal: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    error: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
  Type.Object({
    id: Type.String(),
    status: monitorResultStatusSchema,
    exitCode: Type.Union([Type.Integer(), Type.Null()]),
    signal: Type.Union([Type.String(), Type.Null()]),
    error: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
  Type.Object({
    clearedCount: Type.Integer(),
    warnings: Type.Optional(Type.Array(Type.String())),
  }, { additionalProperties: false }),
]);

// 4. Example

/**
 * Call
 * `{"action":"create","abstract":"Errors in deploy.log","command":"tail -f deploy.log | grep --line-buffered -E 'ERROR|FAILED'"}`
 *
 * Result
 * `{"id":"1a2b3c4d","status":"running"}`
 *
 * Call
 * `{"action":"check","id":"1a2b3c4d"}`
 *
 * Result
 * `{"id":"1a2b3c4d","status":"completed","output":"[stdout] built","exitCode":0,"signal":null}`
 *
 * Call
 * `{"action":"list"}`
 *
 * Result
 * `[{"id":"1a2b3c4d","status":"completed","abstract":"Errors in deploy.log"}]`
 *
 * Call
 * `{"action":"stop","id":"1a2b3c4d"}`
 *
 * Result
 * `{"id":"1a2b3c4d","status":"killed","exitCode":null,"signal":"SIGTERM"}`
 *
 * Call
 * `{"action":"clear"}`
 *
 * Result
 * `{"clearedCount":1}`
 */

export const MONITOR_TOOL_CONTRACT = {
  name: MONITOR_TOOL_NAME,
  description: MONITOR_TOOL_DESCRIPTION,
  parameters: monitorParameters,
} as const;

interface MonitorUpdateContentInput {
  id: string;
  abstract: string;
  status: string;
  terminal: boolean;
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  lines: readonly { stream: string; text: string }[];
  omitted: number;
  truncated: boolean;
}

// Subagent
// 1. Name and description

export const SUBAGENT_TOOL_NAME = "subagent";
export const SUBAGENT_TOOL_DESCRIPTIONS = {
  tool: markdown(
    "Create and manage retained background subagent runs for independent work.",
    "",
    "## When to use",
    "",
    "Use `create` for complex work that can proceed independently, parallel work, or broad investigation across several files.",
    "",
    "For a small lookup or edit whose location is already known, work directly. Once work is delegated, do not duplicate it in the supervisor session. Start several runs together when their work is independent.",
    "",
    "Include every detail the child needs in a self-contained `message`.",
    "",
    "`fork` defaults to `true`. With `fork: true`, the child receives conversation context through the point before the current tool-call batch. All `create` calls in the same batch fork from that same point. With `fork: false`, the child starts an independent session and receives only the supplied `message`.",
    "",
    "## Actions",
    "",
    "- `create` starts a new background run that proceeds asynchronously, then immediately returns its ID and current status.",
    "- `list` returns each retained run's ID, description, status, and source run ID when present.",
    "- `check` returns one run's ID, description, status, source run ID when present, and terminal output or error if completed.",
    "- `steer` sends an instruction to a running run without waiting for completion and returns its ID and current status.",
    "- `interrupt` stops a live run, waits, and returns its ID, final status, output, and error when available.",
    "- `reply` answers a waiting supervisor request, continues the same run, and returns its ID and current status.",
    "- `resume` starts a new run from the reusable context of a terminal run. It returns new and source IDs plus status.",
    "- `delete` removes one terminal run and returns its ID, deletion confirmation, and any cleanup warnings.",
    "- `clear` removes all retained runs when every run is terminal and returns the number removed and any cleanup warnings.",
    "",
    "A subagent can contact the supervisor with `contact_supervisor`, entering `waiting` until the supervisor replies. The subagent cannot continue without a reply and remains waiting. You must answer its question, direct its next work, or ask it to summarize and stop.",
    "",
    "Spawned subagents run asynchronously in the background. Continue only on non-overlapping work after dispatching runs. Otherwise briefly report what was launched and stop. Do not wait or poll for background completion.",
  ),
  input: {
    action: "Action to perform. `create` and `resume` require `abstract` and `message`. `check`, `interrupt`, and `delete` require `id`. `steer` and `reply` require `id` and `message`.",
    abstract: "Short human-readable description of the run. Required for `create` and `resume`.",
    message: "Self-contained task for `create`, instruction for `steer`, answer for `reply`, or continuation for `resume`. Required for those actions.",
    fork: "Whether `create` inherits supervisor conversation context. Defaults to `true`. `true` forks from before the current tool-call batch. `false` starts an independent session.",
    cwd: "Working directory for the run. `create` and `resume` only. Relative paths resolve from the supervisor working directory.",
    id: "Run ID returned by `create` or `resume`. Required for actions that target an existing run.",
  },
  result: {
    create: { id: "Run ID.", status: "Current run status." },
    list: {
      items: {
        id: "Run ID.",
        abstract: "Short run description.",
        status: "Current run status.",
        sourceRunId: "Source run used by `resume`.",
      },
    },
    check: {
      id: "Run ID.",
      abstract: "Short run description.",
      status: "Current run status.",
      sourceRunId: "Source run used by `resume`.",  
      output: "Final assistant output.",
      error: "Final run error.",
    },
    steer: { id: "Run ID.", status: "Current run status." },
    interrupt: {
      id: "Run ID.",
      status: "Current run status.",
      output: "Final assistant output.",
      error: "Final run error.",
    },
    reply: { id: "Run ID.", status: "Current run status." },
    resume: { id: "Run ID.", sourceRunId: "Source run used by `resume`.", status: "Current run status." },
    delete: { id: "Run ID.", deleted: "Whether the run was deleted.", warnings: "Cleanup warnings." },
    clear: { clearedCount: "Number of runs removed.", warnings: "Cleanup warnings." },
  },
  errors: {
    nonEmptyString: COMMON_TOOL_ERRORS.nonEmptyString,
    unknownFields: (label: string, fields: readonly string[]) => `${label} does not accept unknown field(s): ${fields.join(", ")}.`,
    supervisorModel: "The supervisor session has no active model.",
    forkBoolean: "fork must be a boolean.",
    forkBatch: "Could not find the current subagent tool-call batch in the supervisor session.",
    forkRoot: "The current tool-call batch has no preceding session entry to fork.",
    forkHeader: "The supervisor session header is unavailable.",
    unsupportedAction: (action: string) => COMMON_TOOL_ERRORS.unsupportedAction("subagent", action),
    createFields: "create does not accept id.",
    actionCreateFields: (action: string, fields: readonly string[]) => `${action} does not accept create field(s): ${fields.join(", ")}.`,
    actionIdMessage: (action: string) => `${action} does not accept id or message.`,
    actionMessage: (action: string) => `${action} does not accept message.`,
    removed: (id: string) => `Run ${id} was removed from the retained subagent history and is no longer available.`,
    noControl: (id: string) => `Run ${id} has no valid detached control target.`,
    steerStatus: (id: string, status: string) => `steer requires a running run; ${id} is ${status}.`,
    steerSlash: "steer messages beginning with / are unsupported because detached RPC control cannot preserve slash-command expansion semantics.",
    deleteActive: (id: string, status: string) => `Action "delete" requires a terminal run. Run ${id} is ${status}. Ask the user whether to interrupt it before retrying.`,
    clearActive: (runs: string) => `Action "clear" requires every retained run to be terminal. Still active: ${runs}. Ask the user whether to interrupt them before retrying.`,
    resumeStatus: (id: string, status: string) => `resume requires a terminal source run; ${id} is ${status}.`,
    resumeFile: (id: string) => `Run ${id} has no recoverable child session file.`,
    replyStatus: (id: string, status: string) => `reply requires a waiting run; ${id} is ${status}.`,
    replyLive: (id: string) => `reply requires a live waiting run; ${id} is not live.`,
    replyRequest: (id: string) => `Run ${id} has no waiting request.`,
    replySequence: (id: string) => `Run ${id} has no replyable waiting sequence.`,
    duplicateRun: (id: string) => `Run ${id} already exists.`,
    unknownRun: (id: string) => `Unknown subagent run: ${id}`,
    unattached: "Subagent runtime is not attached to a supervisor session.",
    directoryMissing: "Detached run directory is missing.",
    noLongerRetained: (id: string) => `Run ${id} is no longer retained.`,
    handoffUnavailable: (id: string, status: string) => `Run ${id} is ${status}, but this session can no longer hand back its result directly.`,
    stopUnconfirmed: "The detached runner could not be confirmed stopped.",
    processIdentity: (pid: number) => `Could not capture OS process identity for detached runner PID ${pid}.`,
    shuttingDown: "Supervisor session is shutting down.",
    clearRunning: "A subagent clear is already running.",
    deleteRunning: (id: string) => `A subagent delete for ${id} is already running.`,
    sessionConflict: (sessionFile: string, id: string) => `Session ${sessionFile} is already active in run ${id}.`,
  },
  warnings: {
    sharedSession: (id: string) => `Retained child session file for ${id} because another retained run still references it.`,
    sessionRemoval: (id: string, reason: string) => `Retained child session file for ${id}: ${reason}`,
    runRemoval: (id: string, reason: string) => `Retained run directory for ${id}: ${reason}`,
  },
  notifications: {
    lifecycle: (id: string, event: string, request: unknown, output?: string, error?: string) => {
      const requestText = request === undefined ? "" : `\n\nRequest:\n${JSON.stringify(request, null, 2)}`;
      const outputText = output === undefined ? "" : `\n\nOutput: ${output}`;
      const errorText = error === undefined ? "" : `\n\nError: ${error}`;
      return `Subagent ${id} is ${event}.${requestText}${outputText}${errorText}`;
    },
  },
} as const;

export const SUBAGENT_TOOL_DESCRIPTION = SUBAGENT_TOOL_DESCRIPTIONS.tool;
export const SUBAGENT_TOOL_ERRORS = SUBAGENT_TOOL_DESCRIPTIONS.errors;
export const SUBAGENT_WARNINGS = SUBAGENT_TOOL_DESCRIPTIONS.warnings;
export const subagentNotificationContent = SUBAGENT_TOOL_DESCRIPTIONS.notifications.lifecycle;

// 2. Input schema

export const SUBAGENT_ACTIONS = ["create", "list", "check", "steer", "interrupt", "reply", "resume", "delete", "clear"] as const;
export const SUBAGENT_PUBLIC_FIELDS = ["action", "abstract", "message", "fork", "cwd", "id"] as const;

export const subagentParameters = Type.Object({
  action: Type.Union(SUBAGENT_ACTIONS.map((action) => Type.Literal(action)), {
    description: SUBAGENT_TOOL_DESCRIPTIONS.input.action,
  }),
  abstract: Type.Optional(Type.String({ description: SUBAGENT_TOOL_DESCRIPTIONS.input.abstract })),
  message: Type.Optional(Type.String({ description: SUBAGENT_TOOL_DESCRIPTIONS.input.message })),
  fork: Type.Optional(Type.Boolean({ default: true, description: SUBAGENT_TOOL_DESCRIPTIONS.input.fork })),
  cwd: Type.Optional(Type.String({ description: SUBAGENT_TOOL_DESCRIPTIONS.input.cwd })),
  id: Type.Optional(Type.String({ description: SUBAGENT_TOOL_DESCRIPTIONS.input.id })),
}, { additionalProperties: false });

// 3. Successful results

interface SubagentModelRun {
  id: string;
  abstract: string;
  status: string;
  sourceRunId?: string;
  output?: string;
  error?: string;
}

export const subagentRunModelResult = (run: SubagentModelRun) => ({
  id: run.id,
  abstract: run.abstract,
  status: run.status,
  ...(run.sourceRunId === undefined ? {} : { sourceRunId: run.sourceRunId }),
  ...(run.output === undefined ? {} : { output: run.output }),
  ...(run.error === undefined ? {} : { error: run.error }),
});

export const subagentActionModelResult = (
  id: string,
  status: string,
  output?: string,
  error?: string,
) => ({
  id,
  status,
  ...(output === undefined ? {} : { output }),
  ...(error === undefined ? {} : { error }),
});

export const subagentResumeModelResult = (id: string, sourceRunId: string, status: string) => ({ id, sourceRunId, status });
export const subagentDeleteModelResult = (id: string, warnings: readonly string[]) => ({ id, deleted: true as const, warnings: [...warnings] });
export const subagentClearModelResult = (clearedCount: number, warnings: readonly string[]) => ({ clearedCount, warnings: [...warnings] });

const subagentResultStatusSchema = Type.Union(
  ["starting", "running", "waiting", "completed", "failed", "interrupted"].map((status) => Type.Literal(status)),
);
const subagentListItemResultSchema = Type.Object({
  id: Type.String(),
  abstract: Type.String(),
  status: subagentResultStatusSchema,
  sourceRunId: Type.Optional(Type.String()),
}, { additionalProperties: false });
const subagentCheckResultSchema = Type.Object({
  id: Type.String(),
  abstract: Type.String(),
  status: subagentResultStatusSchema,
  sourceRunId: Type.Optional(Type.String()),
  output: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
}, { additionalProperties: false });

export const subagentResultSchema = Type.Union([
  Type.Object({
    id: Type.String(),
    status: subagentResultStatusSchema,
    output: Type.Optional(Type.String()),
    error: Type.Optional(Type.String()),
  }, { additionalProperties: false }),
  Type.Array(subagentListItemResultSchema),
  subagentCheckResultSchema,
  Type.Object({
    id: Type.String(),
    sourceRunId: Type.String(),
    status: subagentResultStatusSchema,
  }, { additionalProperties: false }),
  Type.Object({
    id: Type.String(),
    deleted: Type.Literal(true),
    warnings: Type.Array(Type.String()),
  }, { additionalProperties: false }),
  Type.Object({
    clearedCount: Type.Integer(),
    warnings: Type.Array(Type.String()),
  }, { additionalProperties: false }),
]);

// 4. Example

/**
 * Call
 * `{"action":"create","abstract":"Inspect parser","message":"Find the parser entry point and report its data flow.","fork":true}`
 *
 * Result
 * `{"id":"1a2b3c4d","status":"starting"}`
 */

export const SUBAGENT_TOOL_CONTRACT = {
  name: SUBAGENT_TOOL_NAME,
  description: SUBAGENT_TOOL_DESCRIPTION,
  parameters: subagentParameters,
} as const;

// Contact Supervisor
// 1. Name and description

export const CONTACT_SUPERVISOR_TOOL_NAME = "contact_supervisor";
export const CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS = {
  tool: markdown(
    "Send a decision request, structured interview, or progress update to the supervisor session.",
    "",
    "Use this when the supervisor needs a progress update or when the child cannot continue without a decision. Include all context the supervisor needs in `message` because it receives the request outside the child transcript.",
    "",
    "Every call ends the current child turn and moves the run to `waiting`, including `progress_update`. The same run continues after the supervisor replies.",
    "A successful call returns status `waiting` and the selected reason.",
  ),
  input: {
    reason: "Reason for contacting the supervisor. Use `need_decision`, `interview_request`, or `progress_update`.",
    message: "Complete self-contained context for the supervisor. Defaults to `reason` when omitted or blank.",
    interview: {
      description: "Structured questions for an `interview_request`.",
      title: "Optional short title for the interview.",
      questions: {
        description: "Interview questions in display order.",
        items: {
          id: "Optional stable identifier for the question.",
          prompt: "Question for the supervisor to answer.",
          options: "Optional answer choices in display order.",
        },
      },
    },
  },
  result: {
    status: "Child status after contacting the supervisor.",
    reason: "Reason sent to the supervisor.",
  },
  errors: {
    supervisorIdentity: "OMPS supervisor run identity is missing.",
  },
} as const;

export const CONTACT_SUPERVISOR_TOOL_DESCRIPTION = CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.tool;
export const CONTACT_SUPERVISOR_ERRORS = CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.errors;

// 2. Input schema

export const CONTACT_SUPERVISOR_REASONS = ["need_decision", "interview_request", "progress_update"] as const;

export const contactSupervisorParameters = Type.Object({
  reason: Type.Union(CONTACT_SUPERVISOR_REASONS.map((reason) => Type.Literal(reason)), {
    description: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.reason,
  }),
  message: Type.Optional(Type.String({ description: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.message })),
  interview: Type.Optional(Type.Object({
    title: Type.Optional(Type.String({ description: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.interview.title })),
    questions: Type.Optional(Type.Array(Type.Object({
      id: Type.Optional(Type.String({ description: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.interview.questions.items.id })),
      prompt: Type.String({ description: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.interview.questions.items.prompt }),
      options: Type.Optional(Type.Array(Type.String(), { description: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.interview.questions.items.options })),
    }), { description: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.interview.questions.description })),
  }, { description: CONTACT_SUPERVISOR_TOOL_DESCRIPTIONS.input.interview.description })),
}, { additionalProperties: false });

// 3. Successful results

export const contactSupervisorModelResult = (reason: string) => ({ status: "waiting" as const, reason });

export const contactSupervisorResultSchema = Type.Object({
  status: Type.Literal("waiting"),
  reason: Type.String(),
}, { additionalProperties: false });

// 4. Example

/**
 * Call
 * `{"reason":"need_decision","message":"Choose whether the migration should preserve legacy aliases."}`
 *
 * Result
 * `{"status":"waiting","reason":"need_decision"}`
 */

export const CONTACT_SUPERVISOR_TOOL_CONTRACT = {
  name: CONTACT_SUPERVISOR_TOOL_NAME,
  description: CONTACT_SUPERVISOR_TOOL_DESCRIPTION,
  parameters: contactSupervisorParameters,
} as const;

// Todo
// 1. Name and description

export const TODO_TOOL_NAME = "todo";
export const TODO_TOOL_DESCRIPTIONS = {
  tool: markdown(
    "Read or atomically update the current session's task ledger.",
    "",
    "Use this to track concrete work that spans multiple steps.",
    "",
    "## Actions",
    "",
    "- `list` returns every item in insertion order.",
    "- `update` applies one or more ordered operations as a single transaction. If any operation fails, the entire update is rolled back.",
    "",
    "A successful `update` returns every unfinished item. A failed `update` explains why it failed and confirms that the entire transaction was rolled back.",
    "",
    "## Operations",
    "",
    "- `append` adds an item with a unique `subject` and an `abstract`.",
    "- `modify` changes an existing item identified by its exact `subject`.",
    "- `delete` removes a pending or completed item that no other item depends on.",
    "- `clear` removes all pending and completed items. It fails while any item is `in_progress`.",
    "",
    "Dependencies use exact existing subjects, must be acyclic, and must be completed before a dependent item can leave `pending`. Multiple independent items may be `in_progress`.",
  ),
  input: {
    action: "Action to perform. `list` accepts no `operations`; `update` requires one or more `operations`.",
    operations: {
      description: "Operations to apply in order as one atomic update. Required for `update`.",
      items: {
        append: {
          op: "Add a task.",
          subject: "Unique subject for the new task.",
          abstract: "Short human-readable description of the work.",
          blockedBy: {
            description: "Tasks that must be completed before the new task can start.",
            items: "Exact subject of an existing task.",
          },
        },
        modify: {
          op: "Change an existing task. Provide at least one field to change.",
          target: "Exact current subject of the task to change.",
          newSubject: "Unique replacement subject for the task.",
          abstract: "Replacement description of the work.",
          status: "New status for the task.",
          blockedBy: {
            description: "Complete replacement list of task dependencies.",
            items: "Exact subject of an existing task.",
          },
        },
        delete: {
          op: "Remove a task.",
          target: "Exact subject of the task to remove.",
        },
        clear: {
          description: "This operation may appear at most once in an update.",
          op: "Remove all pending and completed tasks.",
        },
      },
    },
  },
  result: {
    list: {
      items: {
        subject: "Unique task subject.",
        abstract: "Short work description.",
        status: "Current task status.",
        blockedBy: "Subjects of tasks this task depends on.",
      },
    },
    update: {
      items: {
        subject: "Unique task subject.",
        status: "Current task status.",
        blockedBy: "Subjects of tasks this task depends on.",
      },
    },
  },
  errors: {
    nonEmptyString: COMMON_TOOL_ERRORS.nonEmptyString,
    listOperations: "todo list does not accept operations.",
    unsupportedAction: (action: unknown) => COMMON_TOOL_ERRORS.unsupportedAction("todo", action),
    updateOperations: "todo update requires at least one operation.",
    updateFailed: (number: number, reason: unknown) => `Todo update failed at operation ${number}. ${reason instanceof Error ? reason.message : String(reason)} The entire transaction was rolled back.`,
    array: (field: string) => `${field} must be an array.`,
    missingDependency: (subject: string, dependency: string) => `task "${subject}" references missing dependency "${dependency}".`,
    selfDependency: (subject: string) => `task "${subject}" cannot depend on itself.`,
    dependencyCycle: (subject: string) => `dependency cycle includes "${subject}".`,
    incompleteDependency: (subject: string, dependency: string) => `task "${subject}" requires completed dependency "${dependency}".`,
    subjectNotCanonical: (subject: string) => `task subject "${subject}" is not canonical.`,
    abstractNotCanonical: (subject: string) => `task "${subject}" abstract is not canonical.`,
    invalidStatus: (subject: string) => `task "${subject}" has invalid status.`,
    duplicateSubject: (subject: string) => `duplicate subject "${subject}".`,
    blockedByNotCanonical: (subject: string) => `task "${subject}" blockedBy is not canonical.`,
    operationObject: "operation must be an object.",
    unknownOperationFields: (operation: string) => `${operation} contains unknown fields.`,
    modifyFields: "modify requires at least one mutable field.",
    modifyStatus: "modify status is invalid.",
    unknownOperation: (operation: unknown) => `unknown operation "${String(operation)}".`,
    operationsArray: "operations must be a non-empty array.",
    repeatedClear: "clear can appear only once in an update.",
    clearActive: (subjects: string) => `Action "clear" cannot remove in_progress items: ${subjects}. Ask the user whether to return them to pending or complete them before retrying.`,
    subjectExists: (subject: string) => `subject "${subject}" already exists.`,
    dependencyMissing: (dependency: string) => `dependency "${dependency}" does not exist yet.`,
    targetMissing: (target: string) => `target "${target}" does not exist.`,
    deleteActive: (target: string) => `Action "delete" cannot remove "${target}" while it is in_progress. Ask the user whether to return it to pending or complete it before retrying.`,
    deleteReferenced: (target: string, referrers: string) => `Action "delete" cannot remove "${target}" because ${referrers} depend on it.`,
  },
} as const;

export const TODO_TOOL_DESCRIPTION = TODO_TOOL_DESCRIPTIONS.tool;
export const TODO_TOOL_ERRORS = TODO_TOOL_DESCRIPTIONS.errors;

// 2. Input schema

export const TODO_ACTIONS = ["list", "update"] as const;
export const TODO_PUBLIC_FIELDS = ["action", "operations"] as const;

const todoStatusSchema = Type.Union([
  Type.Literal("pending"),
  Type.Literal("in_progress"),
  Type.Literal("completed"),
], { description: TODO_TOOL_DESCRIPTIONS.input.operations.items.modify.status });

const todoDependencySchema = (description: string, itemDescription: string) =>
  Type.Array(Type.String({ description: itemDescription }), { description });

export const appendOperationSchema = Type.Object({
  op: Type.Literal("append", { description: TODO_TOOL_DESCRIPTIONS.input.operations.items.append.op }),
  subject: Type.String({ description: TODO_TOOL_DESCRIPTIONS.input.operations.items.append.subject }),
  abstract: Type.String({ description: TODO_TOOL_DESCRIPTIONS.input.operations.items.append.abstract }),
  blockedBy: Type.Optional(todoDependencySchema(
    TODO_TOOL_DESCRIPTIONS.input.operations.items.append.blockedBy.description,
    TODO_TOOL_DESCRIPTIONS.input.operations.items.append.blockedBy.items,
  )),
}, { additionalProperties: false });

export const modifyOperationSchema = Type.Object({
  op: Type.Literal("modify", { description: TODO_TOOL_DESCRIPTIONS.input.operations.items.modify.op }),
  target: Type.String({ description: TODO_TOOL_DESCRIPTIONS.input.operations.items.modify.target }),
  newSubject: Type.Optional(Type.String({ description: TODO_TOOL_DESCRIPTIONS.input.operations.items.modify.newSubject })),
  abstract: Type.Optional(Type.String({ description: TODO_TOOL_DESCRIPTIONS.input.operations.items.modify.abstract })),
  status: Type.Optional(todoStatusSchema),
  blockedBy: Type.Optional(todoDependencySchema(
    TODO_TOOL_DESCRIPTIONS.input.operations.items.modify.blockedBy.description,
    TODO_TOOL_DESCRIPTIONS.input.operations.items.modify.blockedBy.items,
  )),
}, { additionalProperties: false });

export const deleteOperationSchema = Type.Object({
  op: Type.Literal("delete", { description: TODO_TOOL_DESCRIPTIONS.input.operations.items.delete.op }),
  target: Type.String({ description: TODO_TOOL_DESCRIPTIONS.input.operations.items.delete.target }),
}, { additionalProperties: false });

export const clearOperationSchema = Type.Object({
  op: Type.Literal("clear", { description: TODO_TOOL_DESCRIPTIONS.input.operations.items.clear.op }),
}, { additionalProperties: false, description: TODO_TOOL_DESCRIPTIONS.input.operations.items.clear.description });

export const todoOperationSchema = Type.Union([appendOperationSchema, modifyOperationSchema, deleteOperationSchema, clearOperationSchema]);

export const todoParameters = Type.Object({
  action: Type.Union(TODO_ACTIONS.map((action) => Type.Literal(action)), {
    description: TODO_TOOL_DESCRIPTIONS.input.action,
  }),
  operations: Type.Optional(Type.Array(todoOperationSchema, {
    minItems: 1,
    description: TODO_TOOL_DESCRIPTIONS.input.operations.description,
  })),
}, { additionalProperties: false });

// 3. Successful results

export function todoListContent(tasks: unknown): string {
  return modelJson(tasks);
}

export function todoUpdateContent(unfinished: unknown): string {
  return modelJson(unfinished);
}

const todoTaskResultSchema = Type.Object({
  subject: Type.String(),
  abstract: Type.String(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")]),
  blockedBy: Type.Array(Type.String()),
}, { additionalProperties: false });
const todoUnfinishedResultSchema = Type.Object({
  subject: Type.String(),
  status: Type.String(),
  blockedBy: Type.Array(Type.String()),
}, { additionalProperties: false });

export const todoResultSchema = Type.Union([
  Type.Array(todoTaskResultSchema),
  Type.Array(todoUnfinishedResultSchema),
]);

// 4. Example

/**
 * Call
 * `{"action":"update","operations":[{"op":"append","subject":"Run tests","abstract":"Execute the full validation suite."}]}`
 *
 * Result
 * `[{"subject":"Run tests","status":"pending","blockedBy":[]}]`
 *
 * Failure
 * `Todo update failed at operation 1. subject "Run tests" already exists. The entire transaction was rolled back.`
 */

export const TODO_TOOL_CONTRACT = {
  name: TODO_TOOL_NAME,
  description: TODO_TOOL_DESCRIPTION,
  parameters: todoParameters,
} as const;
