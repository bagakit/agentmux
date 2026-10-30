import { createHash } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import { dirname, basename } from 'node:path'
import { spatialCatalog, AgentMuxError, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { DEFAULT_MOTE_PRESENCE, type MotePreferencesTarget, type MotePresenceReading } from '@agentmux/core/mote-preferences'
import type { MoteMainReader, MoteMainSnapshot } from '@agentmux/core/mote-dialogue'
import type { AgentMuxRpcFilesOwner } from '@agentmux/core/files'
import type { ContinuousProgressLoop } from '@agentmux/core'
import type { GoalExecutionClient } from './goal-runtime.js'
import type { ContinuousProgressLoopManager } from './continuous-progress-loop-manager.js'
import { parseMoteQuickMode } from './mote-quick-mode.js'
import { readOriginalMoteConfiguration } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { homeZoneId } from './mote-model.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const heartbeat = 'Check the current main conversation, its work threads, goals, constraints, decisions and unfinished commitments. Preserve the same Mote identity and task. Continue only useful already-authorized work; if nothing changed, stay quiet. This internal heartbeat grants no new permission and authorizes no external message.'
const key = (target: MotePreferencesTarget) => JSON.stringify(target)
export const motePresenceSourceId = (identity: NonNullable<MoteMainSnapshot['identity']>) => 'mote-main:' + digest(identity)

/** Mote policy adapts original files/roles to the one Host scheduler. No timer or input queue lives here. */
export function createHostMotePresence(options: {
  configurationPath: string; spatial: AgentMuxSpatialStateStore; files: AgentMuxRpcFilesOwner
  main: MoteMainReader; schedules: ContinuousProgressLoopManager
  clients(): readonly { hostId: string; client: GoalExecutionClient }[]
  subscribeClients?(listener: () => void): () => void
}) {
  const targets = new Map<string, MotePreferencesTarget>(), dirty = new Set<string>()
  const sourceTargets = new Map<string,string>(), executionTargets = new Map<string,Set<string>>(), targetExecutions = new Map<string,string>()
  const executionKey = (hostId: string, sid: string) => JSON.stringify([hostId,sid])
  const readings = new Map<string, MotePresenceReading>(), watchers = new Map<string, { path: string; watcher: FSWatcher }>()
  let discovery = true, closed = false, watching: FSWatcher | undefined, serviceIssue: string | undefined
  const exact = (hostId: string) => {
    const matches = options.clients().filter(value => value.hostId === hostId)
    if (matches.length !== 1) throw new AgentMuxError('The exact original Mote execution Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
    return matches[0]!.client
  }
  const invalidate = (target: MotePreferencesTarget) => { const id = key(target); targets.set(id, target); dirty.add(id) }
  async function discover() {
    const [configuration, state] = await Promise.all([readOriginalMoteConfiguration(options.configurationPath), options.spatial.read()])
    const workspaces = configuration && typeof configuration === 'object' && 'workspaces' in configuration && Array.isArray(configuration.workspaces) ? configuration.workspaces : []
    const homes = workspaces.filter(value => value && typeof value === 'object' && value.id === SCRATCH_WORKSPACE_ID && value.hostId === 'local' && typeof value.path === 'string')
    if (homes.length !== 1 || !state) throw new Error('The original Mote configuration or spatial source is unconfirmed.')
    for (const space of spatialCatalog(state.graph).spaces) if (space.kind === 'mote' && space.hostId === homes[0].hostId) invalidate({ spaceId: space.spaceId, zoneId: homeZoneId(space.spaceId), expectedResource: { hostId: homes[0].hostId, workspaceId: homes[0].id, workspacePath: homes[0].path } })
  }
  async function qualify(loop: ContinuousProgressLoop) {
    if (!loop.managedSource) return
    const targetId = sourceTargets.get(loop.managedSource.sourceId), target = targetId ? targets.get(targetId) : undefined
    if (!target) throw new Error('The original Mote maintenance source is not registered.')
    const main = await options.main.readCurrentMoteMain(target)
    if (main.status !== 'ready' || !main.identity || !main.current || main.roleRevision !== loop.managedSource.revision || motePresenceSourceId(main.identity) !== loop.managedSource.sourceId || main.current.hostId !== loop.hostId || main.current.sessionId !== loop.agentSessionId) throw new Error('The original main role changed or is unconfirmed.')
    const file = await options.files.read({ ...target, path: 'MOTE.md' })
    const parsed = file.result.status === 'read' ? parseMoteQuickMode(file.result.document.content) : null
    if (parsed?.status !== 'valid' || !(parsed.defaults.presence ?? DEFAULT_MOTE_PRESENCE).enabled) throw new Error('The original standing maintenance was disabled or is unconfirmed.')
    await options.main.assertCurrent(main)
  }
  async function reconcile(target: MotePreferencesTarget) {
    const id = key(target)
    try {
      const main = await options.main.readCurrentMoteMain(target)
      if (main.status !== 'ready' || !main.identity || !main.resource || !main.roleRevision) throw new Error(main.issue ?? 'The original main role is unconfirmed.')
      if (watchers.get(id)?.path !== main.resource.zonePath) {
        watchers.get(id)?.watcher.close(); watchers.delete(id)
        try {
          const watcher = watch(main.resource.zonePath, (_event, name) => { if (name === null || String(name) === 'MOTE.md') dirty.add(id) })
          watcher.on('error', error => { readings.set(id, { status: 'unconfirmed', schedule: readings.get(id)?.schedule ?? null, issue: 'Observing original Mote settings failed: ' + String(error) }); dirty.add(id) })
          watchers.set(id, { path: main.resource.zonePath, watcher })
        } catch (error) { readings.set(id, { status: 'unconfirmed', schedule: null, issue: 'Original Mote settings watcher is unavailable: ' + String(error) }) }
      }
      const file = await options.files.read({ ...target, path: 'MOTE.md' }), parsed = file.result.status === 'read' ? parseMoteQuickMode(file.result.document.content) : null
      if (parsed?.status !== 'valid') throw new Error('The original maintenance configuration is unconfirmed.')
      const preference = parsed.defaults.presence ?? DEFAULT_MOTE_PRESENCE, sourceId = motePresenceSourceId(main.identity)
      sourceTargets.set(sourceId,id)
      const previous = targetExecutions.get(id), next = main.current ? executionKey(main.current.hostId,main.current.sessionId) : undefined
      if (previous !== next) {
        if (previous) { const entries = executionTargets.get(previous); entries?.delete(id); if (!entries?.size) executionTargets.delete(previous) }
        targetExecutions.delete(id)
        if (next) { const entries = executionTargets.get(next) ?? new Set<string>(); entries.add(id); executionTargets.set(next,entries); targetExecutions.set(id,next) }
      }
      const arrangements = options.schedules.listManaged(sourceId)
      // Rebinding revokes only future actions. Claimed/unknown records stay on their original target.
      for (const loop of arrangements) if (loop.status !== 'stopped' && (loop.managedSource!.revision !== main.roleRevision || !preference.enabled || !main.current)) {
        const method = loop.managedSource!.revision === main.roleRevision && main.current && !preference.enabled ? 'schedule.pause' : 'schedule.cancel'
        if (method === 'schedule.pause' && loop.status === 'paused') continue
        await options.schedules.call(method, { scheduleId: loop.loopId, expectedRevision: loop.revision!, operationId: 'mote-revoke-' + digest([loop.loopId, loop.revision, main.roleRevision, preference.enabled]) })
      }
      const current = options.schedules.listManaged(sourceId).filter(value => value.managedSource?.revision === main.roleRevision)
      let loop = current.find(value => value.status !== 'stopped') ?? current[0]
      if (!preference.enabled || !main.current) { readings.set(id, { status: !preference.enabled ? 'disabled' : 'unbound', schedule: loop ?? null, issue: null }); return }
      const client = exact(main.current.hostId), original = await client.inspectAgentCreation(main.current.sessionId)
      if (original.kind !== 'agent') {
        if (loop?.status === 'active') await options.schedules.call('schedule.pause', { scheduleId: loop.loopId, expectedRevision: loop.revision!, operationId: 'mote-retired-' + digest([loop.loopId, loop.revision]) })
        throw new Error('The original main Agent was explicitly retired. Its identity is retained; select or explicitly restore that original role.')
      }
      if (original.agentSessionId !== main.current.sessionId || original.hostId !== 'local' && original.hostId !== main.current.hostId) throw new Error('The original main execution identity changed.')
      await options.main.assertCurrent(main)
      if (!loop) loop = (await options.schedules.call('schedule.create', { target: { hostId: main.current.hostId, agentSessionId: original.agentSessionId, providerId: original.providerId, workspacePath: original.workspacePath }, everyMs: preference.intervalMs, prompt: heartbeat, managedSource: { sourceId, revision: main.roleRevision }, operationId: 'mote-presence-' + digest([sourceId, main.roleRevision]) })).schedule
      if (loop.status !== 'stopped' && loop.everyMs !== preference.intervalMs) loop = (await options.schedules.call('schedule.update', { scheduleId: loop.loopId, expectedRevision: loop.revision!, operationId: 'mote-interval-' + digest([loop.loopId, loop.revision, preference.intervalMs]), everyMs: preference.intervalMs })).schedule
      readings.set(id, { status: loop.status === 'active' ? 'active' : 'paused', schedule: loop, issue: loop.status === 'active' ? null : loop.status === 'stopped'
        ? 'The original automatic arrangement was stopped. Inspect its retained record and explicitly configure any future automatic work.'
        : loop.lastDecision ?? 'Original automatic maintenance is paused. Resume that exact arrangement explicitly.' })
      if (loop.status !== 'active') return
      const observed = await client.statusAgent(original.agentSessionId)
      if (observed.run.state === 'running') return
      if (observed.run.exitCode === 0 || observed.run.exitReason === 'user-stopped' || observed.session.continuity?.supervision?.cancellation) {
        loop = (await options.schedules.call('schedule.pause', { scheduleId: loop.loopId, expectedRevision: loop.revision!, operationId: 'mote-ended-' + digest([loop.loopId, observed.session.run]) })).schedule
        readings.set(id, { status: 'paused', schedule: loop, issue: 'The original Agent exited normally or was cancelled. Resume the original arrangement explicitly.' }); return
      }
      await options.main.assertCurrent(main)
      const operationId = 'mote-maintain-' + digest([sourceId, main.roleRevision, observed.session.run])
      const recovered = await client.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: observed.session.run, operationId, trigger: 'standing-maintenance', standingIntent: { ...loop.managedSource!, intentId: loop.futureIntentId!, operationId: loop.creationOperationId! }, policy: { continuationEnabled: false, reminderMode: 'off' } })
      if (recovered.kind !== 'resumed' && recovered.kind !== 'reattachable') throw new Error(`Original maintenance recovery is ${recovered.kind}; inspect ${operationId}.`)
    } catch (error) { readings.set(id, { status: 'unconfirmed', schedule: readings.get(id)?.schedule ?? null, issue: String(error) }) }
  }
  const releaseScheduler = options.schedules.setMaintenanceOwner({ qualify, async maintain() {
    if (closed) return
    serviceIssue = undefined
    if (discovery) { discovery = false; try { await discover() } catch (error) { discovery = true; for (const id of targets.keys()) readings.set(id, { status: 'unconfirmed', schedule: readings.get(id)?.schedule ?? null, issue: String(error) }) } }
    // A headless Run need not have an output Attachment publishing exit events.
    // The existing scheduler cadence observes only its active main roles; an
    // ended Run still goes through the original source/role checks in reconcile.
    for (const [id, reading] of readings) {
      if (reading.status === 'unconfirmed') dirty.add(id)
      const loop = reading.schedule && options.schedules.inspectLoop(reading.schedule.loopId)
      if (!loop || loop.status !== 'active' || dirty.has(id)) continue
      try {
        const observed = await exact(loop.hostId).statusAgent(loop.agentSessionId)
        if (observed.run.state !== 'running') dirty.add(id)
      } catch (error) {
        readings.set(id, { status: 'unconfirmed', schedule: loop, issue: 'Observing the original main Run is unconfirmed. Its identity and manual input are retained: ' + String(error) })
        dirty.add(id)
      }
    }
    for (const id of [...dirty]) { dirty.delete(id); const target = targets.get(id); if (target) await reconcile(target) }
  } })
  const releaseScheduleEvents = options.schedules.subscribe(loop => {
    const id = loop.managedSource && sourceTargets.get(loop.managedSource.sourceId)
    if (id) dirty.add(id)
  })
  let spatialSignature: string | undefined
  const releaseSpatial = options.spatial.subscribe(state => {
    const motes = state.graph.spaces.filter(value => value.kind === 'mote'), ids = new Set(motes.map(value => value.spaceId)), homes = new Set(motes.map(value => homeZoneId(value.spaceId)))
    const signature = JSON.stringify([motes.map(value => [value.spaceId,value.topicId,value.hostId,value.directoryPath]), state.graph.zones.filter(value => homes.has(value.zoneId)), state.graph.bindings.filter(value => ids.has(value.spaceId))])
    if (signature !== spatialSignature) { spatialSignature = signature; discovery = true }
  })
  const events = new Map<string, { client: GoalExecutionClient; release(): void }>()
  function subscribeClients() {
    const clients = options.clients(), unique = clients.filter(value => clients.filter(item => item.hostId === value.hostId).length === 1)
    const desired = new Map(unique.map(value => [value.hostId,value.client]))
    for (const [hostId,entry] of events) if (desired.get(hostId) !== entry.client) { entry.release(); events.delete(hostId) }
    for (const { client, hostId } of unique) if (!events.has(hostId)) events.set(hostId, { client, release: client.onEvent(event => {
      if (events.get(hostId)?.client !== client) return
      if (event.type === 'connection-state') { for (const id of targets.keys()) dirty.add(id); return }
      if (event.type !== 'process-state' && event.type !== 'agent-session') return
      const sid = event.type === 'agent-session' ? event.session.agentSessionId : event.agentSessionId
      if (sid) for (const id of executionTargets.get(executionKey(hostId,sid)) ?? []) dirty.add(id)
    }) })
  }
  let releaseClients: (() => void) | undefined
  return { invalidate, read(target: MotePreferencesTarget): MotePresenceReading {
    if (serviceIssue) return { status: 'unconfirmed', schedule: readings.get(key(target))?.schedule ?? null, issue: serviceIssue }
    const reading = readings.get(key(target)); if (!reading) return { status: 'unconfirmed', schedule: null, issue: 'The original Host maintenance observation has not completed.' }
    const schedule = reading.schedule ? options.schedules.inspectLoop(reading.schedule.loopId) ?? reading.schedule : null
    return { ...reading, schedule, ...(schedule?.status === 'paused' && reading.status === 'active' ? { status: 'paused' as const, issue: schedule.lastDecision ?? reading.issue } : {}) }
  }, async start() {
      try {
        subscribeClients(); releaseClients = options.subscribeClients?.(() => { subscribeClients(); for (const id of targets.keys()) dirty.add(id) })
        try { watching = watch(dirname(options.configurationPath), (_event,name) => { if (name === null || String(name) === basename(options.configurationPath)) discovery = true }); watching.on('error', () => { discovery = true }) } catch { discovery = true }
        await options.schedules.start()
      } catch (error) { serviceIssue = 'Starting original Mote maintenance is unconfirmed. The Host, Agents and manual input remain available. Inspect the original schedule owner: ' + String(error) }
    },
    dispose() { closed = true; releaseScheduler(); releaseScheduleEvents(); releaseSpatial(); watching?.close(); releaseClients?.(); for (const entry of watchers.values()) entry.watcher.close(); for (const entry of events.values()) entry.release() } }
}
