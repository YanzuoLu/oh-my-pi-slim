import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const AUDITED_TOOLS = new Set(["contact_supervisor", "loop", "subagent", "todo"]);

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
      ctx.ui.notify(`OMPS_LOAD_PROBE ${JSON.stringify({
        tools: tools.map((tool) => tool.name).sort(),
        activeTools: pi.getActiveTools().filter((name) => AUDITED_TOOLS.has(name)).sort(),
        commands: pi.getCommands().map((command) => command.name).filter((name) => name === "loop").sort(),
        schemas: Object.fromEntries([...AUDITED_TOOLS].sort().map((name) => [
          name,
          byName.has(name) ? schemaSummary(byName.get(name)?.parameters) : null,
        ])),
      })}`, "info");
    },
  });

  pi.on("input", (event, ctx) => {
    if (event.source !== "extension" || !event.text.startsWith("/loop")) return;
    ctx.ui.notify(`LOOP_FORWARD_PROBE ${JSON.stringify({
      text: event.text,
      source: event.source,
      streamingBehavior: event.streamingBehavior,
    })}`, "info");
    return { action: "handled" };
  });
}
