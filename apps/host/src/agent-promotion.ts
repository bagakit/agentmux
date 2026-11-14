import { createHash } from 'node:crypto'
import { constants, link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, durableWriteFile, mintObjectId, type AgentMuxRpcCallContext, type AgentMuxRpcFilesOwner,
  type AgentMuxSpatialGraph, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { associatePromotedAgent, parseAgentPromotionParams, parseAgentPromotionResult, type AgentPromotionApply,
  type AgentPromotionClub, type AgentPromotionDiscovery, type AgentPromotionInspection, type AgentPromotionMembership,
  type AgentPromotionMethod, type AgentPromotionParamsMap, type AgentPromotionPort, type AgentPromotionReceipt,
  type AgentPromotionResultMap, type AgentPromotionTarget } from '@agentmux/core/agent-promotion'
import { DEFAULT_MOTE_PRESENCE, type MotePreferencesTarget } from '@agentmux/core/mote-preferences'
import { ScratchTopics } from './mote-resources.js'
import type { WorkspaceRecord } from './content-types.js'
import { scratchTopicPhysicalPath, scratchTopicStorageRoots, SCRATCH_TOPIC_WIKI_PATH, SCRATCH_TOPIC_WIKI_STATE_PATH } from './mote-topic-model.js'
import { moteDirectoryName } from './mote-directory-identity.mjs'
import { directoryIdentity, homeZoneId } from './mote-model.js'
import { topicContentSpaceId } from './topic-categories.js'
import { parseMoteQuickMode, sameMoteDefaultConversation, serializeMoteQuickMode } from './mote-quick-mode.js'
import { readMoteQuickModeSource, moteQuickModeDefaults } from './mote-quick-mode-source.js'
import { assertPromotionEnabled } from './promotion-policy.js'

export type PromotionAgentInspection = { hostId: string; agentSessionId: string; runId: string | null; cwd: string; runtimeId: string }
type PromotionRecord = AgentPromotionApply & { version: 1 | 2; workspace: WorkspaceRecord; topicId: string; moteSpaceId: string;
  zoneId: string; directoryPath: string; conversation: AgentPromotionReceipt['conversation']; session: PromotionAgentInspection }
type LocatedRecord = { record: PromotionRecord; path: string }
const pending = new Map<string, Promise<unknown>>()
const scanPageSize = 32
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException).code === 'ENOENT'
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function fail(message: string, code = 'AGENT_PROMOTION_UNCONFIRMED'): never { throw new AgentMuxError(message, code) }
async function sync(path: string) { const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await file.sync() } finally { await file.close() } }
async function read(path: string): Promise<string | null> {
  let file
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) } catch (cause) { if (missing(cause)) return null; throw cause }
  try { const info = await file.stat(); if (!info.isFile() || info.size > 128 * 1024) fail('The original promotion file is not a bounded regular file.'); return await file.readFile('utf8') } finally { await file.close() }
}
async function publish(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  if (!(await lstat(dirname(path))).isDirectory()) fail('The original promotion directory is unconfirmed.')
  const temp = path + '.' + mintObjectId() + '.tmp'
  await durableWriteFile(temp, content, { requireDirectorySync: true })
  try { try { await link(temp, path) } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }; await sync(path); await sync(dirname(path)) }
  finally { await unlink(temp); await sync(dirname(path)) }
}
/** One Host content operation. Runtime inspection is borrowed; no start, stop, input or recovery port exists. */
export class HostAgentPromotions implements AgentPromotionPort {
  constructor(private readonly ports: { configurationPath: string; spatial: AgentMuxSpatialStateStore; scratch: ScratchTopics;
    workspace(): Promise<WorkspaceRecord>; files?: Pick<AgentMuxRpcFilesOwner, 'read'>;
    inspectAgent?(target: AgentPromotionTarget, context?: AgentMuxRpcCallContext): Promise<PromotionAgentInspection> }) {}
  private originPath(target: AgentPromotionTarget): string { return join(dirname(this.ports.configurationPath), 'agent-promotions', hash([target.hostId, target.agentSessionId]) + '.json') }
  private operationDirectory(target: AgentPromotionTarget): string { return join(dirname(this.originPath(target)), hash([target.hostId, target.agentSessionId])) }
  private operationPath(target: AgentPromotionTarget, operationId: string): string { return join(this.operationDirectory(target), hash(operationId) + '.json') }
  private async record(target: AgentPromotionTarget, path: string): Promise<LocatedRecord | null> {
    const content = await read(path); if (content === null) return null
    const raw = JSON.parse(content)
    if ((raw.version !== 1 && raw.version !== 2) || !isDeepStrictEqual(raw.target, target) || !raw.workspace || !raw.session ||
      raw.version === 1 && raw.destination !== undefined) fail('The original promotion record is unconfirmed.')
    // Version 1 already admitted a new Club and its Main. Keep that exact original object and promise.
    const record: PromotionRecord = raw.version === 1 ? { ...raw, destination: { kind: 'new-club' } } : raw
    const input = parseAgentPromotionParams('agent.promote.apply', { target: record.target, source: record.source,
      title: record.title, operationId: record.operationId, destination: record.destination })
    if (!isDeepStrictEqual(input.target, target) || record.session.hostId !== target.hostId || record.session.agentSessionId !== target.agentSessionId ||
      !record.session.runtimeId || !record.session.cwd || typeof record.workspace.id !== 'string' || typeof record.workspace.path !== 'string' || record.workspace.hostId !== 'local')
      fail('The original promotion record has another execution or content owner.')
    parseAgentPromotionResult('agent.promote.apply', { promotion: this.receipt(record, record.destination.kind === 'existing-club' ? 'spatial' : 'files') }, input)
    await sync(path); await sync(dirname(path))
    return { record, path }
  }
  private async exact(target: AgentPromotionTarget, operationId: string): Promise<LocatedRecord | null> {
    const operation = await this.record(target, this.operationPath(target, operationId))
    if (operation) {
      if (operation.record.operationId !== operationId) fail('The operation address belongs to another original request.', 'AGENT_PROMOTION_OPERATION_CONFLICT')
      return operation
    }
    // Confirmed absence selects the separately retained first operation; a failed read never changes targets.
    const origin = await this.record(target, this.originPath(target))
    return origin?.record.operationId === operationId ? origin : null
  }
  private issue(cause: unknown): AgentPromotionReceipt['unavailable'][number] {
    return { code: cause instanceof AgentMuxError ? cause.code : (cause as NodeJS.ErrnoException).code ?? 'AGENT_PROMOTION_UNCONFIRMED', message: cause instanceof Error ? cause.message : String(cause), recovery: 'Inspect this exact Agent promotion by its operationId, then explicitly apply its complete original request to continue. Original work remains available.' }
  }
  private receipt(record: PromotionRecord, stage: AgentPromotionReceipt['stage'], unavailable: AgentPromotionReceipt['unavailable'] = []): AgentPromotionReceipt {
    const { version: _version, workspace: _workspace, session: _session, ...original } = record
    return { ...original, stage, state: stage === 'complete' && !unavailable.length ? 'complete' : 'partial', diskDurability: unavailable.length ? 'unconfirmed' : 'confirmed', unavailable }
  }
  private club(graph: AgentMuxSpatialGraph, workspace: WorkspaceRecord, target: MotePreferencesTarget) {
    const space = graph.spaces.find(value => value.spaceId === target.spaceId), zone = graph.zones.find(value => value.zoneId === target.zoneId)
    if (target.expectedResource.hostId !== workspace.hostId || target.expectedResource.workspaceId !== workspace.id || target.expectedResource.workspacePath !== workspace.path ||
      !space || space.kind !== 'mote' || !space.topicId || space.hostId !== workspace.hostId || !zone || zone.zoneId !== homeZoneId(space.spaceId) ||
      zone.workspaceId !== workspace.id || zone.kind !== 'home' || zone.hostId !== workspace.hostId || zone.directoryPath !== space.directoryPath ||
      !graph.bindings.some(value => value.spaceId === space.spaceId && value.zoneId === zone.zoneId))
      fail('The exact original Club home is unconfirmed. Keep its original target and the healthy Agent.', 'AGENT_PROMOTION_HOME_UNCONFIRMED')
    return { space, zone }
  }
  private graph(record: PromotionRecord, graph: AgentMuxSpatialGraph): AgentMuxSpatialGraph {
    const next = structuredClone(graph)
    if (record.destination.kind === 'existing-club') {
      const selected = this.club(next, record.workspace, record.destination.target)
      if (selected.space.topicId !== record.topicId || selected.space.directoryPath !== record.directoryPath || selected.zone.zoneId !== record.zoneId)
        fail('The original Club identity changed. Keep this exact operation.', 'AGENT_PROMOTION_IDENTITY_CONFLICT')
    } else {
      const space = next.spaces.find(value => value.spaceId === record.moteSpaceId), zone = next.zones.find(value => value.zoneId === record.zoneId)
      if (space && (space.kind !== 'mote' || space.topicId !== record.topicId || space.hostId !== record.workspace.hostId || space.directoryPath !== record.directoryPath) || zone && (zone.workspaceId !== record.workspace.id || zone.hostId !== record.workspace.hostId || zone.directoryPath !== record.directoryPath))
        fail('The original Club resource conflicts with another object. All work is retained.', 'AGENT_PROMOTION_IDENTITY_CONFLICT')
      if (!space) next.spaces.push({ spaceId: record.moteSpaceId, kind: 'mote', topicId: record.topicId, name: record.title, hostId: record.workspace.hostId, directoryPath: record.directoryPath, projectId: null })
      if (!zone) next.zones.push({ zoneId: record.zoneId, workspaceId: record.workspace.id, hostId: record.workspace.hostId, directoryPath: record.directoryPath, kind: 'home', branch: null })
      if (!next.bindings.some(value => value.spaceId === record.moteSpaceId && value.zoneId === record.zoneId)) next.bindings.push({ spaceId: record.moteSpaceId, zoneId: record.zoneId })
      const origin = next.resources['zone:' + record.zoneId]
      if (origin !== undefined && !isDeepStrictEqual(origin, { spaceId: record.moteSpaceId, workspaceId: record.workspace.id, topicId: record.topicId, contentKind: 'mote' }))
        fail('The original Club home metadata changed. Keep this operation.', 'AGENT_PROMOTION_IDENTITY_CONFLICT')
      next.resources['zone:' + record.zoneId] = { spaceId: record.moteSpaceId, workspaceId: record.workspace.id, topicId: record.topicId, contentKind: 'mote' }
    }
    return associatePromotedAgent(next, { source: record.source, conversation: record.conversation, spaceId: record.moteSpaceId, zoneId: record.zoneId,
      workspaceId: record.workspace.id, hostId: record.workspace.hostId, directoryPath: record.directoryPath, title: record.title, topicId: record.topicId, session: record.session })
  }
  private async begin(input: AgentPromotionApply, context?: AgentMuxRpcCallContext): Promise<LocatedRecord> {
    await assertPromotionEnabled(this.ports.configurationPath)
    const workspace = await this.ports.workspace()
    if (workspace.hostId !== 'local') fail('The Club content must be owned by its original local Host.', 'AGENT_PROMOTION_RESOURCE_UNAVAILABLE')
    if (!this.ports.inspectAgent) fail('The original Agent inspection owner is unavailable. Keep the existing Agent.', 'AGENT_PROMOTION_SOURCE_UNCONFIRMED')
    const session = await this.ports.inspectAgent(input.target, context)
    if (session.agentSessionId !== input.target.agentSessionId || session.hostId !== input.target.hostId) fail('The original Agent inspection belongs to another target.', 'AGENT_PROMOTION_IDENTITY_CONFLICT')
    const state = await this.ports.spatial.read(); if (!state) fail('The original workface is unconfirmed. Keep the Agent and its original location.')
    const existing = input.destination.kind === 'existing-club' ? this.club(state.graph, workspace, input.destination.target) : null
    const topicId = existing?.space.topicId ?? 'launcher:' + mintObjectId()
    const directoryPath = existing?.space.directoryPath ?? join(scratchTopicStorageRoots(workspace.path).motes, moteDirectoryName(topicId))
    const moteSpaceId = existing?.space.spaceId ?? directoryIdentity(workspace.hostId, directoryPath)
    const record: PromotionRecord = { version: 2, ...input, workspace: structuredClone(workspace), session, topicId, directoryPath, moteSpaceId,
      zoneId: existing?.zone.zoneId ?? homeZoneId(moteSpaceId), conversation: { hostId: input.target.hostId, sessionId: input.target.agentSessionId,
        displayWorkspaceId: workspace.id, groupId: state.graph.layouts[workspace.id]?.activeGroupId ?? mintObjectId(), tabId: mintObjectId(), regionId: mintObjectId() } }
    this.graph(record, state.graph)
    context?.signal?.throwIfAborted(); await context?.assertCurrent?.()
    const path = this.operationPath(input.target, input.operationId)
    await publish(path, JSON.stringify(record) + '\n')
    return (await this.record(input.target, path))!
  }
  private async completed({ record, path }: LocatedRecord): Promise<boolean> {
    const marker = path + '.complete', content = await read(marker)
    if (content === null) return false
    if (content !== record.operationId + '\n') fail('The completion record belongs to another original operation.', 'AGENT_PROMOTION_OPERATION_CONFLICT')
    await sync(marker); await sync(dirname(marker))
    return true
  }
  private async stage(original: LocatedRecord): Promise<AgentPromotionReceipt['stage']> {
    const { record } = original
    if (await this.completed(original)) return 'complete'
    if (record.destination.kind === 'new-club') {
      const topic = await this.ports.scratch.read(record.workspace, record.topicId)
      if (!topic || topic.readError || topic.kind !== 'mote' || scratchTopicPhysicalPath(record.workspace, topic) !== record.directoryPath || topicContentSpaceId(record.workspace, topic) !== record.moteSpaceId) return 'files'
    }
    const state = await this.ports.spatial.read(); if (!state || !isDeepStrictEqual(this.graph(record, state.graph), state.graph)) return 'spatial'
    if (record.version === 2) return 'complete'
    const content = await read(join(record.directoryPath, 'MOTE.md')), mode = content === null ? null : parseMoteQuickMode(content)
    return mode?.status === 'valid' && sameMoteDefaultConversation(mode.defaults.conversation, record.conversation) && mode.defaults.presence?.enabled === false ? 'complete' : 'main'
  }
  private async inspect(original: LocatedRecord): Promise<AgentPromotionReceipt> {
    try {
      // A completion marker owns the historical outcome; current membership and authored settings do not rewrite it.
      if (await this.completed(original)) return this.receipt(original.record, 'complete')
      const stage = await this.stage(original)
      return stage === 'complete'
        ? this.receipt(original.record, original.record.version === 1 ? 'main' : 'spatial', [{ code: 'AGENT_PROMOTION_COMPLETION_UNCONFIRMED', message: 'The original association is available; its completion acknowledgement is unconfirmed.', recovery: 'Explicitly continue this exact original request to confirm completion.' }])
        : this.receipt(original.record, stage)
    } catch (cause) { return this.receipt(original.record, 'spatial', [this.issue(cause)]) }
  }
  private cursor(target: AgentPromotionTarget, after: string | null): string { return Buffer.from(JSON.stringify({ target: hash([target.hostId, target.agentSessionId]), after })).toString('base64url') }
  private after(input: AgentPromotionInspection): string | null {
    if (input.cursor === undefined) return null
    let cursor
    try { cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) } catch { fail('The original operation discovery cursor is invalid.', 'INVALID_CONTROL_REQUEST') }
    if (!cursor || Object.keys(cursor).sort().join(',') !== 'after,target' || cursor.target !== hash([input.target.hostId, input.target.agentSessionId]) ||
      cursor.after !== null && (typeof cursor.after !== 'string' || !/^(?:0-origin|1-[a-f0-9]{64}\.json)$/u.test(cursor.after)))
      fail('The operation cursor belongs to another Agent or source.', 'INVALID_CONTROL_REQUEST')
    return cursor.after
  }
  private async discover(input: AgentPromotionInspection): Promise<AgentPromotionDiscovery> {
    const after = this.after(input), paths: Array<{ key: string; path: string }> = [{ key: '0-origin', path: this.originPath(input.target) }]
    const issues: string[] = []
    let unread = false
    try {
      const directory = this.operationDirectory(input.target), info = await lstat(directory)
      if (!info.isDirectory() || info.isSymbolicLink()) fail('The original operation directory is unconfirmed.')
      for (const name of await readdir(directory)) if (/^[a-f0-9]{64}\.json$/u.test(name)) paths.push({ key: '1-' + name, path: join(directory, name) })
    } catch (cause) { if (!missing(cause)) { unread = true; issues.push(this.issue(cause).message) } }
    const remaining = paths.sort((a, b) => a.key.localeCompare(b.key)).filter(value => after === null || value.key > after), selected = remaining.slice(0, scanPageSize)
    const unfinished: AgentPromotionReceipt[] = []
    for (const item of selected) {
      try {
        const original = await this.record(input.target, item.path)
        if (!original || await this.completed(original)) continue
        const receipt = await this.inspect(original)
        if (unfinished.some(value => value.operationId === receipt.operationId)) fail('Two retained addresses claim the same original operation.', 'AGENT_PROMOTION_OPERATION_CONFLICT')
        unfinished.push(receipt)
      } catch (cause) { unread = true; issues.push(this.issue(cause).message) }
    }
    let nextCursor = remaining.length > selected.length ? this.cursor(input.target, selected.at(-1)!.key) : null
    if (unread && nextCursor === null) nextCursor = this.cursor(input.target, after)
    const clubs: AgentPromotionClub[] = [], memberships: AgentPromotionMembership[] = []
    try {
      const workspace = await this.ports.workspace(), state = await this.ports.spatial.read()
      if (!state) fail('Club membership is unconfirmed because its original spatial owner is unavailable.')
      for (const space of state.graph.spaces.filter(value => value.kind === 'mote' && value.hostId === workspace.hostId)) {
        const target: MotePreferencesTarget = { spaceId: space.spaceId, zoneId: homeZoneId(space.spaceId), expectedResource: { hostId: workspace.hostId, workspaceId: workspace.id, workspacePath: workspace.path } }
        try {
          this.club(state.graph, workspace, target)
          const choice = { title: space.name, directoryPath: space.directoryPath, target }; clubs.push(choice)
          const zones = new Set(state.graph.bindings.filter(binding => binding.spaceId === space.spaceId).map(binding => binding.zoneId))
          const tabs = new Set(state.graph.tabs.filter(tab => tab.zoneId !== null && zones.has(tab.zoneId)).map(tab => tab.tabId))
          const member = state.graph.regions.some(region => tabs.has(region.tabId) && region.kind === 'agent' && region.agentSessionId === input.target.agentSessionId && region.execution?.hostId === input.target.hostId)
          if (!member) continue
          let main: boolean | null = null
          try {
            if (!this.ports.files) fail('The original Main file reader is unavailable. Membership remains readable.')
            const current = moteQuickModeDefaults((await readMoteQuickModeSource(this.ports.files, target)).mode).conversation
            main = current?.hostId === input.target.hostId && current.sessionId === input.target.agentSessionId
          } catch (cause) { issues.push(this.issue(cause).message) }
          memberships.push({ ...choice, main })
        } catch (cause) { issues.push(this.issue(cause).message) }
      }
    } catch (cause) { issues.push(this.issue(cause).message) }
    return { pending: unfinished, clubs, memberships, nextCursor, issue: issues.length ? [...new Set(issues)].join('\n') : null }
  }
  private async advance(original: LocatedRecord, context?: AgentMuxRpcCallContext): Promise<AgentPromotionReceipt> {
    const { record } = original
    let stage: AgentPromotionReceipt['stage'] = record.destination.kind === 'existing-club' ? 'spatial' : 'files'
    try {
      if (await this.completed(original)) return this.receipt(record, 'complete')
      const workspace = await this.ports.workspace()
      if (workspace.id !== record.workspace.id || workspace.hostId !== record.workspace.hostId || workspace.path !== record.workspace.path) fail('The original Club resource changed. Restore its original resource before continuing.', 'AGENT_PROMOTION_IDENTITY_CONFLICT')
      if (record.destination.kind === 'new-club') {
        await this.ports.scratch.ensure(record.workspace, record.topicId, record.title, true)
        await this.ports.scratch.prepareMotePromotion(record.workspace, record.topicId)
        for (const name of ['topic.md', 'AGENTS.md', SCRATCH_TOPIC_WIKI_PATH, SCRATCH_TOPIC_WIKI_STATE_PATH]) await sync(join(record.directoryPath, name))
        await sync(join(record.directoryPath, '.agentmux')); await sync(record.directoryPath)
      }
      stage = 'spatial'
      stage = await this.stage(original)
      if (stage === 'files') fail('The original Club scaffold or identity is not yet confirmed.')
      if (stage === 'spatial') {
        const state = await this.ports.spatial.read(); if (!state) fail('The original spatial owner is unavailable.')
        context?.signal?.throwIfAborted(); await context?.assertCurrent?.()
        await this.ports.spatial.commit({ expectedRevision: state.revision, graph: this.graph(record, state.graph) })
      }
      // Only the already admitted first-format operation retains its original Main promise.
      if (record.version === 1) {
        stage = 'main'
        const content = serializeMoteQuickMode('', { conversation: record.conversation, conversationRevision: record.operationId, presence: { ...DEFAULT_MOTE_PRESENCE, enabled: false } })
        await publish(join(record.directoryPath, 'MOTE.md'), content)
      }
      if (await this.stage(original) !== 'complete') fail('The original association has not been confirmed. Keep its request and inspect the original owners.', 'AGENT_PROMOTION_COMPLETION_UNCONFIRMED')
      context?.signal?.throwIfAborted(); await context?.assertCurrent?.()
      await publish(original.path + '.complete', record.operationId + '\n')
      return this.receipt(record, 'complete')
    } catch (cause) { return this.receipt(record, stage === 'complete' ? 'spatial' : stage, [this.issue(cause)]) }
  }
  async call<M extends AgentPromotionMethod>(method: M, raw: AgentPromotionParamsMap[M], context?: AgentMuxRpcCallContext): Promise<AgentPromotionResultMap[M]> {
    const input = parseAgentPromotionParams(method, raw)
    if (method === 'agent.promote.inspect') {
      const query = input as AgentPromotionInspection
      const result = query.operationId === undefined ? { promotion: null, discovery: await this.discover(query) }
        : { promotion: await this.exact(query.target, query.operationId).then(original => original ? this.inspect(original) : null), discovery: null }
      return parseAgentPromotionResult(method, result, input)
    }
    const apply = input as AgentPromotionApply, key = this.originPath(input.target), previous = pending.get(key)
    const job = Promise.resolve(previous).catch(() => {}).then(async () => {
      const original = await this.exact(apply.target, apply.operationId) ?? await this.begin(apply, context)
      const { record } = original
      if (!isDeepStrictEqual(record.source, apply.source) || record.operationId !== apply.operationId || record.title !== apply.title || !isDeepStrictEqual(record.destination, apply.destination))
        fail('The original promotion request changed. Keep and continue its complete original input.', 'AGENT_PROMOTION_OPERATION_CONFLICT')
      return { promotion: await this.advance(original, context) }
    })
    pending.set(key, job)
    try { return parseAgentPromotionResult(method, await job, input) } finally { if (pending.get(key) === job) pending.delete(key) }
  }
}
