import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JSONRPCClient } from 'json-rpc-2.0'
import { expect, it } from 'vitest'
import { runProcess } from '../src/process-runner.js'
import { nativeProcessFiles } from '../src/agent-native-process.js'
import { discoverAppServerNativeSession } from '../src/providers/app-server-native-session.js'
import { codexMainNativeRecord } from '../src/providers/codex-native-record-role.js'
import { offlineEndpoint } from './helpers/codex-offline-endpoint.js'
import { privateCodexConfigArgs } from './helpers/private-codex-config.js'

/** Actual Codex owns the processes, protocol and writable rollout records.
 * Only the model response boundary is the explicit local deterministic fixture. */
it.runIf(process.platform === 'darwin')('real native main candidates survive another main and expire with their original process', async () => {
  const version = await runProcess('codex', ['--version'], { timeoutMs: 5000 })
  expect(version).toMatchObject({ stdout: 'codex-cli 0.163.0\n', exitCode: 0, stderr: '' })
  const root = await realpath(await mkdtemp(join(tmpdir(), 'amux-native-candidate-proof-'))), home = join(root, 'native-home')
  await mkdir(home)
  const inputs: string[] = [], { endpoint, sockets, requests } = await offlineEndpoint(home, inputs)
  const child = spawn('codex', ['app-server', '--stdio', ...privateCodexConfigArgs], { cwd: root,
    env: { PATH: process.env.PATH, HOME: root, CODEX_HOME: home, TMPDIR: root },
    detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
  const wire: unknown[] = [], events: any[] = [], phases: unknown[] = []
  let carry = '', diagnostic = '', ended = false, passed = false, failure: unknown
  const client = new JSONRPCClient(value => new Promise<void>((resolve, reject) => {
    wire.push({ direction: 'request', value })
    child.stdin.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve())
  }))
  const closed = new Promise<void>(resolve => child.once('close', () => { ended = true; client.rejectAllPendingRequests('Private native proof ended'); resolve() }))
  const stop = async () => {
    if (ended) return
    child.stdin.end()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([closed, new Promise<void>(resolve => { timer = setTimeout(resolve, 1500) })]); clearTimeout(timer)
    if (!ended && child.pid) { process.kill(-child.pid, 'SIGTERM'); await closed }
  }
  child.stderr.on('data', bytes => { diagnostic += bytes.toString() })
  child.stdout.on('data', bytes => {
    carry += bytes.toString()
    for (let newline; (newline = carry.indexOf('\n')) >= 0;) {
      const line = carry.slice(0, newline); carry = carry.slice(newline + 1)
      if (!line.trim()) continue
      const value = JSON.parse(line); wire.push({ direction: 'response', value })
      if (value.method) events.push(value); else client.receive(value)
    }
  })
  const call = (method: string, params: Record<string, unknown>) => client.timeout(10_000).request(method, params) as Promise<any>
  const context = { processId: child.pid!, command: 'codex', args: ['app-server', '--stdio', ...privateCodexConfigArgs], env: {}, workspacePath: root, signal: AbortSignal.timeout(45_000) }
  const discover = () => discoverAppServerNativeSession(context, 'codex', codexMainNativeRecord)
  const recordPhase = async (name: string) => {
    const discovered = await discover()
    const candidates = discovered?.candidates ?? (discovered?.handle ? [discovered] : [])
    phases.push({ name, candidates: candidates.map(value => ({ handle: value.handle, childSessionIds: value.childSessionIds })), files: await nativeProcessFiles(child.pid!, context.signal) })
    return candidates
  }
  try {
    await call('initialize', { clientInfo: { name: 'agentmux_native_candidates_proof', version: '1' }, capabilities: { experimentalApi: true } })
    client.notify('initialized', {}, undefined)
    const create = async (label: string) => {
      const started = await call('thread/start', { cwd: root, threadSource: 'user', modelProvider: 'private_queue', model: 'private-queue', approvalPolicy: 'never', sandbox: 'read-only', ephemeral: false })
      const id = started.thread.id
      expect(typeof id).toBe('string')
      const turn = await call('turn/start', { threadId: id, input: [{ type: 'text', text: 'PRIVATE_QUEUE_CANDIDATE_' + label }] })
      await expect.poll(() => events.some(event => event.method === 'turn/completed' && event.params.turn.id === turn.turn.id), { timeout: 10_000 }).toBe(true)
      const read = await call('thread/read', { threadId: id, includeTurns: false })
      expect(read.thread).toMatchObject({ id, canAcceptDirectInput: true, status: { type: 'idle' } })
      const first = JSON.parse((await readFile(read.thread.path, 'utf8')).split('\n')[0]!)
      expect(first).toMatchObject({ type: 'session_meta', payload: { id, thread_source: 'user' } })
      expect(codexMainNativeRecord(first.payload)).toBe(true)
      return { id, path: read.thread.path }
    }
    const a = await create('A'), b = await create('B')
    expect(a.id).not.toBe(b.id)
    const both = await recordPhase('two-native-main-candidates')
    expect(both.map(value => value.handle.sessionId).sort()).toEqual([a.id, b.id].sort())
    const chosen = both.find(value => value.handle.sessionId === a.id)!
    if (!chosen.assertPresent) throw new Error('The original native candidate lacks membership verification')
    await chosen.assertPresent()
    const c = await create('C')
    expect(c.id).not.toBe(a.id)
    expect((await recordPhase('another-main-created')).map(value => value.handle.sessionId).sort()).toEqual([a.id, b.id, c.id].sort())
    await chosen.assertPresent()
    await stop()
    await expect(chosen.assertPresent()).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
    expect(inputs).toEqual(['PRIVATE_QUEUE_CANDIDATE_A', 'PRIVATE_QUEUE_CANDIDATE_B', 'PRIVATE_QUEUE_CANDIDATE_C'])
    expect(ended).toBe(true)
    passed = true
  } catch (error) { failure = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error; throw error }
  finally {
    await stop()
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => endpoint.close(() => resolve()))
    const evidence = process.env.AGENTMUX_NATIVE_CANDIDATE_PROOF
    if (evidence) {
      await mkdir(evidence, { recursive: true })
      const names = ['packages/core/src/providers/app-server-native-session.ts', 'packages/core/src/providers/codex-native-record-role.ts', 'packages/core/src/agent-native-process.ts', 'packages/core/test/codex-native-candidates-native.test.ts', 'packages/core/test/helpers/codex-offline-endpoint.ts']
      const sources = Object.fromEntries(await Promise.all(names.map(async name => [name, createHash('sha256').update(await readFile(name)).digest('hex')])))
      await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ passed, failure, version, boundary: 'actual native app-server and OS files; deterministic loopback model only; plugin startup disabled; no user actor or credentials', sources, wire, phases, inputs, modelRequests: requests, diagnostic, cleanup: { exited: ended } }, (_, value) => typeof value === 'bigint' ? String(value) : value, 2) + '\n')
    }
    expect(ended).toBe(true)
    await rm(root, { recursive: true })
  }
}, 60_000)
