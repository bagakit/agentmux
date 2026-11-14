/** Safe locator for an already acknowledged, immutable Coordinator intent.
 * It carries no launch input, resource grant, environment or actor authority. */
export type AgentExecutionReference = {
  bindingId: string
  agentSessionId: string
  createOperationId: string
}

/** Frozen journal facts only. Confirmed does not establish a live Agent or input eligibility. */
export type AgentExecutionAssociationWitness = {
  state: 'confirmed'
  reference: AgentExecutionReference
  agentRuntimeId: string
  resourceRuntimeId: string
  resourceWorkspacePath: string
  /** Safe original launch locator; absence never permits current-config reconstruction. */
  agent?: { executorId: string; executorRevision: string; workspacePath: string }
  sourceRequestDigest?: string
} | {
  state: 'unconfirmed'
  reference: AgentExecutionReference
  issue: { code: 'EXECUTION_RUNTIME_WITNESS_UNCONFIRMED'; message: string }
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
