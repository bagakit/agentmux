import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { AgentMuxFileAgentSessionStore, connectAgentMuxRpc } from '@agentmux/core'
import { connectHostedAgentMux } from '@agentmux/core/hosted'
import { startAgentMuxHost } from '../src/host.js'
import { preparePrivateCertificates } from '../src/private-certificates.js'
import { HostedHttpRpcPort } from '../../mobile/src/connection/hosted-rpc.js'
import { createMobileTerminalControl } from '../../mobile/src/terminal/control.js'
import { createMobileTerminalReader } from '../../mobile/src/terminal/reader.js'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })
let root: string
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'amx-mobile-terminal-control-'))
  await mkdir(join(root, 'home/codex'), { recursive: true })
  for (const [key, value] of Object.entries({ HOME: join(root, 'home'), CODEX_HOME: join(root, 'home/codex'),
    AGENTMUX_RUNTIME_DIRECTORY: join(root, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson') })) vi.stubEnv(key, value)
})
afterAll(async () => {
  const cleanup = await import(pathToFileURL(resolve('apps/desktop/scripts/probe-process.mjs')).href) as {
    listProbeProcesses(group: number, root: string): Promise<number[]>
    signalOwnedProbeProcess(pid: number, root: string, name: NodeJS.Signals): Promise<boolean>
  }
  for (const name of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of await cleanup.listProbeProcesses(process.pid + 1_000_000_000, root)) await cleanup.signalOwnedProbeProcess(pid, root, name)
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  expect(await cleanup.listProbeProcesses(process.pid + 1_000_000_000, root)).toEqual([])
  vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true })
})

it('uses authenticated actual HTTPS mobile control and the original SDK against two physical Runs while preserving Unix input, passive sizes, own leases and uncertain receipt identity', async () => {
  const material = await preparePrivateCertificates(join(root, 'certificates'), '127.0.0.1'), ca = await readFile(join(material.directory, 'issuer.pem'))
  const reserved = createServer(); await new Promise<void>(resolve => reserved.listen(0, '127.0.0.1', resolve))
  const address = reserved.address(); if (!address || typeof address === 'string') throw new Error('No private port')
  await new Promise<void>(resolve => reserved.close(() => resolve()))
  const store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json')), socket = join(root, 'control.sock')
  const host = await startAgentMuxHost({ store, socketPath: socket, privateAccess: { host: '127.0.0.1', port: address.port,
    keyPath: material.keyPath, certificatePath: material.certificatePath } })
  const localRpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socket } }), desktop = await connectHostedAgentMux({ rpc: localRpc, expectedStorePath: store.path })
  let mobile: Awaited<ReturnType<typeof connectHostedAgentMux>> | undefined
  let port: HostedHttpRpcPort | undefined
  let reader: ReturnType<typeof createMobileTerminalReader> | undefined
  let control: ReturnType<typeof createMobileTerminalControl> | undefined
  const observers: Array<{ close(): Promise<void> }> = []
  const created: Array<{ agentSessionId: string; run: { runId: string } }> = []
  try {
    const worker = join(root, 'worker.py')
    await writeFile(worker, '#!/usr/bin/python3\nimport os,sys,tty\nif "--version" in sys.argv:\n print("Private control fixture 1");sys.exit(0)\ntty.setraw(0)\nos.write(1,b"original-ready\\r\\n")\nwhile True:\n data=os.read(0,4096)\n if not data:break\n os.write(1,b"original-echo:"+data)\n', { mode: 0o700 })
    for (let index = 0; index < 2; index++) created.push(await host.client!.createAgent({ createOperationId: crypto.randomUUID(), providerId: 'codex',
      executorId: 'private-mobile-control', commandOverride: worker, workspacePath: root, injectAgentMuxGuide: false,
      env: { CODEX_HOME: join(root, 'home/codex') }, cols: 100, rows: 30 }))
    const [original, other] = created
    for (const session of created) await vi.waitFor(async () => {
      const replay = await desktop.readRunReplay(session.run, 0, 'raw')
      expect(replay.replay.map(chunk => chunk.data).join('')).toContain('original-ready')
    }, { timeout: 5000 })
    const before = await desktop.listRuns(), originalRun = before.find(run => run.runId === original!.run.runId)!, otherRun = before.find(run => run.runId === other!.run.runId)!
    expect(before.map(run => run.runId).sort()).toEqual(created.map(session => session.run.runId).sort())
    expect(originalRun.pid).toBeGreaterThan(1); expect(otherRun.pid).toBeGreaterThan(1)
    expect(originalRun).toMatchObject({ state: 'running', cols: 100, rows: 30 })
    const macOutput: string[] = [], otherOutput: string[] = []
    observers.push(await desktop.observeAgentOutput(original!.agentSessionId, originalRun.latestOutputBytes, event => { if (event.type === 'terminal-output') macOutput.push(event.data) }))
    observers.push(await desktop.observeAgentOutput(other!.agentSessionId, otherRun.latestOutputBytes, event => { if (event.type === 'terminal-output') otherOutput.push(event.data) }))
    const authority = await host.deviceAuthority(), invitation = authority.invite(), waiting = authority.begin(authority.hostId, invitation.invitation, 'Private actual mobile control')
    await authority.approve(waiting.deviceId, waiting.confirmationCode)
    const claimed = authority.claim(waiting.hostId, waiting.deviceId, waiting.claim)
    if (claimed.state !== 'approved') throw new Error('Original controlled local approval failed')
    const state = host.privateAccessState(); if (state.state !== 'listening') throw new Error('Actual private HTTPS unavailable')
    let dropNextInputReceipt = false
    const fetchForDevice: typeof fetch = async (input, init) => {
      const requestBody = JSON.parse(String(init?.body))
      const lose = dropNextInputReceipt && requestBody.method === 'runtime.invoke' && requestBody.params.invocation.method === 'writeAgent'
      if (lose) dropNextInputReceipt = false
      const response = await new Promise<Response>((resolve, reject) => {
        const headers = new Headers(init?.headers); headers.set('X-AgentMux-Transport', 'native')
        headers.set('Authorization', `AgentMuxDevice ${authority.hostId}.${claimed.credential}`)
        const request = httpsRequest(String(input), { method: init?.method, ca, headers: Object.fromEntries(headers) }, response => {
          const headers = new Headers(); for (const [key, value] of Object.entries(response.headers)) {
            for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) headers.append(key, item)
          }
          resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status: response.statusCode!, headers }))
        })
        const abort = () => request.destroy(new Error('Own private device request cancelled'))
        init?.signal?.addEventListener('abort', abort, { once: true }); request.once('close', () => init?.signal?.removeEventListener('abort', abort))
        request.once('error', reject); request.end(String(init?.body))
      })
      if (lose) { await response.text(); throw new Error('The actual Core Input applied; only this transport ACK was lost') }
      return response
    }
    port = new HostedHttpRpcPort({ origin: state.origin, fetch: fetchForDevice })
    mobile = await connectHostedAgentMux({ rpc: port, expectedStorePath: store.path })
    expect(mobile.agentSessions().map(session => session.agentSessionId).sort()).toEqual(created.map(session => session.agentSessionId).sort())
    const bytes: number[] = [], unrelated: unknown[] = [], reports: unknown[] = [], resized: Array<[number, number]> = []
    mobile.onEvent(event => { if (event.type === 'terminal-output' && event.run.runId === other!.run.runId) unrelated.push(event) })
    reader = createMobileTerminalReader({ client: mobile, agentSessionId: original!.agentSessionId,
      canvas: { rows: 30, buffer: { active: { type: 'normal', length: 30, baseY: 0, viewportY: 0 } },
        write(data, done) { bytes.push(...data); done() }, resize(cols, rows) { resized.push([cols, rows]) }, reset() {}, scrollToLine() {} },
      report: value => reports.push(value) })
    reader.setVisible(true)
    await vi.waitFor(() => expect(reader!.facts().acquired).toEqual(original!.run))
    const baseline = (await desktop.listRuns()).find(run => run.runId === original!.run.runId)!
    expect(baseline).toMatchObject({ cols: 100, rows: 30, acceptedInputBytes: originalRun.acceptedInputBytes })
    await desktop.writeAgent({ agentSessionId: other!.agentSessionId, expectedRun: other!.run, data: `${'other-only-'.repeat(100)}\n`, source: 'user' })
    await vi.waitFor(() => expect(otherOutput.join('')).toContain('original-echo:other-only-'))
    expect(unrelated).toEqual([]); expect(new TextDecoder().decode(new Uint8Array(bytes))).not.toContain('other-only-')
    const guard = new Map<string, string>()
    control = createMobileTerminalControl({ client: mobile, agentSessionId: original!.agentSessionId, report: value => reports.push(value),
      storage: () => ({ getItem: key => guard.get(key) ?? null, setItem: (key, value) => { guard.set(key, value) }, removeItem: key => { guard.delete(key) } }) })
    control.send('watch-query\x1b[1;1R', 'terminal-protocol')
    expect((await desktop.listRuns()).find(run => run.runId === original!.run.runId)).toMatchObject({ acceptedInputBytes: baseline.acceptedInputBytes, cols: 100, rows: 30 })
    expect(control.enable()).toBe(true); control.send('phone-你好\n', 'user')
    await vi.waitFor(() => expect(control!.facts().phase).toBe('idle'))
    await vi.waitFor(() => expect(macOutput.join('')).toContain('original-echo:phone-你好'))
    await vi.waitFor(() => expect(new TextDecoder().decode(new Uint8Array(bytes))).toContain('original-echo:phone-你好'))
    expect(control.resize(52, 18)).toBe(true)
    await vi.waitFor(async () => expect((await desktop.listRuns()).find(run => run.runId === original!.run.runId)).toMatchObject({ cols: 52, rows: 18, pid: originalRun.pid }))
    await vi.waitFor(() => expect(resized).toContainEqual([52, 18]))
    dropNextInputReceipt = true; control.send('original-uncertain\n', 'user'); control.send('unsent-new-input\n', 'user')
    await vi.waitFor(() => expect(control!.facts().phase).toBe('unknown'))
    await vi.waitFor(() => expect(macOutput.join('')).toContain('original-echo:original-uncertain'))
    await vi.waitFor(() => expect(new TextDecoder().decode(new Uint8Array(bytes))).toContain('original-echo:original-uncertain'))
    expect(control.queuedText()).toBe('unsent-new-input\n')
    const accepted = (await desktop.listRuns()).find(run => run.runId === original!.run.runId)!.acceptedInputBytes
    reader.setVisible(false); control.watch()
    await vi.waitFor(() => expect(reader!.facts().acquired).toBeNull()); reader.setVisible(true)
    await vi.waitFor(() => expect(reader!.facts().acquired).toEqual(original!.run))
    expect((await desktop.listRuns()).find(run => run.runId === original!.run.runId)).toMatchObject({ acceptedInputBytes: accepted, pid: originalRun.pid, cols: 52, rows: 18, state: 'running' })
    expect(control.continueAfterReview()).toBe(true); expect(control.enable()).toBe(true)
    await vi.waitFor(() => expect(macOutput.join('')).toContain('original-echo:unsent-new-input'))
    expect(macOutput.join('').split('original-echo:original-uncertain')).toHaveLength(2)
    await reader.dispose(); reader = undefined; control.dispose(); control = undefined
    await mobile.dispose(); mobile = undefined; port.dispose(); port = undefined
    await desktop.writeAgent({ agentSessionId: original!.agentSessionId, expectedRun: original!.run, data: 'desktop-after-mobile-close\n', source: 'user' })
    await vi.waitFor(() => expect(macOutput.join('')).toContain('original-echo:desktop-after-mobile-close'))
    const final = await desktop.listRuns()
    expect(final.map(run => ({ runId: run.runId, pid: run.pid, state: run.state })).sort((a, b) => a.runId.localeCompare(b.runId)))
      .toEqual([originalRun, otherRun].map(run => ({ runId: run.runId, pid: run.pid, state: 'running' })).sort((a, b) => a.runId.localeCompare(b.runId)))
  } finally {
    control?.dispose(); await reader?.dispose(); await mobile?.dispose(); port?.dispose()
    for (const observer of observers) await observer.close()
    await desktop.dispose(); await localRpc.dispose()
    for (const session of created) await host.client!.stopAgent(session.agentSessionId, session.run)
    await host.dispose()
  }
})
