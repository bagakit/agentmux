import { afterEach, expect, it, vi } from 'vitest'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import { createMoteInputFixture } from './helpers/mote-input-owner.js'
import { createHostContent } from '../../../apps/host/src/content-owner.js'
import { createHostMoteDialogue, createHostMoteMainReader } from '../../../apps/host/src/mote-dialogue.js'
import { createHostMotePresence } from '../../../apps/host/src/mote-presence.js'
import { motePresenceSourceId } from '../src/mote/preferences.js'
import { ContinuousProgressLoopManager } from '../../../apps/host/src/continuous-progress-loop-manager.js'
import { ContinuousProgressLoopStore } from '../../../apps/host/src/continuous-progress-loop-store.js'
import { createGoalRuntime } from '../../../apps/host/src/goal-runtime.js'
import { MoteDialogueStore } from '../src/mote/dialogue-store.js'
import { AgentMuxNotesStorage } from '../src/notes-storage.js'
import { AgentMuxControlServer } from '../src/public-rpc-server.js'
import { connectAgentMuxRpc } from '../src/public-rpc-client.js'
import { AgentMuxRpcService } from '../src/public-rpc-service.js'
import { runSourceObjectCli } from './helpers/source-object-cli.js'
import { objectCliEnvironment } from './helpers/object-cli-rpc.js'
import { serializeMoteQuickMode } from '../../../apps/host/src/mote-model.js'
import type { MoteHeartbeatReportRequest, MoteHeartbeatSource } from '../src/mote/dialogue.js'

// Compile the standalone listener from the same source candidate; never borrow a
// concurrently rebuilt dist asset. Its real OS listener and IPC remain unchanged.
vi.mock('node:child_process', async importOriginal => {
  const native = await importOriginal<typeof import('node:child_process')>()
  return { ...native, fork: (path: string | URL, args: string[], options: import('node:child_process').ForkOptions) => native.fork(String(path).endsWith('/dist/control-endpoint-listener-worker.js')
    ? new URL('../src/control-endpoint-listener-worker.ts', import.meta.url) : path, args, { ...options, execArgv: String(path).endsWith('/dist/control-endpoint-listener-worker.js') ? ['--experimental-transform-types'] : options.execArgv }) }
})
const closes: Array<() => Promise<unknown> | void> = []
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); vi.restoreAllMocks() })
async function evidence(value: unknown) { if (process.env.MOTE_HEARTBEAT_REPORT_CASES) await appendFile(process.env.MOTE_HEARTBEAT_REPORT_CASES, JSON.stringify(value) + '\n') }
async function fixture() {
  const f = await createMoteInputFixture(); closes.push(f.close)
  await evidence({ scenario: 'fixture-root', root: f.root })
  const target = { spaceId: f.graph.spaces[0]!.spaceId, zoneId: f.graph.bindings[0]!.zoneId,
    expectedResource: { hostId: 'local', workspaceId: '__scratch__', workspacePath: join(f.root, 'scratch') } }
  const content = createHostContent({ configurationPath: join(f.root, 'configuration.json'), spatial: f.spatial, storage: new AgentMuxNotesStorage(join(f.root, 'notes-location.json'), join(f.root, 'notes')) })
  const main = createHostMoteMainReader({ configurationPath: join(f.root, 'configuration.json'), spatial: f.spatial, files: content.files! })
  const snapshot = await main.readCurrentMoteMain(target)
  const runtime = createGoalRuntime({ clients: f.coreClients, checkIn: async () => ({ known: false, reason: 'No extra work' }) })
  const manager = new ContinuousProgressLoopManager(new ContinuousProgressLoopStore(join(f.root, 'report-loops.json')),
    async () => { throw Error('Reporting cannot send another input') }, () => 100000,
    async () => { throw Error('This exact admission fixture does not claim a due model turn') },
    { saveFutureIntent: runtime.saveFutureIntent, inspectFutureIntent: runtime.inspectFutureIntent })
  closes.push(() => manager.stop())
  const presence = createHostMotePresence({ configurationPath: join(f.root, 'configuration.json'), spatial: f.spatial,
    files: content.files!, main, schedules: manager, clients: f.coreClients })
  closes.push(() => presence.dispose())
  const primary = f.client.agentSession('primary')
  const loop = (await manager.call('schedule.create', { target: { hostId: 'local', agentSessionId: 'primary', providerId: primary.providerId, workspacePath: primary.workspacePath },
    everyMs: 60000, prompt: 'Original retained automatic heartbeat.', operationId: 'report-original-create',
    managedSource: { sourceId: motePresenceSourceId(snapshot.identity!), revision: snapshot.roleRevision! } })).schedule
  const key = { kind: 'prompt' as const, agentSessionId: 'primary', expectedRun: primary.run, submissionId: 'report-original-input' }
  // Controlled original intake only. Core archive, source qualifier and all public
  // report consumers are real; Root's joined due test owns actual scheduler delivery.
  const definition = (await f.client.readAgentFuturePromptIntent('primary', loop.futureIntentId!))!
  const before = (await f.store.readMetadata('primary'))!
  await f.store.compareAndSwapMetadata(before, { ...before, promptCompletionAdmission: {
    submissionId: key.submissionId, operationId: key.submissionId, inputKey: key, acknowledged: true, transport: 'pty', startByte: 0, endByte: 42,
    futureIntent: { intentId: loop.futureIntentId!, occurrenceAt: 100000 },
    intent: { run: primary.run, ownerInstanceId: 'controlled-original-intake', prompt: loop.prompt,
      message: structuredClone(definition.message), plan: { kind: 'single-phase', data: loop.prompt + '\r' }, execution: 'default',
      admissionIntent: { kind: 'exact-condition', condition: { expectedRun: primary.run, afterSubmissionId: null } } } } })
  const source: MoteHeartbeatSource = { inputKey: key, scheduleId: loop.loopId, definitionIntentId: loop.futureIntentId!, occurrenceAt: 100000, mainRoleRevision: snapshot.roleRevision! }
  const store = new MoteDialogueStore(join(f.root, 'report-dialogue.sqlite'))
  const dialogue = createHostMoteDialogue({ main, spatial: f.spatial, store, clientForHost: () => f.client,
    qualifyHeartbeatSource: (source, original, context) => presence.qualifyHeartbeatSource(source, original, context) })
  const service = new AgentMuxRpcService({ ...content, spatialState: f.spatial, coreClients: f.coreClients, moteDialogue: dialogue, schedules: manager }); closes.push(() => service.dispose())
  const server = new AgentMuxControlServer({ socketPath: join(f.root, 'report.sock'), ...content, spatialState: f.spatial, coreClients: f.coreClients, moteDialogue: dialogue, schedules: manager })
  await server.start(); closes.push(() => server.stop())
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: server.path } }); closes.push(() => rpc.dispose())
  const caller = { caller: { agentSessionId: 'primary', capability: f.capability } }
  const request = (operationId = 'report-op'): MoteHeartbeatReportRequest => ({ target, operationId, source: structuredClone(source),
    report: { disposition: 'quiet', summary: 'Reviewed this original input; no useful new idea.', inspected: [], actions: [] } })
  const cli = async (path: string[], data: unknown, agent = 'primary') => {
    const result = await runSourceObjectCli(['--endpoint', 'unix:' + server.path, ...path, '--input', '-'],
      objectCliEnvironment(f.root, { AGENTMUX_AGENT_SESSION_ID: agent, AGENTMUX_AGENT_CAPABILITY: f.capability }), JSON.stringify(data), 30000,
      new URL('./fixtures/mote-heartbeat-report-loader.mjs', import.meta.url))
    expect(result.code, result.stderr + result.stdout).toBe(0); return JSON.parse(result.stdout).result
  }
  return { ...f, sessions: f.store, target, main, snapshot, source, manager, presence, store, dialogue, content, service, rpc, caller, request, cli }
}
it('actual source CLI records an explicitly selected PTY heartbeat statement without native completion or input', async () => {
  const f = await fixture(), request = f.request(), writes = f.writes.length
  const original = await f.service.call('agent.input.inspect', { key: f.source.inputKey }, f.caller)
  expect(original.record?.nativeResult?.state).toBe('unsupported')
  const saved = await f.cli(['space', 'mote', 'dialogue', 'heartbeat', 'report'], request)
  expect(saved.links).toHaveLength(1)
  expect(saved.links[0]).toMatchObject({ kind: 'heartbeat', attribution: 'agent-statement', source: f.source,
    author: { hostId: 'local', agentSessionId: 'primary', run: f.source.inputKey.expectedRun }, report: request.report, ideaEvidence: [] })
  expect(await f.cli(['space', 'mote', 'dialogue', 'heartbeat', 'report'], request)).toEqual(saved)
  const page = await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'heartbeat', operationId: request.operationId })
  expect(page.links).toEqual(saved.links)
  expect((await f.service.call('agent.input.inspect', { key: f.source.inputKey }, f.caller)).record).toEqual(original.record)
  expect(f.writes).toHaveLength(writes)
  expect(JSON.stringify(saved)).not.toContain('controlled-original-intake')
  await evidence({ scenario: 'source-cli-report', root: f.root, source: f.source, saved, page, nativeResult: original.record?.nativeResult, noAdditionalInput: true })
})
it('an exact ordinary Idea read stays observed-file and never supplies a missing write acknowledgement', async () => {
  const f = await fixture(), path = 'One bounded proposal.md', read = await f.rpc.call('file.read', { ...f.target, path })
  const create = f.content.files!.create.bind(f.content.files!)
  vi.spyOn(f.content.files!, 'create').mockImplementationOnce(async (...args) => { const saved = await create(...args); return { resource: saved.resource, result: { status: 'unknown', code: 'ORIGINAL_WRITE_ACK_UNAVAILABLE', message: 'The exact write acknowledgement is unknown.' } } })
  const written = await f.service.call('file.create', { ...f.target, path, expectedResource: read.resource!, expectedRevision: null, content: '# A bounded idea\n' }, f.caller)
  expect(written.result.status).toBe('unknown')
  const current = await f.rpc.call('file.read', { ...f.target, path }), request = f.request()
  if (current.result.status !== 'read') throw Error('Exact fixture file must be readable')
  request.report.actions = [{ kind: 'idea', path, resource: current.resource!, revision: current.result.document.revision }]
  const saved = await f.service.call('space.mote.dialogue.heartbeat.report', request, f.caller)
  expect(saved.links[0]).toMatchObject({ kind: 'heartbeat', ideaEvidence: [{ status: 'observed-file', revision: current.result.document.revision }] })
  const unknown = f.request('unknown-idea'); unknown.report.actions = request.report.actions
  const originalRead = f.content.files!.read.bind(f.content.files!)
  vi.spyOn(f.content.files!, 'read').mockImplementation(request => request.path === path ? Promise.reject(new Error('Exact file observation unavailable')) : originalRead(request))
  expect((await f.service.call('space.mote.dialogue.heartbeat.report', unknown, f.caller)).links[0]).toMatchObject({ kind: 'heartbeat', report: { disposition: 'quiet' }, ideaEvidence: [{ status: 'unconfirmed' }] })
  await evidence({ scenario: 'idea-observation', root: f.root, saved, source: f.source })
})
it('same operation payload conflicts and a lost report reply reads the original journal event without another write', async () => {
  const f = await fixture(), input = f.request(), append = f.store.append.bind(f.store)
  vi.spyOn(f.store, 'append').mockImplementationOnce(async (...args) => { await append(...args); throw Error('Original report ACK lost') })
  await expect(f.service.call('space.mote.dialogue.heartbeat.report', input, f.caller)).rejects.toThrow('ACK lost')
  const page = await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'heartbeat', operationId: input.operationId })
  expect(page.links).toHaveLength(1)
  expect((await f.service.call('space.mote.dialogue.heartbeat.report', input, f.caller)).links).toEqual(page.links)
  await expect(f.service.call('space.mote.dialogue.heartbeat.report', { ...input, report: { ...input.report, summary: 'Changed statement' } }, f.caller)).rejects.toMatchObject({ code: 'MOTE_DIALOGUE_OPERATION_CONFLICT' })
})
it.each(['run', 'occurrence', 'definition', 'role', 'mote', 'missing-key', 'foreign-agent'] as const)('the original public report rejects a %s source without changing its input', async kind => {
  const f = await fixture(), input: any = f.request(), original = await f.client.inspectAgentPromptSubmission(f.source.inputKey)
  if (kind === 'run') input.source.inputKey.expectedRun.runId += '-other'
  if (kind === 'occurrence') input.source.occurrenceAt++
  if (kind === 'definition') input.source.definitionIntentId += '-other'
  if (kind === 'role') input.source.mainRoleRevision += '-other'
  if (kind === 'mote') input.target = { ...input.target, spaceId: 'another-original-mote' }
  if (kind === 'missing-key') delete input.source.inputKey
  await expect(f.service.call('space.mote.dialogue.heartbeat.report', input, kind === 'foreign-agent' ? { caller: { agentSessionId: 'stranger', capability: f.capability } } : f.caller)).rejects.toThrow()
  expect((await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'heartbeat' })).links).toEqual([])
  expect(await f.client.inspectAgentPromptSubmission(f.source.inputKey)).toEqual(original)
})
it('a person cannot impersonate the Agent statement and an old-role report retains its original source', async () => {
  const f = await fixture(), input = f.request()
  await expect(f.rpc.call('space.mote.dialogue.heartbeat.report', input)).rejects.toMatchObject({ code: 'MANAGED_AGENT_CONTEXT_REQUIRED' })
  await writeFile(f.motePath, serializeMoteQuickMode(await readFile(f.motePath, 'utf8'), { conversationRevision: 'later-role', conversation: { ...f.snapshot.current!, sessionId: 'member' } }))
  const saving = f.service.call('space.mote.dialogue.heartbeat.report', input, f.caller)
  await expect(saving).resolves.toMatchObject({ links: [{ kind: 'heartbeat', source: input.source }] })
  const saved = await saving
  expect(saved.links[0]).toMatchObject({ kind: 'heartbeat', source: { mainRoleRevision: f.source.mainRoleRevision, inputKey: f.source.inputKey }, author: { agentSessionId: 'primary' } })
  expect((await f.main.readCurrentMoteMain(f.target)).current?.sessionId).toBe('member')
})
it('the strict public report rejects JSON coercion without making a quiet statement or broadening a read', async () => {
  const f = await fixture(), input: any = f.request(); input.report.disposition = ['quiet']
  await expect(f.service.call('space.mote.dialogue.heartbeat.report', input, f.caller)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  await expect(f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: ['heartbeat'] } as any)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  const path = 'Original reference.md', read = await f.rpc.call('file.read', { ...f.target, path })
  input.report.disposition = 'quiet'; input.report.actions = [{ kind: 'idea', path, resource: { ...read.resource!, logicalDirectory: [] }, revision: 'sha256:' + 'a'.repeat(64) }]
  await expect(f.service.call('space.mote.dialogue.heartbeat.report', input, f.caller)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
  expect((await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'heartbeat' })).links).toEqual([])
})
it('a declared partial work page retains its cursor and a foreign Mote coverage cannot be attached', async () => {
  const f = await fixture()
  for (let index = 0; index < 2; index++) await f.store.append(f.snapshot.identity!, 'original-work-' + index, JSON.stringify({ index }), [{ kind: 'work',
    eventId: 'original-work-event', mainRoleRevision: f.source.mainRoleRevision, main: { hostId: 'local', agentSessionId: 'primary' }, associatedAt: 100,
    origin: { hostId: 'local', messageId: 'original-source-' + index, threadId: 'original-thread', senderSessionId: 'primary', recipientSessionId: 'member', createdAt: 100 } }])
  const page = await f.service.call('space.mote.dialogue.read', { target: f.target, kind: 'work', limit: 1 }, f.caller)
  expect(page.next).not.toBeNull()
  const request = f.request(); request.report.inspected = [{ kind: 'work', incarnation: page.incarnation, throughSequence: page.throughSequence,
    next: page.next, sourceStatus: page.sourceStatus, issue: page.sourceIssue }]
  const saved = await f.service.call('space.mote.dialogue.heartbeat.report', request, f.caller)
  expect(saved.links[0]).toMatchObject({ kind: 'heartbeat', report: { inspected: [{ next: page.next, throughSequence: page.throughSequence }] } })
  const foreign = structuredClone(request); foreign.operationId = 'foreign-coverage'; (foreign.report.inspected[0] as any).next.identity.moteId = 'another-original-mote'
  await expect(f.service.call('space.mote.dialogue.heartbeat.report', foreign, f.caller)).rejects.toMatchObject({ code: 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED' })
})
it('a committed original Note event is separate from file observation and a foreign event stays unconfirmed', async () => {
  const f = await fixture(), path = 'Scoped proposal.note.md', content = '---\nschema: agentmux.note.md.v1\nnote-id: original-proposal\n---\nOriginal proposal\n\n^original-block\n'
  const absent = await f.rpc.call('file.read', { ...f.target, path })
  expect((await f.service.call('file.create', { ...f.target, path, expectedResource: absent.resource!, expectedRevision: null, content }, f.caller)).result.status).toBe('written')
  const read = await f.rpc.call('file.read', { ...f.target, path }); if (read.result.status !== 'read') throw Error('Original Note is unreadable')
  const state = await f.content.notebookStore!.read()
  await f.content.notebookStore!.apply({ expectedRevision: state.revision, operationId: 'register-report-note', change: { kind: 'register', noteId: 'original-proposal', title: 'Scoped proposal', resource: { hostId: 'local', workspaceId: '__scratch__', workspacePath: f.target.expectedResource.workspacePath, path: read.resource!.path } } }, { kind: 'agent', id: 'primary' })
  const saved = await f.service.call('file.write', { ...f.target, path, expectedResource: read.resource!, expectedRevision: read.result.document.revision,
    baseContent: read.result.document.content, content: read.result.document.content.replace('Original proposal', 'One smaller original experiment'), operationId: 'original-note-edit' }, f.caller)
  expect(saved.result).toMatchObject({ status: 'written', noteHistory: { status: 'committed', eventId: 'original-note-edit' } })
  if (saved.result.status !== 'written') throw Error('Original Note edit missing')
  const request = f.request(); request.report.actions = [{ kind: 'idea', path, resource: read.resource!, revision: saved.result.revision, note: { noteId: 'original-proposal', eventId: 'original-note-edit' } }]
  const report = await f.service.call('space.mote.dialogue.heartbeat.report', request, f.caller)
  expect(report.links[0]).toMatchObject({ kind: 'heartbeat', ideaEvidence: [{ status: 'committed-note', noteId: 'original-proposal', eventId: 'original-note-edit', revision: saved.result.revision, actor: { kind: 'agent', id: 'primary' } }] })
  const unknown = structuredClone(request); unknown.operationId = 'foreign-note-event'; (unknown.report.actions[0] as any).note.eventId = 'missing-original-event'
  expect((await f.service.call('space.mote.dialogue.heartbeat.report', unknown, f.caller)).links[0]).toMatchObject({ kind: 'heartbeat', ideaEvidence: [{ status: 'unconfirmed' }] })
  const history = f.content.files!.history!.bind(f.content.files!)
  const historyReader = vi.spyOn(f.content.files!, 'history')
  historyReader.mockImplementation(async input => {
    const result = structuredClone(await history(input))
    if (result.result.status === 'read') for (const entry of result.result.entries) entry.status = 'unconfirmed'
    return result
  })
  const uncommitted = structuredClone(request); uncommitted.operationId = 'uncommitted-note-event'
  expect((await f.service.call('space.mote.dialogue.heartbeat.report', uncommitted, f.caller)).links[0]).toMatchObject({ kind: 'heartbeat', ideaEvidence: [{ status: 'unconfirmed' }] })
  historyReader.mockRestore()
  const latest = await f.rpc.call('file.read', { ...f.target, path }); if (latest.result.status !== 'read') throw Error('Original Note is unreadable')
  const other = await f.service.call('file.write', { ...f.target, path, expectedResource: latest.resource!, expectedRevision: latest.result.document.revision,
    baseContent: latest.result.document.content, content: latest.result.document.content.replace('One smaller original experiment', 'Another Agent experiment'), operationId: 'another-agent-note-edit' },
    { caller: { agentSessionId: 'stranger', capability: f.capability } })
  expect(other.result).toMatchObject({ status: 'written', noteHistory: { status: 'committed', eventId: 'another-agent-note-edit' } })
  if (other.result.status !== 'written') throw Error('Original other-Agent Note event missing')
  const foreignActor = structuredClone(request); foreignActor.operationId = 'foreign-note-actor'
  const otherAction = foreignActor.report.actions[0] as Extract<typeof foreignActor.report.actions[number], {kind:'idea'}>
  otherAction.revision = other.result.revision; otherAction.note!.eventId = 'another-agent-note-edit'
  expect((await f.service.call('space.mote.dialogue.heartbeat.report', foreignActor, f.caller)).links[0]).toMatchObject({ kind: 'heartbeat', ideaEvidence: [{ status: 'unconfirmed' }] })
  await evidence({ scenario: 'committed-note-report', root: f.root, report, noteReceipt: saved.result.noteHistory })
})
it('a foreign Idea resource and private input reader remain denied without altering the original input', async () => {
  const f = await fixture(), request = f.request(), path = 'Foreign.md', read = await f.rpc.call('file.read', { ...f.target, path })
  request.report.actions = [{ kind: 'idea', path, resource: { ...read.resource!, zoneId: 'another-mote-zone' }, revision: 'sha256:' + 'a'.repeat(64) }]
  await expect(f.service.call('space.mote.dialogue.heartbeat.report', request, f.caller)).rejects.toMatchObject({ code: 'MOTE_DIALOGUE_SOURCE_UNCONFIRMED' })
  await expect(f.service.call('agent.input.inspect', { key: f.source.inputKey }, { caller: { agentSessionId: 'stranger', capability: f.capability } })).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect((await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'heartbeat' })).links).toEqual([])
})
it('a reporting Agent recovery during an Idea read cannot claim the original Run', async () => {
  const f = await fixture(), path = 'One retained idea.md', absent = await f.rpc.call('file.read', { ...f.target, path })
  await f.service.call('file.create', { ...f.target, path, expectedResource: absent.resource!, expectedRevision: null, content: 'Retained idea\n' }, f.caller)
  const read = await f.rpc.call('file.read', { ...f.target, path }); if (read.result.status !== 'read') throw Error('Original idea missing')
  const input = f.request(); input.report.actions = [{ kind: 'idea', path, resource: read.resource!, revision: read.result.document.revision }]
  const original = f.content.files!.read.bind(f.content.files!), reader = vi.spyOn(f.content.files!, 'read'); let changed = false
  reader.mockImplementation(async request => {
    const result = await original(request)
    if (!changed && request.path === path) {
      changed = true
      const before = (await f.sessions.load()).find((value: any) => value.agentSessionId === 'primary') as any
      const { promptCompletionAdmission: _oldInput, terminalPromptSubmission: _oldTerminal, ...retained } = before
      await f.sessions.compareAndSwap(before, { ...retained, run: { runId: 'later-report-run' }, retiredRuns: [...before.retiredRuns, before.run] })
      await f.inner.registry.load('local')
    }
    return result
  })
  await expect(f.service.call('space.mote.dialogue.heartbeat.report', input, f.caller)).rejects.toMatchObject({ code: 'CONTROL_PERMISSION_DENIED' })
  expect(changed).toBe(true)
  expect((await f.rpc.call('space.mote.dialogue.read', { target: f.target, kind: 'heartbeat' })).links).toEqual([])
})
it('two independent OS owners retain the exact report journal key and source without input', async () => {
  const f = await fixture(), input = f.request(), saved = await f.service.call('space.mote.dialogue.heartbeat.report', input, f.caller), records: any[] = []
  for (let index = 0; index < 2; index++) {
    const result = await new Promise<any>((yes, no) => {
      const child = spawn(process.execPath, ['--loader', new URL('./fixtures/mote-heartbeat-report-loader.mjs', import.meta.url).pathname,
        new URL('./fixtures/mote-heartbeat-report-owner.mjs', import.meta.url).pathname], { env: objectCliEnvironment(f.root), stdio: ['pipe', 'pipe', 'pipe'] })
      let output = '', errors = ''; child.stdout.on('data', x => output += x); child.stderr.on('data', x => errors += x)
      child.once('error', no); child.once('close', code => code === 0 ? yes(JSON.parse(output)) : no(Error(errors + output)))
      child.stdin.end(JSON.stringify({ root: f.root, target: f.target, operationId: input.operationId }))
    })
    expect(result.page.links).toEqual(saved.links); expect(result.sessionsBefore).toEqual(result.sessionsAfter); records.push(result)
  }
  expect(records[0].pid).not.toBe(records[1].pid)
  await evidence({ scenario: 'two-os-report', root: f.root, source: f.source, saved, records, noInputOrModel: true })
})
