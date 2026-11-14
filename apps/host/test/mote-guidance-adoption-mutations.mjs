const manager = 'apps/host/src/continuous-progress-loop-manager.ts'
const runtime = 'apps/host/src/goal-runtime.ts'
export const guidanceMutants = [
  { id: 'pending-input-overwritten', file: manager, from: 'if (loop.pendingCompletion) {\n            await save', to: 'if (false) {\n            await save', test: 'paused state, its original episode' },
  { id: 'paused-intent-activated', file: manager, from: "const activating = loop.status === 'active', revision = loop.revision", to: 'const activating = true, revision = loop.revision', test: 'legacy unknown without a pending input' },
  { id: 'old-due-reused', file: manager, from: 'nextIntervalOccurrence(loop.nextCheckAt, publishedAt, loop.everyMs!)', to: 'loop.nextCheckAt', also: ['nextCheckAt === null || nextCheckAt <= publishedAt', 'nextCheckAt === null'], test: 'legacy unknown without a pending input' },
  { id: 'creation-op-used-for-new-definition', file: runtime, from: 'const operationId = loop.currentDefinition?.operationId ?? loop.creationOperationId\n      if (loop.currentDefinition &&', to: 'const operationId = loop.creationOperationId\n      if (loop.currentDefinition &&', test: 'actual preferences CLI adopts' },
  { id: 'previous-guide-stacked', file: manager, from: 'baseIntentId: loop.currentDefinition?.baseIntentId ?? loop.futureIntentId', to: 'baseIntentId: loop.currentDefinition?.intentId ?? loop.futureIntentId', test: 'a second guide uses' },
  { id: 'late-activation-signs-adopted', file: manager, from: 'if (current.status !== status || current.revision !== revision || !isDeepStrictEqual(definition(current), definition(selected)))', to: 'if (false)', test: 'a late activation ACK cannot undo a later pause' },
  { id: 'old-claim-not-cancelled', file: manager, from: 'this.cancelDelivery(loop.loopId)\n          await this.checks.get(loop.loopId)', to: 'await Promise.resolve()\n          await this.checks.get(loop.loopId)', test: 'adoption fences an already claimed' },
  { id: 'notes-edit-blocks-original-reconciliation', file: 'apps/host/src/mote-quick-preferences.ts', from: 'if (!sameBaseline && !(input.action && sameResource && sameControls))', to: 'if (!sameBaseline)', test: 'a published original operation remains reconcilable' },
  { id: 'old-grant-activates-after-later-control', file: manager, from: "if (loop.status === 'stopped' || loop.revision !== adoption!.expectedRevision + 1)", to: 'if (false)', test: 'a later explicit update' },
  { id: 'second-disk-failure-loses-receipt', file: manager, from: 'catch { /* The original IDs and uncertainty already remain in memory. */ }', to: 'catch (error) { throw error }', test: 'continuous Host persistence failure' },
  { id: 'final-receipt-read-rewrites-disk', file: manager, from: '// Reading the original terminal receipt is not another persistence or', to: 'await this.persist(loop.loopId)\n        // Reading the original terminal receipt is not another persistence or', test: 'continuous Host persistence failure' },
  { id: 'lost-return-claims-prewrite-refusal', file: 'apps/host/src/mote-quick-preferences.ts', from: 'dispatched = true\n        const maintenanceAdoption', to: 'dispatched = false\n        const maintenanceAdoption', test: 'an unexpected lost adoption return' },
  { id: 'core-activation-before-host-durability', file: manager, from: 'if (adoption!.publishedAt !== undefined) await this.persist(loop.loopId)', to: 'await Promise.resolve()', test: 'continuous Host persistence failure' },
]
export function instrumentGuidance(code, file) {
  const mutant = guidanceMutants.find(value => value.id === process.env.MOTE_GUIDANCE_MUTANT && value.file === file)
  if (!mutant) return code
  if (code.split(mutant.from).length !== 2) throw Error('Guidance mutant source drift: ' + mutant.id)
  let result = code.replace(mutant.from, mutant.to)
  if (mutant.also) {
    if (result.split(mutant.also[0]).length !== 2) throw Error('Guidance mutant secondary source drift')
    result = result.replace(mutant.also[0], mutant.also[1])
  }
  return result
}
