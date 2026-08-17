import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function todoLoadProbe(pi: ExtensionAPI): void {
  pi.registerCommand("todo-load-probe", {
    description: "Inspect the loaded Todo tool for an isolated smoke test",
    handler: (_args, ctx) => {
      const tools = pi.getAllTools().filter((tool) => tool.name === "todo");
      const schema = tools[0]?.parameters as {
        type?: string;
        additionalProperties?: boolean;
        anyOf?: unknown;
        oneOf?: unknown;
        properties?: { action?: { anyOf?: Array<{ const?: string }> } };
      } | undefined;
      const actions = (schema?.properties?.action?.anyOf ?? [])
        .map((branch) => branch.const)
        .filter((action): action is string => typeof action === "string")
        .sort();
      ctx.ui.notify(`TODO_LOAD_PROBE ${JSON.stringify({
        count: tools.length,
        rootType: schema?.type,
        additionalProperties: schema?.additionalProperties,
        rootHasUnion: schema?.anyOf !== undefined || schema?.oneOf !== undefined,
        actions,
      })}`, "info");
    },
  });
}
