import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  buildAskResult,
  createRpcAskDriver,
  validateQuestionnaire,
} from "../../extensions/oh-my-pi-slim/ask/runtime.js";

export default function askRpcProbe(pi: ExtensionAPI): void {
  pi.registerCommand("ask-rpc-probe", {
    description: "Exercise the built-in Ask RPC dialog without a model call",
    handler: async (_args, ctx) => {
      const questionnaire = validateQuestionnaire({
        questions: [
          {
            question: "Which path?",
            header: "Path",
            options: [
              { label: "Safe", description: "Use the safe path.", preview: "Safe preview." },
              { label: "Fast", description: "Use the fast path." },
            ],
          },
          {
            question: "Which extras?",
            header: "Extras",
            multiSelect: true,
            options: [
              { label: "Logs", description: "Include logs." },
              { label: "Metrics", description: "Include metrics." },
            ],
          },
        ],
      });
      const raw = await createRpcAskDriver(ctx.ui).ask(questionnaire, new AbortController().signal);
      const result = buildAskResult(questionnaire, raw);
      ctx.ui.notify(`ASK_RPC_PROBE ${JSON.stringify(result)}`, "info");
    },
  });
}
