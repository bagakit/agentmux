/** Safe locator for an already acknowledged, immutable Coordinator intent.
 * It carries no launch input, resource grant, environment or actor authority. */
export type AgentExecutionReference = {
  bindingId: string
  agentSessionId: string
  createOperationId: string
}

/** The failed step, separate from the health or outcome of existing Runs. */
export type AgentExecutionFailure = {
  reference: AgentExecutionReference
  hostId: string
  role: 'executor' | 'frontend' | 'agent'
  stage: 'resolve' | 'inventory' | 'prepare' | 'start' | 'attach' | 'create'
}

/** Derived from the original Start attempt and receipt, never a second phase store. */
export type AgentExecutionHelperStart = {
  outcome: 'not-submitted' | 'unknown' | 'confirmed'
  runId: string | null
}
