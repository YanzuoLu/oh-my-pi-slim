const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export interface ParsedModelSpec {
  /** Provider segment before the first slash, when the spec carries one. */
  provider?: string;
  /** Model ID without the provider prefix and without a recognized thinking suffix. */
  model: string;
  /** Trailing thinking level, only when the last colon suffix is a level Pi knows. */
  thinking?: string;
  /** Provider and model ID without the thinking level; the only identity a session migration cares about. */
  base: string;
}

/**
 * Splits a canonical model spec into provider, model ID, and thinking level.
 *
 * The last colon is a thinking separator only when its suffix is a known Pi thinking level.
 * Any other colon belongs to the model ID itself, so `provider/family:2025-01-01` keeps its full ID.
 */
export function parseModelSpec(spec: string): ParsedModelSpec {
  let provider: string | undefined;
  let model = spec;
  const slash = spec.indexOf("/");
  if (slash > 0 && slash < spec.length - 1) {
    const candidateProvider = spec.slice(0, slash);
    const candidateModel = spec.slice(slash + 1);
    if (candidateProvider.trim() && candidateModel.trim()) {
      provider = candidateProvider;
      model = candidateModel;
    }
  }
  let thinking: string | undefined;
  const colon = model.lastIndexOf(":");
  if (colon > 0) {
    const candidate = model.slice(colon + 1);
    if (THINKING_LEVELS.has(candidate) && model.slice(0, colon).trim()) {
      thinking = candidate;
      model = model.slice(0, colon);
    }
  }
  return { provider, model, thinking, base: provider ? `${provider}/${model}` : model };
}

/** Provider and model ID of a spec, with any known thinking level removed. */
export function modelSpecBase(spec: string): string {
  return parseModelSpec(spec.trim()).base;
}

/** True when two specs name the same provider and model ID, ignoring thinking level alone. */
export function sameModelSpecBase(left: string, right: string): boolean {
  return modelSpecBase(left) === modelSpecBase(right);
}

export function formatSubagentModel(canonicalModel: string): string {
  const spec = parseModelSpec(canonicalModel);
  if (!spec.provider) return canonicalModel;
  return `(${spec.provider}) ${spec.model}${spec.thinking ? ` • ${spec.thinking}` : ""}`;
}
