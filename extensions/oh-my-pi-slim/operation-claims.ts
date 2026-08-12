export type AgentOperationKind = "auto-steer" | "explicit-resume";

export interface AgentOperationClaim {
  agentId: string;
  toolCallId: string;
  kind: AgentOperationKind;
}

export interface ClaimResult {
  allowed: boolean;
  claimed: boolean;
  conflict?: AgentOperationClaim;
}

export class AgentOperationClaims {
  private readonly byAgentId = new Map<string, AgentOperationClaim>();
  private readonly agentIdsByToolCallId = new Map<string, Set<string>>();

  claimExplicitResume(agentId: string, toolCallId: string): ClaimResult {
    return this.claim(agentId, toolCallId, "explicit-resume");
  }

  claimSteer(
    agentId: string,
    toolCallId: string,
    status: unknown,
  ): ClaimResult {
    const conflict = this.byAgentId.get(agentId);
    if (conflict) return { allowed: false, claimed: false, conflict };
    if (status !== "completed" && status !== "steered") {
      return { allowed: true, claimed: false };
    }
    return this.claim(agentId, toolCallId, "auto-steer");
  }

  get(agentId: string): AgentOperationClaim | undefined {
    return this.byAgentId.get(agentId);
  }

  releaseToolCall(toolCallId: string): void {
    const agentIds = this.agentIdsByToolCallId.get(toolCallId);
    if (!agentIds) return;
    for (const agentId of agentIds) {
      if (this.byAgentId.get(agentId)?.toolCallId === toolCallId) {
        this.byAgentId.delete(agentId);
      }
    }
    this.agentIdsByToolCallId.delete(toolCallId);
  }

  clear(): void {
    this.byAgentId.clear();
    this.agentIdsByToolCallId.clear();
  }

  private claim(agentId: string, toolCallId: string, kind: AgentOperationKind): ClaimResult {
    const conflict = this.byAgentId.get(agentId);
    if (conflict) return { allowed: false, claimed: false, conflict };

    const claim = { agentId, toolCallId, kind };
    this.byAgentId.set(agentId, claim);
    const agentIds = this.agentIdsByToolCallId.get(toolCallId) ?? new Set<string>();
    agentIds.add(agentId);
    this.agentIdsByToolCallId.set(toolCallId, agentIds);
    return { allowed: true, claimed: true };
  }
}
