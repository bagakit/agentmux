import { afterAll, afterEach, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentMuxFileAgentSessionStore, connectAgentMuxRpc } from '@agentmux/core'

const cleanups: Array<() => Promise<void>> = [], facts: unknown[] = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanups.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Private Host output fixture cleanup is unconfirmed')
})
afterAll(async () => { if (process.env.HOST_OUTPUT_FACTS) await writeFile(process.env.HOST_OUTPUT_FACTS,
  JSON.stringify({ scope: 'Real source Host/Core/FileStore/public Unix RPC/source CLI; only original private Native I/O controlled. No installed App, user service or whole Native qualification.', facts }, null, 2) + '\n') })
const hash = (value: Buffer) => createHash('sha256').update(value).digest('hex')
async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean, label: string): Promise<T> {
  const deadline = Date.now() + 12_000
  let last: unknown
  while (Date.now() < deadline) {
    try { const value = await read(); if (accepts(value)) return value } catch (error) { last = error }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`Private ${label} did not settle`, { cause: last })
}
async function deadline<T>(operation: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(Error(label)), 5000) })]) }
  finally { if (timer) clearTimeout(timer) }
}
function childExit(child: ChildProcess) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject); child.once('exit', (code, signal) => resolve({ code, signal }))
  })
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'h-out-')), home = join(root, 'home'), socket = join(root, 'control.sock')
  await mkdir(home)
  let safeToRemove = true
  cleanups.push(async () => { if (!safeToRemove) throw Error(`Private fixture retained for unconfirmed process cleanup: ${root}`); await rm(root, { recursive: true, force: true }) })
  const log = join(root, 'output.log'), storePath = join(root, 'sessions.json'), loaded = join(root, 'loaded.ndjson')
  const seed = Buffer.from('HOST_OUTPUT_ORIGINAL_BEGIN\n' + 'private original diagnostic line\n'.repeat(70_000) + 'HOST_OUTPUT_ORIGINAL_END\n')
  expect(seed.length).toBeGreaterThan(2 * 1024 * 1024)
  await writeFile(log, seed)
  const nativeHandle = { kind: 'provider' as const, providerId: 'claude', sessionId: 'native-original', transcriptPath: join(root, 'native.jsonl') }
  await new AgentMuxFileAgentSessionStore(storePath).compareAndSwap(null, {
    kind: 'agent', agentSessionId: 'original-agent', providerId: 'claude', executorId: 'claude', hostId: 'local', workspacePath: root,
    run: { runId: 'original-run' }, retiredRuns: [], nativeHandle, hookBindingId: 'original-hook', hookToken: 'private-synthetic-hook-token', createdAt: 1, updatedAt: 1
  })
  await writeFile(nativeHandle.transcriptPath, JSON.stringify({ type: 'assistant', sessionId: 'native-original', uuid: 'prior', message: { role: 'assistant', content: 'Private original recorded answer' } }) + '\n')
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin', LANG: 'C.UTF-8', HOME: home, ZDOTDIR: home, SHELL: '/bin/zsh', TMPDIR: tmpdir(),
    NODE_OPTIONS: '--import ' + pathToFileURL(process.env.HOST_OUTPUT_LOADER!).href,
    HOST_OUTPUT_LISTENER_ENTRY: process.env.HOST_OUTPUT_LISTENER_ENTRY!, HOST_OUTPUT_LOADED: loaded,
    HOST_INDEX_NATIVE_FACTS: join(root, 'native-facts.json'), HOST_INDEX_WORKSPACE: root,
    AGENTMUX_AGENT_SESSION_STORE: storePath, AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
    AGENTMUX_SPATIAL_STATE_STORE: join(root, 'spatial.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'), AGENTMUX_MOBILE_BUILD_DIRECTORY: join(root, 'absent-mobile') }
  const hostFd = await open(log, 'a+'), writerFd = await open(log, 'a')
  cleanups.push(async () => { await hostFd.close(); await writerFd.close() })
  const writer = spawn(process.execPath, [new URL('./fixtures/host-output-writer.mjs', import.meta.url).pathname], { env, stdio: ['ignore', writerFd.fd, writerFd.fd, 'ipc'] })
  const writerExited = childExit(writer), acks: Array<{ sequence: number; phase: string; bytes: number }> = []
  writer.on('message', message => acks.push(message as typeof acks[number]))
  let writerClosed = false
  const closeWriter = async () => {
    if (writerClosed) return
    if (writer.exitCode === null && writer.signalCode === null) writer.send('stop')
    const ended = await deadline(writerExited, 'Private writer exit unconfirmed')
    expect(ended).toEqual({ code: 0, signal: null }); writerClosed = true
  }
  cleanups.push(async () => { try { await closeWriter() } catch (error) { safeToRemove = false; throw error } })
  await waitFor(async () => acks, values => values.some(value => value.phase === 'before'), 'writer initial ACK')
  async function writerPhase(phase: 'after-ready' | 'after-host-exit') {
    writer.send(phase)
    await waitFor(async () => acks, values => values.some(value => value.phase === phase), `writer ${phase} ACK`)
  }
  async function start(valid: boolean) {
    const child = spawn(process.execPath, [process.env.HOST_OUTPUT_HOST_ENTRY!, '--store', valid ? storePath : join(root, 'different-store.json')],
      { cwd: root, env, stdio: ['ignore', hostFd.fd, hostFd.fd] })
    const exited = childExit(child)
    let closed = false
    const close = async () => {
      if (closed) return
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      const result = await deadline(exited, 'Private Host exit unconfirmed')
      if (valid) expect(result).toEqual({ code: 0, signal: null })
      closed = true
    }
    cleanups.push(async () => { try { await close() } catch (error) { safeToRemove = false; throw error } })
    return { child, exited, close }
  }
  async function assertBytes(kind: string, extra: object) {
    await closeWriter()
    const bytes = await readFile(log), text = bytes.toString('utf8')
    const observed = [...text.matchAll(/HOST_OUTPUT_WRITER_(\d+)_([^\n]+)\n/g)].map(value => Number(value[1]))
    const retainedSeed = bytes.subarray(0, seed.length).equals(seed)
    const missingAcks = acks.filter(ack => observed.filter(sequence => sequence === ack.sequence).length !== 1).length
    const witness = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(witness.some(row => row.path === 'apps/host/src/index.ts' && row.surface === 'host')).toBe(true)
    facts.push({ case: kind, seedBytes: seed.length, outputBytes: bytes.length, seedSHA256: hash(seed), outputSHA256: hash(bytes),
      retainedSeed, acknowledgedAppends: acks.length, missingOrRepeatedAcks: missingAcks, phases: [...new Set(acks.map(ack => ack.phase))], loaded: witness, ...extra })
    expect(retainedSeed, 'HOST_OUTPUT_ORIGINAL_SEED_PRESERVED').toBe(true)
    expect(missingAcks, 'HOST_OUTPUT_INDEPENDENT_ACKS_PRESERVED').toBe(0)
  }
  return { root, log, storePath, socket, seed, nativeHandle, env, loaded, start, writerPhase, assertBytes }
}

it('valid actual Host entry preserves large inherited output and independent appends through original RPC and source CLI', async () => {
  const f = await fixture(), host = await f.start(true)
  await waitFor(async () => { await access(f.socket); return true }, Boolean, 'original endpoint')
  const rpc = await connectAgentMuxRpc({ endpoint: { transport: 'unix', path: f.socket } }); cleanups.push(() => rpc.dispose())
  const { owner } = await waitFor(() => rpc.call('runtime.owner.identity', {}), value => value.owner.availability === 'connected', 'original owner')
  const bootstrap = await rpc.call('runtime.bootstrap', { consumerId: 'private-output-observer', fence: { runtimeId: owner.runtimeId, ownerInstanceId: owner.ownerInstanceId } })
  expect(bootstrap.storePath).toBe(f.storePath); expect(bootstrap.hostProcessId).toBe(host.child.pid)
  const session = (await rpc.call('agent.inspect', { target: { kind: 'agent-session', agentSessionId: 'original-agent' } })).session
  expect(session.agentSessionId).toBe('original-agent'); expect(session.run).toEqual({ runId: 'original-run' }); expect(session.nativeHandle).toEqual(f.nativeHandle)
  const cli = spawn(process.execPath, [process.env.HOST_OUTPUT_CLI_ENTRY!, '--endpoint', 'unix:' + f.socket, 'runtime', 'owner', 'identity'], { env: f.env, stdio: ['ignore', 'pipe', 'pipe'] })
  const cliExited = childExit(cli)
  cleanups.push(async () => { if (cli.exitCode === null && cli.signalCode === null) cli.kill('SIGTERM'); await deadline(cliExited, 'Private source CLI exit unconfirmed') })
  let stdout = '', stderr = ''; cli.stdout!.on('data', data => { stdout += String(data) }); cli.stderr!.on('data', data => { stderr += String(data) })
  expect(await cliExited, stderr).toEqual({ code: 0, signal: null })
  expect(JSON.parse(stdout).result.owner).toEqual(owner)
  await waitFor(async () => (await readFile(f.log, 'utf8')).includes('"protocol":"jsonrpc-2.0"'), Boolean, 'actual entry stdout readiness')
  await f.writerPhase('after-ready'); await rpc.dispose(); await host.close(); await f.writerPhase('after-host-exit')
  const native = await readFile(f.env.HOST_INDEX_NATIVE_FACTS!, 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return { effects: [], lifecycle: [] }; throw error })
  expect(native.effects).toEqual([]); expect(native.lifecycle.filter((event: { name: string }) => event.name === 'stop')).toEqual([])
  await f.assertBytes('valid-entry', { rpcOriginalOwner: true, sourceCliSameOwner: true, originalSessionAndNativeHandle: true, nativeInputEffects: native.effects.length, nativeStopCalls: native.lifecycle.filter((event: { name: string }) => event.name === 'stop').length })
})

it('refused actual Host Store argv preserves arbitrary large inherited output and an independent writer', async () => {
  const f = await fixture(), host = await f.start(false), ended = await host.exited
  expect(ended.code).not.toBe(0); expect(ended.signal).toBeNull()
  await expect(access(f.socket)).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await readFile(f.log, 'utf8')).includes('The Host Store argument and original namespace do not agree.')).toBe(true)
  await f.writerPhase('after-host-exit')
  await f.assertBytes('refused-store-argv', { refusedOriginalMismatch: true, noEndpointOpened: true })
})
