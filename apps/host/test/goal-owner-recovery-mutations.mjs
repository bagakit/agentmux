import { createHash } from 'node:crypto'

const manager = 'apps/host/src/continuous-progress-loop-manager.ts'
const observers = ['goal-delegation-attention', 'goal-start-responsibility', 'goal-responsibility-owner', 'goal-patrol-owner'].map(name => `apps/host/src/${name}.ts`)
export const goalOwnerRecoveryMutations = {
  'memory-ack': { pattern: 'public create retries', edits: [[manager,
    '          await this.persist(original.loopId)\n          return { loop: this.require(original.loopId), diskDurability:',
    '          return { loop: this.require(original.loopId), diskDurability:']] },
  'startup-rejection-latched': { pattern: 'repaired load|failed startup saves', edits: [[manager,
    'if (this.started === starting) this.started = undefined', 'if (false && this.started === starting) this.started = undefined']] },
  'unrelated-index-scan': { pattern: 'without reading unrelated published history|Goal progress reads only', edits: [
    ...observers.map(path => [path, 'const complete = this.revision < 0 || !changes || snapshot.revision !== this.revision + 1', 'const complete = true']),
    [manager, 'for (const loopId of this.goalLoops.get(goalId) ?? [])', "for (const loopId of this.list().filter(loop => loop.taskSource?.kind === 'goal' && loop.taskSource.goalId === goalId).map(loop => loop.loopId))"]] },
  'cancellation-delayed': { pattern: 'same local mutation delivery', edits: [[manager,
    '// Confirmed original owner updates cancel any in-flight input synchronously.\n        this.cancelDelivery(loop.loopId)',
    '// Confirmed original owner updates cancel any in-flight input synchronously.\n        queueMicrotask(() => this.cancelDelivery(loop.loopId))']] }
}
export const goalOwnerRecoverySources = [manager, ...observers,
  'apps/host/src/goals.ts', 'apps/host/src/goal-runtime.ts', 'apps/host/src/continuous-progress-loop-store.ts',
  'apps/host/src/continuous-progress-task-source.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/src/continuous-progress-scheduler.ts', 'packages/core/src/agent-progress.ts', 'packages/core/src/durable-write.ts',
  'packages/demand/src/demand-store.ts', 'packages/demand/src/demand-types.ts',
  'apps/host/test/goal-owner-recovery.test.ts', 'apps/host/test/goal-owner-changes.test.ts']
const observed = new Set(goalOwnerRecoverySources)
export function instrumentGoalOwnerRecovery(source, path, surface) {
  if (!observed.has(path)) return source
  const original = source, mutant = process.env.AGENTMUX_GOAL_OWNER_RECOVERY_MUTANT
  if (mutant && !Object.hasOwn(goalOwnerRecoveryMutations, mutant)) throw Error('Unknown Goal owner recovery mutation')
  let applied = false
  for (const [target, anchor, replacement] of goalOwnerRecoveryMutations[mutant]?.edits ?? []) if (path === target) {
    if (source.split(anchor).length !== 2) throw Error('Goal recovery mutation requires exactly one original source anchor: ' + mutant + ':' + path)
    source = source.replace(anchor, replacement); applied = true
  }
  const report = process.env.AGENTMUX_GOAL_OWNER_RECOVERY_LOADED
  if (report) {
    const hash = value => createHash('sha256').update(value).digest('hex')
    const record = { path, surface, originalSHA256: hash(original), loadedSHA256: hash(source), ...(applied ? { mutant } : {}) }
    source = "import { appendFileSync as __goalRecoveryEvaluated } from 'node:fs'; __goalRecoveryEvaluated(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(record) + '\n') + ');\n' + source
  }
  return source
}
