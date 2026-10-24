import { createHash } from 'node:crypto'
export const executorRecoveryMutations = {
  'resume-forwarded-to-desktop': { path: 'packages/core/src/public-rpc-service.ts',
    before: 'this.ports.forwardControl && !independentResume &&', after: 'this.ports.forwardControl &&',
    target: 'session configuration reaches the default Host through original agent.open, RPC and CLI across Host restart' },
  'host-reader-omitted': { path: 'apps/host/src/host.ts',
    before: "...(configurationPath ? { sessionExecutorConfiguration: (executorId: string) => readConfiguredExecutor(configurationPath, executorId) } : {}),",
    after: '', target: 'session configuration reaches the default Host through original agent.open, RPC and CLI across Host restart' },
  'reader-ignored': { path: 'packages/core/src/client.ts', before: 'config = await this.sessionExecutorConfiguration(session.executorId)',
    after: 'config = (await this.hostExecutorOwner!.resolve(session.executorId)).config', target: 'session configuration unreadable retains the original identity without fallback' },
  'target-owner-replaced': { path: 'packages/core/src/client.ts', before: 'if (!targetOwned && this.sessionExecutorConfiguration) {',
    after: 'if (this.sessionExecutorConfiguration) {', target: 'session configuration does not replace target-owned registry authority' },
  'provider-conflict-ignored': { path: 'packages/core/src/client.ts', before: 'if (config.providerId !== session.providerId) throw new AgentMuxError',
    after: 'if (false) throw new AgentMuxError', target: 'session configuration provider-conflict retains the original identity without fallback' },
  'callback-only-owner-rejected': { path: 'packages/core/src/agent-session-recovery/continuity-attempt.ts',
    before: 'if (!ports.executors.hostExecutorOwner && (current.creation?.executorRevision || !ports.executors.sessionExecutorConfiguration))',
    after: 'if (!ports.executors.hostExecutorOwner)', target: 'session configuration supports a standalone owner and its automatic context-only retry' }
}
export function instrumentExecutorRecovery(source, path, surface) {
  if (!/^(?:packages\/core|apps\/host)\/src\/.+\.(?:ts|mjs)$/u.test(path)) return source
  const original = source, mutant = process.env.SESSION_EXECUTOR_MUTANT
  if (mutant && !Object.hasOwn(executorRecoveryMutations, mutant)) throw Error('Unknown Session executor mutation')
  const mutation = mutant && executorRecoveryMutations[mutant]
  if (mutation && mutation.path === path) {
    if (source.split(mutation.before).length !== 2) throw Error('Session executor mutation requires one exact owning expression: ' + mutant)
    source = source.replace(mutation.before, mutation.after)
  }
  if (process.env.SESSION_EXECUTOR_LOADED) {
    const hash = value => createHash('sha256').update(value).digest('hex')
    const row = { path, surface, originalSHA256: hash(original), loadedSHA256: hash(source), ...(source === original ? {} : { mutant }) }
    const witness = "import { appendFileSync as __executorEvaluated } from 'node:fs'; __executorEvaluated(" + JSON.stringify(process.env.SESSION_EXECUTOR_LOADED) + ',' + JSON.stringify(JSON.stringify(row) + '\n') + ');\n'
    const offset = source.startsWith('#!') ? source.indexOf('\n') + 1 : 0
    source = source.slice(0, offset) + witness + source.slice(offset)
  }
  return source
}
