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
  try {
    for (const data of edits) await bridge.api!.sessions.write(control, data, 'user')
    const pauses = h.rpc.mock.calls.filter(([, method]) => method === 'agent.automation.pause')
    expect(pauses).toHaveLength(edits.length)
    for (const [host, , target] of pauses) {
      expect(host).toBe(control.hostId)
      expect(target).toMatchObject({ agentSessionId: control.agentSessionId, expectedRun: control.run, ownerInstanceId: 'original-owner', operationId: expect.any(String) })
    }
    expect(h.write.mock.calls.map(([, data]) => data)).toEqual(edits)
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
