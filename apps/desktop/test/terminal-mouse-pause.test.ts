// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentMuxRunInputData } from '@agentmux/core'
import { bridge, control, owningBridge } from './helpers/first-execution-ipc-bridge'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); bridge.invoke.mockReset() })

async function fixture() {
  const h = await owningBridge()
  // The actual preload and registered Main handler are under test. These are
  // the unchanged writer and Host RPC boundaries; no native Run is started.
  const write = vi.spyOn(h.runtime, 'write').mockResolvedValue(undefined)
  const paste = vi.spyOn(h.runtime, 'paste').mockResolvedValue(undefined)
  const rpc = vi.spyOn(h.runtime, 'callOriginalCore').mockImplementation(async (_host, method) => {
    if (method === 'runtime.owner.identity') return { owner: { ownerInstanceId: 'original-owner' } } as never
    if (method === 'agent.automation.pause') return { receipt: { status: 'confirmed' } } as never
    throw Error('Unexpected Host call: ' + method)
  })
  return { ...h, write, paste, rpc }
}

it('forwards a whole mouse burst unchanged without starting automatic pause transactions', async () => {
  const h = await fixture()
  const reports: AgentMuxRunInputData[] = [
    '\x1b[<0;10;20M', '\x1b[<0;10;20m', '\x1b[<64;10;20M',
    '\x1b[M !!', Uint8Array.of(27, 91, 77, 96, 255, 255),
    '\x1b[<64;10;20M\x1b[<65;10;20M',
    Uint8Array.from(Buffer.from('\x1b[<64;10;20M'))
  ]
  try {
    for (const data of reports) await bridge.api!.sessions.write(control, data, 'user')
    expect(h.write.mock.calls.map(([target, data, source]) => ({ target, data, source })))
      .toEqual(reports.map(data => ({ target: control, data, source: 'user' })))
    expect(h.rpc, 'Mouse transport reports must not create owner discovery or automatic pause operations').not.toHaveBeenCalled()
  } finally { await h.dispose() }
})

it('keeps keyboard, mixed and incomplete input on the original manual pause path', async () => {
  const h = await fixture()
  const edits: AgentMuxRunInputData[] = [
    'x', '\r', '\x1b[A', '\x1b[<64;10;20Mx', 'x\x1b[<64;10;20M',
    '\x1b[<64;10;', '\x1b[<64;0;20M', '\x1b[<256;10;20M',
    '\x1b[<64;10;20M\x1b[', '\x1b[?unknown',
    Uint8Array.of(27, 91, 77, 96, 32, 42), '\x1b[M \u00ff!'
  ]
  const now = vi.spyOn(Date, 'now')
  try {
    // Each edit is its own burst here, so each one starts the original pause.
    let clock = 1_000_000
    for (const data of edits) { now.mockReturnValue(clock += 5_000); await bridge.api!.sessions.write(control, data, 'user') }
    const pauses = h.rpc.mock.calls.filter(([, method]) => method === 'agent.automation.pause')
    expect(pauses).toHaveLength(edits.length)
    for (const [host, , target] of pauses) {
      expect(host).toBe(control.hostId)
      expect(target).toMatchObject({ agentSessionId: control.agentSessionId, expectedRun: control.run, ownerInstanceId: 'original-owner', operationId: expect.any(String) })
    }
    expect(h.write.mock.calls.map(([, data]) => data)).toEqual(edits)
  } finally { await h.dispose() }
})

it('starts one original pause per continuous typing burst and never withholds a key', async () => {
  const h = await fixture(), now = vi.spyOn(Date, 'now')
  const other = { ...control, run: { runId: 'other-run' } }
  try {
    let clock = 2_000_000
    const type = async (target: typeof control, text: string, gapMs = 120) => {
      for (const key of text) { now.mockReturnValue(clock += gapMs); await bridge.api!.sessions.write(target, key, 'user') }
    }
    const pauses = () => h.rpc.mock.calls.filter(([, method]) => method === 'agent.automation.pause').map(([, , target]) => target as { expectedRun: { runId: string } })
    await type(control, 'hello world, a long burst of keys')
    expect(pauses(), 'one burst on one exact Run is one cancel-only pause').toHaveLength(1)
    await type(other, 'abc')
    expect(pauses().map(target => target.expectedRun.runId), 'another exact Run owns its own burst').toEqual([control.run.runId, other.run.runId])
    now.mockReturnValue(clock += 2_000)
    await type(control, 'next', 10)
    expect(pauses(), 'a pause in typing ends the burst; the next key pauses afresh').toHaveLength(3)
    expect(h.write.mock.calls.map(([, data]) => data).join(''), 'every key is still sent in order').toBe('hello world, a long burst of keysabcnext')
    await bridge.api!.sessions.paste(control, 'paste', 'paste')
    expect(pauses(), 'paste remains a discrete explicit pause inside a burst').toHaveLength(4)
    await type(control, 'still typing', 10)
    expect(pauses(), 'continued keys stay in the same burst').toHaveLength(4)
    const target = { hostId: control.hostId, agentSessionId: control.agentSessionId, providerId: 'codex', workspacePath: 'private-workspace' }
    // The explicit change ends the burst before its own Host request, whatever that request's outcome.
    await bridge.api!.continuousProgress.action(target, 'loop', 'resume', {} as never, 'resume-operation').catch(() => {})
    await type(control, 'x', 10)
    expect(pauses(), 'after an explicit progress change the next key pauses afresh').toHaveLength(5)
  } finally { await h.dispose() }
})

it('keeps explicit paste and editing distinct from empty, protocol and ordinary terminal traffic', async () => {
  const h = await fixture(), report = '\x1b[<64;10;20M'
  try {
    await bridge.api!.sessions.write(control, '', 'user')
    await bridge.api!.sessions.write(control, new Uint8Array(), 'user')
    await bridge.api!.sessions.write(control, 'protocol', 'terminal-protocol')
    await bridge.api!.sessions.write({ kind: 'terminal', hostId: 'local', runId: 'shell-run', run: { runId: 'shell-run' } }, 'shell', 'user')
    expect(h.rpc).not.toHaveBeenCalled()
    expect(h.write).toHaveBeenCalledTimes(4)
    await bridge.api!.sessions.paste(control, report, report)
    await bridge.api!.sessions.notifyInputOccupation(control)
    expect(h.paste.mock.calls[0]?.slice(0, 3)).toEqual([control, report, report])
    expect(h.rpc.mock.calls.filter(([, method]) => method === 'agent.automation.pause')).toHaveLength(2)
  } finally { await h.dispose() }
})
