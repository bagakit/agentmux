import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { bundleIdentityRuntime } from '../../../packages/identity/scripts/runtime-bundle.mjs'
import { workspaceSourceExport } from '../../../packages/core/test/helpers/workspace-source-export.mjs'
import { bundlePrivateNodeSource } from '../../../packages/core/test/helpers/private-node-source-bundle.mjs'

export const goalOwnerIdentitySource = '.local/state/mobile-independent-host/review-remediation/goal-owner-recovery/source-runtime/identity-runtime-source.mjs'
export async function prepareGoalOwnerIdentity(root) {
  const file = resolve(root, goalOwnerIdentitySource)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, 'export const identityRuntimeSource = ' + JSON.stringify((await bundleIdentityRuntime()).source) + ';\n')
}
/** Resolve only declared workspace exports to their source, never local dist. */
export function goalOwnerRecoverySource(root, specifier) {
  if (specifier === '@agentmux/identity/runtime-source') return resolve(root, goalOwnerIdentitySource)
  return workspaceSourceExport(root, specifier)
}

/** Compile the original Store and its declared source dependencies once; the
 * independent process executes that Store, without cold-loading the Core barrel. */
export async function bundleGoalOwnerStoreReader(root, directory) {
  await mkdir(directory, { recursive: true })
  const entry = resolve(directory, 'entry.mjs'), file = resolve(directory, 'reader.mjs')
  await writeFile(entry, "import { ContinuousProgressLoopStore } from '@agentmux/host/continuous-progress-loop-store';\nconsole.log(JSON.stringify({ pid: process.pid, loops: await ContinuousProgressLoopStore.forUserData(process.argv[2]).load() }));\n")
  return bundlePrivateNodeSource({ root, entry, file, sourceExport: id => goalOwnerRecoverySource(root, id),
    instrument: (original, path) => instrumentGoalOwnerRecovery(original, path, 'node-process') })
}

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
    '// Confirmed original owner updates cancel any in-flight input synchronously.\n        queueMicrotask(() => this.cancelDelivery(loop.loopId))']] },
  'directory-sync-ack-omitted': { pattern: 'after-replace directory sync uncertainty', edits: [['apps/host/src/continuous-progress-loop-store.ts',
    'durableWriteFile(this.path, content, { requireDirectorySync: true })', 'durableWriteFile(this.path, content)']] }
}
export const goalOwnerRecoverySources = [manager, ...observers,
  'apps/host/src/goals.ts', 'apps/host/src/goal-runtime.ts', 'apps/host/src/continuous-progress-loop-store.ts',
  'apps/host/src/continuous-progress-task-source.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/src/continuous-progress-scheduler.ts', 'packages/core/src/agent-progress.ts', 'packages/core/src/durable-write.ts',
  'packages/demand/src/demand-store.ts', 'packages/demand/src/demand-types.ts',
  'packages/identity/src/index.ts', goalOwnerIdentitySource,
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
