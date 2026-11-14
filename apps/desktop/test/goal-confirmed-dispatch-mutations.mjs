// The former queue predicates now belong to the original Host/Domain input owner.
export const goalConfirmedDispatchMutations = [
  { id: 'missing-confirmed-clear', path: 'apps/host/src/goal-dispatch-input.ts',
    anchor: "return this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'confirmed', receipt })",
    replacement: "return this.demands.recordDispatchPhase(reference.goalId, reference.operationId, { stage: 'unknown' })",
    oracle: 'only the exact original Core prompt receipt confirms a selected prepared Goal dispatch' },
  { id: 'loop-confirmation-alone', path: 'apps/host/src/goal-dispatch-input.ts',
    anchor: 'const receipt = timeline.agentSessionId === original.agentSessionId ? receiptFor(original, timeline.items) : undefined',
    replacement: "const receipt = { kind: 'core-prompt' as const, itemId: 'prompt:' + original.operationId, createdAt: 1 }",
    oracle: 'the public dispatch reader retains the original unknown input for still-unknown without submission' },
  { id: 'goal-without-operation', path: 'apps/host/src/goal-dispatch-input.ts',
    edits: [{ anchor: 'item.id === `prompt:${dispatch.operationId}`', replacement: 'true' },
      { anchor: 'itemId: matches[0]!.id', replacement: 'itemId: `prompt:${dispatch.operationId}`' }],
    oracle: 'the public dispatch reader retains the original unknown input for different-operation without submission' },
  { id: 'operation-without-goal', path: 'packages/demand/src/demand-store.ts',
    anchor: 'const owner = snapshot.demands.find(item => item.dispatches?.some(dispatch => dispatch.operationId === intent.operationId))',
    replacement: 'const owner = snapshot.demands.find(item => item.id === id && item.dispatches?.some(dispatch => dispatch.operationId === intent.operationId))',
    oracle: 'the public Start refuses an operation belonging to another Goal without input or relationship changes' }
]
