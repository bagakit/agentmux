import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { expect, it } from 'vitest'
import { AgentMuxClient } from '../../../packages/core/src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../../../packages/core/src/agent-session-store.js'
import { RuntimeController } from '../src/main/runtime-controller.js'

it('routes a real Desktop attachment resize to the public Client and continues its original Screen wait', async () => {
  const client = new AgentMuxClient({ store: new AgentMuxMemoryAgentSessionStore() }), owner = client as any
  const session = { kind: 'agent', agentSessionId: 'desktop-original', providerId: 'codex', executorId: 'codex', hostId: 'local',
    workspacePath: _hygiene_fixturePath("private/desktop-original"), run: { runId: 'desktop-run' }, retiredRuns: [], hookBindingId: 'binding', hookToken: 'token', createdAt: 1, updatedAt: 1 }
  await owner.registry.put(session); owner.connected = true
  let cols = 80, rows = 24, revision = 0, inputCalls = 0
  owner.kernel.isConnected = () => true; owner.kernel.disconnect = () => {}
  owner.kernel.input = async () => { inputCalls++; throw new Error('Read-only Desktop control must not input.') }
  owner.kernel.resize = async (id: string, c: number, r: number) => {
    expect(id).toBe('desktop-run'); cols = c; rows = r; revision++; return { cols, rows }
  }
  owner.kernel.replay = async () => ({ run: { latestOutputBytes: 0 }, gap: null, replay: [] })
  owner.kernel.observeOutput = async () => ({ run: { runId: 'desktop-run', cols, rows, latestOutputBytes: 0 }, resizeRevision: revision, gap: null, replay: [], close: async () => {},
    terminal: { type: 'basic-vt', checkpoint: { runId: 'desktop-run', throughByte: 0, resizeRevision: revision, size: { cols, rows }, restoreSize: { cols, rows }, restoreScrollbackRows: null, resizeAfterRestoreBytes: 0 }, restoreBytes: Buffer.from('\x1bc'), resizes: [] } })
  const control = { kind: 'agent', hostId: 'local', agentSessionId: session.agentSessionId, run: session.run }
  const controller = { sessionAttachmentLeases: new Map([['lease', { webContentsId: 42, key: 'original' }]]),
    sessionAttachmentOwners: new Map([['original', { attachmentIds: new Set(['lease']), control }]]),
    connectedClient: async (host: string) => { expect(host).toBe('local'); return client },
    serializeSessionAttachment: async (_key: string, work: () => Promise<unknown>) => await work() }
  try {
    const reading = owner.screenEvidence.wait(session, 0, false, (screen: any) => screen.snapshot().cols === 100,
      { timeoutMs: 500, timeoutMessage: 'original Desktop read deadline', terminalMessage: 'exit' })
    for (let turn = 0; turn < 100 && !(owner.screenEvidence.evidence.get(session.agentSessionId)?.evidence.listeners.size > 1); turn++) await new Promise(resolve => setImmediate(resolve))
    expect(owner.screenEvidence.evidence.get(session.agentSessionId)?.evidence.listeners.size).toBeGreaterThan(1)
    expect(await RuntimeController.prototype.resizeSessionAttachment.call(controller as never, 42, 'lease', 100, 30)).toEqual({ cols: 100, rows: 30 })
    await expect(reading).resolves.toBe(0); expect(inputCalls).toBe(0)
    expect(owner.registry.get(session.agentSessionId).run).toEqual(session.run)
  } finally { await client.dispose() }
})
