import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rpcOwnerFixture } from './helpers/public-rpc-owner.js'
import { startPackedPublicControl, exercisePackedPublicControl, rawControlReceipt } from './fixtures/packed-public-rpc.mjs'

const exec = promisify(execFile)
const bin = fileURLToPath(new URL('../bin/amux', import.meta.url))
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

async function fixture() {
  const core = await rpcOwnerFixture(['codex-semantic'])
  cleanups.push(core.close)
  const host = await startPackedPublicControl({ codex: core.client.agentSession('codex-semantic'),
    coreClients: core.coreClients, connectCore: async () => core.client, disposeCore: async () => {},
    path: join(core.root, 'control.sock') })
  cleanups.push(() => host.controlServer.stop())
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key)))
  const cli = (args: string[], managed = {}) => exec(process.execPath, [bin, '--endpoint', 'unix:' + host.controlServer.path, ...args], {
    maxBuffer: 4 * 1024 * 1024, env: { ...env, ...managed }
  })
  return { core, host, env, cli, managed: { AGENTMUX_ENV: '1', AGENTMUX_AGENT_SESSION_ID: core.credentials.agentSessionId,
    AGENTMUX_AGENT_CAPABILITY: core.credentials.capability } }
}

describe('original packed public block through the compiled CLI and public Unix SDK', () => {
  it('keeps all eight original Desktop actions, literal prompts, partial focus, capability and ambiguous candidates', async () => {
    const h = await fixture()
    const receipt = join(h.core.root, 'issued-credential.json')
    const fakeCodex = fileURLToPath(new URL('./fixtures/fake-codex-cli.mjs', import.meta.url))
    const launchFixture = (env: Record<string, string | undefined>) => exec(process.execPath, [fakeCodex], { env })
    // Deliberately omit Native Hook inputs: after the optional test-only capture,
    // the original fixture fails its unchanged required-environment check.
    await expect(launchFixture({ ...h.env, ...h.managed }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('missing AgentMux hook environment') })
    await expect(stat(receipt)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(launchFixture({ ...h.env, ...h.managed, AGENTMUX_FAKE_CAPABILITY_RECEIPT: receipt }))
      .rejects.toMatchObject({ stderr: expect.stringContaining('missing AgentMux hook environment') })
    const captured = JSON.parse(await readFile(receipt, 'utf8'))
    expect(captured.agentSessionId).toBe(h.core.credentials.agentSessionId)
    expect(captured.capability === h.core.credentials.capability).toBe(true)
    expect((await stat(receipt)).mode & 0o777).toBe(0o600)
    await exercisePackedPublicControl(h.cli, h.managed, h.host)
    const inspected = JSON.parse((await h.cli(['agent', 'inspect', '--session', h.core.credentials.agentSessionId])).stdout)
    expect(inspected).toMatchObject({ ok: true, operation: 'agent.inspect', result: {
      session: { agentSessionId: 'codex-semantic', run: { runId: 'run-codex-semantic' } }
    } })
    const listed = JSON.parse((await h.cli(['agent', 'ls'])).stdout)
    expect(listed.operation).toBe('agent.ls')
    expect(listed.result.sessions.map((item: { session: { agentSessionId: string } }) => item.session.agentSessionId)).toEqual(['codex-semantic'])
    await expect(h.cli(['space', 'inspect', '--tab', 'self'], { ...h.managed, AGENTMUX_AGENT_CAPABILITY: 'wrong-private-claim' }))
      .rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('AGENT_CAPABILITY_INVALID') })
    expect(h.core.inner.kernel.stop).not.toHaveBeenCalled()
    expect(h.core.client.agentSessions().map(session => session.agentSessionId)).toEqual(['codex-semantic'])
  }, 30_000)

  it('keeps fragmented UTF-8 wire correlation and the original exact Tab facts', async () => {
    const h = await fixture()
    const request = { jsonrpc: '2.0', id: 'packed-继续', method: 'space.inspect', params: { target: { tabId: h.host.agentRegion.tabId } } }
    const bytes = Buffer.from(JSON.stringify(request) + '\n')
    const start = bytes.indexOf(Buffer.from('继续'))
    expect(start).toBeGreaterThan(-1)
    const result = await rawControlReceipt(h.host.controlServer.path, request, start + 1)
    expect(result).toMatchObject({ jsonrpc: '2.0', id: request.id, result: {
      presentation: { tab: { tabId: h.host.agentRegion.tabId, regions: [{ regionId: h.host.agentRegion.regionId }] }, unavailable: [] }
    } })
    expect(h.host.controlRequests.map((request: { operation: string }) => request.operation)).toEqual(['inspect.tab', 'space.inspect'])
  })

  it('reads ordered bytes in the compiled replay stream and cancels only a live reader', async () => {
    const h = await fixture()
    h.core.inner.kernel.observeOutput = vi.fn(async (runId: string) => ({ run: h.core.run(runId), gap: null,
      terminal: { type: 'not-requested' }, resizeRevision: 0,
      replay: [{ type: 'data', runId, startByte: 0, endByte: 3, data: '中', dataBytes: Buffer.from('中') }],
      close: async () => { h.core.closes() } }))
    const replay = (await h.cli(['agent', 'output', '--session', 'codex-semantic', '--after-byte', '0'])).stdout
      .trim().split('\n').map(line => JSON.parse(line))
    expect(replay[0]).toMatchObject({ jsonrpc: '2.0', result: { method: 'agent.output', initial: {
      session: { agentSessionId: 'codex-semantic', run: { runId: 'run-codex-semantic' } }, gap: null
    } } })
    const outputs = replay.slice(1).filter(frame => frame.params.event.type === 'output')
    expect(outputs).toHaveLength(1)
    expect(Buffer.concat(outputs.map(frame => Buffer.from(frame.params.event.data.dataBase64, 'base64')))).toEqual(Buffer.from('中'))
    expect(replay.at(-1)).toMatchObject({ method: 'system.subscription.event', params: { event: { type: 'end' } } })
    const reader = spawn(process.execPath, [bin, '--endpoint', 'unix:' + h.host.controlServer.path,
      'agent', 'output', '--session', 'codex-semantic', '--after-byte', '0', '--follow'], { env: h.env, stdio: ['ignore', 'pipe', 'pipe'] })
    const stderr: Buffer[] = []
    reader.stderr.on('data', chunk => stderr.push(chunk))
    try {
      const initial = await new Promise<unknown>((resolve, reject) => {
        let text = ''
        reader.stdout.on('data', chunk => { text += chunk; const end = text.indexOf('\n'); if (end >= 0) resolve(JSON.parse(text.slice(0, end))) })
        reader.once('error', reject)
        reader.once('exit', code => reject(new Error('Reader ended before its response: ' + code + ':' + Buffer.concat(stderr))))
      })
      expect(initial).toMatchObject({ result: { method: 'agent.output', initial: { session: { agentSessionId: 'codex-semantic' } } } })
      const exited = once(reader, 'exit')
      reader.kill('SIGINT')
      const [code, signal] = await exited
      expect(signal).toBeNull()
      // Cancellation can win the initial reader handshake. Keep its typed
      // cancellation fact; no unrelated failure may pass this assertion.
      if (code === 1) expect(JSON.parse(Buffer.concat(stderr).toString('utf8')))
        .toMatchObject({ ok: false, operation: 'agent.output', error: { code: 'CONTROL_CANCELLED' } })
      else expect(code).toBe(0)
    } finally { if (reader.exitCode === null && reader.signalCode === null) { const exited = once(reader, 'exit'); reader.kill('SIGKILL'); await exited } }
    expect(h.core.client.agentSession('codex-semantic').run).toEqual({ runId: 'run-codex-semantic' })
    expect(h.core.inner.kernel.stop).not.toHaveBeenCalled()
    expect(h.core.inner.kernel.attach).not.toHaveBeenCalled()
    expect(h.core.inner.kernel.detach).not.toHaveBeenCalled()
  }, 30_000)
})
