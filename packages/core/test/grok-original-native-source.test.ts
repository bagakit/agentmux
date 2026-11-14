import { appendFile, mkdtemp, mkdir, writeFile, rm, rename, open, readFile, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { afterEach, expect, it, vi } from 'vitest'
import { observeGrokSessionStatus, readGrokPromptExecutionEvidence } from '../src/providers/grok-session-status.js'
import * as nativeProcess from '../src/agent-native-process.js'
import { NativeJsonlHistoryReader } from '../src/native-jsonl-history-reader.js'
import * as nativeHistory from '../src/native-jsonl-history-reader.js'

const NATIVE = 'native-current', TURN = 'turn-current'
let event = 0
const close: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); vi.restoreAllMocks() })
const wire = (update: Record<string, unknown>, promptId?: string, method = 'session/update') => ({
  timestamp: 2, method, params: { sessionId: NATIVE, update, _meta: { eventId: NATIVE + '-' + ++event,
    agentTimestampMs: 2000, ...(promptId ? { promptId } : {}) } }
})
const prompt = (turn = TURN) => wire({ sessionUpdate: 'hook_execution', event_name: 'user_prompt_submit', prompt_id: turn,
  runs: [{ name: 'original-observer', status: { status: 'success', elapsed_ms: 0 } }] }, undefined, '_x.ai/session/update')
const user = (index = 0) => wire({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Neutral input' }, _meta: { promptIndex: index } })
const activity = (turn = TURN) => wire({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Neutral result' } }, turn)
const end = (turn = TURN) => wire({ sessionUpdate: 'turn_completed', prompt_id: turn, stop_reason: 'end_turn' }, undefined, '_x.ai/session/update')
const jsonl = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n'
async function proof(value: Record<string, unknown>) {
  if (process.env.MOTE_GROK_ORIGINAL_CASE_PROOF) await appendFile(process.env.MOTE_GROK_ORIGINAL_CASE_PROOF, JSON.stringify(value) + '\n')
}

async function source(rows = [prompt(), user(), activity(), end()], workspace?: string) {
  const root = workspace ?? await mkdtemp(join(tmpdir(), 'mote-grok-native-source-'))
  if (!workspace) close.push(() => rm(root, { recursive: true, force: true }))
  const directory = join(root, NATIVE); await mkdir(directory)
  const path = join(directory, 'updates.jsonl'), events = join(directory, 'events.jsonl')
  await writeFile(path, jsonl(rows))
  await writeFile(join(directory, 'summary.json'), JSON.stringify({ info: { id: NATIVE, cwd: root } }))
  await writeFile(events, jsonl([{ type: 'turn_started', session_id: NATIVE, session_relationship: 'primary', schema_version: '1.0', turn_number: 7 }]))
  const context = { command: '', args: [], workspacePath: root,
    nativeHandle: { kind: 'provider' as const, providerId: 'grok' as const, sessionId: NATIVE, transcriptPath: path } }
  return { root, directory, path, events, context }
}

async function writer(path: string, readOnly = false, additional: string[] = []) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/grok-native-writer.mjs', import.meta.url)), path, ...additional, ...(readOnly ? ['--read-only'] : [])],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = ''
  child.stdout.on('data', data => { stdout += data }); child.stderr.on('data', data => { stderr += data })
  const ended = new Promise<number | null>(resolve => child.once('close', resolve))
  close.push(async () => { child.stdin.end(); expect(await ended, stderr).toBe(0) })
  await vi.waitFor(() => expect(stdout, stderr).toContain('"ready":true'), { timeout: 5000 })
  return child.pid!
}

async function observed(f: Awaited<ReturnType<typeof source>>) {
  const states: any[] = [], unavailable: any[] = [], controller = new AbortController()
  const observer = await observeGrokSessionStatus({ ...f.context, signal: controller.signal,
    onStatus: state => states.push(state), onUnavailable: (code, message) => unavailable.push({ code, message }) })
  close.push(async () => { controller.abort(); observer.dispose() })
  return { states, unavailable }
}

it('the original prompt-submit machine marker binds a no-ID user before matching activity and completion', async () => {
  const f = await source()
  expect(await readGrokPromptExecutionEvidence(f.context)).toMatchObject({ state: 'ended', nativeTurnId: TURN, endReason: 'completed' })
})

it('the exact private OS Run writable primary events descriptor locates the original source without environment', async () => {
  const f = await source(), processId = await writer(f.events)
  const { transcriptPath: _path, ...nativeHandle } = f.context.nativeHandle
  await expect(readGrokPromptExecutionEvidence({ ...f.context, nativeHandle, processId })).resolves.toMatchObject({ state: 'ended', nativeTurnId: TURN })
})

it('a pending native prompt marker withholds old idle across cuts until its exact counted user arrives', async () => {
  const f = await source([prompt('old-turn'), user(6), activity('old-turn'), end('old-turn')]), watch = await observed(f)
  expect(watch.states.at(-1)).toMatchObject({ state: 'done', nativeTurnId: 'old-turn' })
  await appendFile(f.path, jsonl([prompt()]))
  await vi.waitFor(() => expect(watch.states.at(-1)).toMatchObject({ state: 'unknown', nativeTurnId: TURN }))
  expect(await readGrokPromptExecutionEvidence(f.context)).toBeNull()
  await appendFile(f.path, jsonl([user(7), activity(), end()]))
  await vi.waitFor(() => expect(watch.states.at(-1)).toMatchObject({ state: 'done', nativeTurnId: TURN }))
  expect(await readGrokPromptExecutionEvidence(f.context)).toMatchObject({ state: 'ended', nativeTurnId: TURN })
})

it('finite and cold watch bind the first counted user chunk of the same contiguous multiblock run', async () => {
  const f = await source([prompt(), user(), user(), activity(), end()]), watch = await observed(f)
  expect(await readGrokPromptExecutionEvidence(f.context)).toMatchObject({ state: 'ended', nativeTurnId: TURN })
  expect(watch.states.at(-1)).toMatchObject({ state: 'done', nativeTurnId: TURN })
})

it.each(['finite', 'watch'])('an unterminated but valid JSON terminal never grants %s completion', async mode => {
  const f = await source(), bytes = await readFile(f.path)
  await writeFile(f.path, bytes.subarray(0, -1))
  if (mode === 'finite') expect(await readGrokPromptExecutionEvidence(f.context)).toBeNull()
  else await expect(observed(f)).rejects.toMatchObject({ code: 'AGENT_NATIVE_STATUS_UNCONFIRMED' })
})

it.each(['finite', 'watch'])('a complete native append between path stat and descriptor open remains readable by %s', async mode => {
  const f = await source(), original = NativeJsonlHistoryReader.open
  vi.spyOn(NativeJsonlHistoryReader, 'open').mockImplementationOnce(async (...args) => {
    await appendFile(f.path, jsonl([prompt('next-turn'), user(1), activity('next-turn'), end('next-turn')]))
    return await original(...args)
  })
  if (mode === 'finite') expect(await readGrokPromptExecutionEvidence(f.context)).toMatchObject({ state: 'ended', nativeTurnId: 'next-turn' })
  else expect((await observed(f)).states.at(-1)).toMatchObject({ state: 'done', nativeTurnId: 'next-turn' })
})

it.each(['missing', 'metadata-gap', 'physical-gap', 'counter-gap', 'blocked', 'empty-runs', 'all-skipped', 'unknown-status', 'replayed', 'changed-index'])(
  '%s cannot bind a no-ID user or revive the previous native idle', async shape => {
    const marker = prompt(), first = user(), rows: any[] = [marker, first]
    if (shape === 'missing') rows.shift()
    if (shape === 'metadata-gap') rows.splice(1, 0, wire({ sessionUpdate: 'hook_annotation' }, undefined, '_x.ai/session/update'))
    if (shape === 'counter-gap') first.params._meta.eventId = NATIVE + '-999999'
    if (shape === 'blocked') marker.params.update.runs = [{ name: 'original-observer', status: { status: 'failed', elapsed_ms: 0, error: 'blocked', blocked: true } }]
    if (shape === 'empty-runs') marker.params.update.runs = []
    if (shape === 'all-skipped') marker.params.update.runs = [{ name: 'original-observer', status: { status: 'skipped' } }]
    if (shape === 'unknown-status') marker.params.update.runs = [{ name: 'original-observer', status: { status: 'unknown' } }]
    if (shape === 'replayed') (marker.params._meta as any).isReplay = true
    if (shape === 'changed-index') rows.push(user(8))
    rows.push(activity(), end())
    const f = await source(rows)
    if (shape === 'physical-gap') await writeFile(f.path, jsonl([rows[0]]) + '\n' + jsonl(rows.slice(1)))
    const watch = await observed(f)
    expect(await readGrokPromptExecutionEvidence(f.context)).toBeNull()
    expect(watch.states.at(-1)?.state).not.toBe('done')
  })

it.each([true, false])('a new original marker prevents late old activity and end from owning its no-ID user (older ended=%s)', async ended => {
  const prior = [prompt('old-turn'), user(6), activity('old-turn'), ...(ended ? [end('old-turn')] : [])]
  const f = await source(prior), watch = await observed(f)
  await appendFile(f.path, jsonl([prompt(), user(7), activity('old-turn'), end('old-turn')]))
  await vi.waitFor(() => expect(watch.states.at(-1)).toMatchObject({ state: 'working', nativeTurnId: TURN }))
  expect(await readGrokPromptExecutionEvidence(f.context)).toMatchObject({ state: 'working', nativeTurnId: TURN })
  await appendFile(f.path, jsonl([activity(), end()]))
  await vi.waitFor(() => expect(watch.states.at(-1)).toMatchObject({ state: 'done', nativeTurnId: TURN }))
})

it('finite and restarted watch cannot revive the preceding completed ID through a reused prompt-submit marker', async () => {
  const f = await source([prompt('old-turn'), user(6), activity('old-turn'), end('old-turn')]), watch = await observed(f)
  await appendFile(f.path, jsonl([prompt('old-turn'), user(7), activity('old-turn'), end('old-turn')]))
  await vi.waitFor(() => expect(watch.states.at(-1)?.state).not.toBe('done'))
  expect(await readGrokPromptExecutionEvidence(f.context)).toBeNull()
  const cold = await observed(f)
  expect(cold.states.at(-1)?.state).not.toBe('done')
})

it.each(['zero-index', 'explicit'])('the %s shortcut cannot revive a completed ID at a new counted user boundary', async shape => {
  const f = await source([prompt('old-turn'), user(6), activity('old-turn'), end('old-turn')]), watch = await observed(f)
  const marker = shape === 'zero-index' ? [prompt('old-turn')] : []
  const next = user(0)
  if (shape === 'explicit') (next.params._meta as any).promptId = 'old-turn'
  await appendFile(f.path, jsonl([...marker, next, activity('old-turn'), end('old-turn')]))
  await vi.waitFor(() => expect(watch.states.at(-1)?.state).not.toBe('done'))
  expect(await readGrokPromptExecutionEvidence(f.context)).toBeNull()
  expect((await observed(f)).states.at(-1)?.state).not.toBe('done')
})

it.each(['counted', 'legacy-explicit'])('a fresh explicit native ID preserves contiguous multiblock %s input', async shape => {
  const prior = [prompt('old-turn'), user(1), activity('old-turn'), end('old-turn')]
  const first = user(2), second = user(2), third = user(2)
  for (const row of [first, second, third]) {
    ;(row.params._meta as any).promptId = TURN
    if (shape === 'legacy-explicit') delete row.params.update._meta
  }
  const f = await source([...prior, first, second, third, activity(), end()]), watch = await observed(f)
  expect(await readGrokPromptExecutionEvidence(f.context)).toMatchObject({ state: 'ended', nativeTurnId: TURN })
  expect(watch.states.at(-1)).toMatchObject({ state: 'done', nativeTurnId: TURN })
})

it.each(['native', 'cwd', 'child', 'schema'])('an original OS descriptor cannot borrow a wrong %s identity', async shape => {
  const f = await source(), processId = await writer(f.events)
  if (shape === 'cwd') await writeFile(join(f.directory, 'summary.json'), JSON.stringify({ info: { id: NATIVE, cwd: f.root + '-foreign' } }))
  else await writeFile(f.events, jsonl([{ type: 'turn_started', session_id: shape === 'native' ? 'foreign' : NATIVE,
    session_relationship: shape === 'child' ? 'subagent' : 'primary', schema_version: shape === 'schema' ? '2.0' : '1.0' }]))
  const { transcriptPath: _path, ...nativeHandle } = f.context.nativeHandle
  await expect(readGrokPromptExecutionEvidence({ ...f.context, nativeHandle, processId })).rejects.toThrow()
})

it('an updates replacement between qualification and open cannot inherit the original OS witness', async () => {
  const f = await source(), processId = await writer(f.events), original = NativeJsonlHistoryReader.open
  vi.spyOn(NativeJsonlHistoryReader, 'open').mockImplementationOnce(async (...args) => {
    await rename(f.path, f.path + '.original'); await writeFile(f.path, jsonl([prompt(), user(), activity(), end()]))
    return await original(...args)
  })
  const { transcriptPath: _path, ...nativeHandle } = f.context.nativeHandle
  await expect(readGrokPromptExecutionEvidence({ ...f.context, nativeHandle, processId })).rejects.toMatchObject({ code: 'AGENT_NATIVE_STATUS_SOURCE_CHANGED' })
})

it('the original process birth and writable descriptor remain necessary before accepting a native result', async () => {
  const f = await source(), processId = await writer(f.events), original = nativeProcess.nativeProcessBirth
  let calls = 0
  vi.spyOn(nativeProcess, 'nativeProcessBirth').mockImplementation(async (...args) => { const value = await original(...args); return ++calls > 2 ? value + '-changed' : value })
  const { transcriptPath: _path, ...nativeHandle } = f.context.nativeHandle
  await expect(readGrokPromptExecutionEvidence({ ...f.context, nativeHandle, processId })).rejects.toMatchObject({ code: 'AGENT_NATIVE_STATUS_UNAVAILABLE' })
})

it('a read-only OS descriptor never establishes the original writable native source', async () => {
  const f = await source(), processId = await writer(f.events, true)
  const { transcriptPath: _path, ...nativeHandle } = f.context.nativeHandle
  await expect(readGrokPromptExecutionEvidence({ ...f.context, nativeHandle, processId })).rejects.toMatchObject({ code: 'AGENT_NATIVE_STATUS_UNAVAILABLE' })
})

it('a FIFO replacing the observed events path cannot wait outside the original source budget', async () => {
  const f = await source(), processId = await writer(f.events), original = nativeProcess.nativeProcessFiles
  let swapped = false
  vi.spyOn(nativeProcess, 'nativeProcessFiles').mockImplementation(async (...args) => {
    const files = await original(...args)
    if (!swapped) { swapped = true; await rename(f.events, f.events + '.original'); await promisify(execFile)('mkfifo', [f.events]) }
    return files
  })
  const { transcriptPath: _path, ...nativeHandle } = f.context.nativeHandle
  const qualification = readGrokPromptExecutionEvidence({ ...f.context, nativeHandle, processId }).then(() => 'accepted', () => 'rejected')
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    expect(await Promise.race([qualification, new Promise(resolve => { deadline = setTimeout(() => resolve('blocked'), 5500) })])).toBe('rejected')
  } finally {
    if (deadline) clearTimeout(deadline)
    // Release even the pre-fix blocking reader before removing this private FIFO.
    const release = await open(f.events, constants.O_RDWR | constants.O_NONBLOCK)
    await qualification; await release.close()
  }
})

it('two writable native primary sources in the original Run are ambiguous', async () => {
  const f = await source(), second = join(f.root, 'another', NATIVE)
  await mkdir(second, { recursive: true })
  await writeFile(join(second, 'events.jsonl'), jsonl([{ type: 'turn_started', session_id: NATIVE, session_relationship: 'primary', schema_version: '1.0' }]))
  await writeFile(join(second, 'summary.json'), JSON.stringify({ info: { id: NATIVE, cwd: f.root } }))
  const processId = await writer(f.events, false, [join(second, 'events.jsonl')])
  const { transcriptPath: _path, ...nativeHandle } = f.context.nativeHandle
  await expect(readGrokPromptExecutionEvidence({ ...f.context, nativeHandle, processId })).rejects.toMatchObject({ code: 'AGENT_NATIVE_STATUS_UNAVAILABLE' })
})

it('a summary rewritten during its original identity read cannot qualify the source snapshot', async () => {
  const f = await source(), processId = await writer(f.events), summary = join(f.directory, 'summary.json')
  const originalBytes = await readFile(summary), summaryInode = (await stat(summary)).ino, read = nativeHistory.readNativeHistoryBytes
  let rewritten = false
  vi.spyOn(nativeHistory, 'readNativeHistoryBytes').mockImplementation(async (...args) => {
    const bytes = await read(...args)
    if (!rewritten && (await args[0].stat()).ino === summaryInode) {
      rewritten = true
      await writeFile(summary, JSON.stringify({ info: { id: 'foreign', cwd: f.root } }))
      await writeFile(summary, originalBytes)
    }
    return bytes
  })
  const { transcriptPath: _path, ...nativeHandle } = f.context.nativeHandle
  await expect(readGrokPromptExecutionEvidence({ ...f.context, nativeHandle, processId })).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_SOURCE_CHANGED' })
  expect(rewritten).toBe(true)
})

it('current finite reads and watch bootstrap stay bounded to the current user run; append observation remains incremental', async () => {
  const history = Array.from({ length: 3000 }, () => wire({ sessionUpdate: 'hook_annotation' }, undefined, '_x.ai/session/update'))
  const f = await source([...history, prompt('prior'), user(1), activity('prior'), end('prior'), prompt(), user(2), activity(), end()])
  const previous = vi.spyOn(NativeJsonlHistoryReader.prototype, 'readPrevious')
  for (let i = 0; i < 3; i++) expect(await readGrokPromptExecutionEvidence(f.context)).toMatchObject({ state: 'ended', nativeTurnId: TURN })
  expect(previous.mock.calls.length).toBeLessThanOrEqual(48)
  const watch = await observed(f), initialReads = previous.mock.calls.length
  expect(initialReads).toBeLessThanOrEqual(64)
  await appendFile(f.path, jsonl([prompt('next-turn'), user(3), activity('next-turn'), end('next-turn')]))
  await vi.waitFor(() => expect(watch.states.at(-1)).toMatchObject({ state: 'done', nativeTurnId: 'next-turn' }))
  expect(previous.mock.calls.length).toBe(initialReads)
  await proof({ scenario: 'bounded-native-current-cut', privateRoot: f.root, olderMetadataRows: history.length,
    finiteReads: 3, coldBackwardReads: initialReads, appendedBackwardReads: previous.mock.calls.length - initialReads })
})

it('cancelling original native source qualification cannot grant an outcome or replace the private writer', async () => {
  const f = await source(), processId = await writer(f.events), controller = new AbortController(), reason = Error('Original reader cancelled')
  controller.abort(reason)
  const { transcriptPath: _path, ...nativeHandle } = f.context.nativeHandle
  const reader = vi.spyOn(NativeJsonlHistoryReader, 'open')
  await expect(readGrokPromptExecutionEvidence({ ...f.context, nativeHandle, processId, signal: controller.signal })).rejects.toBe(reason)
  expect(reader).not.toHaveBeenCalled()
  expect(await nativeProcess.nativeProcessBirth(processId, new AbortController().signal)).toBeTruthy()
})

it('the actual OS witness reaches public Core and CLI; the Host defers a marker-only cut and consumes its original confirmed result', async () => {
  const [{ rpcOwnerFixture }, { AgentMuxRpcService }, { ObjectCliProbe }, { runSourceObjectCli }, { createGoalRuntime },
    { ContinuousProgressLoopManager }, { deliverContinuousProgress }] = await Promise.all([
      import('./helpers/public-rpc-owner.js'), import('../src/public-rpc-service.js'), import('./helpers/object-cli-rpc.js'),
      import('./helpers/source-object-cli.js'), import('../../../apps/host/src/goal-runtime.js'),
      import('../../../apps/host/src/continuous-progress-loop-manager.js'), import('../../../apps/host/src/continuous-progress-delivery.js')
    ])
  const core = await rpcOwnerFixture(['recipient', 'neighbor'], undefined, () => ({ providerId: 'grok', executorId: 'grok' }),
    () => ({ sessionExecutorConfiguration: async () => { throw Error('Current configuration cannot substitute the original source') } }))
  close.push(core.close)
  const f = await source([prompt('prior'), user(6), activity('prior'), end('prior')], core.root), processId = await writer(f.events)
  const before = (await core.store.readMetadata('recipient'))!, run = before.run
  await core.store.compareAndSwap(before, { ...before, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1 },
    nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: NATIVE } })
  const original = core.inner.kernel.status as (id: string) => Promise<any>
  core.inner.kernel.status = vi.fn(async (id: string) => ({ ...await original(id), program: '/private/grok', pid: processId }))
  core.inner.kernel.start = vi.fn(async () => { throw Error('No new Run is authorized') })
  const service = new AgentMuxRpcService({ coreClients: core.coreClients }); close.push(() => service.dispose())
  const inspect = () => service.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'recipient' } })
  await vi.waitFor(async () => expect((await inspect()).status?.observation.semantic).toBe('idle'), { timeout: 10000 })
  const probe = new ObjectCliProbe(request => service.call(request.method as any, request.params as any))
  await probe.start(); close.push(() => probe.stop())
  const cli = await runSourceObjectCli(['--endpoint', 'unix:' + probe.socketPath, 'agent', 'inspect', '--session', 'recipient'], probe.environment())
  expect(cli.code, cli.stderr).toBe(0)
  expect(JSON.parse(cli.stdout).result.status.observation.semantic).toBe('idle')
  let clock = Date.now(), records: any[] = []
  const runtime = createGoalRuntime({ clients: core.coreClients, checkIn: async () => ({ known: false, reason: 'not used' }) })
  const manager = new ContinuousProgressLoopManager({ load: async () => records, save: async (next: any[]) => { records = structuredClone(next) } } as any,
    (...args) => deliverContinuousProgress(runtime, ...args), () => clock,
    (loop, tick, now, signal) => runtime.observeContinuousProgress(loop, tick, now, signal), runtime)
  close.push(() => manager.stop())
  const arranged = await manager.call('schedule.create', { target: { hostId: 'local', agentSessionId: 'recipient', providerId: 'grok', workspacePath: core.root },
    everyMs: 60000, prompt: 'Neutral original Mote check', operationId: 'private-original-due', managedSource: { sourceId: 'private-mote', revision: 'private-main' } })
  manager.setMaintenanceOwner({ maintain: async () => {}, qualify: async () => ({ action: 'continue' }) })
  await appendFile(f.path, jsonl([prompt()]))
  await vi.waitFor(async () => expect((await inspect()).status?.observation.semantic).toBe('unknown'), { timeout: 10000 })
  expect(await readGrokPromptExecutionEvidence({ ...f.context, nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: NATIVE }, processId })).toBeNull()
  clock += 60000; await manager.check(clock)
  expect(manager.inspectLoop(arranged.schedule.loopId)!.lastOutcome).not.toBe('sent')
  expect(core.rawInput).not.toHaveBeenCalled()
  await appendFile(f.path, jsonl([user(7), activity('prior'), end('prior')]))
  await vi.waitFor(async () => expect((await inspect()).status?.session.semanticStatus).toMatchObject({ state: 'working', nativeTurnId: TURN }), { timeout: 10000 })
  expect((await inspect()).status?.observation.semantic).not.toBe('idle')
  await appendFile(f.path, jsonl([activity(), end()]))
  await vi.waitFor(async () => expect((await inspect()).status?.observation.semantic).toBe('idle'), { timeout: 10000 })
  clock += 60000; await manager.check(clock)
  const loop = manager.inspectLoop(arranged.schedule.loopId)!
  expect(loop).toMatchObject({ status: 'active', lastOutcome: 'sent', nextCheckAt: clock + 60000 })
  const submitted = await core.client.inspectAgentPromptSubmission({ kind: 'prompt', agentSessionId: 'recipient', expectedRun: run, submissionId: loop.lastTickId! })
  expect(submitted?.admission?.acknowledged).toBe(true)
  expect(core.inner.kernel.start).not.toHaveBeenCalled()
  expect(core.client.agentSession('recipient').run).toEqual(run)
  expect(core.client.agentSession('recipient').nativeHandle).not.toHaveProperty('transcriptPath')
  expect(core.client.agentSession('neighbor').semanticStatus).toBeUndefined()
  await proof({ scenario: 'os-public-cli-host', privateRoot: core.root, osWriterPid: processId, run, nativeSessionId: NATIVE,
    markerOnly: 'unknown-no-input', latePrior: 'working-no-idle', methods: probe.requests.map(r => r.method),
    loopId: loop.loopId, tick: loop.lastTickId, acknowledged: submitted?.admission?.acknowledged, nextCheckAt: loop.nextCheckAt,
    sourceNotPersistedOrPreseeded: true, modelCalls: 0 })
})

it('two independent OS Core owners reacquire the same original writable source without retained environment or locator', async () => {
  const [{ rpcOwnerFixture }, { runSourceObjectCli }] = await Promise.all([import('./helpers/public-rpc-owner.js'), import('./helpers/source-object-cli.js')])
  const core = await rpcOwnerFixture(['recipient'], undefined, () => ({ providerId: 'grok', executorId: 'grok' }))
  close.push(core.close)
  const f = await source(undefined, core.root), processId = await writer(f.events)
  const before = (await core.store.readMetadata('recipient'))!, run = before.run
  await core.store.compareAndSwap(before, { ...before, semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1 },
    nativeHandle: { kind: 'provider', providerId: 'grok', sessionId: NATIVE } })
  await core.client.dispose()
  const owner = fileURLToPath(new URL('./fixtures/grok-status-owner.mjs', import.meta.url))
  const loader = new URL('../../../apps/desktop/scripts/fixtures/performance-failure-evidence/source-loader.mjs', import.meta.url)
  const registration = `import { register } from 'node:module'; register(${JSON.stringify(loader.href)}, ${JSON.stringify(import.meta.url)});`
  const pids: number[] = [], states: any[] = [], originalBytes = await readFile(f.path)
  for (let index = 0; index < 2; index++) {
    const child = spawn(process.execPath, ['--import', 'data:text/javascript,' + encodeURIComponent(registration), owner, core.root, 'recipient', String(processId)],
      { env: { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: core.root, AGENTMUX_STATE_DIRECTORY: join(core.root, 'state'),
        AGENTMUX_MESSAGE_QUEUE_PATH: join(core.root, 'messages.ndjson') }, stdio: ['pipe', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', data => { output += data }); child.stderr.on('data', data => { errors += data })
    const ended = new Promise<number | null>(resolve => child.once('close', resolve))
    close.push(async () => { if (child.exitCode === null) child.stdin.end(); await ended })
    await vi.waitFor(() => expect(output, errors).toContain('"socket"'), { timeout: 30000 })
    const opened = JSON.parse(output.split('\n')[0]!)
    pids.push(opened.pid)
    let result: any
    await vi.waitFor(async () => {
      const cli = await runSourceObjectCli(['--endpoint', 'unix:' + opened.socket, 'agent', 'inspect', '--session', 'recipient'],
        { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: core.root })
      expect(cli.code, cli.stderr).toBe(0); result = JSON.parse(cli.stdout).result
      expect(result.status.observation.semantic, JSON.stringify(result.status)).toBe('idle')
    }, { timeout: 30000 })
    expect(result.session.nativeHandle).not.toHaveProperty('transcriptPath')
    expect(result.session.creation?.executorInvocationDigest).toBeUndefined()
    states.push({ run: result.session.run, nativeHandle: result.session.nativeHandle, semanticStatus: result.session.semanticStatus })
    child.stdin.end(); expect(await ended, errors).toBe(0); expect(output).toContain('"closed":true')
  }
  expect(pids[0]).not.toBe(pids[1]); expect(states[0]).toEqual(states[1]); expect(states[0].run).toEqual(run)
  expect(states[0].semanticStatus).toMatchObject({ state: 'done', nativeTurnId: TURN, observedAt: 2000 })
  expect(await readFile(f.path)).toEqual(originalBytes)
  await proof({ scenario: 'two-os-original-source', privateRoot: core.root, pids, writerPid: processId, run,
    nativeHandle: states[0].nativeHandle, originalClockRetained: true, originalBytesUnchanged: true, noEnvironmentOrLocatorSeed: true, modelCalls: 0 })
}, 120000)
