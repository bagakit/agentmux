export const managedNotificationMutations = [
  { name: 'managed-direct-send-blocked', file: 'packages/core/src/public-rpc-service.ts',
    before: "const referenceIntake = Boolean(caller && (original ? original.deliveryMode === 'reference' : !terminalManual))",
    after: "const referenceIntake = Boolean(caller && (!original || original.deliveryMode === 'reference'))",
    test: '^source CLI preserves ordinary' },
  { name: 'selected-mid-first-only', file: 'packages/core/src/client.ts',
    before: 'if (originals.some(original => !original || original.senderSessionId !== caller.agentSessionId && original.recipientSessionId !== caller.agentSessionId))',
    after: 'if (originals.slice(0, 1).some(original => !original || original.senderSessionId !== caller.agentSessionId && original.recipientSessionId !== caller.agentSessionId))',
    test: '^permits the original receiver' },
  { name: 'notification-input-authority-dropped', file: 'packages/core/src/client.ts',
    before: "this.inputCallAuthority(authority, context), 'prompt', undefined, undefined, notice)",
    after: "this.inputCallAuthority(undefined, context), 'prompt', undefined, undefined, notice)",
    test: '^rechecks caller capability' },
  { name: 'managed-notify-category-blocked', file: 'packages/core/src/public-rpc-service.ts',
    before: "if (!caller && (!context.principal || !['user', 'device'].includes(context.principal.kind))) throw new AgentMuxError(\n          'Notification operations require an authenticated Agent participant or trusted user/device.'",
    after: "if (caller || !context.principal || !['user', 'device'].includes(context.principal.kind)) throw new AgentMuxError(\n          'Notification operations require an authenticated Agent participant or trusted user/device.'",
    test: '^source CLI notifies an existing MID' }
]

export function transformManagedNotificationSource(source, file, name) {
  if (!name) return source
  const mutation = managedNotificationMutations.find(item => item.name === name)
  if (!mutation) throw new Error('Unknown managed notification mutation: ' + name)
  if (file !== mutation.file) return source
  if (source.split(mutation.before).length !== 2) throw new Error('Mutation must target exactly one loaded production branch: ' + name)
  return source.replace(mutation.before, mutation.after)
}
