import { effectiveRoomGrant } from './effective-grant.js'
import { mintObjectId } from '@agentmux/core/object-id'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError } from '@agentmux/core'
import { sameMotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { parseMoteChatConfiguration, parseMoteChatParams, parseMoteChatPerson, parseMoteChatResult,
  type MoteChatAllocate, type MoteChatAudienceInput, type MoteChatCallContext, type MoteChatConfiguration, type MoteChatConfigure,
  type MoteChatGeneration, type MoteChatHistoryInput, type MoteChatInspect, type MoteChatOperation, type MoteChatPort, type MoteChatTarget } from '@agentmux/core/mote-chat'
import { parseConnectionActor, parseConnectionGrant, parseRoomBinding, type ConnectionActor, type ConnectionIngressMessage,
  type RoomBinding, type RoomBindingListInput, type RoomBindingReadPort } from '@agentmux/core/connections'
import type { ConnectionHost } from './connection-host.js'
import { MoteChatStore, type MoteChatGenerationRow, type MoteChatPersonRow, type MoteChatPreparedLaunch } from './mote-chat-store.js'
import { readMoteChatDiagnosis, type MoteChatDiagnosisOwner } from './mote-chat-diagnosis.js'

export type { MoteChatPreparedLaunch } from './mote-chat-store.js'
export type MoteChatCreatedAgent = { executionHostId: string; agentSessionId: string; regionId?: string }
/** Original Mote preparation and Core creation. The saved input is never recomposed after dispatch. */
export interface MoteChatAgentPort {
  prepare(input: { generation: MoteChatGeneration; recent: MoteChatGeneration[]; systemContext: string }): Promise<MoteChatPreparedLaunch>
  create(prepared: MoteChatPreparedLaunch): Promise<MoteChatCreatedAgent>
  /** Read/reconcile the exact saved create; null means that original creation has not started. */
  inspect(prepared: MoteChatPreparedLaunch): Promise<MoteChatCreatedAgent | null>
  /** Restore the original conversation before a new external input freezes its Run. */
  prepareInput(prepared: MoteChatPreparedLaunch): Promise<void>
  /** Typed original activity only. Null means unknown, never metadata update/poll time. */
  activity(reference: { executionHostId: string; agentSessionId: string }): Promise<{ lastActivityAt: number | null }>
}
export type MoteChatHostOptions = {
  connections: ConnectionHost
  agents: MoteChatAgentPort
  assertTarget(target: MoteChatTarget): Promise<void>
  assertReady?: NonNullable<MoteChatDiagnosisOwner['assertReady']>
  ingress?: NonNullable<MoteChatDiagnosisOwner['ingress']>
  now?: () => number
}
export type MoteChatIncoming = Pick<ConnectionIngressMessage, 'ingressId' | 'connectionId' | 'application' | 'externalMessageId' | 'externalConversationId' | 'actor'> & { conversationKind: 'direct' }
const same = isDeepStrictEqual
const encode = JSON.stringify
function fail(code: string, message: string): never { throw new AgentMuxError(message, code) }
function dedicatedCreation(prepared: MoteChatPreparedLaunch): void {
  if ('forkSource' in prepared.input || 'nativeResumeSource' in prepared.input) fail('MOTE_CHAT_CREATE_MISMATCH', 'Private chat requires its original dedicated creation. The existing imported or copied conversation is retained without expanding its audience.')
}
const personKey = (spaceId: string, actor: ConnectionActor) => encode([spaceId, actor.application.domain, actor.application.appId, actor.idType, actor.userId])
const laneKey = (spaceId: string, incoming: Pick<MoteChatIncoming, 'application' | 'externalConversationId' | 'actor'>) => encode([spaceId, incoming.application.domain, incoming.application.appId, incoming.externalConversationId, incoming.actor.idType, incoming.actor.userId])
const management = (context?: MoteChatCallContext) => {
  if (context?.actor.kind === 'agent') fail('CONTROL_PERMISSION_DENIED', 'Mote chat configuration and audience management require the original human or device. Chat history remains available to its own Agent.')
}
function cursor(scope: unknown, after: string | number) { return Buffer.from(encode({ scope: createHash('sha256').update(encode(scope)).digest('hex'), after })).toString('base64url') }
function position(scope: unknown, value: string | undefined, initial: string | number): string | number {
  if (value === undefined) return initial
  try {
    const p = JSON.parse(Buffer.from(value, 'base64url').toString())
    if (!p || Object.keys(p).sort().join(',') !== 'after,scope' || p.scope !== createHash('sha256').update(encode(scope)).digest('hex') || typeof p.after !== typeof initial || typeof p.after === 'number' && (!Number.isSafeInteger(p.after) || p.after < 1)) throw new Error('Different original scope')
    return p.after
  } catch { return fail('MOTE_CHAT_CURSOR_INVALID', 'This cursor belongs to another original Mote chat scope. Read a fresh page for the same target.') }
}

/** One durable business owner; borrows Core lifecycle, input and publication rather than duplicating them. */
export class MoteChatHost implements MoteChatPort, RoomBindingReadPort {
  readonly store: MoteChatStore
  private readonly pending = new Map<string, Promise<RoomBinding>>()
  private readonly now: () => number
  constructor(private readonly options: MoteChatHostOptions) { this.store = new MoteChatStore(options.connections.database); this.now = options.now ?? Date.now }
  private exact(target: MoteChatTarget): MoteChatConfiguration | null {
    const c = this.store.configuration(target.spaceId)
    if (c && !sameMotePreferencesTarget(c.target, target)) fail('MOTE_CHAT_TARGET_CHANGED', 'The original Mote home changed. Read the exact Mote again; its existing conversations and files are retained.')
    return c
  }
  private originalOperation(id: string, intent: string): MoteChatOperation | null {
    const o = this.store.operation(id)
    if (o && o.intent !== intent) fail('MOTE_CHAT_OPERATION_CONFLICT', 'This operation already belongs to another original Mote chat intent or actor. Inspect it without replacing its identity.')
    return o?.operation ?? null
  }
  async configure(value: MoteChatConfigure, context: MoteChatCallContext) {
    const input = parseMoteChatParams('space.mote.chat.configure', value); management(context); await context.assertCurrent?.()
    const intent = encode({ method: 'configure', input, actor: context.actor }), original = this.originalOperation(input.operationId, intent)
    if (original) return parseMoteChatResult('space.mote.chat.configure', original, input)
    await this.options.assertTarget(input.target)
    const current = this.exact(input.target)
    let creator = current?.creator ?? null
    if (input.values.connection) {
      const ref = input.values.connection, connection = (await this.options.connections.inspect({ connectionId: ref.connectionId })).connection
      if (!connection || !same(connection.config.application, ref.application) || connection.revision !== input.expectedConnectionRevision) fail('MOTE_CHAT_CONNECTION_CHANGED', 'The selected original application changed. Read it again before saving this chat configuration.')
      const changed = !same(current?.values.connection, ref)
      if (input.values.enabled && (!connection.config.enabled || changed && connection.initialSetup?.state === 'incomplete')) fail('MOTE_CHAT_CONNECTION_UNAVAILABLE', 'The selected application is disabled or its original setup has not completed. Continue that exact identity in Lark settings; existing conversations are retained.')
      if (input.values.enabled && (changed || !creator)) {
        const observation = await this.options.connections.profile?.get({ connectionId: ref.connectionId, expectedConnectionRevision: connection.revision }, context)
        if (!observation?.creator || !same(observation.application, ref.application) || observation.connectionRevision !== connection.revision) fail('MOTE_CHAT_CREATOR_UNCONFIRMED', 'The original application-scoped creator is not confirmed. Check this application profile and its read permission before enabling chat; no Agent was started.')
        creator = parseConnectionActor({ application: ref.application, ...observation.creator })
      } else if (changed) creator = null
    } else creator = null
    await context.assertCurrent?.()
    return this.store.transaction(() => {
      const original = this.originalOperation(input.operationId, intent)
      if (original) return parseMoteChatResult('space.mote.chat.configure', original, input)
      const actual = this.exact(input.target)
      if ((actual?.revision ?? null) !== input.expectedRevision) fail('MOTE_CHAT_REVISION_CONFLICT', 'Mote chat settings changed. Keep this draft and read the current revision before explicitly saving again.')
      const ref = input.values.connection
      if (ref) {
        const c = this.options.connections.readConfiguration(ref.connectionId)
        if (!c || c.revision !== input.expectedConnectionRevision || !same(c.config.application, ref.application)) fail('MOTE_CHAT_CONNECTION_CHANGED', 'The original application changed during this save. No chat configuration was replaced.')
        const owner = this.store.route(ref.application)
        if (input.values.enabled && owner && owner.target.spaceId !== input.target.spaceId) fail('MOTE_CHAT_APPLICATION_IN_USE', 'This application already routes private chat to another Mote. Choose another identity or explicitly disable that original route first.')
      }
      const configuration = parseMoteChatConfiguration({ target: input.target, revision: (actual?.revision ?? 0) + 1, values: input.values, creator })
      const operation = parseMoteChatResult('space.mote.chat.configure', { operationId: input.operationId, action: 'configure', configuration }, input)
      this.store.saveConfiguration(configuration); this.store.saveOperation(intent, operation)
      return operation
    })
  }
  async inspect(value: MoteChatInspect, context?: MoteChatCallContext) {
    const input = parseMoteChatParams('space.mote.chat.inspect', value); management(context); await context?.assertCurrent?.()
    const operation = input.operationId === undefined ? null : this.store.operation(input.operationId)?.operation ?? null
    const current = input.target ? this.exact(input.target) : operation ? this.store.configuration(operation.configuration.target.spaceId) : null
    const configuration = operation && current && !sameMotePreferencesTarget(current.target, operation.configuration.target) ? null : current
    return parseMoteChatResult('space.mote.chat.inspect', { configuration, operation }, input)
  }
  async diagnose(value: { target: MoteChatTarget }, context?: MoteChatCallContext) {
    const input = parseMoteChatParams('space.mote.chat.diagnose', value)
    await context?.assertCurrent?.()
    const report = await readMoteChatDiagnosis(input.target, { ...this.options, store: this.store })
    await context?.assertCurrent?.()
    return parseMoteChatResult('space.mote.chat.diagnose', report, input)
  }
  async audience(value: MoteChatAudienceInput, context?: MoteChatCallContext) {
    const input = parseMoteChatParams('space.mote.chat.audience', value); management(context); await context?.assertCurrent?.(); this.exact(input.target)
    const scope = ['audience', input.target], after = position(scope, input.cursor, '') as string
    const rows = this.store.people(input.target.spaceId, after, (input.limit ?? 20) + 1), page = rows.slice(0, input.limit)
    return parseMoteChatResult('space.mote.chat.audience', { people: page.map(row => row.person), next: rows.length > page.length ? cursor(scope, page.at(-1)!.key) : null }, input)
  }
  async allocate(value: MoteChatAllocate, context: MoteChatCallContext) {
    const input = parseMoteChatParams('space.mote.chat.allocate', value); management(context); await context.assertCurrent?.(); await this.options.assertTarget(input.target)
    await context.assertCurrent?.()
    const intent = encode({ method: 'allocate', input, actor: context.actor })
    return this.store.transaction(() => {
      const original = this.originalOperation(input.operationId, intent)
      if (original) return parseMoteChatResult('space.mote.chat.allocate', original, input)
      const configuration = this.exact(input.target), key = personKey(input.target.spaceId, input.actor), row = this.store.person(key)
      if (!configuration || configuration.revision !== input.expectedConfigurationRevision || !row || row.person.revision !== input.expectedPersonRevision) fail('MOTE_CHAT_REVISION_CONFLICT', 'This original person or Mote configuration changed. Read the current allocation before saving another intent.')
      if (row.person.creator) fail('MOTE_CHAT_CREATOR_UNLIMITED', 'The confirmed application creator already has unlimited chat access. Allocate an allowance to an exact guest instead.')
      const person = parseMoteChatPerson({ ...row.person, revision: row.person.revision + 1, total: input.total, remaining: Math.max(0, input.total - row.person.used) })
      const operation = parseMoteChatResult('space.mote.chat.allocate', { operationId: input.operationId, action: 'allocate', configuration, person }, input)
      this.store.savePerson({ ...row, person }); this.store.saveOperation(intent, operation); return operation
    })
  }
  async history(value: MoteChatHistoryInput, context?: MoteChatCallContext) {
    const input = parseMoteChatParams('space.mote.chat.history', value); await context?.assertCurrent?.(); this.exact(input.target)
    let lane: string | undefined
    if (context?.actor.kind === 'agent') {
      const source = this.store.generationBySession(context.actor.id)
      if (!source || !sameMotePreferencesTarget(source.generation.target, input.target) || input.actor && !same(input.actor, source.generation.actor)) fail('CONTROL_PERMISSION_DENIED', 'An Agent may read only its exact original Mote private-chat lane.')
      lane = source.laneKey
    }
    const scope = ['history', input.target, input.actor ?? null, lane ?? null], before = position(scope, input.cursor, Number.MAX_SAFE_INTEGER) as number
    const rows = this.store.generations(input.target.spaceId, before, (input.limit ?? 20) + 1, lane, input.actor), page = rows.slice(0, input.limit)
    return parseMoteChatResult('space.mote.chat.history', { generations: page.map(row => row.generation), next: rows.length > page.length ? cursor(scope, page.at(-1)!.sequence) : null }, input)
  }
  private active(row: MoteChatGenerationRow): boolean {
    const config = this.store.configuration(row.generation.target.spaceId), ref = config?.values.connection
    if (!config?.values.enabled || !ref || !sameMotePreferencesTarget(config.target, row.generation.target) || !same(ref.application, row.generation.application)) return false
    const connection = this.options.connections.readConfiguration(row.connectionId)
    return !!connection?.config.enabled && same(connection.config.application, row.generation.application)
  }
  private person(configuration: MoteChatConfiguration, actor: ConnectionActor): MoteChatPersonRow {
    const key = personKey(configuration.target.spaceId, actor), existing = this.store.person(key)
    if (existing) return existing
    const creator = same(configuration.creator, actor), total = creator ? null : configuration.values.strangerMessageLimit
    return { key, spaceId: configuration.target.spaceId, person: parseMoteChatPerson({ actor, creator, revision: 1, total, used: 0, remaining: total }) }
  }
  private assertService(connectionId: string): void {
    const connection = this.options.connections.readConfiguration(connectionId)
    if (!connection) fail('MOTE_CHAT_CONNECTION_UNAVAILABLE', 'The original chat application is unavailable. Its retained messages and Agent identities are kept.')
    this.options.connections.assertServiceEnabled(connection.config.adapterId)
  }
  /** Called only for an authenticated, durably ACKed direct event before the original input claim. */
  async prepareIncoming(incoming: MoteChatIncoming): Promise<RoomBinding | null> {
    if (incoming.conversationKind !== 'direct' || !same(incoming.application, incoming.actor.application)) fail('MOTE_CHAT_SOURCE_MISMATCH', 'This original intake does not identify an authenticated direct conversation.')
    const saved = this.store.admission(incoming.application, incoming.externalMessageId)
    if (saved) {
      if (!same(saved.actor, incoming.actor) || saved.externalConversationId !== incoming.externalConversationId || saved.ingressId !== incoming.ingressId) fail('MOTE_CHAT_ADMISSION_CONFLICT', 'This original message already belongs to another chat admission. Keep its original intake identity.')
      return await this.ready(saved.generationId)
    }
    const configuration = this.store.route(incoming.application)
    if (!configuration) return null
    this.assertService(configuration.values.connection!.connectionId)
    await this.options.assertTarget(configuration.target)
    const key = laneKey(configuration.target.spaceId, incoming), observed = this.store.latest(key)
    let activity: number | null = null
    if (observed?.generation.phase === 'ready') {
      try { activity = (await this.options.agents.activity(observed.generation)).lastActivityAt } catch { /* Missing extra observation cannot erase the durable accepted activity. */ }
      if (activity !== null && (!Number.isSafeInteger(activity) || activity < 0)) activity = null
    }
    const selected = this.store.transaction(() => {
      const duplicate = this.store.admission(incoming.application, incoming.externalMessageId)
      if (duplicate) return { generationId: duplicate.generationId }
      const current = this.store.route(incoming.application)
      if (!current || current.revision !== configuration.revision || !sameMotePreferencesTarget(current.target, configuration.target)) fail('MOTE_CHAT_ROUTE_CHANGED', 'This exact Mote chat route changed while preparing the message. The original intake is retained.')
      const connection = this.options.connections.readConfiguration(current.values.connection!.connectionId)
      if (!connection?.config.enabled || !same(connection.config.application, incoming.application)) fail('MOTE_CHAT_CONNECTION_UNAVAILABLE', 'The original chat application is unavailable. Its retained messages and Agent identities are kept.')
      this.options.connections.assertServiceEnabled(connection.config.adapterId)
      const person = this.person(current, parseConnectionActor(incoming.actor))
      if (!person.person.creator && person.person.used >= person.person.total!) { this.store.savePerson(person); return { refused: true as const } }
      const now = this.now()
      let row = this.store.latest(key)
      if (row && observed?.generation.generationId === row.generation.generationId && activity !== null) row.generation.lastActivityAt = Math.max(row.generation.lastActivityAt, activity)
      const elapsed = row ? now - row.generation.lastActivityAt : 0
      if (!row || row.generation.phase === 'ready' && elapsed > current.values.conversationIdleMs) {
        const id = mintObjectId()
        row = this.store.insertGeneration({ sequence: 0, laneKey: key, connectionId: current.values.connection!.connectionId, configurationRevision: current.revision,
          authorizedBy: this.configurationAuthority(current), prepared: null, dispatched: false, binding: null, grant: null,
          generation: { generationId: id, target: current.target, application: incoming.application, externalConversationId: incoming.externalConversationId,
            actor: incoming.actor, executionHostId: current.target.expectedResource.hostId, agentSessionId: `mote-chat-${id}`, createOperationId: `mote-chat-create:${id}`, phase: 'preparing', createdAt: now, lastActivityAt: now } })
      } else { row.generation.lastActivityAt = Math.max(row.generation.lastActivityAt, now); this.store.saveGeneration(row) }
      person.person = parseMoteChatPerson({ ...person.person, revision: person.person.revision + 1, used: person.person.used + 1, remaining: person.person.creator ? null : Math.max(0, person.person.total! - person.person.used - 1) })
      this.store.savePerson(person)
      this.store.saveAdmission({ ingressId: incoming.ingressId, application: incoming.application, externalMessageId: incoming.externalMessageId, actor: incoming.actor, externalConversationId: incoming.externalConversationId, generationId: row.generation.generationId })
      return { generationId: row.generation.generationId }
    })
    if ('refused' in selected) fail('MOTE_CHAT_QUOTA_EXHAUSTED', 'This person has no remaining Mote chat messages. The creator can allocate an allowance in this Mote Profile; no Agent was started.')
    return await this.ready(selected.generationId)
  }
  private configurationAuthority(configuration: MoteChatConfiguration): MoteChatCallContext['actor'] {
    const actor = this.store.configurationAuthority(configuration)
    return actor ?? fail('MOTE_CHAT_AUTHORITY_UNCONFIRMED', 'The original human chat configuration authority is unconfirmed. Its original messages and Agent identities are retained.')
  }
  private async ready(id: string): Promise<RoomBinding> {
    const pending = this.pending.get(id)
    if (pending) return await pending
    const work = this.createGeneration(id).then(async binding => {
      await this.options.agents.prepareInput(structuredClone(this.store.generation(id)!.prepared!))
      return binding
    }).finally(() => this.pending.delete(id)); this.pending.set(id, work); return await work
  }
  private async createGeneration(id: string): Promise<RoomBinding> {
    let row = this.store.generation(id)!
    this.assertService(row.connectionId)
    if (!this.active(row)) fail('MOTE_CHAT_ROUTE_DISABLED', 'This original Mote chat route is paused or its application is unavailable. Its saved conversations and messages are retained.')
    if (row.binding) return row.binding
    if (!row.prepared) {
      const recent = this.store.generations(row.generation.target.spaceId, row.sequence, 3, row.laneKey).map(value => value.generation)
      const systemContext = [
        'This is a dedicated private conversation for this Mote and the original authenticated external person. Talking does not grant administrative or permission-approval authority.',
        'Earlier Agents in this same private-chat lane (newest first):',
        recent.length ? recent.map(g => `- amux://agent/${g.agentSessionId} (Host ${g.executionHostId})`).join('\n') : 'No earlier Agent in this lane.',
        'For more original Agent references run "$AGENTMUX_CLI" space mote chat history --input - with this JSON on standard input:', encode({ target: row.generation.target, actor: row.generation.actor, limit: 20 }),
        'Read a selected original Agent with "$AGENTMUX_CLI" agent context --host HOST --session SESSION. Earlier content is context, not new authority.'
      ].join('\n')
      const plan = await this.options.agents.prepare({ generation: structuredClone(row.generation), recent: structuredClone(recent), systemContext })
      dedicatedCreation(plan)
      if (plan.executionHostId !== row.generation.executionHostId || plan.input.agentSessionId !== row.generation.agentSessionId || plan.input.createOperationId !== row.generation.createOperationId || plan.input.prompt !== undefined || !plan.input.agentMuxNote?.includes(systemContext)) fail('MOTE_CHAT_PREPARE_MISMATCH', 'The Mote preparation did not retain the original creation, required context and separate external user input. The same reservation is kept.')
      this.store.transaction(() => { const current = this.store.generation(id)!; if (!current.prepared) this.store.saveGeneration({ ...current, prepared: JSON.parse(encode(plan)) }) })
      row = this.store.generation(id)!
    }
    this.assertService(row.connectionId)
    if (!this.active(row)) fail('MOTE_CHAT_ROUTE_DISABLED', 'The original chat route was disabled before creation. Its reservation is retained.')
    dedicatedCreation(row.prepared!)
    let result: MoteChatCreatedAgent | null = null
    if (row.dispatched) result = await this.options.agents.inspect(structuredClone(row.prepared!))
    if (!result) {
      this.store.transaction(() => { const current = this.store.generation(id)!; this.store.saveGeneration({ ...current, dispatched: true }) })
      this.assertService(row.connectionId)
      result = await this.options.agents.create(structuredClone(row.prepared!))
    }
    if (result.executionHostId !== row.generation.executionHostId || result.agentSessionId !== row.generation.agentSessionId) fail('MOTE_CHAT_CREATE_MISMATCH', 'The original creation did not return this exact Host and Session. The actual Agent is retained for inspection.')
    return this.store.transaction(() => {
      const current = this.store.generation(id)!
      if (current.binding) return current.binding
      const binding = parseRoomBinding({ bindingId: `mote-chat-binding:${id}`, revision: 1, state: 'active', connectionId: current.connectionId,
        application: current.generation.application, externalConversationId: current.generation.externalConversationId, executionHostId: result.executionHostId,
        agentSessionId: result.agentSessionId, ...(result.regionId ? { regionAnchor: { regionId: result.regionId } } : {}), scope: { input: 'all-messages', publication: 'future-native-user-facing' },
        sourceCheckpoints: [], publicationOrigin: { createOperationId: current.generation.createOperationId }, authorizedBy: current.authorizedBy })
      const grant = parseConnectionGrant({ grantId: `mote-chat-grant:${id}`, revision: 1, bindingId: binding.bindingId, bindingRevision: 1, connectionId: binding.connectionId,
        externalConversationId: binding.externalConversationId, actor: current.generation.actor, capabilities: ['input', 'answer'], state: 'active' })
      this.store.saveGeneration({ ...current, generation: { ...current.generation, phase: 'ready' }, binding, grant }); return binding
    })
  }
  readExact(bindingId: string, revision: number): RoomBinding | null { const row = this.store.generationByBinding(bindingId); return revision === 1 ? row?.binding ?? null : null }
  readCurrent(bindingId: string): RoomBinding | null { const row = this.store.generationByBinding(bindingId); return row?.binding ? { ...row.binding, state: this.active(row) ? 'active' : 'paused' } : null }
  /** On-demand identity authority comes from the current lane/policy, independently of automatic traffic. */
  apiBinding(bindingId: string): RoomBinding | null {
    const row = this.store.generationByBinding(bindingId)
    if (!row?.binding || !this.active(row) || this.store.configuration(row.generation.target.spaceId)?.values.connection?.connectionId !== row.connectionId ||
      this.store.latest(row.laneKey)?.generation.generationId !== row.generation.generationId) return null
    return row.binding
  }
  findActiveAudience(input: { application: RoomBinding['application']; externalConversationId: string }): RoomBinding | null {
    const c = this.store.route(input.application)
    if (!c) return null
    // Native p2p chat IDs identify one person; the saved actor remains checked separately by its grant.
    const generation = this.store.latestAudience(c.target.spaceId, input.application, input.externalConversationId)
    if (!generation) return null
    return generation.binding && this.active(generation) ? generation.binding : null
  }
  knowsAudience(input: { application: RoomBinding['application']; externalConversationId: string }): boolean { return this.store.knowsAudience(input.application, input.externalConversationId) }
  listBindings(input: RoomBindingListInput = {}): RoomBinding[] {
    return this.store.allBindings(input).map(row => ({ ...row.binding!, state: this.active(row) ? 'active' as const : 'paused' as const }))
  }
  listActive(input: RoomBindingListInput = {}): RoomBinding[] { return this.listBindings(input).filter(binding => binding.state === 'active') }
  publicationAuthority(bindingId: string, revision: number) {
    const binding = this.readExact(bindingId, revision), row = this.store.generationByBinding(bindingId)
    if (!binding || !row) return { binding, authorized: false, reason: 'missing' as const }
    const connection = this.options.connections.readConfiguration(row.connectionId)
    if (!connection?.config.enabled || !same(connection.config.application, row.generation.application)) return { binding, authorized: false, reason: 'connection-disabled' as const }
    if (!this.options.connections.automaticTrafficEnabled(connection.config.adapterId)) return { binding, authorized: false, reason: 'service-disabled' as const }
    return this.active(row) ? { binding, authorized: true } : { binding, authorized: false, reason: 'paused' as const }
  }
  readGrant(grantId: string, revision?: number) { const row = this.store.generationByGrant(grantId); return row?.grant && (revision === undefined || revision === row.grant.revision) ? { ...row.grant, state: this.active(row) ? 'active' as const : 'revoked' as const } : null }
  grants(bindingId: string, revision: number) { const row = this.store.generationByBinding(bindingId); const grant = row?.grant ? this.readGrant(row.grant.grantId) : null; return revision === 1 && grant ? [grant] : [] }
  effectiveGrant(bindingId: string, revision: number, actor: ConnectionActor) { const grant = this.grants(bindingId, revision).find(g => same(g.actor, actor)); return grant ? effectiveRoomGrant(grant) : null }
  effectiveGrants(bindingId: string, revision: number) { return { grants: this.grants(bindingId, revision).map(effectiveRoomGrant), issue: null } }
  findGrant(input: { connectionId: string; externalConversationId: string; actor: ConnectionActor }) {
    const c = this.store.route(input.actor.application)
    if (!c) return null
    const row = this.store.latest(laneKey(c.target.spaceId, { application: input.actor.application, externalConversationId: input.externalConversationId, actor: input.actor }))
    return row?.grant && row.connectionId === input.connectionId ? this.readGrant(row.grant.grantId) : null
  }
  /** The original quota decision survives exhaustion and rollover; explicit route shutdown still applies. */
  hasAdmission(ingressId: string, bindingId: string, actor: ConnectionActor): boolean {
    const a = this.store.admissionByIngress(ingressId), row = a ? this.store.generation(a.generationId) : null
    return !!row?.binding && row.binding.bindingId === bindingId && same(a!.actor, actor) && this.active(row) &&
      this.store.configuration(row.generation.target.spaceId)?.values.connection?.connectionId === row.connectionId
  }
}

/** Exact native IDs do not fall through to another owner after a known Mote binding is paused. */
export function composeMoteChatBindings(groups: RoomBindingReadPort, chat: MoteChatHost): RoomBindingReadPort {
  return {
    effectiveGrant: (id, revision, actor) => chat.readExact(id, revision) ? chat.effectiveGrant(id, revision, actor) : groups.effectiveGrant(id, revision, actor),
    effectiveGrants: (id, revision) => chat.readExact(id, revision) ? chat.effectiveGrants(id, revision) : groups.effectiveGrants(id, revision),
    readOperation: id => groups.readOperation?.(id) ?? null,
    readExact: (id, revision) => chat.readExact(id, revision) ?? groups.readExact(id, revision),
    readCurrent: id => chat.readCurrent(id) ?? groups.readCurrent(id),
    findActiveAudience: input => chat.knowsAudience(input) ? chat.findActiveAudience(input) : groups.findActiveAudience(input),
    listActive: input => [...groups.listActive(input), ...chat.listActive(input)],
    publicationAuthority: (id, revision) => chat.readExact(id, revision) ? chat.publicationAuthority(id, revision) : groups.publicationAuthority(id, revision),
    readGrant: (id, revision) => chat.readGrant(id, revision) ?? groups.readGrant(id, revision),
    findGrant: input => chat.findGrant(input) ?? groups.findGrant(input),
    grants: (id, revision) => chat.readExact(id, revision) ? chat.grants(id, revision) : groups.grants?.(id, revision) ?? []
  }
}
