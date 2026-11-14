import { createHash } from 'node:crypto'
export const reliabilityMutants = {
  'core-prepare-unknown': ['packages/core/src/prompt-submission.ts', 'if (nativeClaimAttempted) return error', 'return error; if (nativeClaimAttempted) return error'],
  'core-forget-claim': ['packages/core/src/prompt-submission.ts', 'nativeClaimAttempted = true\n      beginClaim()', 'nativeClaimAttempted = false\n      beginClaim()'],
  'stale-claim-clock': ['apps/host/src/continuous-progress-loop-manager.ts', 'if (now === undefined) { checkAt = Math.max(checkAt, this.now()); refreshLatest() }', 'if (false) { checkAt = Math.max(checkAt, this.now()); refreshLatest() }'],
  'creation-never-retries': ['apps/host/src/mote-presence.ts', "else if (loop.status === 'paused' && loop.lastOutcome === 'unknown' && !loop.lastTickId && !loop.pendingCompletion && !loop.lastMutation)", 'else if (false)'],
  'final-read-unknown': ['apps/host/src/continuous-progress-delivery.ts', "throw loop.lastOutcome === 'unknown' ? error : new AutomaticInputNotDispatchedError(error)", 'throw error'],
  'serial-due': ['apps/host/src/continuous-progress-loop-manager.ts', 'const previous = this.targetChecks.get(target)', 'const previous = Promise.allSettled([...this.checks.values()]).then(() => {})'],
  'same-target-parallel': ['apps/host/src/continuous-progress-loop-manager.ts', 'const previous = this.targetChecks.get(target)', 'const previous = undefined'],
  'duplicate-tick': ['apps/host/src/continuous-progress-loop-manager.ts', 'if (existing) return Promise.resolve()', 'if (false && existing) return Promise.resolve()'],
  'core-wait-stalls': ['apps/host/src/goal-runtime.ts', 'return automation ? awaitUntilCancelled(dispatch, automation.signal) : dispatch()', 'return dispatch()'],
  'core-boundary': ['apps/host/src/goal-runtime.ts', 'if (automation && !dispatchStarted) throw new AutomaticInputNotDispatchedError(error)', 'if (automation) throw new AutomaticInputNotDispatchedError(error)'],
  'forget-unknown': ['apps/host/src/continuous-progress-loop-manager.ts', 'let dispatched = Boolean(pending)', 'let dispatched = false'],
  'claim-pauses': ['apps/host/src/continuous-progress-loop-manager.ts', "status: claim.loop.managedSource && !claim.loop.pendingCompletion ? this.require(claim.loop.loopId).status : 'paused'", "status: 'paused'"],
  'maintenance-shared-lock': ['apps/host/src/mote-presence.ts', 'if (targetChecks.has(id)) continue', 'if (targetChecks.size) continue']
}
export function instrumentReliability(original,path,surface) {
  const mutant=process.env.MOTE_RELIABILITY_MUTANT, report=process.env.MOTE_RELIABILITY_LOADED
  if(mutant && !Object.hasOwn(reliabilityMutants,mutant))throw Error('Unknown reliability mutant '+mutant)
  const selected=mutant&&reliabilityMutants[mutant]
  let source=original
  if(selected&&selected[0]===path){
    if(source.split(selected[1]).length!==2)throw Error('Reliability mutation must modify exactly one loaded production boundary: '+mutant)
    source=source.replace(selected[1],selected[2])
  }
  const owned=path==='packages/core/src/prompt-submission.ts'||/^apps\/host\/src\/(continuous-progress-loop-manager|continuous-progress-delivery|goal-runtime|mote-presence|await-until-cancelled|automatic-input-not-dispatched|goals|host)\.ts$/u.test(path)
  if(report&&owned){
    const hash=s=>createHash('sha256').update(s).digest('hex')
    const fact={path,surface,originalSHA256:hash(original),loadedSHA256:hash(source),...(source!==original?{mutant}:{})}
    source="import { appendFileSync as __reliabilityFact } from 'node:fs'; __reliabilityFact("+JSON.stringify(report)+', '+JSON.stringify(JSON.stringify(fact)+'\n')+');\n'+source
  }
  return source
}
