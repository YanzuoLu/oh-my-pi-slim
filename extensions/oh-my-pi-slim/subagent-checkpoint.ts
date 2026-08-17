import {
  shouldCompact,
  type CompactionSettings,
  type ContextUsage,
  type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

export const CHECKPOINT_RESUME_TEXT = "Resume the user's latest intent. Re-read kept recent messages above the summary to confirm the latest request. If it supersedes earlier plans in the summary, follow it. If no work remains, say so briefly; do not invent work.";

interface CheckpointTool {
  id: string;
  name: string;
}

export function completedToolBatch(event: TurnEndEvent): boolean {
  if (event.message.role !== "assistant" || event.message.stopReason !== "toolUse") return false;
  const tools: CheckpointTool[] = [];
  const callsById = new Map<string, string>();
  for (const content of event.message.content) {
    if (content.type !== "toolCall") continue;
    if (callsById.has(content.id)) return false;
    callsById.set(content.id, content.name);
    tools.push({ id: content.id, name: content.name });
  }
  if (tools.length === 0 || event.toolResults.length !== tools.length) return false;
  const resultIds = new Set<string>();
  for (const result of event.toolResults) {
    if (resultIds.has(result.toolCallId)) return false;
    resultIds.add(result.toolCallId);
    if (callsById.get(result.toolCallId) !== result.toolName) return false;
  }
  return true;
}

export function contextUsageNeedsCheckpoint(
  usage: Pick<ContextUsage, "tokens" | "contextWindow"> | null | undefined,
  settings: CompactionSettings,
): boolean {
  return usage?.tokens !== null && usage?.tokens !== undefined &&
    usage.contextWindow !== null && usage.contextWindow !== undefined &&
    shouldCompact(usage.tokens, usage.contextWindow, settings);
}
