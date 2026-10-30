import { isDeepStrictEqual } from 'node:util'
import { sameMotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { spatialAgentOpenDocument, spatialAgentOpenRecord } from '@agentmux/core/mote-dialogue'
import { moteMainCreatedReference, moteMainBindingDefaults } from '@agentmux/core/spatial-graph'
import { createHash } from 'node:crypto'
import type { ConversationCheckpoint } from '@agentmux/core/mote-dialogue'
import type { MoteMainTransitionMarker } from '@agentmux/core/mote-preferences'
import { AgentMuxError, spatialCatalog, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { moteMainRoleRevision, type MoteMainReader, type MoteMainSnapshot } from '@agentmux/core/mote-dialogue'
import type { MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { parseFileReadResult, type AgentMuxRpcFilesOwner } from '@agentmux/core/files'
import { parseMoteQuickMode, MOTE_QUICK_MODE_PATH, sameMoteDefaultConversation } from './mote-quick-mode.js'
import { readOriginalMoteConfiguration } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { homeZoneId } from './mote-model.js'

/** One original MOTE reader for dialogue, maintenance and input adapters. Reading never creates history. */
export function createHostMoteMainReader(options: {
  configurationPath: string
  spatial: AgentMuxSpatialStateStore
  files: AgentMuxRpcFilesOwner
}): MoteMainReader {
  async function readCurrentMoteMain(target: MotePreferencesTarget, signal?: AbortSignal): Promise<MoteMainSnapshot> {
    const snapshot: MoteMainSnapshot = { target, identity: null, status: 'unconfirmed', resource: null,
      documentRevision: null, roleRevision: null, current: null, issue: null }
    try {
      signal?.throwIfAborted()
      const state = await options.spatial.read()
      signal?.throwIfAborted()
      const catalog = state ? spatialCatalog(state.graph) : null
      const spaces = catalog?.spaces.filter(space => space.spaceId === target.spaceId && space.kind === 'mote') ?? []
      const space = spaces.length === 1 ? spaces[0] : undefined
      if (!space?.topicId || space.hostId !== target.expectedResource.hostId || target.zoneId !== homeZoneId(space.spaceId) ||
        !catalog?.bindings.some(binding => binding.spaceId === space.spaceId && binding.zoneId === target.zoneId))
        throw new Error('The original Mote resource identity is unconfirmed. Its saved references and healthy work remain available.')
      snapshot.identity = { hostId: space.hostId, moteId: space.topicId }
      const configuration = await readOriginalMoteConfiguration(options.configurationPath)
      signal?.throwIfAborted()
      const workspaces = configuration && typeof configuration === 'object' && 'workspaces' in configuration && Array.isArray(configuration.workspaces)
        ? configuration.workspaces : []
      const matches = workspaces.filter(workspace => workspace && typeof workspace === 'object' &&
        workspace.id === SCRATCH_WORKSPACE_ID && workspace.id === target.expectedResource.workspaceId &&
        workspace.hostId === target.expectedResource.hostId && workspace.path === target.expectedResource.workspacePath)
      if (matches.length !== 1) throw new Error('The original Mote Files resource is unconfirmed. Keep the original target and retry discovery.')
      const input = { ...target, path: MOTE_QUICK_MODE_PATH }
      const file = parseFileReadResult(await options.files.read(input), input)
      signal?.throwIfAborted()
      snapshot.resource = file.resource
      if (!file.resource) throw new Error('The original MOTE.md Files mapping is unconfirmed. Its role is not replaced.')
      if (file.result.status !== 'read') throw new Error('The original MOTE.md could not be read. Its current role is not replaced.')
      snapshot.documentRevision = file.result.document.revision
      const parsed = parseMoteQuickMode(file.result.document.content)
      if (parsed.status !== 'valid') throw new Error(parsed.message)
      snapshot.current = parsed.defaults.conversation ?? null
      snapshot.roleRevision = moteMainRoleRevision(parsed.defaults, snapshot.documentRevision)
      if(parsed.defaults.conversationTransition)snapshot.transition=parsed.defaults.conversationTransition
      snapshot.status = 'ready'
      return snapshot
    } catch (error) {
      signal?.throwIfAborted()
      snapshot.issue = error instanceof Error ? error.message : String(error)
      return snapshot
    }
  }
  const tails=new Map<string,Promise<void>>()
  return { readCurrentMoteMain, async withRole<T>(target:MotePreferencesTarget,work:()=>Promise<T>):Promise<T> {
    const key=JSON.stringify([target.spaceId,target.zoneId,target.expectedResource.hostId,target.expectedResource.workspaceId,target.expectedResource.workspacePath]),prior=tails.get(key)??Promise.resolve();let release!:()=>void
    const next=new Promise<void>(done=>{release=done});tails.set(key,next);await prior
    try{return await work()}finally{release();if(tails.get(key)===next)tails.delete(key)}
  }, async assertCurrent(original, signal) {
    const current = await readCurrentMoteMain(original.target, signal)
    if (original.status !== 'ready' || current.status !== 'ready' || !original.identity ||
      current.identity?.hostId !== original.identity.hostId || current.identity.moteId !== original.identity.moteId ||
      current.roleRevision !== original.roleRevision || !sameMoteDefaultConversation(current.current ?? undefined, original.current ?? undefined))
      throw new AgentMuxError('The exact original Mote role changed or is unconfirmed. Retain its original operations; no later Agent was controlled.', 'MOTE_MAIN_CHANGED')
  } }
}

import { MoteDialogueStore } from '@agentmux/core/mote-dialogue-store'
import { parseMoteDialogueParams, parseMoteDialogueResult, sameMoteDialogue, type MoteDialoguePort,
  type MoteDialogueCallContext, type MoteDialogueRead, type MoteDialogueWrite, type MoteDialogueLink } from '@agentmux/core/mote-dialogue'
import type { AgentMuxClient } from '@agentmux/core'

/** Compose original Files/space, source relationships and message owners; never send, restore or assign a role. */
export function createHostMoteDialogue(options: {
  main: MoteMainReader
  spatial: AgentMuxSpatialStateStore
  store: MoteDialogueStore
  clientForHost(hostId: string): Pick<AgentMuxClient, 'readMessage'> & Partial<Pick<AgentMuxClient,'conversationCheckpoint'>> | Promise<Pick<AgentMuxClient, 'readMessage'> & Partial<Pick<AgentMuxClient,'conversationCheckpoint'>>>
}): MoteDialoguePort & { prepareMainSource(before:MoteMainSnapshot, roleRevision:string, reference:import('@agentmux/core/mote-preferences').MoteDefaultConversation|null, operationId:string):Promise<MoteMainTransitionMarker>; recordMainSource(before: MoteMainSnapshot, after: MoteMainSnapshot, operationId: string): Promise<void> } {
  const mainSource = (snapshot: MoteMainSnapshot, associatedAt: number) => {
    if (snapshot.status !== 'ready' || !snapshot.identity || !snapshot.current || !snapshot.roleRevision || !snapshot.resource || !snapshot.documentRevision) return null
    return { kind: 'main' as const, roleRevision: snapshot.roleRevision, reference: snapshot.current, range: 'whole-session' as const,
      file: { resource: snapshot.resource, revision: snapshot.documentRevision }, associatedAt }
  }
  async function authorizeRead(snapshot: MoteMainSnapshot, context?: MoteDialogueCallContext) {
    const caller = context?.caller
    if (!caller) return
    if (snapshot.current?.hostId === caller.hostId && snapshot.current.sessionId === caller.agentSessionId) return
    const state = await options.spatial.read(), catalog = state ? spatialCatalog(state.graph) : null
    const zones = new Set(catalog?.bindings.filter(binding => binding.spaceId === snapshot.target.spaceId).map(binding => binding.zoneId))
    if (!catalog?.regions.some(region => region.kind === 'agent' && region.agentSessionId === caller.agentSessionId && region.execution?.hostId === caller.hostId &&
      catalog.tabs.some(tab => tab.tabId === region.tabId && tab.zoneId && zones.has(tab.zoneId) && tab.regionIds.includes(region.regionId))))
      throw new AgentMuxError('Only this Mote’s original participants may inspect its dialogue sources. Other conversations remain separate.', 'CONTROL_PERMISSION_DENIED')
  }
  return {
    mainInput: options.main,
    async prepareMainSource(before,roleRevision,reference,operationId) {
      if(!before.identity)throw new AgentMuxError('The original role identity is unconfirmed.','MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
      if(before.transition&&before.roleRevision)await options.store.confirmTransition(before.identity,before.transition,before.roleRevision,before.current)
      const intentDigest=createHash('sha256').update(JSON.stringify({before:{roleRevision:before.roleRevision,reference:before.current,document:before.documentRevision},after:{roleRevision,reference}})).digest('hex')
      const prior=await options.store.transition(before.identity,operationId,intentDigest);if(prior)return prior.marker
      const cut=async (source:typeof reference):Promise<ConversationCheckpoint|null>=>{
        if(!source)return null
        const client=await options.clientForHost(source.hostId)
        if(!client.conversationCheckpoint)throw new Error('The original conversation checkpoint owner is unavailable.')
        return (await client.conversationCheckpoint({hostId:source.hostId,agentSessionId:source.sessionId})).checkpoint
      }
      let beforeCut:ConversationCheckpoint|null=null,afterCut:ConversationCheckpoint|null=null,issue:string|null=null
      try {beforeCut=await cut(before.current)}catch(error){issue=String(error)}
      try {afterCut=await cut(reference)}catch(error){issue=[issue,String(error)].filter(Boolean).join('\n')}
      const graph=(await options.spatial.read())?.graph
      const admissions = graph ? Object.keys(spatialAgentOpenDocument(graph).requests)
        .map(id => spatialAgentOpenRecord(graph, id)!)
        .filter(record => {
          const intent = record.moteMain
          return intent?.bindOperationId === operationId && sameMotePreferencesTarget(intent.target, before.target) &&
            intent.expectedRoleRevision === before.roleRevision && intent.baseline.documentRevision === before.documentRevision &&
            isDeepStrictEqual(intent.baseline.resource, before.resource) &&
            sameMoteDefaultConversation(intent.baseline.defaults.conversation, before.current ?? undefined) &&
            sameMoteDefaultConversation(moteMainCreatedReference(record), reference ?? undefined) &&
            moteMainBindingDefaults(record).conversationRevision === roleRevision
        }) : []
      const admission = admissions.length === 1 ? admissions[0] : undefined
      const intent=admission?.moteMain
      const cause:import('@agentmux/core/mote-dialogue').MoteMainTransitionCause=intent?.rollover?{kind:'automatic',operationId,decision:intent.rollover}:{kind:!before.current?'initial':!reference?'clear':intent?.handover?'manual-takeover':'selection',operationId}
      const prepared=await options.store.prepareTransition({identity:before.identity,marker:{operationId,intentDigest,effectiveAt:Date.now()},before:{roleRevision:before.roleRevision,reference:before.current,...(before.resource&&before.documentRevision?{file:{resource:before.resource,revision:before.documentRevision}}:{})},after:{roleRevision,reference},beforeCut,afterCut,afterQualified:!reference||admission?.agentSessionId===reference.sessionId,cause,issue:reference&&admission?.agentSessionId!==reference.sessionId?[issue,'This pre-existing Session has no role-qualified turn boundary. Its original Session retains uncertain in-flight replies.'].filter(Boolean).join('\n'):issue})
      return prepared.marker
    },
    async read(raw, context) {
      const input = parseMoteDialogueParams('space.mote.dialogue.read', raw)
      const main = await options.main.readCurrentMoteMain(input.target, context?.signal)
      await context?.assertCurrent?.(); await authorizeRead(main, context)
      try {
        const page = main.identity ? await options.store.read(main.identity, input, main) : { links: [], incarnation: null, throughSequence: 0, next: null }
        const bindingLinks=main.identity&&main.transition&&input.kind!=='work'?await options.store.inspect(main.identity,main.transition.operationId):null
        const recordingGap=!!main.transition&&input.kind!=='work'&&!bindingLinks?.some(link=>link.kind==='main'&&link.roleRevision===main.roleRevision)
        return parseMoteDialogueResult('space.mote.dialogue.read', { main, ...page, coverage: 'linked-sources-only', sourceStatus:recordingGap?'unconfirmed':'read', sourceIssue:recordingGap?'The saved Main role is available; its original source recording is unconfirmed. Advance the original setup to reconcile it.':null }, input)
      } catch (error) {
        context?.signal?.throwIfAborted()
        if (error instanceof AgentMuxError && error.code === 'MOTE_DIALOGUE_SOURCE_CHANGED') throw error
        return parseMoteDialogueResult('space.mote.dialogue.read', { main, links: [], incarnation: input.cursor?.incarnation ?? null,
          throughSequence: input.cursor?.throughSequence ?? 0, next: null, coverage: 'linked-sources-only', sourceStatus: 'unconfirmed',
          sourceIssue: error instanceof Error ? error.message : String(error) }, input)
      }
    },
    async link(raw, context) {
      const input = parseMoteDialogueParams('space.mote.dialogue.link', raw)
      let intent = JSON.stringify(input)
      const main = await options.main.readCurrentMoteMain(input.target, context?.signal)
      await context?.assertCurrent?.(); await authorizeRead(main, context)
      if (!main.identity) throw new AgentMuxError('The original Mote identity is unconfirmed. No source relationship was changed.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
      if(input.source.kind==='main'&&main.transition?.operationId===input.operationId)intent=JSON.stringify({kind:'main-role-save',intentDigest:main.transition.intentDigest})
      const prior = await options.store.inspect(main.identity, input.operationId, intent)
      if (prior) return { operationId: input.operationId, links: prior }
      if (main.status !== 'ready' || !main.current || main.roleRevision !== input.expectedRoleRevision)
        throw new AgentMuxError('The original current Mote role changed or is unconfirmed. Keep the original association request.', 'MOTE_MAIN_CHANGED')
      if (context?.caller && (context.caller.hostId !== main.current.hostId || context.caller.agentSessionId !== main.current.sessionId))
        throw new AgentMuxError('Only the current main Agent may associate new work with its Mote. Existing work remains available.', 'CONTROL_PERMISSION_DENIED')
      const associatedAt = Date.now()
      let source
      let earlierSource:ReturnType<typeof mainSource>=null
      if (input.source.kind === 'main') {
        if(main.transition?.operationId===input.operationId) {
          const prepared=await options.store.transition(main.identity,input.operationId,main.transition.intentDigest)
          await options.store.confirmTransition(main.identity,main.transition,main.roleRevision!,main.current)
          if(prepared?.before.reference&&prepared.before.roleRevision&&prepared.before.file)earlierSource={kind:'main',roleRevision:prepared.before.roleRevision,reference:prepared.before.reference,range:'whole-session',file:prepared.before.file,associatedAt}
        }
        source = mainSource(main, associatedAt)
        if (!source) throw new AgentMuxError('The original main source is unconfirmed. No history was invented.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
      } else {
        if (input.source.messageHostId !== main.current.hostId) throw new AgentMuxError('The original work message belongs to another Host.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
        const client = await options.clientForHost(input.source.messageHostId)
        const original = await client.readMessage({ messageId: input.source.messageId })
        const envelope = original?.envelope
        if (!envelope || envelope.sender.kind !== 'agent-session' || envelope.recipient.kind !== 'agent-session' ||
          envelope.senderSessionId !== main.current.sessionId || envelope.sender.agentSessionId !== main.current.sessionId ||
          envelope.recipientSessionId !== envelope.recipient.agentSessionId || !envelope.senderRunId || !envelope.recipientRunId)
          throw new AgentMuxError('A work event requires its exact original main-to-member dispatch message. Existing messages were not reclassified.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
        const eventId = input.source.eventId ?? JSON.stringify([main.identity.hostId, main.identity.moteId, input.source.messageHostId, envelope.threadId])
        if (input.source.eventId) {
          const existing = await options.store.read(main.identity, { target: input.target, kind: 'work', eventId, limit: 1 })
          if (!existing.links.length) throw new AgentMuxError('The original work event is not associated with this Mote.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
        }
        source = { kind: 'work' as const, eventId, mainRoleRevision: main.roleRevision!, main: { hostId: main.current.hostId, agentSessionId: main.current.sessionId },
          origin: { hostId: input.source.messageHostId, messageId: envelope.messageId, threadId: envelope.threadId,
            senderSessionId: envelope.senderSessionId!, recipientSessionId: envelope.recipientSessionId!, createdAt: envelope.createdAt ?? null }, associatedAt }
      }
      await context?.assertCurrent?.(); await options.main.assertCurrent(main, context?.signal)
      const links = await options.store.append(main.identity, input.operationId, intent, [...(earlierSource?[earlierSource]:[]),source])
      return parseMoteDialogueResult('space.mote.dialogue.link', { operationId: input.operationId, links }, input)
    },
    async recordMainSource(before, after, operationId) {
      if (after.status !== 'ready' || !after.identity) throw new AgentMuxError('The saved Mote role’s source association is unconfirmed; retain its original configuration receipt.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
      if (before.identity && !sameMoteDialogue(before.identity, after.identity)) throw new AgentMuxError('The saved role source belongs to another Mote. Its original write receipt is retained.', 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED')
      if(after.transition&&after.roleRevision)await options.store.confirmTransition(after.identity,after.transition,after.roleRevision,after.current)
      const sources = [mainSource(before, Date.now()), mainSource(after, Date.now())].filter((source): source is NonNullable<typeof source> => !!source)
      // The trusted original CAS writer supplies these immutable before/after facts. A later role does not rewrite their subjects.
      const intent = after.transition?JSON.stringify({kind:'main-role-save',intentDigest:after.transition.intentDigest}):JSON.stringify({ kind: 'main-role-save', before: { roleRevision: before.roleRevision, reference: before.current, file: before.documentRevision, resource: before.resource }, after: { roleRevision: after.roleRevision, reference: after.current, file: after.documentRevision, resource: after.resource } })
      await options.store.append(after.identity, operationId, intent, sources)
    }
  }
}
