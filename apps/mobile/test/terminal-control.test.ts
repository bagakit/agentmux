import { describe, expect, it, vi } from 'vitest'
import type { AgentMuxHostedClient } from '@agentmux/core/hosted'
import { subscribeTerminalInput } from '@agentmux/client-ui/terminal/input'
import { createMobileTerminalControl, type MobileTerminalControlState } from '../src/terminal/control'
import { deferred, session } from './conversation-fixture'

function harness(backing = new Map<string, string>()) {
  let current = session(), cursor = 0
  const reports: MobileTerminalControlState[] = []
  const write = vi.fn<AgentMuxHostedClient['writeAgent']>(async input => {
    const start = cursor, length = typeof input.data === 'string' ? new TextEncoder().encode(input.data).length : input.data.length
    cursor += length; return { runId: input.expectedRun.runId, appliedByteRange: { startByte: start, endByte: cursor }, acceptedThroughByte: cursor }
  })
  const resize = vi.fn<AgentMuxHostedClient['resizeAgent']>(async (_id, run, cols, rows) => ({ ...run, cols, rows }))
  const storage = { getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => { backing.set(key, value) }, removeItem: (key: string) => { backing.delete(key) } }
  const client = { runtimeIdentity: () => ({ hostId: 'local', instanceId: 'runtime-original', buildIdentity: 'fixture', protocolVersion: 1, processId: null }),
    agentSession: () => current, writeAgent: write, resizeAgent: resize }
  const control = createMobileTerminalControl({ client,
    agentSessionId: 'session-original', report: state => reports.push(state), storage: () => storage })
  return { control, client, write, resize, reports, backing, storage, setRun: (runId: string) => { current = { ...current, run: { runId } } } }
}
const settle = async () => { for (let index = 0; index < 8; index++) await Promise.resolve() }
const key = 'agentmux-mobile-terminal-intent-v1:session-original'

describe('explicit original Run terminal control', () => {
  it('shares the actual Desktop input source, admits only explicit user control and drops DA/DSR parser replies in either mode', async () => {
    const h = harness()
    let user!: () => void, data!: (value: string) => void, binary!: (value: string) => void
    const disposed = [false, false, false]
    const binding = subscribeTerminalInput({ onUserInput: listener => { user = listener; return { dispose() { disposed[0] = true } } },
      onData: listener => { data = listener; return { dispose() { disposed[1] = true } } },
      onBinary: listener => { binary = listener; return { dispose() { disposed[2] = true } } } }, h.control.send)
    user(); data('watch'); binary('\x80'); data('\x1b[1;1R'); await settle()
    expect(h.write.mock.calls).toEqual([]); expect(h.resize.mock.calls).toEqual([])
    expect(h.control.enable()).toBe(true)
    data('\x1b[1;1R'); data('\x1b[?1;2c'); user(); data('你好'); binary('\x1b[M\x20\x80\xff'); user(); data('')
    await settle()
    expect(h.write.mock.calls.map(([input]) => input)).toEqual([
      { agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, source: 'user', data: '你好' },
      { agentSessionId: 'session-original', expectedRun: { runId: 'run-original' }, source: 'user', data: Uint8Array.of(27, 91, 77, 32, 128, 255) }
    ])
    binding.dispose(); expect(disposed).toEqual([true, true, true]); h.control.dispose()
  })

  it('holds subsequent user bytes in original order until the exact ACK, without blocking or replacing the original Run', async () => {
    const h = harness(), first = deferred<Awaited<ReturnType<AgentMuxHostedClient['writeAgent']>>>()
    h.write.mockReturnValueOnce(first.promise); h.control.enable()
    h.control.send('a', 'user'); h.control.send('你好', 'user'); h.control.send('c', 'user')
    expect(h.write.mock.calls.map(([input]) => input.data)).toEqual(['a'])
    expect(h.control.facts()).toMatchObject({ phase: 'sending', queuedBytes: 7 })
    first.resolve({ runId: 'run-original', appliedByteRange: { startByte: 20, endByte: 21 }, acceptedThroughByte: 21 }); await settle()
    expect(h.write.mock.calls.map(([input]) => input.data)).toEqual(['a', '你好', 'c'])
    expect(h.control.facts()).toMatchObject({ phase: 'idle', queuedBytes: 0 }); expect(h.backing.size).toBe(0)
    h.control.dispose()
  })

  it('never repeats unknown dispatched bytes, keeps unsent bytes, and resumes only those after explicit review and control gestures', async () => {
    const h = harness(), first = deferred<Awaited<ReturnType<AgentMuxHostedClient['writeAgent']>>>()
    h.write.mockReturnValueOnce(first.promise); h.control.enable()
    h.control.send('original unknown', 'user'); h.control.send('unsent suffix', 'user')
    first.reject(new Error('Original connection lost after dispatch')); await settle()
    expect(h.control.facts()).toMatchObject({ phase: 'unknown', queuedBytes: 13, pending: { runId: 'run-original', kind: 'input' } })
    expect(h.control.queuedText()).toBe('unsent suffix'); expect(h.control.enable()).toBe(false)
    h.control.watch(); await settle(); expect(h.write.mock.calls.map(([input]) => input.data)).toEqual(['original unknown'])
    expect(h.control.continueAfterReview()).toBe(true); await settle()
    expect(h.write.mock.calls.map(([input]) => input.data)).toEqual(['original unknown'])
    h.control.enable(); await settle()
    expect(h.write.mock.calls.map(([input]) => input.data)).toEqual(['original unknown', 'unsent suffix'])
    h.control.dispose()
  })

  it('treats a mismatched or incomplete application receipt as unknown rather than as permission to repeat input', async () => {
    const h = harness(); h.write.mockResolvedValueOnce({ runId: 'other-run', appliedByteRange: { startByte: 0, endByte: 1 }, acceptedThroughByte: 1 })
    h.control.enable(); h.control.send('x', 'user'); await settle()
    expect(h.control.facts()).toMatchObject({ phase: 'unknown' }); expect(h.write).toHaveBeenCalledTimes(1)
    expect(h.control.enable()).toBe(false); h.control.dispose()
  })

  it('keeps queued bytes on watch and isolates them from a Core-confirmed replacement Run', async () => {
    const h = harness(), first = deferred<Awaited<ReturnType<AgentMuxHostedClient['writeAgent']>>>()
    h.write.mockReturnValueOnce(first.promise); h.control.enable(); h.control.send('a', 'user'); h.control.send('old Run only', 'user')
    h.control.watch(); h.setRun('new-run')
    first.resolve({ runId: 'run-original', appliedByteRange: { startByte: 0, endByte: 1 }, acceptedThroughByte: 1 }); await settle()
    expect(h.control.enable()).toBe(false); expect(h.control.queuedText()).toBe('old Run only')
    expect(h.write.mock.calls.map(([input]) => input.expectedRun)).toEqual([{ runId: 'run-original' }])
    h.control.discardUnsent(); expect(h.control.enable()).toBe(true); h.control.send('new intent', 'user'); await settle()
    expect(h.write.mock.calls.map(([input]) => input.expectedRun)).toEqual([{ runId: 'run-original' }, { runId: 'new-run' }]); h.control.dispose()
  })

  it('resizes only after explicit control and user-selected valid dimensions using the original SDK tuple', async () => {
    const h = harness()
    expect(h.control.resize(52, 18)).toBe(false); h.control.enable()
    expect(h.resize.mock.calls).toEqual([])
    expect(h.control.resize(1, 0)).toBe(false); expect(h.resize.mock.calls).toEqual([])
    expect(h.control.resize(52, 18)).toBe(true); await settle()
    expect(h.resize.mock.calls).toEqual([['session-original', { runId: 'run-original' }, 52, 18]])
    h.control.watch(); expect(h.control.resize(80, 24)).toBe(false); h.control.dispose()
  })

  it('restores an unconfirmed intent as unknown without saving secret/input bytes or automatically dispatching after a page restart', async () => {
    const h = harness(), first = deferred<Awaited<ReturnType<AgentMuxHostedClient['writeAgent']>>>()
    h.write.mockReturnValueOnce(first.promise); h.control.enable(); h.control.send('never persist this terminal payload', 'user')
    const saved = h.backing.get(key)!
    expect(JSON.parse(saved)).toEqual({ version: 1, intentId: expect.any(String), runId: 'run-original', kind: 'input', createdAt: expect.any(Number) })
    expect(saved).not.toContain('never persist'); h.control.dispose()
    const restored = harness(h.backing)
    expect(restored.control.facts()).toMatchObject({ mode: 'watch', phase: 'unknown' })
    expect(restored.control.enable()).toBe(false); expect(restored.write.mock.calls).toEqual([]); restored.control.dispose()
    first.reject(new Error('Old request ended')); await settle()
  })

  it('retains malformed durable bytes while healthy input remains available with a persistent storage notice', async () => {
    const backing = new Map([[key, '{original bad bytes']]), h = harness(backing)
    expect(h.control.facts().storageIssue).toContain('原字节保留'); h.control.enable(); h.control.send('healthy user input', 'user'); await settle()
    expect(h.write.mock.calls.map(([input]) => input.data)).toEqual(['healthy user input'])
    expect(backing.get(key)).toBe('{original bad bytes'); expect(h.control.facts().storageIssue).toContain('原字节保留'); h.control.dispose()
  })

  it('does not let the unmounted previous instance late ACK clear a different current intent guard', async () => {
    const backing = new Map<string, string>(), old = harness(backing), first = deferred<Awaited<ReturnType<AgentMuxHostedClient['writeAgent']>>>()
    old.write.mockReturnValueOnce(first.promise); old.control.enable(); old.control.send('old input', 'user'); old.control.dispose()
    const next = harness(backing); expect(next.control.continueAfterReview()).toBe(true)
    const second = deferred<Awaited<ReturnType<AgentMuxHostedClient['writeAgent']>>>()
    next.write.mockReturnValueOnce(second.promise); next.control.enable(); next.control.send('current input', 'user')
    const currentBytes = backing.get(key)
    first.resolve({ runId: 'run-original', appliedByteRange: { startByte: 0, endByte: 9 }, acceptedThroughByte: 9 }); await settle()
    expect(backing.get(key)).toBe(currentBytes); expect(JSON.parse(currentBytes!).runId).toBe('run-original')
    next.control.dispose(); second.reject(new Error('Controlled end')); await settle()
  })

  it('rebinds the same semantic owner without dropping unknown intent or its never-called suffix', async () => {
    const h = harness(), first = deferred<Awaited<ReturnType<AgentMuxHostedClient['writeAgent']>>>()
    h.write.mockReturnValueOnce(first.promise); h.control.enable(); h.control.send('uncertain', 'user'); h.control.send('suffix', 'user')
    first.reject(new Error('Lost ACK')); await settle()
    const next = harness(); h.control.rebind(next.client)
    expect(h.control.facts()).toMatchObject({ mode: 'watch', phase: 'unknown', queuedBytes: 6 })
    expect(h.control.queuedText()).toBe('suffix'); expect(next.write.mock.calls).toEqual([])
    expect(h.control.continueAfterReview()).toBe(true); expect(h.control.enable()).toBe(true); await settle()
    expect(h.write.mock.calls.map(([input]) => input.data)).toEqual(['uncertain'])
    expect(next.write.mock.calls.map(([input]) => input.data)).toEqual(['suffix']); h.control.dispose(); next.control.dispose()
  })

  it('rebinds without forwarding retained input to another runtime instance, Session or Run', async () => {
    const h = harness(), first = deferred<Awaited<ReturnType<AgentMuxHostedClient['writeAgent']>>>()
    h.write.mockReturnValueOnce(first.promise); h.control.enable(); h.control.send('uncertain', 'user'); h.control.send('only original owner', 'user')
    first.reject(new Error('Lost ACK')); await settle(); h.control.continueAfterReview()
    const next = harness()
    h.control.rebind({ ...next.client, runtimeIdentity: () => ({ ...next.client.runtimeIdentity(), instanceId: 'other-runtime' }) })
    expect(h.control.enable()).toBe(false); expect(h.control.queuedText()).toBe('only original owner'); expect(next.write.mock.calls).toEqual([])
    h.control.rebind({ ...next.client, agentSession: () => ({ ...next.client.agentSession(), agentSessionId: 'another-session' }) })
    expect(h.control.enable()).toBe(false); expect(next.write.mock.calls).toEqual([])
    next.setRun('another-run'); h.control.rebind(next.client)
    expect(h.control.enable()).toBe(false); expect(next.write.mock.calls).toEqual([])
    h.control.rebind(null); expect(h.control.enable()).toBe(false); expect(h.control.queuedText()).toBe('only original owner')
    h.control.dispose(); next.control.dispose()
  })

  it('rebinds while the original ACK is in flight without enabling automatic drain on the new port', async () => {
    const h = harness(), first = deferred<Awaited<ReturnType<AgentMuxHostedClient['writeAgent']>>>()
    h.write.mockReturnValueOnce(first.promise); h.control.enable(); h.control.send('a', 'user'); h.control.send('suffix', 'user')
    const next = harness(); h.control.rebind(next.client)
    first.resolve({ runId: 'run-original', appliedByteRange: { startByte: 0, endByte: 1 }, acceptedThroughByte: 1 }); await settle()
    expect(h.control.facts()).toMatchObject({ mode: 'watch', phase: 'idle', queuedBytes: 6 })
    expect(next.write.mock.calls).toEqual([]); expect(h.control.queuedText()).toBe('suffix')
    expect(h.control.enable()).toBe(true); await settle(); expect(next.write.mock.calls.map(([input]) => input.data)).toEqual(['suffix'])
    h.control.dispose(); next.control.dispose()
  })
})
