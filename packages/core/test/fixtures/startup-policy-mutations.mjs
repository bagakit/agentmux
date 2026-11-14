export const mutations = {
  'retain-policy-decision': { file: 'packages/core/src/agent-session-recovery/supervisor.ts',
    from: 'if (lifecycleConfirmedClear && this.unadmittedPolicyDecision(session, input, root)) return',
    to: 'if (false && this.unadmittedPolicyDecision(session, input, root)) return' },
  'skip-policy-admission-fence': { file: 'packages/core/src/agent-session-recovery/continuity-attempt.ts',
    from: 'if (!root || !isDeepStrictEqual(root, reevaluatedPolicy) || !supervisor.unadmittedPolicyDecision(value, input, root))',
    to: 'if (false)' },
  'skip-policy-record-fence': { file: 'packages/core/src/agent-session-recovery/continuity-attempt.ts',
    from: 'assertPolicyDecision(value)\n          absenceChanged = false',
    to: 'absenceChanged = false' },
  'skip-policy-lifecycle-recheck': { file: 'packages/core/src/agent-session-recovery/continuity-attempt.ts',
    from: 'if (reevaluatedPolicy && await ports.sessions.store.readLifecycleReservation(input.agentSessionId))',
    to: 'if (false)' },
  'keep-policy-fence-after-commit': { file: 'packages/core/src/agent-session-recovery/continuity-attempt.ts',
    from: 'if (current.continuity?.operationId === receipt.operationId) reevaluatedPolicy = undefined',
    to: '/* mutant retains the obsolete policy snapshot after its replacement committed */' }
}
export function mutatePolicySource(source, file, selected) {
  if (selected && !Object.hasOwn(mutations, selected)) throw Error('Unknown startup policy mutation: ' + selected)
  const mutation = mutations[selected]
  if (mutation?.file !== file) return source
  if (source.split(mutation.from).length !== 2) throw Error('Expected one loaded policy owner mutation: ' + selected)
  return source.replace(mutation.from, mutation.to)
}
