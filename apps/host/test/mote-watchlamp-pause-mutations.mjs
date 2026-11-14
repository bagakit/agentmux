import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const manager = 'apps/host/src/continuous-progress-loop-manager.ts', core = 'packages/core/src/continuous-progress-scheduler.ts'
const mutations = {
  'manual-reason': [manager, "pauseReason: ContinuousProgressPauseReason = 'manual')", "pauseReason: ContinuousProgressPauseReason = 'input-unconfirmed')"],
  'refresh-onset': [manager, "if (loop.status === 'active') return { reason, episodeId: mintObjectId(), pausedAt: this.now() }", "if (loop.status !== 'stopped') return { reason, episodeId: mintObjectId(), pausedAt: this.now() }"],
  'late-unknown': [manager, "if (current.status === 'active') this.pauseWithReason(current.loopId, 'input-unconfirmed')", "this.patch(current.loopId, { status: 'paused', pause: { reason: 'input-unconfirmed', episodeId: mintObjectId(), pausedAt: this.now() } })"],
  'restart-unknown': [manager, "pause: this.pauseFacts(loop, 'input-unconfirmed')", "pause: this.pauseFacts(loop, 'manual')"],
  'legacy-fabrication': [manager, "const loops = (await this.store.load()).map((loop) => loop.pendingCompletion", "const loops = (await this.store.load()).map(loop => loop.status === 'paused' ? { ...loop, pause: { reason: 'input-unconfirmed', episodeId: mintObjectId(), pausedAt: this.now() } } : loop).map((loop) => loop.pendingCompletion"],
  'resume-stale': [manager, "const { lastDecision: _, pause: __, ...loop } = this.scheduler.resume(loopId)", "const { lastDecision: _, ...loop } = this.scheduler.resume(loopId)"],
  'codec-reason': [core, "!['manual', 'source-disabled', 'source-changed', 'execution-ended', 'preparation', 'input-unconfirmed', 'persistence-unconfirmed', 'timing-unrepresentable'].includes(p.reason)", 'false'],
  'codec-pair': [core, "(p.episodeId === undefined) !== (p.pausedAt === undefined)", 'false'],
  'internal-manual': ['apps/host/src/mote-presence.ts', "undefined, 'source-disabled')", "undefined, 'manual')"]
}
export function instrumentWatchlamp(code, path, loader) {
  if (![manager, core, 'packages/core/src/public-rpc-schedules.ts', 'apps/host/src/mote-presence.ts', 'apps/host/src/continuous-progress-loop-store.ts', 'apps/host/src/host.ts'].includes(path)) return code
  const original = code, mutant = process.env.MOTE_WATCHLAMP_MUTANT
  if (mutant && !Object.hasOwn(mutations, mutant)) throw Error('Unknown watchlamp mutation: ' + mutant)
  const spec = mutations[mutant]
  if (spec?.[0] === path) {
    // A repeated default parameter is intentionally narrowed to the public call declaration.
    const anchor = mutant === 'manual-reason' ? "async call<M extends ScheduleMethod>(method: M, input: ScheduleParamsMap[M], context?: AgentMuxRpcCallContext, " + spec[1] : spec[1]
    const replacement = mutant === 'manual-reason' ? "async call<M extends ScheduleMethod>(method: M, input: ScheduleParamsMap[M], context?: AgentMuxRpcCallContext, " + spec[2] : spec[2]
    if (code.split(anchor).length !== 2) throw Error('Mutation must affect exactly one original owner: ' + mutant)
    code = code.replace(anchor, replacement)
  }
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  if (process.env.MOTE_WATCHLAMP_LOADS) appendFileSync(process.env.MOTE_WATCHLAMP_LOADS, JSON.stringify({ path, loader, pid: process.pid, rawSHA256: hash(readFileSync(resolve(root,path))), originalSHA256: hash(original), loadedSHA256: hash(code), ...(original === code ? {} : { mutant }) }) + '\n')
  return code
}
