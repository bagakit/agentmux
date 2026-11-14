import { optionalInputEpoch } from '@agentmux/core/prompt-condition'
import { awaitUntilCancelled } from './await-until-cancelled.js'
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { watch, type FSWatcher } from 'node:fs'
import { dirname, basename } from 'node:path'
import { spatialCatalog, AgentMuxError, type AgentMuxSpatialStateStore } from '@agentmux/core'
import { DEFAULT_MOTE_PRESENCE, type MotePreferencesTarget, type MotePresenceReading, type MoteQuickPreferencesSaveParams, type MoteQuickPreferencesSaveResult } from '@agentmux/core/mote-preferences'
import type { ConnectionEnrollmentCallContext } from '@agentmux/core/connections'
import { MOTE_SUPERVISION_GUIDANCE, type MoteMainReader, type MoteMainSnapshot } from '@agentmux/core/mote-dialogue'
import type { AgentMuxRpcFilesOwner } from '@agentmux/core/files'
import type { ContinuousProgressLoop } from '@agentmux/core'
import type { MoteHeartbeatSource, MoteDialogueCallContext } from '@agentmux/core/mote-dialogue'
import { assertScheduledInputSource, scheduledDefinitionOperation } from './scheduled-input-source.js'
import type { GoalExecutionClient } from './goal-runtime.js'
import { MAINTENANCE_RETRY_LIMIT_MS, MAINTENANCE_RETRY_MS, type ContinuousProgressLoopManager, type MaintenanceSourceDecision } from './continuous-progress-loop-manager.js'
import { readMoteQuickModeSource, moteQuickModeDefaults } from './mote-quick-mode-source.js'
import { readOriginalMoteConfiguration } from './mote-resources.js'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { homeZoneId } from './mote-model.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const heartbeat = (target: MotePreferencesTarget) => 'Mote main heartbeat.\n\n' + MOTE_SUPERVISION_GUIDANCE +
  '\n\nRead the original supervision page with this exact input:\n' + JSON.stringify({ target })
export const moteGuidanceRevision = () => 'sha256:' + digest(MOTE_SUPERVISION_GUIDANCE)
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
  // An unconfirmed Mote is read again after a doubling wait, not on every scheduler tick. Any change event reads it at once.
  const retries = new Map<string, { at: number; waitMs: number }>()
  const targetChecks = new Map<string, Promise<void>>()
  let discovering: Promise<void> | undefined
  let discovery = true, closed = false, watching: FSWatcher | undefined, serviceIssue: string | undefined
  const exact = (hostId: string) => {
    const matches = options.clients().filter(value => value.hostId === hostId)
    if (matches.length !== 1) throw new AgentMuxError('The exact original Mote execution Host is unavailable or ambiguous.', 'CONTROL_UNAVAILABLE')
    return matches[0]!.client
  }
  const invalidate = (target: MotePreferencesTarget) => { const id = key(target); targets.set(id, target); dirty.add(id) }
  async function qualifyHeartbeatSource(source: MoteHeartbeatSource, main: MoteMainSnapshot, context: MoteDialogueCallContext) {
    const loop = options.schedules.inspectLoop(source.scheduleId), caller = context.caller
    if (!main.identity || !loop?.managedSource || motePresenceSourceId(main.identity) !== loop.managedSource.sourceId || loop.managedSource.revision !== source.mainRoleRevision ||
        source.inputKey.agentSessionId !== loop.agentSessionId || !caller?.run || caller.hostId !== loop.hostId || caller.agentSessionId !== loop.agentSessionId || !isDeepStrictEqual(caller.run, source.inputKey.expectedRun) || !context.readInput)
      throw new AgentMuxError('Only this original heartbeat input participant may report its work statement. Existing inputs and Agents remain available.', 'CONTROL_PERMISSION_DENIED')
    const operationId = scheduledDefinitionOperation(loop, source.definitionIntentId)
    if (!operationId) throw new AgentMuxError('The original heartbeat definition is unconfirmed.', 'SCHEDULE_INPUT_SOURCE_UNCONFIRMED')
    const record = await context.readInput(loop.hostId, source.inputKey)
    const intent = await exact(loop.hostId).readAgentFuturePromptIntent(loop.agentSessionId, source.definitionIntentId)
    assertScheduledInputSource(loop, { inputKey: source.inputKey, futureIntent: { intentId: source.definitionIntentId, occurrenceAt: source.occurrenceAt }, definitionOperationId: operationId, managedSource: loop.managedSource }, record, intent)
    // A historical source remains historical across Main changes. Recheck only
    // this original Mote identity, without granting current-role ownership.
    const fresh = await options.main.readCurrentMoteMain(main.target, context.signal)
    if (fresh.status !== 'ready' || !fresh.identity || motePresenceSourceId(fresh.identity) !== loop.managedSource.sourceId)
      throw new AgentMuxError('The original Mote source identity is unconfirmed. Keep this same report operation.', 'SCHEDULE_INPUT_SOURCE_UNCONFIRMED')
    context.signal?.throwIfAborted(); await context.assertCurrent?.()
  }
  async function adoptGuidance(input: MoteQuickPreferencesSaveParams, before: MoteMainSnapshot, context: ConnectionEnrollmentCallContext, mode?: { reconcilePublished: true }): Promise<NonNullable<MoteQuickPreferencesSaveResult['maintenanceAdoption']>> {
    const action = input.action
    if (!action || !['user', 'device'].includes(context.actor.kind) || !context.actor.id.trim()) throw new AgentMuxError('Adopting future guidance requires the original authenticated person or device.', 'CONTROL_PERMISSION_DENIED')
    const loop = options.schedules.inspectLoop(action.expectedSchedule.loopId)
    if (!loop) throw new AgentMuxError('The original Mote arrangement is unconfirmed.', 'UNKNOWN_SCHEDULE')
    const prior = loop.guidanceAdoptions?.find(value => value.operationId === input.operationId)
    if (!prior && action.guidanceRevision !== moteGuidanceRevision()) throw new AgentMuxError('The available guidance changed. Reread the original settings before adopting it.', 'SCHEDULE_REVISION_CONFLICT')
    const qualify = async (current: ContinuousProgressLoop) => {
      await options.main.assertCurrent(before, context.signal)
      const fresh = await options.main.readCurrentMoteMain(input.target, context.signal)
      if (fresh.status !== 'ready' || !fresh.identity || !fresh.current || fresh.roleRevision !== action.expectedMain.roleRevision ||
          !isDeepStrictEqual(fresh.current, action.expectedMain.reference) || !isDeepStrictEqual(before.current, fresh.current) ||
          current.managedSource?.sourceId !== motePresenceSourceId(fresh.identity) || current.managedSource.revision !== fresh.roleRevision ||
          current.hostId !== fresh.current.hostId || current.agentSessionId !== fresh.current.sessionId)
        throw new AgentMuxError('The original Mote Main or its role generation changed. Its existing Agent and inputs remain retained.', 'SCHEDULE_REVISION_CONFLICT')
      const original = await exact(current.hostId).inspectAgentCreation(current.agentSessionId)
      if (original.kind !== 'agent' || original.agentSessionId !== current.agentSessionId || original.providerId !== current.providerId || original.workspacePath !== current.workspacePath)
        throw new AgentMuxError('The original Mote execution target is unconfirmed.', 'STALE_AGENT_SESSION')
      await options.main.assertCurrent(fresh, context.signal)
    }
    const actor = { kind: context.actor.kind as 'user' | 'device', id: context.actor.id }
    return await options.schedules.adoptGuidance({ loopId: loop.loopId, expectedRevision: action.expectedSchedule.revision,
      expectedDefinition: action.expectedDefinition, operationId: input.operationId, requestDigest: digest({ input, actor }), actor,
      ...(mode?.reconcilePublished ? { publishedOnly: true as const } : {}),
      guidanceRevision: action.guidanceRevision,
      guidance: 'The original person or device explicitly adopted this current application guidance for future Mote heartbeats. Current user corrections and authorization limits continue to govern this same task.\n\n' + MOTE_SUPERVISION_GUIDANCE + '\n\nRead the original supervision page with this exact input:\n' + JSON.stringify({ target: input.target }) },
      qualify, { principal: actor, ...(context.signal ? { signal: context.signal } : {}), ...(context.assertCurrent ? { assertCurrent: context.assertCurrent } : {}) })
  }
  async function discover(signal?: AbortSignal) {
    const [configuration, state] = await Promise.all([readOriginalMoteConfiguration(options.configurationPath), options.spatial.read()])
    if (closed || signal?.aborted) return
    const workspaces = configuration && typeof configuration === 'object' && 'workspaces' in configuration && Array.isArray(configuration.workspaces) ? configuration.workspaces : []
    const homes = workspaces.filter(value => value && typeof value === 'object' && value.id === SCRATCH_WORKSPACE_ID && value.hostId === 'local' && typeof value.path === 'string')
    if (homes.length !== 1 || !state) throw new Error('The original Mote configuration or spatial source is unconfirmed.')
    for (const space of spatialCatalog(state.graph).spaces) if (space.kind === 'mote' && space.hostId === homes[0].hostId) invalidate({ spaceId: space.spaceId, zoneId: homeZoneId(space.spaceId), expectedResource: { hostId: homes[0].hostId, workspaceId: homes[0].id, workspacePath: homes[0].path } })
  }
  /** Confirmed role or preference changes pause the arrangement; anything not yet readable only skips this occurrence. */
  async function qualify(loop: ContinuousProgressLoop): Promise<MaintenanceSourceDecision> {
    if (!loop.managedSource) return { action: 'continue' }
    const targetId = sourceTargets.get(loop.managedSource.sourceId), target = targetId ? targets.get(targetId) : undefined
    if (!target) return { action: 'defer', reason: 'The original Mote maintenance source is not registered yet.' }
    const main = await options.main.readCurrentMoteMain(target)
    if (main.status !== 'ready' || !main.identity) return { action: 'defer', reason: main.issue ?? 'The original main role is unconfirmed.' }
    if (!main.current || main.roleRevision !== loop.managedSource.revision || motePresenceSourceId(main.identity) !== loop.managedSource.sourceId ||
      main.current.hostId !== loop.hostId || main.current.sessionId !== loop.agentSessionId) return { action: 'pause', pauseReason: 'source-changed', reason: 'The original main role changed.' }
    const { mode } = await readMoteQuickModeSource(options.files, target)
    if (mode.status === 'unconfirmed') return { action: 'defer', reason: mode.message }
    if (!(moteQuickModeDefaults(mode).presence ?? DEFAULT_MOTE_PRESENCE).enabled) return { action: 'pause', pauseReason: 'source-disabled', reason: 'The original standing maintenance was disabled.' }
    await options.main.assertCurrent(main)
    return { action: 'continue' }
  }
  async function reconcile(target: MotePreferencesTarget, signal: AbortSignal) {
    const id = key(target)
    const assertOpen = () => { signal.throwIfAborted(); if (closed) throw new Error('The original Mote maintenance owner was closed.') }
    const read = <T>(task: () => Promise<T>) => awaitUntilCancelled(task, signal)
    try {
      const main = await read(() => options.main.readCurrentMoteMain(target))
      if (main.status !== 'ready' || !main.identity || !main.resource || !main.roleRevision) throw new Error(main.issue ?? 'The original main role is unconfirmed.')
      if (watchers.get(id)?.path !== main.resource.zonePath) {
        watchers.get(id)?.watcher.close(); watchers.delete(id)
        try {
          const watcher = watch(main.resource.zonePath, (_event, name) => { if (name === null || String(name) === 'MOTE.md') dirty.add(id) })
          watcher.on('error', error => { readings.set(id, { status: 'unconfirmed', schedule: readings.get(id)?.schedule ?? null, issue: 'Observing original Mote settings failed: ' + String(error) }); dirty.add(id) })
          watchers.set(id, { path: main.resource.zonePath, watcher })
        } catch (error) { if (closed || signal.aborted) return; readings.set(id, { status: 'unconfirmed', schedule: null, issue: 'Original Mote settings watcher is unavailable: ' + String(error) }) }
      }
      const { mode } = await read(() => readMoteQuickModeSource(options.files, target))
      const preference = moteQuickModeDefaults(mode).presence ?? DEFAULT_MOTE_PRESENCE, sourceId = motePresenceSourceId(main.identity)
      sourceTargets.set(sourceId,id)
      const previous = targetExecutions.get(id), next = main.current ? executionKey(main.current.hostId,main.current.sessionId) : undefined
      if (previous !== next) {
        if (previous) { const entries = executionTargets.get(previous); entries?.delete(id); if (!entries?.size) executionTargets.delete(previous) }
        targetExecutions.delete(id)
        if (next) { const entries = executionTargets.get(next) ?? new Set<string>(); entries.add(id); executionTargets.set(next,entries); targetExecutions.set(id,next) }
      }
      await read(() => options.main.assertCurrent(main)); assertOpen()
      const arrangements = options.schedules.listManaged(sourceId)
      // Rebinding revokes only future actions. Claimed/unknown records stay on their original target.
      for (const loop of arrangements) if (loop.status !== 'stopped' && (loop.managedSource!.revision !== main.roleRevision || !preference.enabled || !main.current)) {
        const method = loop.managedSource!.revision === main.roleRevision && main.current && !preference.enabled ? 'schedule.pause' : 'schedule.cancel'
        if (method === 'schedule.pause' && loop.status === 'paused') continue
        await options.schedules.call(method, { scheduleId: loop.loopId, expectedRevision: loop.revision!, operationId: 'mote-revoke-' + digest([loop.loopId, loop.revision, main.roleRevision, preference.enabled]) }, undefined, 'source-disabled')
      }
      const current = options.schedules.listManaged(sourceId).filter(value => value.managedSource?.revision === main.roleRevision)
      let loop = current.find(value => value.status !== 'stopped') ?? current[0]
      if (!preference.enabled || !main.current) { readings.set(id, { status: !preference.enabled ? 'disabled' : 'unbound', schedule: loop ?? null, issue: null }); return }
      const client = exact(main.current.hostId)
      const assertExecutionCurrent = () => {
        assertOpen()
        if (exact(main.current!.hostId) !== client) throw new AgentMuxError('The original Mote execution owner changed during observation. Its Session and input are retained.', 'STALE_AGENT_SESSION')
      }
      const original = await read(() => client.inspectAgentCreation(main.current!.sessionId))
      assertExecutionCurrent()
      if (original.kind !== 'agent') {
        if (loop?.status === 'active') await options.schedules.call('schedule.pause', { scheduleId: loop.loopId, expectedRevision: loop.revision!, operationId: 'mote-retired-' + digest([loop.loopId, loop.revision]) }, undefined, 'execution-ended')
        throw new Error('The original main Agent was explicitly retired. Its identity is retained; select or explicitly restore that original role.')
      }
      if (original.agentSessionId !== main.current.sessionId || original.hostId !== 'local' && original.hostId !== main.current.hostId) throw new Error('The original main execution identity changed.')
      await read(() => options.main.assertCurrent(main)); assertOpen()
      if (!loop) loop = (await options.schedules.call('schedule.create', { ...optionalInputEpoch(original.creation?.inputEpoch),target: { hostId: main.current.hostId, agentSessionId: original.agentSessionId, providerId: original.providerId, workspacePath: original.workspacePath }, everyMs: preference.intervalMs, prompt: heartbeat(target), managedSource: { sourceId, revision: main.roleRevision }, operationId: 'mote-presence-' + digest([sourceId, main.roleRevision]) })).schedule
      else if (loop.status === 'paused' && loop.lastOutcome === 'unknown' && !loop.lastTickId && !loop.pendingCompletion && !loop.lastMutation) {
        // This is the original unconfirmed configuration write, not an unknown input.
        // Reuse its complete immutable request; the original scheduler converges the same Future Intent.
        loop = (await options.schedules.call('schedule.create', { ...optionalInputEpoch(loop.inputEpoch),target: { hostId: loop.hostId, agentSessionId: loop.agentSessionId, providerId: loop.providerId, workspacePath: loop.workspacePath }, everyMs: loop.everyMs!, prompt: loop.prompt, managedSource: loop.managedSource!, operationId: loop.creationOperationId! })).schedule
      }
      if (loop.status !== 'stopped' && loop.everyMs !== preference.intervalMs) loop = (await options.schedules.call('schedule.update', { scheduleId: loop.loopId, expectedRevision: loop.revision!, operationId: 'mote-interval-' + digest([loop.loopId, loop.revision, preference.intervalMs]), everyMs: preference.intervalMs })).schedule
      readings.set(id, { status: loop.status === 'active' ? 'active' : 'paused', schedule: loop, issue: loop.status === 'active' ? null : loop.status === 'stopped'
        ? 'The original automatic arrangement was stopped. Inspect its retained record and explicitly configure any future automatic work.'
        : loop.lastDecision ?? 'Original automatic maintenance is paused. Resume that exact arrangement explicitly.' })
      if (loop.status !== 'active') return
      const observed = await read(() => client.statusAgent(original.agentSessionId))
      assertExecutionCurrent()
      if (observed.run.state === 'running') return
      if (observed.run.exitCode === 0 || observed.run.exitReason === 'user-stopped' || observed.session.continuity?.supervision?.cancellation) {
        loop = (await options.schedules.call('schedule.pause', { scheduleId: loop.loopId, expectedRevision: loop.revision!, operationId: 'mote-ended-' + digest([loop.loopId, observed.session.run]) }, undefined, 'execution-ended')).schedule
        readings.set(id, { status: 'paused', schedule: loop, issue: 'The original Agent exited normally or was cancelled. Resume the original arrangement explicitly.' }); return
      }
      await read(() => options.main.assertCurrent(main)); assertOpen()
      assertExecutionCurrent()
      const operationId = 'mote-maintain-' + digest([sourceId, main.roleRevision, observed.session.run])
      const recovered = await awaitUntilCancelled(() => { assertExecutionCurrent(); return client.ensureAgentContinuity({ agentSessionId: original.agentSessionId, expectedRun: observed.session.run, operationId, trigger: 'standing-maintenance', standingIntent: { ...loop!.managedSource!, intentId: loop!.futureIntentId!, operationId: loop!.currentDefinition?.operationId ?? loop!.creationOperationId! }, policy: { continuationEnabled: false, reminderMode: 'off' } }) }, signal)
      if (recovered.kind !== 'resumed' && recovered.kind !== 'reattachable') throw new Error(`Original maintenance recovery is ${recovered.kind}; inspect ${operationId}.`)
    } catch (error) { if (closed || signal.aborted) return; readings.set(id, { status: 'unconfirmed', schedule: readings.get(id)?.schedule ?? null, issue: String(error) }) }
  }
  const releaseScheduler = options.schedules.setMaintenanceOwner({ qualify, async maintain(now, signal) {
    if (closed || signal.aborted) return
    serviceIssue = undefined
    // Discovery is shared source work; existing exact targets continue while its next read is held.
    if (discovery && !discovering) {
      discovery = false
      const observed = awaitUntilCancelled(() => discover(signal), signal).catch(error => {
        if (closed || signal.aborted) return
        discovery = true
        for (const id of targets.keys()) readings.set(id, { status: 'unconfirmed', schedule: readings.get(id)?.schedule ?? null, issue: String(error) })
      }).finally(() => { if (discovering === observed) discovering = undefined })
      discovering = observed
      await observed
    }
    if (closed || signal.aborted) return
    const jobs: Promise<void>[] = []
    for (const [id, target] of targets) {
      if (targetChecks.has(id)) continue
      const checking = (async () => {
        const reading = readings.get(id)
        if (reading?.status === 'unconfirmed' && now >= (retries.get(id)?.at ?? now)) dirty.add(id)
        const loop = reading?.schedule && options.schedules.inspectLoop(reading.schedule.loopId)
        // A headless Run may not publish output events. Observe only this original active main.
        if (loop?.status === 'active' && !dirty.has(id)) {
          try {
            const observed = await awaitUntilCancelled(() => exact(loop.hostId).statusAgent(loop.agentSessionId), signal)
            if (observed.run.state !== 'running') dirty.add(id)
          } catch (error) {
            if (closed || signal.aborted) return
            readings.set(id, { status: 'unconfirmed', schedule: loop, issue: 'Observing the original main Run is unconfirmed. Its identity and manual input are retained: ' + String(error) })
            dirty.add(id)
          }
        }
        if (closed || signal.aborted || !dirty.delete(id)) return
        await reconcile(target, signal)
        if (closed || signal.aborted) return
        if (readings.get(id)?.status !== 'unconfirmed') { retries.delete(id); return }
        const waitMs = Math.min((retries.get(id)?.waitMs ?? MAINTENANCE_RETRY_MS / 2) * 2, MAINTENANCE_RETRY_LIMIT_MS)
        retries.set(id, { at: now + waitMs, waitMs })
      })().finally(() => { if (targetChecks.get(id) === checking) targetChecks.delete(id) })
      targetChecks.set(id, checking); jobs.push(checking)
    }
    // Join new work only. A later cadence can maintain healthy targets while another read is held.
    await Promise.all(jobs)
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
  return { invalidate, adoptGuidance, qualifyHeartbeatSource, read(target: MotePreferencesTarget): MotePresenceReading {
    const withGuidance = (value: MotePresenceReading): MotePresenceReading => ({ ...value, guidance: {
      availableRevision: moteGuidanceRevision(), currentDefinition: value.schedule?.currentDefinition ?? (value.schedule?.futureIntentId && value.schedule.creationOperationId ? { intentId: value.schedule.futureIntentId, operationId: value.schedule.creationOperationId } : null),
      adoptedRevision: value.schedule?.guidanceAdoptions?.find(record => record.state === 'adopted' && record.newDefinition.intentId === value.schedule?.futureIntentId)?.newDefinition.guidanceRevision ?? null, adoptions: value.schedule?.guidanceAdoptions ?? [] } })
    if (serviceIssue) return withGuidance({ status: 'unconfirmed', schedule: readings.get(key(target))?.schedule ?? null, issue: serviceIssue })
    const reading = readings.get(key(target)); if (!reading) return withGuidance({ status: 'unconfirmed', schedule: null, issue: 'The original Host maintenance observation has not completed.' })
    const schedule = reading.schedule ? options.schedules.inspectLoop(reading.schedule.loopId) ?? reading.schedule : null
    return withGuidance({ ...reading, schedule, ...(schedule?.status === 'paused' && reading.status === 'active' ? { status: 'paused' as const, issue: schedule.lastDecision ?? reading.issue } : {}) })
  }, async start() {
      try {
        subscribeClients(); releaseClients = options.subscribeClients?.(() => { subscribeClients(); for (const id of targets.keys()) dirty.add(id) })
        try { watching = watch(dirname(options.configurationPath), (_event,name) => { if (name === null || String(name) === basename(options.configurationPath)) discovery = true }); watching.on('error', () => { discovery = true }) } catch { discovery = true }
        await options.schedules.start()
      } catch (error) { serviceIssue = 'Starting original Mote maintenance is unconfirmed. The Host, Agents and manual input remain available. Inspect the original schedule owner: ' + String(error) }
    },
    dispose() { closed = true; releaseScheduler(); releaseScheduleEvents(); releaseSpatial(); watching?.close(); releaseClients?.(); for (const entry of watchers.values()) entry.watcher.close(); for (const entry of events.values()) entry.release() } }
}
