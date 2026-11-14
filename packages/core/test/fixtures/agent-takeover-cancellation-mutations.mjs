import { createHash } from 'node:crypto'
const variants = {
  'skip-cancellation-pair': {path:'packages/core/src/client.ts',edits:[
    ['    if (actual !== expected) throw new AgentMuxError(', '    if (false && actual !== expected) throw new AgentMuxError('],
    ['    for (const reservation of [closed, correlation]) {', '    for (const reservation of []) {']]},
  'missing-core-is-cancelled': {path:'packages/core/src/client.ts',edits:[["    return unknown(issue ?? (pending?.preparedDispatch ? 'The original prepared Start has not been confirmed fenced or retained. Inspect this same cancellation.'\n      : 'Future original creation and initial input are held; missing Core history does not confirm whether an earlier Native Start occurred. Inspect this same cancellation.'))\n","    return {cancellation,outcome:'cancelled',run:null,initialInput:'held',diskDurability:acknowledged?'confirmed':'unconfirmed',issue:null}\n"]]},
  'missing-private-is-held': {path:'packages/core/src/client.ts',edits:[["        initialInput: confirmed ? 'already-dispatched' : notDispatched || notRequested ? 'held' : 'unknown',", "        initialInput: 'held',"]]},
  'skip-input-claim-fence': {path:'packages/core/src/agent-session-store.ts',edits:[['  if (cancellation && newPromptClaim(previous, next)', '  if (false && cancellation && newPromptClaim(previous, next)']]},
  'skip-source-admission': { path:'packages/core/src/spatial-agent-open.ts', edits:[['  const cancelled = takeoverCancellationRecord(graph, input.request.requestId)', '  const cancelled = null']] },
  'skip-start-fence': { path:'packages/core/src/client.ts', edits:[['      await this.assertCreationNotCancelled(createOperationId)\n','']] },
  'skip-initial-input-hold': { path:'packages/core/src/client.ts', edits:[
    ['    if (original.creation?.createOperationId) await this.assertCreationNotCancelled(original.creation.createOperationId)\n',''],
    ['    if (current.creation?.createOperationId && await this.store.readCreationCancellation(current.creation.createOperationId)) return current\n','']], also:{path:'packages/core/src/agent-session-store.ts',edits:[['  if (cancellation && newPromptClaim(previous, next)', '  if (false && cancellation && newPromptClaim(previous, next)']]} },
  'skip-binding-fence': { path:'packages/core/src/agent-execution-coordinator.ts', edits:[[
    '    if (this.read(bindingId)?.cancellation) throw fail(', '    if (false && this.read(bindingId)?.cancellation) throw fail(']] },
  'forget-execution-control': { path:'packages/core/src/agent-session-store.ts', edits:[[
    "      const row = db.prepare('SELECT json FROM creation_cancellations WHERE creation_operation=?').get(createOperationId)", "      const row = db.prepare('SELECT json FROM creation_cancellations WHERE creation_operation=? AND 0').get(createOperationId)" ]] },
}
export function cancellationSource(path, source, mutation) {
  let loaded=source, changed=false
  const variant=variants[mutation]
  if(mutation&&!variant)throw Error('Unknown cancellation mutation: '+mutation)
  const target=variant?.path===path?variant:variant?.also?.path===path?variant.also:undefined
  if(target){
    for(const [before,after] of target.edits){if(!loaded.includes(before))throw Error('Cancellation mutation did not match its actual owner: '+mutation);loaded=loaded.split(before).join(after)}
    changed=loaded!==source
  }
  return {loaded,receipt:{path,mutation:mutation??null,applied:changed,sourceSHA256:createHash('sha256').update(source).digest('hex'),loadedSHA256:createHash('sha256').update(loaded).digest('hex')}}
}
