import { createHash } from 'node:crypto'
import { constants, link, lstat, mkdir, open, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, durableWriteFile, mintObjectId, type AgentMuxRpcCallContext, type AgentMuxSpatialGraph, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { associatePromotedAgent, parseAgentPromotionParams, parseAgentPromotionResult, type AgentPromotionApply, type AgentPromotionMethod, type AgentPromotionParamsMap, type AgentPromotionPort, type AgentPromotionReceipt, type AgentPromotionResultMap, type AgentPromotionTarget } from '@agentmux/core/agent-promotion'
import { DEFAULT_MOTE_PRESENCE } from '@agentmux/core/mote-preferences'
import { ScratchTopics } from './mote-resources.js'
import type { WorkspaceRecord } from './content-types.js'
import { scratchTopicPhysicalPath, SCRATCH_TOPIC_WIKI_PATH, SCRATCH_TOPIC_WIKI_STATE_PATH } from './mote-topic-model.js'
import { topicContentSpaceId } from './topic-categories.js'
import { parseMoteQuickMode, sameMoteDefaultConversation, serializeMoteQuickMode } from './mote-quick-mode.js'

type AcceptedAgentSnapshot = { hostId: string; agentSessionId: string; runId: string | null; cwd: string; runtimeId: string }
type Record = AgentPromotionApply & { version: 1; workspace: WorkspaceRecord; topicId: string; moteSpaceId: string; zoneId: string; directoryPath: string; conversation: AgentPromotionReceipt['conversation']; session: AcceptedAgentSnapshot }
const pending = new Map<string, Promise<unknown>>()
const missing = (cause: unknown) => (cause as NodeJS.ErrnoException).code === 'ENOENT'
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
/** Continue an originally accepted content operation from its frozen record. No Runtime control or admission port exists. */
export class HostAgentPromotions implements AgentPromotionPort {
  constructor(private readonly ports: { configurationPath: string; spatial: AgentMuxSpatialStateStore; scratch: ScratchTopics; workspace(): Promise<WorkspaceRecord> }) {}
  private path(target: AgentPromotionTarget): string { return join(dirname(this.ports.configurationPath), 'agent-promotions', createHash('sha256').update(JSON.stringify([target.hostId, target.agentSessionId])).digest('hex') + '.json') }
  private async record(target: AgentPromotionTarget): Promise<Record | null> {
    const content = await read(this.path(target)); if (content === null) return null
    const record = JSON.parse(content) as Record
    if (record.version !== 1 || !isDeepStrictEqual(record.target, target) || !record.workspace || !record.session) fail('The original promotion record is unconfirmed.')
    parseAgentPromotionParams('agent.promote.apply', { target: record.target, source: record.source, title: record.title, operationId: record.operationId })
    // Validate durable output identities through the same public codec used by every consumer.
    parseAgentPromotionResult('agent.promote.inspect', { promotion: { ...this.receipt(record, 'files'), unavailable: [] } }, { target })
    await sync(this.path(target)); await sync(dirname(this.path(target)))
    return record
  }
  private issue(cause: unknown): AgentPromotionReceipt['unavailable'][number] {
    return { code: cause instanceof AgentMuxError ? cause.code : (cause as NodeJS.ErrnoException).code ?? 'AGENT_PROMOTION_UNCONFIRMED', message: cause instanceof Error ? cause.message : String(cause), recovery: 'Inspect this original Agent promotion, then explicitly apply its complete original request with the same operationId. Original work remains available.' }
  }
  private receipt(record: Record, stage: AgentPromotionReceipt['stage'], unavailable: AgentPromotionReceipt['unavailable'] = []): AgentPromotionReceipt {
    const { version: _version, workspace: _workspace, session: _session, ...original } = record
    return { ...original, stage, state: stage === 'complete' && !unavailable.length ? 'complete' : 'partial', diskDurability: unavailable.length ? 'unconfirmed' : 'confirmed', unavailable }
  }
  private graph(record: Record, graph: AgentMuxSpatialGraph): AgentMuxSpatialGraph {
    const next = structuredClone(graph), space = next.spaces.find(value => value.spaceId === record.moteSpaceId), zone = next.zones.find(value => value.zoneId === record.zoneId)
    if (space && (space.kind !== 'mote' || space.topicId !== record.topicId || space.hostId !== record.workspace.hostId || space.directoryPath !== record.directoryPath) || zone && (zone.workspaceId !== record.workspace.id || zone.hostId !== record.workspace.hostId || zone.directoryPath !== record.directoryPath))
      fail('The original Mote resource conflicts with another object. All work is retained.', 'AGENT_PROMOTION_IDENTITY_CONFLICT')
    if (!space) next.spaces.push({ spaceId: record.moteSpaceId, kind: 'mote', topicId: record.topicId, name: record.title, hostId: record.workspace.hostId, directoryPath: record.directoryPath, projectId: null })
    if (!zone) next.zones.push({ zoneId: record.zoneId, workspaceId: record.workspace.id, hostId: record.workspace.hostId, directoryPath: record.directoryPath, kind: 'home', branch: null })
    if (!next.bindings.some(value => value.spaceId === record.moteSpaceId && value.zoneId === record.zoneId)) next.bindings.push({ spaceId: record.moteSpaceId, zoneId: record.zoneId })
    const origin = next.resources['zone:' + record.zoneId]
    if (origin !== undefined && !isDeepStrictEqual(origin, { spaceId: record.moteSpaceId, workspaceId: record.workspace.id, topicId: record.topicId, contentKind: 'mote' })) fail('The original Mote home metadata changed. Keep this operation.', 'AGENT_PROMOTION_IDENTITY_CONFLICT')
    next.resources['zone:' + record.zoneId] = { spaceId: record.moteSpaceId, workspaceId: record.workspace.id, topicId: record.topicId, contentKind: 'mote' }
    return associatePromotedAgent(next, { source: record.source, conversation: record.conversation, spaceId: record.moteSpaceId, zoneId: record.zoneId, workspaceId: record.workspace.id, hostId: record.workspace.hostId, directoryPath: record.directoryPath, title: record.title, topicId: record.topicId, session: record.session })
  }
  private async completed(record: Record): Promise<boolean> {
    const path = this.path(record.target) + '.complete', content = await read(path)
    if (content === null) return false
    if (content !== record.operationId + '\n') fail('The completion record belongs to another original operation.', 'AGENT_PROMOTION_OPERATION_CONFLICT')
    // File visibility is not a durable ACK. Confirm this same marker and its parent after an interrupted publication.
    await sync(path); await sync(dirname(path))
    return true
  }
  private async stage(record: Record): Promise<AgentPromotionReceipt['stage']> {
    if (await this.completed(record)) return 'complete'
    const topic = await this.ports.scratch.read(record.workspace, record.topicId)
    if (!topic || topic.readError || topic.kind !== 'mote' || scratchTopicPhysicalPath(record.workspace, topic) !== record.directoryPath || topicContentSpaceId(record.workspace, topic) !== record.moteSpaceId) return 'files'
    const state = await this.ports.spatial.read(); if (!state) return 'spatial'
    if (!isDeepStrictEqual(this.graph(record, state.graph), state.graph)) return 'spatial'
    const content = await read(join(record.directoryPath, 'MOTE.md')), mode = content === null ? null : parseMoteQuickMode(content)
    return mode?.status === 'valid' && sameMoteDefaultConversation(mode.defaults.conversation, record.conversation) && mode.defaults.presence?.enabled === false ? 'complete' : 'main'
  }
  async call<M extends AgentPromotionMethod>(method: M, raw: AgentPromotionParamsMap[M], context?: AgentMuxRpcCallContext): Promise<AgentPromotionResultMap[M]> {
    const input = parseAgentPromotionParams(method, raw), path = this.path(input.target)
    const work = async () => {
      const record = await this.record(input.target)
      if (record && input.operationId !== undefined && input.operationId !== record.operationId) fail('This Agent already has another original promotion. Inspect without an operation ID to discover it.', 'AGENT_PROMOTION_OPERATION_CONFLICT')
      if (method === 'agent.promote.inspect') {
        if (!record) return { promotion: null }
        try {
          const stage = await this.stage(record)
          if (stage === 'complete' && !await this.completed(record))
            return { promotion: this.receipt(record, 'main', [{ code: 'AGENT_PROMOTION_COMPLETION_UNCONFIRMED', message: 'The saved Mote is available; its original completion record is unconfirmed.', recovery: 'Explicitly continue this complete original request with its same operationId to confirm completion.' }]) }
          return { promotion: this.receipt(record, stage) }
        } catch (cause) { return { promotion: this.receipt(record, 'spatial', [this.issue(cause)]) } }
      }
      const apply = input as AgentPromotionApply
      if (!record) fail('New Agent promotions use Takeover at the selected Club. Inspect or continue an already accepted promotion with its complete original input.', 'AGENT_PROMOTION_ADMISSION_CLOSED')
      if (!isDeepStrictEqual(record.source, apply.source) || record.operationId !== apply.operationId || record.title !== apply.title) fail('The original promotion request changed. Keep and continue its complete original input.', 'AGENT_PROMOTION_OPERATION_CONFLICT')
      let stage: AgentPromotionReceipt['stage'] = 'main'
      try {
        if (await this.completed(record)) return { promotion: this.receipt(record, 'complete') }
        stage = 'files'
        const workspace = await this.ports.workspace()
        if (workspace.id !== record.workspace.id || workspace.hostId !== record.workspace.hostId || workspace.path !== record.workspace.path) fail('The original Mote resource changed. Restore the original resource before continuing.', 'AGENT_PROMOTION_IDENTITY_CONFLICT')
        await this.ports.scratch.ensure(record.workspace, record.topicId, record.title, true)
        await this.ports.scratch.prepareMotePromotion(record.workspace, record.topicId)
        for (const name of ['topic.md', 'AGENTS.md', SCRATCH_TOPIC_WIKI_PATH, SCRATCH_TOPIC_WIKI_STATE_PATH]) await sync(join(record.directoryPath, name))
        await sync(join(record.directoryPath, '.agentmux')); await sync(record.directoryPath)
        stage = 'spatial'
        stage = await this.stage(record)
        if (stage === 'files') fail('The original Mote scaffold or identity is not yet confirmed.')
        if (stage === 'spatial') {
          const state = await this.ports.spatial.read(); if (!state) fail('The original spatial owner is unavailable.')
          context?.signal?.throwIfAborted(); await context?.assertCurrent?.()
          await this.ports.spatial.commit({ expectedRevision: state.revision, graph: this.graph(record, state.graph) })
        }
        stage = 'main'
        const path = join(record.directoryPath, 'MOTE.md')
        const content = serializeMoteQuickMode('', { conversation: record.conversation, conversationRevision: record.operationId, presence: { ...DEFAULT_MOTE_PRESENCE, enabled: false } })
        await publish(path, content)
        if (await this.stage(record) !== 'complete') fail('The original MOTE.md has different authored settings. Preserve it and this promotion; inspect the original file before continuing.', 'AGENT_PROMOTION_MAIN_CONFLICT')
        await publish(this.path(record.target) + '.complete', record.operationId + '\n')
        return { promotion: this.receipt(record, 'complete') }
      } catch (cause) {
        return { promotion: this.receipt(record, stage === 'complete' ? 'main' : stage, [this.issue(cause)]) }
      }
    }
    if (method === 'agent.promote.inspect') return parseAgentPromotionResult(method, await work(), input)
    const previous = pending.get(path), job = Promise.resolve(previous).catch(() => {}).then(work)
    pending.set(path, job)
    try { return parseAgentPromotionResult(method, await job, input) } finally { if (pending.get(path) === job) pending.delete(path) }
  }
}
