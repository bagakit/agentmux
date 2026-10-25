import { fixturePath } from './helpers/fixture-values.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AgentMuxClient as DefaultClient } from '../src/client.js'
import { AgentMuxFileAgentSessionStore } from '../src/agent-session-store.js'
import { agentPromptCondition } from '../src/agent-prompt-condition.js'
import { composeAgentPrompt } from '../src/agent-outbound-message.js'
import { hostedTestClient } from './helpers/hosted-runtime-port.js'

const Client: typeof DefaultClient = process.env.AGENTMUX_TEST_INJECTED_CONTEXT_CLIENT
  ? (await import(process.env.AGENTMUX_TEST_INJECTED_CONTEXT_CLIENT)).AgentMuxClient : DefaultClient
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs() })

/** Public Core / FileStore and Native tuple recovery execute; only Native I/O is controlled. */
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'amx-injected-submit-'))
  cleanups.push(() => rm(root, { recursive: true, force: true }))
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', join(root, 'runtime'))
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', join(root, 'state'))
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const path = join(root, 'sessions.json')
  const store = new AgentMuxFileAgentSessionStore(path)
  const session = { kind: 'agent' as const, agentSessionId: 'injected-recipient', providerId: 'traex', executorId: 'traex',
    hostId: 'local', workspacePath: root, run: { runId: 'original-run' }, retiredRuns: [],
    createdAt: 1, updatedAt: 1, hookBindingId: 'private-binding', hookToken: 'private-token' }
  await store.compareAndSwap(null, session)
  let cursor = 0, loseAck = false
  const requests: unknown[] = [], writes: string[] = [], receipts = new Map<string, unknown>()
  const run = () => ({ runId: session.run.runId, lifecycleOperationId: null, program: fixturePath("private/generic"), args: [], workspacePath: root,
    pid: 321, state: { type: 'running' }, cols: 80, rows: 24, latestOutputBytes: 0, firstAvailableByte: 0, acceptedInputBytes: cursor })
  const stop = vi.fn()
  const make = async () => {
    const freshStore = new AgentMuxFileAgentSessionStore(path)
    const core = new Client({ store: freshStore }); cleanups.push(() => core.dispose())
    const inner = core as unknown as { connected: boolean; registry: { load(hostId: string): Promise<void> }; kernel: Record<string, unknown> }
    await inner.registry.load('local'); inner.connected = true
    Object.assign(inner.kernel, { isConnected: () => true, identity: () => ({ daemonInstanceId: 'original-daemon', protocolVersion: 18, buildIdentity: 'private-io' }),
      status: async () => run(), list: async () => [run()], stop,
      input: async (runId: string, input: { operationId: string; expectedByte: number; data: string }) => {
        expect(runId).toBe(session.run.runId); requests.push(structuredClone(input))
        const previous = receipts.get(input.operationId)
        if (previous) expect(input).toEqual(previous)
        else {
          expect(input.expectedByte).toBe(cursor); receipts.set(input.operationId, structuredClone(input))
          writes.push(input.data); cursor += Buffer.byteLength(input.data)
        }
        if (loseAck) { loseAck = false; throw new Error('Input accepted; ACK lost') }
        return { run: run(), appliedByteRange: { startByte: input.expectedByte, endByte: input.expectedByte + Buffer.byteLength(input.data) } }
      } })
    return { core, store: freshStore }
  }
  const first = await make()
  return { ...first, make, session, requests, writes, stop, loseNextAck: () => { loseAck = true },
    intent: (core = first.core) => ({ ...agentPromptCondition(core.agentSession(session.agentSessionId)), agentSessionId: session.agentSessionId,
      operationId: 'original-operation', prompt: body, agentMuxNote: note, authorHuman: true }) }
}
const body = '  Keep <User> & &amp;\r\nLiteral </amux> and trailing whitespace.  \n'
const note = 'Platform rules: <canonical Session ID> & literal </amux>.\r\nKeep the note.'

async function hosted(core: DefaultClient) {
  vi.spyOn(core, 'connect').mockResolvedValue()
  const remote = await hostedTestClient(core)
  cleanups.push(remote.dispose)
  return remote.sdk
}

describe('explicit injected context shares public Core submission and durable provenance', () => {
  it('carries explicit context through actual Hosted RPC and records raw platform/user segments separately', async () => {
    const f = await fixture(), remote = await hosted(f.core), input = f.intent()
    await remote.submitAgentPrompt(input)
    const composed = composeAgentPrompt(body, note)
    expect(f.writes).toEqual([composed.text + '\r'])
    expect((await f.store.loadTimeline(f.session.agentSessionId)).items.map(item => [item.kind, item.source, item.content, item.authorHuman])).toEqual([
      ['system_message', 'agentmux', composed.systemContext, undefined], ['user_message', 'user', body, true]
    ])
    const admission = (await new AgentMuxFileAgentSessionStore(f.store.path).load())[0]!.promptCompletionAdmission!
    expect(admission.intent!.message).toEqual({ userContent: body, systemContext: composed.systemContext, authorHuman: true, sourceChannel: 'api' })
    expect(admission.acknowledged).toBe(true); expect(f.stop.mock.calls).toEqual([])
  })

  it('preserves standalone context and complete escaped wire above the former input cutoff', async () => {
    const f = await fixture()
    await f.core.submitAgentPrompt({ ...f.intent(), prompt: '', authorHuman: false })
    const composed = composeAgentPrompt('', note)
    expect(composed.systemContext).toBe(note)
    expect(composed.text).not.toContain('Wait for the user.')
    expect(f.writes).toEqual([composed.text + '\r'])
    expect((await f.store.loadTimeline(f.session.agentSessionId)).items.map(item => [item.kind, item.content])).toEqual([['system_message', composed.systemContext]])
    const large = await fixture()
    const largeNote = '原始上下文<&>\n'.repeat(5000)
    const complete = composeAgentPrompt(body, largeNote)
    expect(Buffer.byteLength(complete.text)).toBeGreaterThan(65_536)
    await large.core.submitAgentPrompt({ ...large.intent(), operationId: 'large-context', agentMuxNote: largeNote })
    expect(large.writes).toEqual([complete.text + '\r'])
    const original = (await new AgentMuxFileAgentSessionStore(large.store.path).load())[0]!.promptCompletionAdmission!
    expect(original.intent!.prompt).toBe(complete.text)
    expect(original.intent!.message).toEqual({ userContent: body, systemContext: largeNote, authorHuman: true, sourceChannel: 'api' })
    expect(large.requests).toHaveLength(1); expect(large.core.agentSession(large.session.agentSessionId).run).toEqual(large.session.run)
  })

  it('does not promote a user-authored identical wire or replace its author during cold same-operation recovery', async () => {
    const f = await fixture(), composed = composeAgentPrompt(body, note)
    const original = { ...f.intent(), prompt: composed.text, agentMuxNote: undefined }
    f.loseNextAck(); await expect(f.core.submitAgentPrompt(original)).rejects.toThrow('Input accepted; ACK lost')
    expect(f.writes).toEqual([composed.text + '\r'])
    const cold = await f.make()
    await expect(cold.core.submitAgentPrompt({ ...f.intent(), authorHuman: false })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    expect((await cold.store.loadTimeline(f.session.agentSessionId)).items).toEqual([])
    expect(f.writes).toHaveLength(1); expect(f.requests).toHaveLength(1)
    await cold.core.submitAgentPrompt(original)
    expect(f.requests[1]).toEqual(f.requests[0]); expect(f.writes).toHaveLength(1)
    expect((await cold.store.loadTimeline(f.session.agentSessionId)).items.map(item => [item.kind, item.content, item.authorHuman])).toEqual([['user_message', composed.text, true]])
    expect(f.stop.mock.calls).toEqual([])
  })

  it('recovers a structured message with its original Native tuple, raw body and frozen author after fresh Core/FileStore', async () => {
    const f = await fixture(), input = f.intent(), composed = composeAgentPrompt(body, note)
    f.loseNextAck(); await expect(f.core.submitAgentPrompt(input)).rejects.toThrow('Input accepted; ACK lost')
    const cold = await f.make()
    await expect(cold.core.submitAgentPrompt({ ...input, authorHuman: false })).rejects.toMatchObject({ code: 'AGENT_PROMPT_OPERATION_CONFLICT' })
    await cold.core.submitAgentPrompt(input)
    expect(f.requests).toHaveLength(2); expect(f.requests[1]).toEqual(f.requests[0]); expect(f.writes).toEqual([composed.text + '\r'])
    expect((await cold.store.loadTimeline(f.session.agentSessionId)).items.map(item => [item.kind, item.content, item.authorHuman])).toEqual([
      ['system_message', composed.systemContext, undefined], ['user_message', body, true]
    ])
    expect(cold.core.agentSession(f.session.agentSessionId).promptCompletionAdmission!.intent!.message).toEqual({ userContent: body, systemContext: composed.systemContext, authorHuman: true, sourceChannel: 'api' })
    expect(f.stop.mock.calls).toEqual([])
  })

  it('reports missing original producer facts as unknown without replacing the Input or inventing attribution', async () => {
    const f = await fixture(), input = f.intent()
    f.loseNextAck(); await expect(f.core.submitAgentPrompt(input)).rejects.toThrow('Input accepted; ACK lost')
    const previous = (await f.store.load())[0]!
    const withoutSource = structuredClone(previous)
    delete withoutSource.promptCompletionAdmission!.intent!.message
    await f.store.compareAndSwap(previous, withoutSource)
    const cold = await f.make()
    await expect(cold.core.submitAgentPrompt(input)).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    expect(f.requests).toHaveLength(1); expect(f.writes).toHaveLength(1)
    expect((await cold.store.loadTimeline(f.session.agentSessionId)).items).toEqual([])
    expect(cold.core.agentSession(f.session.agentSessionId).run).toEqual(f.session.run); expect(f.stop.mock.calls).toEqual([])
  })

  it('retains the raw user and healthy Run when persisting a System observation fails', async () => {
    const f = await fixture(), apply = f.store.applyTimelineMutation.bind(f.store), events: unknown[] = []
    f.core.onEvent(event => { if (event.type === 'agent-error') events.push(event) })
    vi.spyOn(f.store, 'applyTimelineMutation').mockImplementation(async (mutation, signal) => {
      if ('item' in mutation && mutation.item.kind === 'system_message') throw new Error('Private System observation disk failure')
      return apply(mutation, signal)
    })
    await f.core.submitAgentPrompt(f.intent())
    expect(f.writes).toHaveLength(1)
    expect((await f.store.loadTimeline(f.session.agentSessionId)).items.map(item => [item.kind, item.content])).toEqual([['user_message', body]])
    expect(events).toEqual([expect.objectContaining({ code: 'AGENT_TIMELINE_PERSIST_FAILED' })]); expect(f.stop.mock.calls).toEqual([])
    await f.core.writeAgent({ agentSessionId: f.session.agentSessionId, expectedRun: f.session.run, data: 'manual raw', source: 'user' })
    expect(f.writes.at(-1)).toBe('manual raw')
  })
})
