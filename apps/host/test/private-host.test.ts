import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createServer } from 'node:net'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { AgentMuxFileAgentSessionStore, connectAgentMuxRpc, type AgentMuxAgentSession } from '@agentmux/core'
import { connectHostedAgentMux } from '@agentmux/core/hosted'
import { openAgentMuxRpcHttpRequest, parseRpcResponse, parseRpcRequest, rpcRecord, rpcResponseError,
  type AgentMuxRpcHttpReader } from '@agentmux/core/public-rpc-http'
import { startAgentMuxHost, type AgentMuxHostOptions } from '../src/host.js'
import { preparePrivateCertificates } from '../src/private-certificates.js'
import { defaultPrivateAccessConfigurationPath, readPrivateAccessConfiguration } from '../src/private-access-configuration.js'

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 })
let directory: string, ca: Buffer, material: Awaited<ReturnType<typeof preparePrivateCertificates>>, counter = 0
beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), 'amx-private-host-'))
  const home = join(directory, 'home')
  await mkdir(join(home, 'codex'), { recursive: true })
  for (const [key, value] of Object.entries({ HOME: home, CODEX_HOME: join(home, 'codex'),
    AGENTMUX_RUNTIME_DIRECTORY: join(directory, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(directory, 'state'),
    AGENTMUX_MESSAGE_QUEUE_PATH: join(directory, 'messages.ndjson') })) vi.stubEnv(key, value)
  material = await preparePrivateCertificates(join(directory, 'certificates'), '127.0.0.1')
  ca = await readFile(join(material.directory, 'issuer.pem'))
})
afterAll(async () => {
  // The shared helper rechecks the unique private path immediately before each signal.
  const helpers = await import(pathToFileURL(resolve('apps/desktop/scripts/probe-process.mjs')).href) as {
    listProbeProcesses(group: number, root: string): Promise<number[]>
    signalOwnedProbeProcess(pid: number, root: string, name: NodeJS.Signals): Promise<boolean>
  }
  for (const name of ['SIGTERM', 'SIGKILL'] as const) {
    for (const pid of await helpers.listProbeProcesses(process.pid + 1_000_000_000, directory)) {
      await helpers.signalOwnedProbeProcess(pid, directory, name)
    }
    await new Promise(resolve => setTimeout(resolve, 150))
  }
  expect(await helpers.listProbeProcesses(process.pid + 1_000_000_000, directory)).toEqual([])
  vi.unstubAllEnvs()
  await rm(directory, { recursive: true, force: true })
})

async function availablePort() {
  const server = createServer()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Private port was not reserved')
  await new Promise<void>(resolve => server.close(() => resolve()))
  return address.port
}
async function fixture() {
  const root = join(directory, `fixture-${++counter}`), store = new AgentMuxFileAgentSessionStore(join(root, 'sessions.json'))
  await mkdir(root)
  const worker = join(root, 'worker.py')
  await writeFile(worker, '#!/usr/bin/python3\nimport os,sys\nif "--version" in sys.argv:\n print("Private TLS worker 1");sys.exit(0)\nos.write(1,b"private-ready\\r\\n")\nwhile True:\n data=os.read(0,4096)\n if not data: break\n os.write(1,b"private-echo:"+data)\n', { mode: 0o700 })
  const base = { store, socketPath: join(root, 'control.sock') }
  let host = await startAgentMuxHost(base), original: AgentMuxAgentSession | undefined
  const seed = async () => {
    original = await host.client!.createAgent({ createOperationId: crypto.randomUUID(), providerId: 'codex',
      executorId: 'private-tls-proof', commandOverride: worker, workspacePath: root,
      injectAgentMuxGuide: false, env: { CODEX_HOME: join(directory, 'home/codex') }, cols: 100, rows: 30 })
    const run = (await host.client!.listRuns()).find(value => value.runId === original!.run.runId)
    expect(run).toMatchObject({ state: 'running', cols: 100, rows: 30 })
    expect(run!.pid).toBeGreaterThan(1)
    return run!
  }
  const restart = async (options: Partial<AgentMuxHostOptions>) => {
    await host.dispose(); host = await startAgentMuxHost({ ...base, ...options }); return host
  }
  const healthy = async (expected: Awaited<ReturnType<typeof seed>>, text: string) => {
    const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: base.socketPath } })
    const client = await connectHostedAgentMux({ rpc, expectedStorePath: store.path })
    try {
      expect(client.agentSessions()).toEqual([expect.objectContaining({ agentSessionId: original!.agentSessionId, run: original!.run })])
      const run = (await client.listRuns()).find(value => value.runId === original!.run.runId)
      expect(run).toMatchObject({ runId: expected.runId, pid: expected.pid, state: 'running', cols: expected.cols, rows: expected.rows })
      const bytes: string[] = []
      const reading = await client.observeAgentOutput(original!.agentSessionId, run!.latestOutputBytes, event => {
        if (event.type === 'terminal-output') bytes.push(event.data)
      })
      try {
        await client.writeAgent({ agentSessionId: original!.agentSessionId, expectedRun: original!.run, data: `${text}\n`, source: 'user' })
        await vi.waitFor(() => expect(bytes.join('')).toContain(`private-echo:${text}`), { timeout: 5000 })
        expect((await client.listRuns()).find(value => value.runId === expected.runId)).toMatchObject({ pid: expected.pid, state: 'running' })
      } finally { await reading.close() }
    } finally { await client.dispose(); await rpc.dispose() }
  }
  return { root, store, base, seed, restart, healthy, host: () => host, session: () => original!,
    configuration: async () => ({ host: '127.0.0.1', port: await availablePort(), keyPath: material.keyPath,
      certificatePath: material.certificatePath }),
    async dispose() { try {
      if (original && host.client!.agentSessions().some(value => value.agentSessionId === original!.agentSessionId && value.run.runId === original!.run.runId)) {
        await host.client!.stopAgent(original.agentSessionId, original.run)
      }
    } finally { await host.dispose() } } }
}

it('reads one exact non-secret startup manifest and retains malformed, foreign and symbolic configuration bytes', async () => {
  const root = join(directory, 'manifest'); await mkdir(root)
  const path = defaultPrivateAccessConfigurationPath(join(root, 'sessions.json'))
  const configuration = { host: '127.0.0.1', port: 7443, keyPath: material.keyPath, certificatePath: material.certificatePath,
    mobileBuildDirectory: join(root, 'mobile') }
  await writeFile(path, JSON.stringify(configuration))
  expect(await readPrivateAccessConfiguration(path)).toEqual(configuration)
  const malformed = [JSON.stringify({ ...configuration, port: false }), JSON.stringify({ ...configuration, host: '0.0.0.0' }),
    JSON.stringify({ ...configuration, keyPath: 'relative.key' }), JSON.stringify({ ...configuration, token: 'forbidden-secret' }),
    JSON.stringify({ ...configuration, mobileBuildDirectory: null }), '{original-broken-bytes', ' '.repeat(4097)]
  expect(malformed).toHaveLength(7)
  for (const bytes of malformed) {
    await writeFile(path, bytes)
    await expect(readPrivateAccessConfiguration(path)).rejects.toBeInstanceOf(Error)
    expect(await readFile(path, 'utf8')).toBe(bytes)
  }
  const symbolic = join(root, 'symbolic.json'); await symlink(path, symbolic)
  await expect(readPrivateAccessConfiguration(symbolic)).rejects.toMatchObject({ code: 'INVALID_CONTROL_REQUEST' })
})

it('uses the actual Host startup entry for the durable default manifest and explicit manifest without turning their failure into a Unix startup failure', async () => {
  const root = join(directory, 'startup'); await mkdir(root)
  const storePath = join(root, 'sessions.json'), manifest = defaultPrivateAccessConfigurationPath(storePath)
  const config = { host: '127.0.0.1', port: await availablePort(), keyPath: material.keyPath, certificatePath: material.certificatePath }
  const explicit = join(root, 'selected-access.json'); await writeFile(explicit, JSON.stringify(config))
  await writeFile(manifest, '{original-broken-startup-manifest')
  const cases = [
    { args: [] as string[], state: 'unavailable', message: 'configuration is invalid' },
    { args: ['--private-access', join(root, 'missing.json')], state: 'unavailable', message: 'ENOENT' },
    { args: ['--private-access', explicit], state: 'listening', message: 'HTTPS is listening' }
  ]
  expect(cases).toHaveLength(3)
  for (const candidate of cases) {
    const child = spawn(process.execPath, [process.env.AGENTMUX_TEST_HOST_ENTRY ?? resolve('apps/host/dist/index.js'), '--store', storePath, ...candidate.args], {
      env: { ...process.env, AGENTMUX_AGENT_SESSION_STORE: storePath }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.on('data', value => { output += value.toString() }); child.stderr.on('data', value => { errors += value.toString() })
    const exited = new Promise<void>(resolve => child.once('exit', () => resolve()))
    try {
      await vi.waitFor(() => {
        expect(child.exitCode, errors).toBeNull()
        expect(output).toContain('\n')
      }, { timeout: 5000 })
      const receipt = JSON.parse(output.split('\n')[0]!) as { pid: number; privateAccess: { state: string; message: string }; identity: unknown }
      expect(receipt.pid).toBe(child.pid)
      expect(receipt.privateAccess).toMatchObject({ state: candidate.state, message: expect.stringContaining(candidate.message) })
      const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: join(directory, 'runtime/control.sock') } })
      try {
        const bootstrap = await rpc.call('runtime.bootstrap', { consumerId: 'startup-proof' })
        expect(bootstrap).toMatchObject({ storePath, identity: receipt.identity, hostProcessId: child.pid })
      } finally { await rpc.dispose() }
      expect(await readFile(manifest, 'utf8')).toBe('{original-broken-startup-manifest')
      expect(await readFile(explicit, 'utf8')).toBe(JSON.stringify(config))
    } finally { child.kill('SIGTERM'); await exited }
    expect(child.exitCode, errors).toBe(0)
  }
})

it('keeps the original healthy Run and Unix business available when explicit mobile configuration cannot be read', async () => {
  const f = await fixture()
  try {
    const run = await f.seed(), host = await f.restart({ privateAccessIssue: 'Original manifest cannot be read.' })
    expect(host.privateAccessState()).toEqual({ state: 'unavailable', message: 'Original manifest cannot be read.' })
    expect(host.server.httpAddress).toBeNull()
    await f.healthy(run, 'manifest-retained')
  } finally { await f.dispose() }
})

it('retains a healthy original Run and unusable certificate bytes instead of enabling untrusted HTTP', async () => {
  const f = await fixture()
  try {
    const run = await f.seed(), certificatePath = join(f.root, 'bad-certificate.pem')
    await writeFile(certificatePath, 'original-invalid-certificate')
    const host = await f.restart({ privateAccess: { ...await f.configuration(), certificatePath } })
    expect(host.privateAccessState().state).toBe('unavailable'); expect(host.server.httpAddress).toBeNull()
    expect(await readFile(certificatePath, 'utf8')).toBe('original-invalid-certificate')
    await f.healthy(run, 'tls-retained')
  } finally { await f.dispose() }
})

it('keeps bad durable device identity bytes and the healthy original Run without creating another device issuer', async () => {
  const f = await fixture()
  try {
    const run = await f.seed(), authorityPath = join(f.root, 'agentmux-devices.json')
    await writeFile(authorityPath, '{original-broken-device-identity')
    const host = await f.restart({ privateAccess: await f.configuration() })
    expect(host.privateAccessState()).toMatchObject({ state: 'unavailable', message: expect.stringContaining('original device authority') })
    await expect(host.deviceAuthority()).rejects.toBeInstanceOf(Error)
    expect(await readFile(authorityPath, 'utf8')).toBe('{original-broken-device-identity')
    await f.healthy(run, 'authority-retained')
  } finally { await f.dispose() }
})

it('reports an occupied HTTPS port while preserving the original Unix owner, Run and input', async () => {
  const f = await fixture(), blocker = createServer()
  try {
    const run = await f.seed()
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
    const address = blocker.address(); if (!address || typeof address === 'string') throw new Error('Private blocker has no port')
    const host = await f.restart({ privateAccess: { ...await f.configuration(), port: address.port } })
    expect(host.privateAccessState()).toMatchObject({ state: 'unavailable', message: expect.stringContaining('existing Unix') })
    expect(host.server.httpAddress).toBeNull()
    await f.healthy(run, 'http-retained')
  } finally { await new Promise<void>(resolve => blocker.close(() => resolve())); await f.dispose() }
})

it('serves actual mobile assets and authenticated public RPC on the one verified HTTPS Host, revoking only its approved device stream', async () => {
  const f = await fixture(), readers: AgentMuxRpcHttpReader[] = []
  try {
    const run = await f.seed(), build = join(f.root, 'mobile')
    await mkdir(join(build, 'assets'), { recursive: true })
    await writeFile(join(build, 'index.html'), '<!doctype html><script type="module" src="/assets/mobile-proof.js"></script>')
    await writeFile(join(build, 'assets/mobile-proof.js'), 'globalThis.originalMobileBuild=true;')
    const host = await f.restart({ privateAccess: { ...await f.configuration(), mobileBuildDirectory: build } })
    const state = host.privateAccessState()
    expect(state).toMatchObject({ state: 'listening', mobileBuildDigest: expect.stringMatching(/^[a-f0-9]{64}$/u) })
    if (state.state !== 'listening') throw new Error('Actual HTTPS did not start')
    const authority = await host.deviceAuthority()
    expect(state.issuerHostId).toBe(authority.hostId); expect(state.issuerHostId).not.toBe(host.client!.runtimeIdentity().hostId)
    const send = (path: string, method = 'GET', body?: unknown, cookie?: string, trusted = true) =>
      new Promise<{ status: number; text: string; cookies: string[] }>((resolve, reject) => {
        const request = httpsRequest(`${state.origin}${path}`, { method, ...(trusted ? { ca } : {}), headers: {
          ...(method === 'GET' ? {} : { Origin: state.origin, 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {})
        } }, response => {
          const chunks: Buffer[] = []; response.on('data', value => chunks.push(value))
          response.once('end', () => resolve({ status: response.statusCode!, text: Buffer.concat(chunks).toString(), cookies: response.headers['set-cookie'] ?? [] }))
        })
        request.once('error', reject); request.end(body === undefined ? undefined : JSON.stringify(body))
      })
    expect(await send('/')).toMatchObject({ status: 200, text: expect.stringContaining('/assets/mobile-proof.js') })
    expect(await send('/assets/mobile-proof.js')).toMatchObject({ status: 200, text: 'globalThis.originalMobileBuild=true;' })
    await expect(send('/_agentmux/device', 'GET', undefined, undefined, false)).rejects.toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
    expect((await send('/', 'POST', { jsonrpc: '2.0', id: 'unauthorized', method: 'runtime.bootstrap', params: { consumerId: 'device-consumer' } })).status).toBe(401)
    const approve = async (name: string) => {
      const invitation = authority.invite()
      const response = await send('/_agentmux/device', 'POST', { hostId: authority.hostId, invitation: invitation.invitation, name })
      expect(response.status).toBe(201)
      const pending = JSON.parse(response.text) as { deviceId: string; confirmationCode: string }
      // Controlled local Authority admission proves server composition, not an OS user dialog.
      await authority.approve(pending.deviceId, pending.confirmationCode)
      const claim = await send('/_agentmux/device/claim', 'POST', { hostId: authority.hostId }, response.cookies[0]!.split(';')[0])
      expect(claim.status).toBe(200)
      return { deviceId: pending.deviceId, cookie: claim.cookies[0]!.split(';')[0]! }
    }
    const a = await approve('Private iPhone'), b = await approve('Private second reader')
    const bootstrap = parseRpcResponse(JSON.parse((await send('/', 'POST', { jsonrpc: '2.0', id: 'confirmed', method: 'runtime.bootstrap',
      params: { consumerId: 'same-consumer-name' } }, a.cookie)).text))
    expect(rpcResponseError(bootstrap)).toBeNull()
    expect(bootstrap.result).toMatchObject({ storePath: f.store.path, identity: host.client!.runtimeIdentity(),
      sessions: [expect.objectContaining({ agentSessionId: f.session().agentSessionId, run: f.session().run })] })
    const framesA: unknown[] = [], framesB: unknown[] = [], endedA = vi.fn(), endedB = vi.fn()
    const fetchFor = (cookie: string): typeof fetch => async (input, init) => new Promise((resolve, reject) => {
      const headers = new Headers(init?.headers); headers.set('Origin', state.origin); headers.set('Cookie', cookie)
      const request = httpsRequest(String(input), { method: init?.method, ca, headers: Object.fromEntries(headers) }, response => {
        const received = new Headers(); for (const [key, value] of Object.entries(response.headers)) {
          for (const item of Array.isArray(value) ? value : value === undefined ? [] : [value]) received.append(key, item)
        }
        const stream = Readable.toWeb(response) as ReadableStream<Uint8Array>
        resolve(new Response(stream, { status: response.statusCode!, headers: received }))
      })
      const abort = () => request.destroy(new Error('Private request cancelled'))
      init?.signal?.addEventListener('abort', abort, { once: true })
      request.once('close', () => init?.signal?.removeEventListener('abort', abort))
      request.once('error', reject); request.end(typeof init?.body === 'string' ? init.body : undefined)
    })
    for (const [device, frames, end] of [[a, framesA, endedA], [b, framesB, endedB]] as const) {
      readers.push(await openAgentMuxRpcHttpRequest({ url: `${state.origin}/`, fetch: fetchFor(device.cookie) },
        { jsonrpc: '2.0', id: crypto.randomUUID(), method: 'agent.output', params: { agentSessionId: f.session().agentSessionId, afterByte: run.latestOutputBytes, follow: true } },
        frame => frames.push(frame), end, new AbortController().signal))
    }
    await vi.waitFor(() => { expect(framesA.length).toBeGreaterThan(0); expect(framesB.length).toBeGreaterThan(0) })
    await authority.revoke(a.deviceId)
    await vi.waitFor(() => expect(endedA).toHaveBeenCalledTimes(1))
    const before = framesB.length
    await f.healthy(run, 'other-device-kept')
    await vi.waitFor(() => {
      const output = framesB.slice(before).flatMap(frame => {
        const notification = parseRpcRequest(frame), event = rpcRecord(rpcRecord(notification.params).event)
        if (event.type !== 'output') return []
        const value = rpcRecord(event.data)
        expect(typeof value.dataBase64).toBe('string')
        return [Buffer.from(value.dataBase64 as string, 'base64').toString('utf8')]
      })
      expect(output.join('')).toContain('private-echo:other-device-kept')
    })
    expect(endedB).not.toHaveBeenCalled()
    const originalAuthority = await readFile(join(f.root, 'agentmux-devices.json'))
    await Promise.all(readers.map(reader => reader.dispose())); readers.length = 0
    const restarted = await f.restart({ privateAccess: { ...await f.configuration(), mobileBuildDirectory: build } })
    expect((await restarted.deviceAuthority()).hostId).toBe(state.issuerHostId)
    expect(await readFile(join(f.root, 'agentmux-devices.json'))).toEqual(originalAuthority)
    await f.healthy(run, 'private-host-restart-kept')
  } finally { await Promise.all(readers.map(reader => reader.dispose())); await f.dispose() }
})
