export const nativeMainConfirmationMutations = [
  { name: 'drop-retained-main-receipt', path: 'packages/core/src/agent-native-source.ts',
    before: "return session.nativeBinding.source === 'semantic-resume-target' && receipt?.providerId === session.providerId &&",
    after: "return false && receipt?.providerId === session.providerId &&",
    test: '^consumes the retained weak projection through the original input owner', reason: 'retained main proof must qualify the original input' },
  { name: 'keep-weak-binding', path: 'packages/core/src/client.ts',
    before: "current.nativeBinding?.source === 'semantic-resume-target' &&\n              hasCurrentNativeMainBinding({ ...current, hookReceipt: persistedReceipt })",
    after: 'false', test: '^keeps actual post-main input qualification after a later child receipt',
    reason: 'a later child must not restore initialization gating after the main object was confirmed' },
  { name: 'restore-source-kind-lineage-veto', path: 'packages/core/src/agent-session-resume-sources.ts',
    before: 'if (!session.nativeBinding || session.nativeBinding.run.runId !== session.run.runId ||',
    after: "if ((session.nativeBinding?.source !== 'semantic-resume-target' && session.nativeBinding?.source !== 'user-selected') || session.nativeBinding.run.runId !== session.run.runId ||",
    test: '^keeps original automatic A2A notification eligibility after same-target confirmation',
    reason: 'confirmed same-target binding must retain automatic original-MID eligibility' }
]
export function transformNativeMainConfirmationSource(source, path, mutation) {
  if (!mutation) return source
  const change = nativeMainConfirmationMutations.find(item => item.name === mutation)
  if (!change) throw Error('Unknown native-main confirmation mutation: ' + mutation)
  if (path !== change.path) return source
  if (source.split(change.before).length !== 2) throw Error('Missing or ambiguous native-main mutation anchor: ' + mutation)
  return source.replace(change.before, change.after)
}
