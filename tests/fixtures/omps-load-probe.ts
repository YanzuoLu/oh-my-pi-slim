import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AUDITED_TOOLS = new Set(["ask_user_question", "contact_supervisor", "goal", "monitor", "subagent", "todo"]);

function schemaSummary(parameters: unknown) {
  const schema = parameters && typeof parameters === "object" ? parameters as {
    type?: string;
    additionalProperties?: boolean;
    anyOf?: unknown;
    oneOf?: unknown;
    properties?: { action?: { anyOf?: Array<{ const?: string }> } };
  } : undefined;
  return {
    rootType: schema?.type,
    additionalProperties: schema?.additionalProperties,
    rootHasUnion: schema?.anyOf !== undefined || schema?.oneOf !== undefined,
    actions: (schema?.properties?.action?.anyOf ?? [])
      .map((branch) => branch.const)
      .filter((action): action is string => typeof action === "string"),
  };
}

export default function ompsLoadProbe(pi: ExtensionAPI): void {
  pi.registerCommand("omps-load-probe", {
    description: "Inspect isolated OMPS package registration",
    handler: async (_args, ctx) => {
      const tools = pi.getAllTools().filter((tool) => AUDITED_TOOLS.has(tool.name));
      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      const guidelinesByTool = Object.fromEntries(tools.map((tool) => [tool.name, [...(tool.promptGuidelines ?? [])]]));
      ctx.ui.notify(`OMPS_LOAD_PROBE ${JSON.stringify({
        tools: tools.map((tool) => tool.name).sort(),
        activeTools: pi.getActiveTools().filter((name) => AUDITED_TOOLS.has(name)).sort(),
        commands: pi.getCommands().map((command) => command.name).filter((name) => name === "cache" || name === "fast" || name === "goal").sort(),
        descriptions: Object.fromEntries(tools.map((tool) => [tool.name, tool.description])),
        promptSnippets: Object.fromEntries(tools.flatMap((tool) =>
          typeof tool.promptSnippet === "string" ? [[tool.name, tool.promptSnippet]] : [])),
        guidelinesByTool,
        flattenedGuidelines: Object.values(guidelinesByTool).flat(),
        schemas: Object.fromEntries([...AUDITED_TOOLS].sort().map((name) => [
          name,
          byName.has(name) ? schemaSummary(byName.get(name)?.parameters) : null,
        ])),
      })}`, "info");
    },
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "extension") return;
    const prefix = event.text.startsWith("/goal") ? "GOAL_FORWARD_PROBE " : undefined;
    if (!prefix) return;
    ctx.ui.notify(`${prefix}${JSON.stringify({
      text: event.text,
      source: event.source,
      streamingBehavior: event.streamingBehavior,
    })}`, "info");
    return { action: "handled" };
  });
}
