import { expect, it, vi } from 'vitest'
import { RuntimeController } from '../src/main/runtime-controller.js'
import { AgentMuxMemoryAgentSessionStore } from '@agentmux/core'
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve() }
it('Agent OSC replies use the same raw input owner and quiescence as keyboard input', async () => {
  const owner = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), async () => { throw Error('Unexpected connection') })
  let release!: () => void
  const pending = new Promise<void>(resolve => { release = resolve })
  const writeAgent = vi.fn(async () => { await pending })
  const connectRuntime = vi.fn(async () => {})
  const client = { writeAgent, connectRuntime, runtimeOwnerIdentity: () => ({ availability: 'connected' }) }
  const inner = owner as any
  inner.hosts.set('local', { client, executionHost: { kind: 'local' } })
  const run = { runId: 'protocol-run' }
  const output = { type: 'terminal-output', run, data: '\u001b]10;?\u0007' }
  try {
    // A query before its Session arrives is delivered through the same owner when bound.
    inner.publish('local', output)
    expect(writeAgent).not.toHaveBeenCalled()
    inner.publish('local', { type: 'agent-session', session: { agentSessionId: 'protocol-agent', run } })
    expect(inner.hostOperations.get('local')?.size).toBe(1)
    await flush()
    expect(writeAgent).toHaveBeenCalledWith({ agentSessionId: 'protocol-agent', expectedRun: run,
      source: 'terminal-protocol', data: '\u001b]10;rgb:ffff/ffff/ffff\u001b\\' })
    expect(connectRuntime).not.toHaveBeenCalled()
    let quiet = false
    const idle = inner.waitForHostQuiescence('local').then(() => { quiet = true })
    await flush(); expect(quiet).toBe(false)
    release(); await idle; await flush()
    expect(inner.hostOperations.size).toBe(0)
    inner.publish('local', output)
    await flush()
    expect(writeAgent).toHaveBeenCalledTimes(2)
    expect(connectRuntime).not.toHaveBeenCalled()
  } finally { release(); owner.resourceSampler.dispose() }
})
it('Main raw input tracks original Host work without cursor or full-receipt serialization', async () => {
  const connect = vi.fn(async () => { throw new Error('No connection should be opened') })
  const owner = new RuntimeController(new AgentMuxMemoryAgentSessionStore(), connect)
  let prepare!: () => void, native!: () => void
  const preparation = new Promise<void>(resolve => { prepare = resolve }), pending = new Promise<void>(resolve => { native = resolve })
  const sent: string[] = [], failure = new Error('original native failure')
  const client = { runtimeIdentity: () => ({ instanceId: 'synthetic-owner' }),
    writeTerminalBytes: async (_run: unknown, data: string) => {
      sent.push(data)
      if (data === 'first') await pending
      if (data === 'failure') throw failure
      return { appliedByteRange: { startByte: 0, endByte: data.length }, acceptedThroughByte: data.length }
    }
  }
  const inner = owner as any
  inner.connectedClient = async () => { await preparation; return client }
  const control = { kind: 'terminal' as const, hostId: 'local', runId: 'synthetic-run', run: { runId: 'synthetic-run' } }
  const snapshot = async () => (await owner.performanceDiagnostics(new AbortController().signal, 0)).main.input
  try {
    const first = owner.write(control, 'first', 'user'), second = owner.paste(control, 'paste', '\u001b[200~paste\u001b[201~')
    expect(inner.hostOperations.get('local').size).toBe(2)
    let quiet = false
    const quiescence = inner.waitForHostQuiescence('local').then(() => { quiet = true })
    await flush(); expect(quiet).toBe(false); expect(sent).toEqual([])
    prepare(); await second
    expect(sent).toEqual(['first', '\u001b[200~paste\u001b[201~'])
    expect(quiet).toBe(false); expect(inner.hostOperations.get('local').size).toBe(1)
    native(); await first; await quiescence
    expect(inner.hostOperations.size).toBe(0)
    await expect(owner.write(control, 'failure', 'user')).rejects.toBe(failure)
    expect(await snapshot()).toMatchObject({ started: 3, completed: 2, failed: 1, pending: 0,
      currentRun: { count: 0 }, nativeInput: { count: 0 } })
    expect((await snapshot()).recent.at(-1)?.stage).toBe('host-call')
    expect(connect).not.toHaveBeenCalled()
  } finally { prepare(); native(); owner.resourceSampler.dispose() }
})
