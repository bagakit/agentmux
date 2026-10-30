import { dequal } from 'dequal'
import type { AgentMuxAgentCreationInspection } from './types.js'
import type { AgentMuxSpatialStateStore } from './spatial-state.js'
import { moteMainBaseline, moteMainBindingDefaults, moteMainBindingInput, moteMainCreatedReference, retainedMoteMainBindingReceipt, sameMoteMainBaseline, spatialAgentOpenRecord, type MoteMainBindingObservation } from './spatial-agent-open-contract.js'
import { moteQuickBaseline, sameMotePreferencesTarget, sameMoteQuickDefaults, type MoteQuickPreferencesReadInput, type MoteQuickPreferencesReadResult, type MoteQuickPreferencesSaveParams, type MoteQuickPreferencesSaveResult } from './mote-preferences.js'
import type { MoteDialoguePage, MoteDialogueRead, MoteDialogueReceipt, MoteDialogueWrite, MoteMainSetupRequest, MoteMainSetupResult } from './mote-dialogue-contract.js'

/** Composition over the original admission, Session, dialogue and Files owners. No new durable owner. */
export async function reconcileMoteMainSetup(input: MoteMainSetupRequest, advance: boolean, ports: {
  spatial: AgentMuxSpatialStateStore
  creation(hostId: string, sessionId: string): Promise<AgentMuxAgentCreationInspection>
  read(input: MoteQuickPreferencesReadInput): Promise<MoteQuickPreferencesReadResult>
  save(input: MoteQuickPreferencesSaveParams): Promise<MoteQuickPreferencesSaveResult>
  sources(input: MoteDialogueRead): Promise<MoteDialoguePage>
  link(input: MoteDialogueWrite): Promise<MoteDialogueReceipt>
  assertCurrent(): Promise<void>
}): Promise<MoteMainSetupResult> {
  const result: MoteMainSetupResult = { operationId:input.creation.operationId,ownerHostId:input.creation.hostId,record:null,reference:null,
    creation:'unconfirmed',source:'unconfirmed',binding:'unconfirmed',issue:null,bindingReceipt:null,bindingObserved:null }
  try {
    const state = await ports.spatial.read(), record = state && spatialAgentOpenRecord(state.graph,input.creation.operationId)
    if (!record?.moteMain || !sameMotePreferencesTarget(record.moteMain.target,input.target)) throw new Error('The exact original Main admission and Mote target are unconfirmed. Keep the original Agent and request.')
    result.record = record; result.reference = moteMainCreatedReference(record)
    result.bindingReceipt = record.moteMainFollowUps?.bindingReceipt ?? null
    result.bindingObserved = record.moteMainFollowUps?.bindingObserved ?? null
    if (result.bindingReceipt) result.binding = result.bindingReceipt.status === 'saved' || result.bindingReceipt.status === 'unchanged' ? 'confirmed' : result.bindingReceipt.status === 'refused-before-write' ? 'refused' : 'unconfirmed'
    if (result.bindingObserved) result.binding = 'confirmed'
    const intent = record.moteMain, created = await ports.creation(record.execution.hostId,record.agentSessionId)
    if (created.kind !== 'agent' || created.agentSessionId !== record.agentSessionId || created.creation?.createOperationId !== record.requestId ||
      created.executorId !== record.executorId || created.workspacePath !== record.execution.workspacePath || !created.run.runId ||
      created.creation.persistence === 'unconfirmed' || created.creation.failure) throw new Error('The original Core Agent creation is unconfirmed. Its Session and reserved workface are retained.')
    result.creation = 'confirmed'; result.reference = moteMainCreatedReference(record)
    const region = state!.graph.regions.find(value => value.tabId === record.address.tabId && value.regionId === record.address.regionId)
    if (region?.kind !== 'agent' || region.agentSessionId !== record.agentSessionId || region.execution?.hostId !== record.execution.hostId ||
      record.address.spaceId !== intent.target.spaceId || record.address.zoneId !== intent.target.zoneId) throw new Error('The created Agent is available, but its original Mote placement is unconfirmed. Keep this exact Agent.')
    const old = intent.baseline.defaults.conversation
    if (old) {
      const matches = (links: MoteDialogueReceipt['links']) => links.some(link => link.kind === 'main' && link.operationId === intent.sourceOperationId && link.roleRevision === intent.expectedRoleRevision && dequal(link.reference,old))
      let confirmed = matches((await ports.sources({target:intent.target,operationId:intent.sourceOperationId})).links)
      if (!confirmed && advance && !record.moteMainFollowUps?.bindingReceipt && !record.moteMainFollowUps?.bindingObserved && !record.moteMainFollowUps?.refusedBeforeBinding) {
        await ports.assertCurrent()
        const claimed = await ports.spatial.claimMoteMainFollowUp({requestId:record.requestId,step:'source'})
        result.record = claimed.record
        if (claimed.claimed) { await ports.assertCurrent(); confirmed = matches((await ports.link({target:intent.target,operationId:intent.sourceOperationId,expectedRoleRevision:intent.expectedRoleRevision!,source:{kind:'main'}})).links) }
      }
      result.source = confirmed ? 'confirmed' : 'unconfirmed'
    } else result.source = 'not-needed'
    const original = result.record!
    result.bindingReceipt = original.moteMainFollowUps?.bindingReceipt ?? null
    result.bindingObserved = original.moteMainFollowUps?.bindingObserved ?? null
    if (result.bindingReceipt) {
      result.binding = result.bindingReceipt.status === 'saved' || result.bindingReceipt.status === 'unchanged' ? 'confirmed' : result.bindingReceipt.status === 'refused-before-write' ? 'refused' : 'unconfirmed'
      result.issue = result.bindingReceipt.message
      if (result.binding !== 'unconfirmed') return result
    }
    if (result.bindingObserved) { result.binding = 'confirmed'; return result }
    // A writer-derived role or its original journal can reconcile a lost ACK, including an independent CLI save.
    const read = await ports.read({kind:'quick',target:intent.target}), baseline = moteQuickBaseline(read), expected = moteMainBindingDefaults(record)
    let observed: MoteMainBindingObservation | null = read.status === 'ready' && baseline && sameMoteQuickDefaults(baseline.defaults,expected) ? {kind:'preferences',source:moteMainBaseline(baseline)} : null
    if (!observed) {
      const sources = await ports.sources({target:intent.target,operationId:intent.bindOperationId})
      const saved = sources.links.find(link => link.kind === 'main' && link.operationId === intent.bindOperationId && link.roleRevision === expected.conversationRevision && dequal(link.reference,result.reference))
      if (saved?.kind === 'main') observed = {kind:'source',operationId:saved.operationId,file:saved.file,reference:saved.reference,roleRevision:saved.roleRevision}
    }
    if (observed) {
      result.binding = 'confirmed'; result.bindingObserved = observed
      if (advance) { await ports.assertCurrent(); result.record = await ports.spatial.observeMoteMainBinding(record.requestId,observed) }
      return result
    }
    if (original.moteMainFollowUps?.refusedBeforeBinding) { result.binding = 'refused'; result.issue = 'The original MOTE settings changed before binding was submitted. The created Agent is kept; review it in settings or begin a new action from the current source.'; return result }
    if (result.source === 'unconfirmed') throw new Error('The old Main source association is unconfirmed. Inspect its original operation before binding the available new Agent.')
    if (!advance || original.moteMainFollowUps?.bindStarted) throw new Error('The original Main binding is unconfirmed. Inspect this same operation without saving again or replacing a later Main.')
    if (read.status !== 'ready' || !baseline) throw new Error('The original binding source cannot currently be read. The created Agent and request are retained.')
    await ports.assertCurrent()
    if (!sameMoteMainBaseline(intent.baseline,moteMainBaseline(baseline))) {
      const refused = await ports.spatial.claimMoteMainFollowUp({requestId:record.requestId,step:'binding',baselineChanged:moteMainBaseline(baseline)})
      result.record = refused.record; result.binding = 'refused'; result.issue = 'The original MOTE settings changed before binding was submitted. The created Agent is kept; review it in settings.'; return result
    }
    const binding = moteMainBindingInput(record,baseline), claimed = await ports.spatial.claimMoteMainFollowUp({requestId:record.requestId,step:'binding'})
    result.record = claimed.record
    if (!claimed.claimed) throw new Error('The original binding was already dispatched. Inspect it without saving again.')
    await ports.assertCurrent()
    const saved = await ports.save(binding)
    result.bindingReceipt = retainedMoteMainBindingReceipt(record,saved)
    result.binding = saved.status === 'saved' || saved.status === 'unchanged' ? 'confirmed' : saved.status === 'refused-before-write' ? 'refused' : 'unconfirmed'; result.issue = saved.message
    try {
      await ports.assertCurrent()
      await ports.spatial.recordMoteMainBindingResult(binding,saved)
      result.record = spatialAgentOpenRecord((await ports.spatial.read())!.graph,record.requestId)
      result.bindingReceipt = result.record?.moteMainFollowUps?.bindingReceipt ?? result.bindingReceipt
    } catch (cause) { result.issue = [result.issue,'The original binding receipt retention is unconfirmed: ' + String(cause)].filter(Boolean).join('\n') }
  } catch (cause) { result.issue = cause instanceof Error ? cause.message : String(cause) }
  return result
}
