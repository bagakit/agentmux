import { parseFileWriteResult, parseFileCreateResult, type AgentMuxRpcFilesOwner } from '@agentmux/core/files'
import { DEFAULT_MOTE_PRESENCE, effectiveMoteQuickSave, sameMoteQuickDefaults, parseMotePreferencesReadResult, parseMotePreferencesSaveParams, parseMotePreferencesSaveResult, type MoteQuickPreferencesPort, type MoteQuickPreferencesReadInput, type MoteQuickPreferencesReadResult, type MoteQuickPreferencesSaveParams, type MoteQuickPreferencesSaveResult, type MotePresenceReading } from '@agentmux/core/mote-preferences'
import type { MoteMainReader, MoteMainSnapshot } from '@agentmux/core/mote-dialogue'
import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import type { ConnectionEnrollmentCallContext } from '@agentmux/core/connections'
import { AgentMuxError } from '@agentmux/core'
import { PMO_TEAMS_TOPIC_ID } from './mote-topic-model.js'
import { isDeepStrictEqual } from 'node:util'
import { parseMoteQuickMode, serializeMoteQuickMode, sameMoteDefaultConversation } from './mote-quick-mode.js'
import { readMoteQuickModeSource, moteQuickModeDefaults } from './mote-quick-mode-source.js'

/** The original MOTE.md semantic writer. Navigation remains a client action after its receipt. */
export class HostMoteQuickPreferences implements MoteQuickPreferencesPort {
  constructor(private readonly ports: {
    files: AgentMuxRpcFilesOwner; main: MoteMainReader
    catalog(): Promise<AgentMuxSpaceCatalog | null>
    executors(): Promise<MoteQuickPreferencesReadResult['choices']['executors']>
    maintenance?(target: MoteQuickPreferencesReadInput['target']): MotePresenceReading
    adoptGuidance?(input: MoteQuickPreferencesSaveParams, main: MoteMainSnapshot, context: ConnectionEnrollmentCallContext, options?: { reconcilePublished: true }): Promise<NonNullable<MoteQuickPreferencesSaveResult['maintenanceAdoption']>>
    changed?(target: MoteQuickPreferencesReadInput['target']): void
    prepareMainSource?(before:MoteMainSnapshot, roleRevision:string, reference:import('@agentmux/core/mote-preferences').MoteDefaultConversation|null, operationId:string):Promise<import('@agentmux/core/mote-preferences').MoteMainTransitionMarker>
    recordMainSource?(before: MoteMainSnapshot, after: MoteMainSnapshot, operationId: string): Promise<void>
  }) {}
  async read(input: MoteQuickPreferencesReadInput): Promise<MoteQuickPreferencesReadResult> {
    input = { kind: 'quick', target: input.target }
    let source: MoteQuickPreferencesReadResult['source'] = null
    let defaults: MoteQuickPreferencesReadResult['defaults'] = null
    const empty = { executors: [], conversations: [], destinations: [] }
    try {
      const main = await this.ports.main.readCurrentMoteMain(input.target)
      if (!main.identity) throw new Error(main.issue ?? 'The original Mote identity is unconfirmed.')
      const file = await readMoteQuickModeSource(this.ports.files, input.target)
      source = file.source
      defaults = moteQuickModeDefaults(file.mode)
      const catalog = await this.ports.catalog(), locations = catalog?.locations.filter(value => value.spaceId === input.target.spaceId) ?? []
      const conversations = locations.flatMap(location => {
        const region = catalog!.regions.find(value => value.tabId === location.tabId && value.regionId === location.regionId)
        return region?.kind === 'agent' && region.agentSessionId && region.execution ? [{ reference: { hostId: region.execution.hostId, sessionId: region.agentSessionId, displayWorkspaceId: location.displayWorkspaceId, groupId: location.groupId, tabId: location.tabId, regionId: location.regionId }, label: `${region.execution.hostId} · ${region.agentSessionId}` }] : []
      })
      const executors = await this.ports.executors()
      return parseMotePreferencesReadResult({ ...input, status: 'ready', source, defaults,
        choices: { executors, conversations, destinations: locations.map(value => ({ reference: { kind: 'occurrence', displayWorkspaceId: value.displayWorkspaceId, groupId: value.groupId, tabId: value.tabId, regionId: value.regionId }, label: `${value.tabId} · ${value.regionId}` })) },
        main: main.identity.moteId === PMO_TEAMS_TOPIC_ID, issue: null, ...(this.ports.maintenance ? { maintenance: this.ports.maintenance(input.target) } : {}) }, input)
    } catch (error) { return parseMotePreferencesReadResult({ ...input, status: 'unconfirmed', source, defaults, choices: empty, main: null, issue: String(error) }, input) }
  }
  async save(raw: MoteQuickPreferencesSaveParams, context?: ConnectionEnrollmentCallContext): Promise<MoteQuickPreferencesSaveResult> {
    return this.ports.main.withRole?await this.ports.main.withRole(raw.target,()=>this.saveInRole(raw,context)):await this.saveInRole(raw,context)
  }
  private async saveInRole(raw: MoteQuickPreferencesSaveParams, context?: ConnectionEnrollmentCallContext): Promise<MoteQuickPreferencesSaveResult> {
    const input = parseMotePreferencesSaveParams(raw), values = effectiveMoteQuickSave(input)
    let dispatched = false
    const result = (status: MoteQuickPreferencesSaveResult['status'], source: MoteQuickPreferencesSaveResult['source'], message: string | null) => parseMotePreferencesSaveResult({ kind: 'quick', target: input.target, operationId: input.operationId, status, source, message }, input)
    try {
      const read = await this.read({ kind: 'quick', target: input.target }), baseline = input.baseline
      if (read.status !== 'ready' || !read.source?.resource || read.source.result.status !== 'read' && read.source.result.status !== 'deleted' || !read.defaults) throw new Error(read.issue ?? 'The original settings are unconfirmed.')
      const document = read.source.result.status === 'read' ? read.source.result.document : null
      const sameResource = isDeepStrictEqual(read.source.resource, baseline.resource), sameControls = isDeepStrictEqual(read.defaults, baseline.defaults)
      const sameBaseline = sameResource && document?.revision === baseline.document?.revision && document?.content === baseline.document?.content && sameControls
      // A new adoption still needs the complete File CAS. An already-published
      // original operation may reconcile after a notes-only edit; its immutable
      // request, actor, role, definition and controlling preferences stay exact.
      if (!sameBaseline && !(input.action && sameResource && sameControls)) throw new Error('The original MOTE.md changed. Reread its exact revision; your request is retained.')
      if (input.action) {
        if (!context || !['user', 'device'].includes(context.actor.kind) || !context.actor.id.trim()) throw new Error('Adopting guidance requires the original authenticated person or device. The Agent and its inputs remain available.')
        if (input.destination || !isDeepStrictEqual(input.values, baseline.defaults)) throw new Error('Guidance adoption must preserve the complete original settings and Main binding. Save preference changes separately.')
        if (!this.ports.adoptGuidance) throw new Error('The original guidance adoption owner is unavailable.')
        const before = await this.ports.main.readCurrentMoteMain(input.target, context.signal)
        dispatched = true
        const maintenanceAdoption = await this.ports.adoptGuidance(input, before, context, sameBaseline ? undefined : { reconcilePublished: true })
        return parseMotePreferencesSaveResult({ kind: 'quick', target: input.target, operationId: input.operationId,
          status: 'unchanged', source: baseline, message: null, maintenanceAdoption }, input)
      }
      if (input.values.recovery !== undefined && input.values.recovery !== read.defaults.recovery) throw new Error('The original reconnect timing is retained history. Configure presence and heartbeat through the original Mote maintenance settings.')
      const roleChanged = !sameMoteDefaultConversation(values.conversation, read.defaults.conversation)
      if (roleChanged && !input.destination) throw new Error('Changing the original Main requires its exact legitimate destination.')
      const presenceChanged = JSON.stringify(values.presence ?? DEFAULT_MOTE_PRESENCE) !== JSON.stringify(read.defaults.presence ?? DEFAULT_MOTE_PRESENCE)
      if (context?.actor.kind === 'agent' && (roleChanged || presenceChanged)) throw new Error('Standing maintenance and its current role require the original person or device configuration. Existing Agents remain available.')
      if (values.executorId !== read.defaults.executorId && values.executorId && !read.choices.executors.some(value => value.id === values.executorId)) throw new Error('The selected original Executor is unconfirmed.')
      if (roleChanged && values.conversation && !read.choices.conversations.some(value => sameMoteDefaultConversation(value.reference, values.conversation))) throw new Error('The selected original Agent and its Host/location are unconfirmed.')
      const before = await this.ports.main.readCurrentMoteMain(input.target, context?.signal)
      let preparationIssue:string|null=null
      if(roleChanged&&this.ports.prepareMainSource) {try{values.conversationTransition=await this.ports.prepareMainSource(before,values.conversationRevision!,values.conversation??null,input.operationId)}catch(error){preparationIssue='The original role boundary preparation is unconfirmed: '+String(error)}}
      const content = serializeMoteQuickMode(document?.content ?? '', values)
      if (document?.content === content) return result('unchanged', { resource: read.source.resource, document, defaults: values }, null)
      context?.signal?.throwIfAborted(); await context?.assertCurrent?.()
      const base = { ...input.target, expectedResource: read.source.resource, path: 'MOTE.md', content }
      dispatched = true
      const saved = document ? parseFileWriteResult(await this.ports.files.write({ ...base, expectedRevision: document.revision }, context ? { actor: context.actor } : undefined), { ...base, expectedRevision: document.revision }) : parseFileCreateResult(await this.ports.files.create({ ...base, expectedRevision: null }, context ? { actor: context.actor } : undefined), { ...base, expectedRevision: null })
      if (saved.result.status !== 'written') return result(saved.result.status === 'unknown' ? 'unconfirmed' : 'refused-before-write', null, saved.result.status === 'conflict' ? 'The original file changed before this save. Keep this request and reread.' : saved.result.message)
      const actual = saved.result.content ?? content, parsed = parseMoteQuickMode(actual)
      if (!saved.resource || parsed.status !== 'valid' || !sameMoteQuickDefaults(parsed.defaults, values)) throw new Error('The original writer result is unconfirmed. Inspect this same save; do not overwrite or replay it.')
      const source = { resource: saved.resource, document: { path: saved.resource.path, content: actual, revision: saved.result.revision }, defaults: parsed.defaults }
      this.ports.changed?.(input.target)
      let issue: string | null = preparationIssue
      if (roleChanged && this.ports.recordMainSource) {
        try { await this.ports.recordMainSource(before, { target: input.target, identity: before.identity, status: 'ready', resource: source.resource, documentRevision: source.document.revision, roleRevision: parsed.defaults.conversationRevision!, current: parsed.defaults.conversation ?? null, issue: null, ...(parsed.defaults.conversationTransition?{transition:parsed.defaults.conversationTransition}:{}) }, input.operationId) }
        catch (error) { issue = 'Settings were saved; recording the original dialogue association is unconfirmed. ' + String(error) }
      }
      return result('saved', source, issue)
    } catch (error) {
      const refused = input.action && error instanceof AgentMuxError && ['CONTROL_PERMISSION_DENIED', 'UNKNOWN_SCHEDULE', 'SCHEDULE_REVISION_CONFLICT', 'SCHEDULE_OPERATION_CONFLICT', 'STALE_AGENT_SESSION'].includes(error.code)
      return result(dispatched && !refused ? 'unconfirmed' : 'refused-before-write', null, String(error))
    }
  }
}
