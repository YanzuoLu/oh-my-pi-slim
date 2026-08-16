const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export function formatSubagentModel(canonicalModel: string): string {
  const slash = canonicalModel.indexOf("/");
  if (slash <= 0 || slash >= canonicalModel.length - 1) return canonicalModel;
  const provider = canonicalModel.slice(0, slash);
  let model = canonicalModel.slice(slash + 1);
  if (!provider.trim() || !model.trim()) return canonicalModel;

  let thinking: string | undefined;
  const colon = model.lastIndexOf(":");
  if (colon > 0) {
    const candidate = model.slice(colon + 1);
    if (THINKING_LEVELS.has(candidate) && model.slice(0, colon).trim()) {
      thinking = candidate;
      model = model.slice(0, colon);
    }
  }
  return `(${provider}) ${model}${thinking ? ` • ${thinking}` : ""}`;
}
