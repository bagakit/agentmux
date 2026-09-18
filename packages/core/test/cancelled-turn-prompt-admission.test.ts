import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { OutputChunk, RunEvent } from '@ctxmux/sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentMuxClient, AgentMuxError, AgentMuxFileAgentSessionStore, createNumberedTerminalInteractionProtocol,
  defineAgentProvider } from '../dist/index.js'
import { agentTurnCompletionIdentity, agentTurnEndBoundary } from '../src/agent-session-identity.js'
import { normalizeStoredAgentSession } from '../src/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import { defaultAgentMuxHookPort } from '../src/runtime-paths.js'
import type { AgentMuxClientEvent, AgentMuxStoredAgentSession, AgentHookReceipt } from '../src/types.js'

const isolation = vi.hoisted(() => ({ homedir: '/synthetic/unset-home' }))
vi.mock('node:os', async importOriginal => ({
  ...await importOriginal<typeof import('node:os')>(), homedir: () => isolation.homedir
}))
const exec = promisify(execFile)
const sessionId = 'cancel-session', runId = 'cancel-run', token = 't'.repeat(43)
const frameStart = '\u001b[?2026h', frameEnd = '\u001b[?2026l'
const modes = ['single-phase', 'render-then-submit'] as const
type Mode = typeof modes[number]
type Payload = Record<string, unknown>

afterEach(() => vi.unstubAllEnvs())

function nativeReadiness(session: AgentMuxStoredAgentSession) {
  const readiness = session.terminalPromptReadiness
  expect(readiness?.source).toBe('native-stop')
  if (readiness?.source !== 'native-stop') throw new Error('Expected native readiness fixture fact')
  return readiness
}

// Synthetic native protocols and SDK receipts are the fixture boundary. The public Client,
// authenticated HTTP ingress, FileStore, input coordinator and xterm screen evidence use built Core.
// No native Agent, Electron, personal config, Session transcript or existing Run is opened.
async function harness(mode: Mode, receiptTime?: number | null) {
  const root = await mkdtemp(join(tmpdir(), 'amux-cancel-admission-'))
  const path = join(root, 'sessions.json'), workspacePath = join(root, 'workspace')
  await mkdir(workspacePath)
  isolation.homedir = join(root, 'home')
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'queue.ndjson'))
  vi.stubEnv('AGENTMUX_AGENT_SESSION_STORE', path)
  const providerId = `synthetic-${mode}`
  const store = new AgentMuxFileAgentSessionStore(path)
  await store.compareAndSwap(null, {
    kind: 'agent', agentSessionId: sessionId, providerId, executorId: providerId,
    hostId: 'local', workspacePath, run: { runId }, retiredRuns: [],
    hookBindingId: 'b'.repeat(43), hookToken: token, createdAt: 1, updatedAt: 1,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 1 },
    promptCompletionAdmission: { submissionId: 'prior', operationId: 'prior-input', startByte: 0, endByte: 10 },
    ...(receiptTime === undefined ? {} : { updatedAt: 200,
      semanticStatus: { state: 'working' as const, source: 'native-hook' as const, observedAt: 200 },
      ...(receiptTime === null ? {
        hookReceipt: { id: 'neutral-old', providerId, agentSessionId: sessionId, run: { runId },
          eventName: 'Notification', observedAt: 199 },
        terminalPromptReadiness: { source: 'native-stop' as const, id: 'known-old', run: { runId }, outputCursorBytes: 0 }
      } : {
        hookReceipt: { id: 'stale-end', providerId, agentSessionId: sessionId, run: { runId },
          eventName: 'notice', lifecycleEvent: 'turn-end' as const, observedAt: receiptTime },
        terminalPromptReadiness: { source: 'native-stop' as const, id: 'stale-end', run: { runId },
          outputCursorBytes: 0, observedAt: receiptTime }
      }) })
  })
  const provider = defineAgentProvider({
    catalog: {
      id: providerId, label: 'Synthetic native boundary', executable: 'synthetic-agent',
      expectedProcess: 'synthetic-agent', promptDelivery: 'positional-argv',
      readySignal: { kind: 'foreground-process', expectedProcess: 'synthetic-agent' },
      // Public connect cannot touch a managed default config while T-019 is in another tree.
      hookStrategy: { kind: 'native', installation: 'unmanaged' },
      resumeStrategy: { kind: 'none' }, acpStrategy: { kind: 'none' },
      capabilities: { terminal: true, timeline: 'complete-events', permission: 'respond',
        providerResume: false, replyCorrelation: 'none' }
    },
    buildArgs: (_prompt, args) => [...args],
    ...(mode === 'render-then-submit' ? {
      terminalPromptRender: { frameStart, frameEnd, activeComposer: '›' },
      planPromptInput: (prompt: string) => ({ kind: 'render-then-submit' as const,
        payload: prompt, renderedText: prompt, submit: '\r' })
    } : {}),
    hook: { rules: [
      { events: ['notice'], state: 'unknown', matches: p => p.reason === 'cancelled', lifecycleEvent: 'turn-end' },
      { events: ['signal'], state: 'unknown', matches: p => p.category === 'turn' && p.reason === 'halt', lifecycleEvent: 'turn-end' },
      { events: ['turn_open'], state: 'working', lifecycleEvent: 'turn-start' },
      { events: ['prompt_open'], state: 'unknown', lifecycleEvent: 'user-prompt-submit' },
      { events: ['PostToolUse'], state: 'working' },
      { events: ['finish'], state: 'done', lifecycleEvent: 'turn-end' },
      { events: ['ask'], state: 'waiting', toolNames: ['select'] }
    ] },
    interaction: createNumberedTerminalInteractionProtocol({
      questionEvents: ['ask'], questionTools: ['select'], questionCompletionEvents: ['answer-observed'],
      permissionOptions: [
        { id: 'allow', label: 'Allow', kind: 'allow-once', input: '1' },
        { id: 'deny', label: 'Deny', kind: 'reject-once', input: '2' }
      ]
    })
  })
  let cursor = 10, outputCursor = 0, partialFailure = false, snapshotFailure = false
  const writes: string[] = [], chunks: OutputChunk[] = []
  const streams = new Set<{ push(event: RunEvent): void; close(): void }>()
  const run = () => ({
    id: runId, spec: { program: 'synthetic-agent', args: [], cwd: workspacePath, env: {} },
    lineage: null, pid: 123, state: { type: 'running' as const }, latest_output_bytes: outputCursor,
    durable_output_bytes: outputCursor, first_available_byte: 0, attachments: streams.size,
    applied_input_bytes: cursor, current_size: { cols: 80, rows: 24 }
  })
  function output(text: string) {
    const data = new TextEncoder().encode(text)
    const chunk = { start_byte: outputCursor, end_byte: outputCursor + data.byteLength, data }
    outputCursor = chunk.end_byte
    chunks.push(chunk)
    for (const stream of streams) stream.push({ type: 'output', chunk })
  }
  output(`${frameStart}\u001b[22;1H› \u001b[22;3H${frameEnd}`)
  const receipts = new Map<string, { start_byte: number; end_byte: number; data: string }>()
  const recoverableInput = vi.fn(async (op: {
    daemonInstance: string; operationKey: string; runId: string; expectedByte: number; data: string
  }) => {
    expect(op.daemonInstance).toBe('synthetic-daemon')
    expect(op.runId).toBe(runId)
    const existing = receipts.get(op.operationKey)
    if (existing) {
      expect([op.expectedByte, op.data]).toEqual([existing.start_byte, existing.data])
      return { run: run(), receipt: existing }
    }
    expect(op.expectedByte).toBe(cursor)
    if (partialFailure) {
      partialFailure = false
      cursor += 1
      writes.push(op.data.slice(0, 1))
      throw new Error('Synthetic partial acceptance without receipt')
    }
    const receipt = { start_byte: cursor, end_byte: cursor + Buffer.byteLength(op.data), data: op.data }
    cursor = receipt.end_byte
    receipts.set(op.operationKey, receipt)
    writes.push(op.data)
    if (mode === 'render-then-submit' && op.data !== '\r') {
      output(`${frameStart}\u001b[2J\u001b[22;1H› ${op.data}\u001b[22;${3 + op.data.length}H${frameEnd}`)
    }
    return { run: run(), receipt }
  })
  const attachTerminal = vi.fn(async (id: string) => {
    expect(id).toBe(runId)
    let closed = false, wake: (() => void) | undefined
    const queue: RunEvent[] = []
    const stream = { push(event: RunEvent) { queue.push(event); wake?.() },
      close() { closed = true; wake?.(); streams.delete(stream) } }
    streams.add(stream)
    return {
      snapshot: { run: run(), resize_revision: 0,
        terminal: { type: 'basic_vt', checkpoint: { run_id: runId, through_byte: 0,
          resize_revision: 0, size: { cols: 80, rows: 24 } }, resizes: [] },
        terminal_restore: new TextEncoder().encode('\u001bc'),
        replay: { chunks: [...chunks], first_available_byte: 0,
          latest_output_bytes: outputCursor, truncated: false } },
      async *events() {
        while (!closed) {
          if (queue.length) yield queue.shift()!
          else await new Promise<void>(resolve => { wake = resolve })
        }
      }, detach: async () => stream.close(), close: () => stream.close()
    }
  })
  const start = vi.fn(async () => { throw new Error('Unexpected native Run creation') })
  const stop = vi.fn(async () => { throw new Error('Unexpected native Run stop') })
  const clients: AgentMuxClient[] = [], events: AgentMuxClientEvent[] = []
  async function connect() {
    const client = new AgentMuxClient({ store: new AgentMuxFileAgentSessionStore(path), providers: [provider] })
    // Keep the constructor's adapter object: the coordinator and screen owner already reference it.
    // Control only its SDK transport, never a private admission/Hook/registry method.
    const adapter = (client as unknown as { kernel: CtxmuxRunAdapter }).kernel
    Object.assign(adapter, { client: { list: async () => [{ id: runId }],
      status: async () => {
        if (snapshotFailure) { snapshotFailure = false; throw new AgentMuxError('Synthetic snapshot unavailable', 'CTXMUX_DISCONNECTED') }
        return run()
      }, recoverableInput, attachTerminal, start, stop },
      runtime: { daemonInstanceId: 'synthetic-daemon' } })
    clients.push(client)
    client.onEvent(event => events.push(event))
    await client.connect()
    expect(client.agentSessions().map(s => [s.agentSessionId, s.run.runId])).toEqual([[sessionId, runId]])
    expect((await client.listRuns()).map(r => [r.runId, r.state])).toEqual([[runId, 'running']])
    return client
  }
  let client: AgentMuxClient
  try { client = await connect() } catch (error) {
    for (const c of clients) await c.dispose()
    await rm(root, { recursive: true, force: true })
    throw error
  }
  let receiptNumber = 0
  async function feed(eventName: string, payload: Payload = {}, receiptId?: string, badToken = false) {
    const response = await fetch(`http://127.0.0.1:${defaultAgentMuxHookPort()}/v1/events`, {
      method: 'POST', headers: { authorization: `Bearer ${badToken ? 'wrong' : token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ receiptId: receiptId ?? `receipt-${++receiptNumber}`, eventName, payload })
    })
    return response.status
  }
  async function stored() {
    const rows = (await new AgentMuxFileAgentSessionStore(path).load()).map(normalizeStoredAgentSession)
    expect(rows).toHaveLength(1)
    return rows[0]!
  }
  const close = async () => {
    for (const c of clients) await c.dispose()
    for (const stream of streams) stream.close()
    await rm(root, { recursive: true, force: true })
  }
  return { get client() { return client }, feed, stored, writes, events, start, stop, recoverableInput, attachTerminal,
    // Explicit fixture corruption of time only; production ingress remains the positive path.
    async writeFixtureReceipt(receipt: AgentHookReceipt) {
      const current = await stored()
      await store.compareAndSwap(current, { ...current, hookReceipt: receipt })
      expect((await stored()).hookReceipt).toEqual(receipt)
    },
    send: (operationId: string, prompt: string, expectedCompletionId?: string) => client.submitAgentPrompt({
      agentSessionId: sessionId, operationId, prompt, ...(expectedCompletionId ? { expectedCompletionId } : {}) }),
    failPartial: () => { partialFailure = true },
    failHookSnapshot: () => { snapshotFailure = true },
    async reopen() {
      await client.dispose()
      const expected = await store.load()
      const env = { ...process.env }
      for (const key of Object.keys(env)) if (key.startsWith('AGENTMUX_')) delete env[key]
      Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'),
        AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'queue.ndjson'), AGENTMUX_AGENT_SESSION_STORE: path })
      const script = `
        import os from 'node:os';import {syncBuiltinESMExports} from 'node:module';
        os.homedir=()=>${JSON.stringify(join(root, 'home'))};syncBuiltinESMExports();
        const {AgentMuxFileAgentSessionStore}=await import(${JSON.stringify(new URL('../dist/index.js', import.meta.url).href)});
        console.log(JSON.stringify({pid:process.pid,sessions:await new AgentMuxFileAgentSessionStore(process.argv[1]).load()}));`
      const child = JSON.parse((await exec(process.execPath, ['--input-type=module', '-e', script, path], { env, timeout: 8000 })).stdout)
      expect(child.pid).not.toBe(process.pid)
      expect(child.sessions).toEqual(expected)
      client = await connect()
    }, close }
}

describe('manual admission after native cancellation', () => {
  it.each(modes)('%s does not replace a consumed native end with an older or equal actual end observation', async mode => {
    const h = await harness(mode)
    try {
      expect(await h.feed('notice', { reason: 'cancelled' }, 'current-end')).toBe(204)
      await h.send('consume-current', 'hello')
      const consumed = nativeReadiness(await h.stored())
      expect(consumed.observedAt).toBeTypeOf('number')
      for (const observedAt of [consumed.observedAt! - 1, consumed.observedAt!]) {
        // Control only the synthetic ingress clock; this is still an actual HTTP native-end fold.
        const clock = vi.spyOn(Date, 'now').mockReturnValue(observedAt)
        try {
          expect(await h.feed('notice', { reason: 'cancelled' }, `older-end-${observedAt}`)).toBe(204)
        } finally { clock.mockRestore() }
        expect((await h.stored()).hookReceipt).toMatchObject({ observedAt, lifecycleEvent: 'turn-end' })
        expect(nativeReadiness(await h.stored())).toEqual(consumed)
        await expect(h.send(`older-end-next-${observedAt}`, 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      }
      await h.reopen()
      await expect(h.send('older-end-restored', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual(mode === 'single-phase' ? ['hello\r'] : ['hello', '\r'])
      expect((await h.client.listRuns()).map(r => [r.runId, r.state])).toEqual([[runId, 'running']])
    } finally { await h.close() }
  })

  it.each(modes)('%s structurally invalidates a native end on a neutral native prompt reopening', async mode => {
    const h = await harness(mode)
    try {
      expect(await h.feed('notice', { reason: 'cancelled' })).toBe(204)
      const cancelled = await h.stored()
      expect(await h.feed('prompt_open')).toBe(204)
      const reopened = await h.stored()
      expect(reopened.hookReceipt).toMatchObject({ eventName: 'prompt_open', lifecycleEvent: 'user-prompt-submit' })
      expect(reopened.semanticStatus).toEqual(cancelled.semanticStatus)
      expect(reopened.terminalPromptReadiness).toBeUndefined()
      expect(await h.feed('Notification')).toBe(204)
      await h.reopen()
      await expect(h.send('reopened-neutral', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual([])
      expect(await h.feed('PostToolUse', { tool_name: 'synthetic-shell' })).toBe(204)
      expect((await h.stored()).semanticStatus?.observedAt).toBeGreaterThan(cancelled.semanticStatus!.observedAt)
      expect(await h.feed('notice', { reason: 'cancelled' })).toBe(204)
      await h.send('after-new-end', 'hello')
      expect(h.writes).toEqual(mode === 'single-phase' ? ['hello\r'] : ['hello', '\r'])
    } finally { await h.close() }
  })

  it.each(modes)('%s retains the known native end through ordinary and suppressed tool diagnostics, including restart', async mode => {
    const h = await harness(mode)
    try {
      expect(await h.feed('notice', { reason: 'cancelled' }, 'adjacent-cancel')).toBe(204)
      const cancelled = await h.stored()
      expect(await h.feed('Notification', { reason: 'information' })).toBe(204)
      expect(await h.feed('PostToolUse', { tool_name: 'synthetic-shell' })).toBe(204)
      expect((await h.stored()).hookReceipt).toMatchObject({ eventName: 'PostToolUse', lifecycleEvent: 'tool-use-end' })
      expect((await h.stored()).semanticStatus).toEqual(cancelled.semanticStatus)
      await h.reopen()
      expect(await h.feed('PostToolUse', { tool_name: 'synthetic-shell' })).toBe(204)
      expect((await h.stored()).semanticStatus).toEqual(cancelled.semanticStatus)
      await h.send('adjacent-next', 'hello')
      const expected = mode === 'single-phase' ? ['hello\r'] : ['hello', '\r']
      expect(h.writes).toEqual(expected)
      expect((await h.stored()).terminalPromptReadiness).toMatchObject({ source: 'native-stop',
        id: 'adjacent-cancel', run: { runId }, observedAt: cancelled.hookReceipt!.observedAt,
        consumedBySubmissionId: 'adjacent-next' })
      expect((await h.stored()).promptCompletionAdmission?.completionId).toBeUndefined()
      await expect(h.send('adjacent-once', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      await h.reopen()
      await h.send('adjacent-next', 'hello')
      expect(await h.feed('notice', { reason: 'cancelled' }, 'adjacent-cancel')).toBe(204)
      await expect(h.send('same-end-replayed', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect((await h.stored()).terminalPromptReadiness?.consumedBySubmissionId).toBe('adjacent-next')
      expect(await h.feed('turn_open')).toBe(204)
      expect((await h.stored()).terminalPromptReadiness).toBeUndefined()
      expect(await h.feed('Notification', { reason: 'information' })).toBe(204)
      await h.reopen()
      await expect(h.send('new-working', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual(expected)
      expect(h.start).not.toHaveBeenCalled()
      expect(h.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it.each(modes)('%s preserves native end without guessing an unavailable output snapshot', async mode => {
    const h = await harness(mode)
    try {
      h.failHookSnapshot()
      expect(await h.feed('notice', { reason: 'cancelled' }, 'no-snapshot')).toBe(204)
      const cancelled = await h.stored()
      expect(cancelled.hookReceipt?.outputCursorBytes).toBeUndefined()
      expect(cancelled.terminalPromptReadiness).toMatchObject({ source: 'native-stop', id: 'no-snapshot',
        observedAt: cancelled.hookReceipt!.observedAt, run: { runId } })
      expect(cancelled.terminalPromptReadiness?.outputCursorBytes).toBeUndefined()
      expect(cancelled.terminalPromptReadiness?.readyThroughByte).toBeUndefined()
      expect(await h.feed('Notification')).toBe(204)
      await h.reopen()
      await h.send('without-snapshot', 'hello')
      expect(h.writes).toEqual(mode === 'single-phase' ? ['hello\r'] : ['hello', '\r'])
      expect((await h.stored()).terminalPromptReadiness?.consumedBySubmissionId).toBe('without-snapshot')
      expect((await h.stored()).semanticStatus?.state).toBe('working')
      expect((await h.stored()).promptCompletionAdmission?.completionId).toBeUndefined()
      await expect(h.send('without-snapshot-once', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
    } finally { await h.close() }
  })

  it.each(modes)('%s retains a healthy durable Session when native end time is absent and honestly unknown', async mode => {
    const h = await harness(mode, null)
    try {
      expect(nativeReadiness(await h.stored()).observedAt).toBeUndefined()
      await h.reopen()
      expect(await h.feed('Notification')).toBe(204)
      expect(nativeReadiness(await h.stored()).observedAt).toBeUndefined()
      expect(h.client.agentSessions().map(s => [s.agentSessionId, s.run.runId])).toEqual([[sessionId, runId]])
      await expect(h.send('unknown-old-time', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual([])
      expect(await h.feed('notice', { reason: 'cancelled' }, 'known-new-end')).toBe(204)
      await h.send('known-time', 'hello')
      expect(h.writes).toEqual(mode === 'single-phase' ? ['hello\r'] : ['hello', '\r'])
    } finally { await h.close() }
  })
  it.each(modes)('%s consumes one HTTP native end without inventing success, across a fresh Client', async mode => {
    const h = await harness(mode)
    try {
      expect(await h.feed('notice', { reason: 'cancelled' }, 'cancel-1', true)).toBe(403)
      expect((await h.stored()).hookReceipt).toBeUndefined()
      expect(await h.feed('notice', { reason: 'cancelled' }, 'cancel-1')).toBe(204)
      const cancelled = await h.stored()
      expect(cancelled.hookReceipt).toMatchObject({ id: 'cancel-1', eventName: 'notice', lifecycleEvent: 'turn-end', run: { runId } })
      expect(cancelled.semanticStatus?.state).toBe('working')
      expect(agentTurnCompletionIdentity(cancelled)).toBeUndefined()
      await expect(h.send('auto-cancel', 'automatic', JSON.stringify([runId, cancelled.hookReceipt!.observedAt])))
        .rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
      expect(h.writes).toEqual([])
      await h.reopen()
      await h.send('next-manual', 'hello')
      const expectedWrites = mode === 'single-phase' ? ['hello\r'] : ['hello', '\r']
      expect(h.writes).toEqual(expectedWrites)
      expect((await h.stored()).promptCompletionAdmission?.completionId).toBeUndefined()
      expect((await h.stored()).terminalPromptDelivery).toBeUndefined()
      expect(h.events.filter(e => e.type === 'agent-status').map(e => e.state)).toEqual(['unknown'])
      if (mode === 'render-then-submit') {
        expect(h.attachTerminal).toHaveBeenCalled()
        expect((await h.stored()).terminalPromptSubmission).toMatchObject({
          payload: { acknowledged: true }, submit: { acknowledged: true } })
      }
      await h.send('next-manual', 'hello')
      expect(h.writes).toEqual(expectedWrites)
      await expect(h.send('another', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      await h.reopen()
      await h.send('next-manual', 'hello')
      expect(h.writes).toEqual(expectedWrites)
      expect(await h.feed('notice', { reason: 'cancelled' }, 'cancel-1')).toBe(204)
      await expect(h.send('replayed-end', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual(expectedWrites)
      expect((await h.stored()).terminalPromptReadiness).toMatchObject({ source: 'native-stop',
        id: 'cancel-1', run: { runId }, observedAt: cancelled.hookReceipt!.observedAt, consumedBySubmissionId: 'next-manual' })
      await h.writeFixtureReceipt({ ...cancelled.hookReceipt!, id: 'stale-unseen-id' })
      await h.reopen()
      await expect(h.send('old-time-restored', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual(expectedWrites)
      expect(await h.feed('signal', { extra: { category: 'turn', reason: 'halt' } }, 'cancel-2')).toBe(204)
      expect((await h.stored()).hookReceipt!.observedAt).toBeGreaterThan(cancelled.hookReceipt!.observedAt)
      await h.send('new-boundary', 'again')
      expect(h.writes).toEqual([...expectedWrites, ...(mode === 'single-phase' ? ['again\r'] : ['again', '\r'])])
      expect((await h.stored()).terminalPromptReadiness).toMatchObject({ id: 'cancel-2', consumedBySubmissionId: 'new-boundary' })
      await expect(h.send('still-once', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.start).not.toHaveBeenCalled()
      expect(h.stop).not.toHaveBeenCalled()
      expect((await h.client.listRuns()).map(r => [r.runId, r.state])).toEqual([[runId, 'running']])
    } finally { await h.close() }
  })

  it.each(modes)('%s keeps ordinary notifications, working, pending interaction and stale requested Run guarded', async mode => {
    const h = await harness(mode)
    try {
      expect(await h.feed('notice', { reason: 'information' })).toBe(204)
      expect((await h.stored()).hookReceipt?.lifecycleEvent).toBeUndefined()
      await expect(h.send('notice-is-not-end', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(await h.feed('notice', { reason: 'cancelled' })).toBe(204)
      expect(await h.feed('turn_open')).toBe(204)
      await expect(h.send('still-working', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(await h.feed('ask', { tool_name: 'select', tool_use_id: 'choice-1',
        tool_input: { questions: [{ question: 'Synthetic choice?', options: [{ label: 'First' }, { label: 'Second' }] }] } })).toBe(204)
      expect(await h.feed('notice', { reason: 'cancelled' })).toBe(204)
      expect((await h.stored()).pendingInteraction?.request).toMatchObject({ kind: 'question', nativeToolCallId: 'choice-1' })
      await expect(h.send('pending-choice', 'later')).rejects.toMatchObject({ code: 'AGENT_INTERACTION_PENDING' })
      await expect(h.client.submitAgentPrompt({ agentSessionId: sessionId, operationId: 'old-run', prompt: 'later', expectedRun: { runId: 'retired-run' } }))
        .rejects.toMatchObject({ code: 'STALE_AGENT_SESSION' })
      expect(h.writes).toEqual([])
      expect(h.recoverableInput).not.toHaveBeenCalled()
      expect(h.start).not.toHaveBeenCalled()
      expect(h.stop).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it.each(modes)('%s does not let a new native end replace incomplete input', async mode => {
    const h = await harness(mode)
    try {
      expect(await h.feed('notice', { reason: 'cancelled' })).toBe(204)
      h.failPartial()
      await expect(h.send('partial', 'hello')).rejects.toThrow('Synthetic partial acceptance without receipt')
      expect(h.writes).toEqual(['h'])
      expect(await h.feed('signal', { extra: { category: 'turn', reason: 'halt' } })).toBe(204)
      await expect(h.send('replacement', 'again')).rejects.toMatchObject({ code: 'AGENT_PROMPT_SUBMISSION_BUSY' })
      await h.reopen()
      await expect(h.send('replacement-after-restart', 'again')).rejects.toMatchObject({ code: 'AGENT_PROMPT_SUBMISSION_BUSY' })
      expect(h.writes).toEqual(['h'])
      expect(h.recoverableInput).toHaveBeenCalledOnce()
    } finally { await h.close() }
  })

  it.each(modes)('%s does not open for a stored native end older than resumed working', async mode => {
    const h = await harness(mode, 150)
    try {
      expect((await h.stored()).hookReceipt).toMatchObject({ lifecycleEvent: 'turn-end', observedAt: 150 })
      await expect(h.send('stale-end', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      await h.reopen()
      await expect(h.send('stale-end-restored', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual([])
      expect(h.recoverableInput).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it.each(modes)('%s preserves exact successful automatic completion and consumes its native end too', async mode => {
    const h = await harness(mode)
    try {
      expect(await h.feed('finish', {}, 'successful-end')).toBe(204)
      const completion = agentTurnCompletionIdentity(await h.stored())
      expect(completion).toBeTypeOf('string')
      await expect(h.send('wrong-completion', 'automatic', 'other')).rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
      await h.send('successful-auto', 'automatic', completion)
      expect(h.writes).toEqual(mode === 'single-phase' ? ['automatic\r'] : ['automatic', '\r'])
      expect((await h.stored()).promptCompletionAdmission).toMatchObject({ completionId: completion })
      expect((await h.stored()).terminalPromptReadiness).toMatchObject({ id: 'successful-end', run: { runId },
        consumedBySubmissionId: 'successful-auto' })
      await h.reopen()
      await expect(h.send('consumed-auto', 'automatic', completion)).rejects.toMatchObject({ code: 'AGENT_COMPLETION_CHANGED' })
      await expect(h.send('consumed-manual', 'later')).rejects.toMatchObject({ code: 'AGENT_TURN_END_UNCONFIRMED' })
      expect(h.writes).toEqual(mode === 'single-phase' ? ['automatic\r'] : ['automatic', '\r'])
    } finally { await h.close() }
  })
})

function boundaryFixture(): AgentMuxStoredAgentSession {
  return { kind: 'agent', agentSessionId: sessionId, providerId: 'synthetic', executorId: 'synthetic',
    hostId: 'local', workspacePath: '/synthetic/workspace', run: { runId }, retiredRuns: [],
    hookBindingId: 'b'.repeat(43), hookToken: token, createdAt: 1, updatedAt: 300,
    semanticStatus: { state: 'working', source: 'native-hook', observedAt: 100 },
    hookReceipt: { id: 'end-2', providerId: 'synthetic', agentSessionId: sessionId,
      eventName: 'notice', lifecycleEvent: 'turn-end', run: { runId }, observedAt: 200 },
    terminalPromptReadiness: { source: 'native-stop', id: 'end-2', run: { runId }, observedAt: 200 },
    promptCompletionAdmission: { operationId: 'prior-input', startByte: 0, endByte: 10 } }
}

describe('durable native-end admission identity', () => {
  it('requires the canonical current owner and a strictly newer, unconsumed boundary', () => {
    const session = boundaryFixture(), receipt = session.hookReceipt!, readiness = nativeReadiness(session)
    expect(agentTurnEndBoundary(session)).toEqual({ id: 'end-2', run: { runId }, observedAt: 200 })
    // A matching native receipt can supply its own time when the retained end time is absent.
    const { observedAt: _time, ...withoutTime } = readiness
    const missingTime = { ...session, terminalPromptReadiness: withoutTime }
    expect(agentTurnEndBoundary(missingTime)).toEqual({ id: 'end-2', run: { runId }, observedAt: 200 })
    for (const patch of [
      { providerId: 'foreign' }, { agentSessionId: 'foreign' }, { run: { runId: 'retired-run' } },
      { id: 'other-end' }, { lifecycleEvent: 'tool-use-end' }
    ] satisfies Partial<AgentHookReceipt>[]) {
      expect(agentTurnEndBoundary({ ...missingTime, hookReceipt: { ...receipt, ...patch } })).toBeUndefined()
    }
    const { hookReceipt: _receipt, ...withoutReceipt } = session
    const { lifecycleEvent: _lifecycle, ...undeclared } = receipt
    expect(agentTurnEndBoundary(withoutReceipt)).toEqual({ id: 'end-2', run: { runId }, observedAt: 200 })
    expect(agentTurnEndBoundary({ ...missingTime, hookReceipt: undeclared })).toBeUndefined()
    expect(agentTurnEndBoundary({ ...session, terminalPromptReadiness: { ...readiness, run: { runId: 'retired-run' } } })).toBeUndefined()
    expect(agentTurnEndBoundary({ ...session, terminalPromptReadiness: { ...readiness, consumedBySubmissionId: 'prior' } })).toBeUndefined()
    expect(agentTurnEndBoundary({ ...session, terminalPromptReadiness: { source: 'initial-composer',
      id: 'screen-only', run: { runId }, outputCursorBytes: 0, readyThroughByte: 1 } })).toBeUndefined()
    expect(agentTurnEndBoundary({ ...session, semanticStatus: {
      state: 'working', source: 'native-hook', observedAt: 201 } })).toBeUndefined()
    // Existing fixed dialects and Provider contributions share the same canonical computation.
    expect(agentTurnEndBoundary({ ...missingTime, hookReceipt: {
      ...undeclared, eventName: 'Stop' } })).toEqual({ id: 'end-2', run: { runId }, observedAt: 200 })
    expect(agentTurnCompletionIdentity(session)).toBeUndefined()
  })

  it('validates consumption on the existing FileStore admission without dropping absent facts', () => {
    const session = boundaryFixture(), readiness = nativeReadiness(session)
    expect(normalizeStoredAgentSession(session)).toEqual(session)
    const { observedAt: _time, ...withoutTime } = readiness
    expect(nativeReadiness(normalizeStoredAgentSession({ ...session, terminalPromptReadiness: withoutTime })).observedAt).toBeUndefined()
    expect(normalizeStoredAgentSession({ ...session, terminalPromptReadiness: { ...readiness,
      consumedBySubmissionId: 'manual' } }).terminalPromptReadiness).toEqual({ ...readiness, consumedBySubmissionId: 'manual' })
    for (const patch of [
      { id: '' }, { run: { runId: 'retired-run' } }, { observedAt: -1 },
      { observedAt: 301 }, { observedAt: '120' }, { readyThroughByte: 1 }
    ]) {
      expect(() => normalizeStoredAgentSession({ ...session, terminalPromptReadiness: { ...readiness, ...patch } }))
        .toThrow()
    }
    expect(() => normalizeStoredAgentSession({ ...session, terminalPromptReadiness: {
      source: 'initial-composer', id: 'screen', run: { runId }, outputCursorBytes: 0, consumedBySubmissionId: 'manual'
    } })).toThrow()
  })
})
