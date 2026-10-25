import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { activateRuntime, defineRun } from '@ctxmux/sdk'
import { expect, it, vi } from 'vitest'
import { AgentMuxClient } from '../src/client.js'
import { AgentMuxMemoryAgentSessionStore } from '../src/agent-session-store.js'
import type { CtxmuxRunAdapter } from '../src/ctxmux-run-adapter.js'
import type { AgentMuxStoredAgentSession } from '../src/types.js'

async function observe<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 2000
  let value = await read()
  while (!ready(value) && Date.now() < deadline) { await delay(5); value = await read() }
  return value
}

it('public Core dispatch reaches native before the earlier ACK and keeps only unfinished input', async () => {
  const binary = process.env.AGENTMUX_TEST_INPUT_DAEMON ?? fileURLToPath(new URL(
    `../vendor/ctxmux/${process.platform}-${process.arch}/bin/ctxmuxd`, import.meta.url))
  const evidence = process.env.AGENTMUX_TEST_INPUT_EVIDENCE
  const root = await mkdtemp(join(tmpdir(), 'amux-input-channel-'))
  for (const key of Object.keys(process.env)) if (/^(AGENTMUX_|CTXMUX_)/u.test(key)) vi.stubEnv(key, undefined)
  const socketPath = join(root, 'r.sock'), proxyPath = join(root, 'ctxmux.sock'), stateDir = join(root, 'state')
  vi.stubEnv('AGENTMUX_RUNTIME_DIRECTORY', root)
  vi.stubEnv('AGENTMUX_STATE_DIRECTORY', stateDir)
  vi.stubEnv('AGENTMUX_MESSAGE_QUEUE_PATH', join(root, 'messages.ndjson'))
  const sockets = new Set<Socket>(), held: Array<{ socket: Socket; line: string }> = []
  const requests: string[] = []
  let automatic = false
  const server = createServer(socket => {
    const upstream = createConnection(socketPath); sockets.add(socket); sockets.add(upstream)
    socket.on('error', () => {}); upstream.on('error', () => {})
    let input = '', output = ''
    socket.on('data', part => {
      input += String(part)
      while (input.includes('\n')) {
        const end = input.indexOf('\n'), line = input.slice(0, end + 1); input = input.slice(end + 1)
        const frame = JSON.parse(line); requests.push(frame.type === 'request' ? frame.request.type : frame.type); upstream.write(line)
      }
    })
    upstream.on('data', part => {
      output += String(part)
      while (output.includes('\n')) {
        const end = output.indexOf('\n'), line = output.slice(0, end + 1); output = output.slice(end + 1)
        if (JSON.parse(line).type === 'command_result' && !automatic) held.push({ socket, line })
        else socket.write(line)
      }
    })
    upstream.on('end', () => socket.end()); socket.on('close', () => upstream.destroy())
  })
  const coreClients: AgentMuxClient[] = []
  await mkdir(join(stateDir, 'ctxmux'), { recursive: true, mode: 0o700 })
  const activation = await activateRuntime({ executable: binary, socketPath, stateDir: join(stateDir, 'ctxmux'), timeoutMs: 5000,
    env: { AGENTMUX_AGENT_SESSION_ID: undefined, AGENTMUX_AGENT_CAPABILITY: undefined },
    childDisposition: { mode: 'detached', stdout: 'ignore', stderr: 'pipe' } }).catch(async error => {
      vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true })
      throw new Error(String(error) + ': ' + String(error.stderr), { cause: error })
    })
  try {
    server.listen(proxyPath); await once(server, 'listening')
    const native = activation.client
    const run = await native.start(defineRun('/bin/sh', { args: ['-c', 'stty raw -echo; printf READY; exec cat'], cwd: root }))
    const read = async () => {
      const view = await native.attach(run.id)
      const data = Buffer.concat(view.snapshot.replay.chunks.map(chunk => Buffer.from(chunk.data))).toString()
      await view.detach(); return data
    }
    expect(await observe(read, text => text === 'READY')).toBe('READY')
    async function client(id: string, workspacePath = root) {
      const store = new AgentMuxMemoryAgentSessionStore()
      const session: AgentMuxStoredAgentSession = { kind: 'agent', agentSessionId: id, providerId: 'claude', executorId: 'claude',
        hostId: 'local', workspacePath, run: { runId: run.id }, retiredRuns: [], hookBindingId: id + '-hook', hookToken: id + '-token', createdAt: 1, updatedAt: 2 }
      await store.compareAndSwap(null, session)
      const core = new AgentMuxClient({ store }); coreClients.push(core); await core.connectRuntime()
      return { core, session, write: (data: string) => core.writeAgent({ agentSessionId: id, expectedRun: session.run, source: 'user', data }) }
    }
    const wrong = await client('wrong-cold', join(root, 'wrong-cwd'))
    await expect(wrong.write('wrong')).rejects.toMatchObject({ code: 'AGENT_SESSION_RUN_MISMATCH' })
    expect((await native.status(run.id)).applied_input_bytes).toBe(0)
    await wrong.core.dispose()
    const h = await client('original-cold')
    const inner = h.core as unknown as { kernel: CtxmuxRunAdapter; agentInputLanes: Map<string, { pending: Set<Promise<void>> }> }
    const status = vi.spyOn(inner.kernel, 'status')
    const reports = Array.from({ length: 134 }, (_, index) => String.fromCharCode(65 + index % 26))
    let firstSettled = false
    const pending = reports.map((report, index) => {
      const promise = h.write(report)
      if (index === 0) void promise.then(() => { firstSettled = true }, () => {})
      void promise.catch(() => {})
      return promise
    })
    const before = await observe(() => native.status(run.id), value => value.applied_input_bytes === 64)
    const beforeFirstSettled = firstSettled
    const first = held.shift()
    if (first) first.socket.write(first.line)
    const afterOne = await observe(() => native.status(run.id), value => value.applied_input_bytes === 65)
    // Flush after taking the pre-release facts even for the inverse candidate.
    automatic = true
    for (const frame of held.splice(0)) frame.socket.write(frame.line)
    const receipts = await Promise.all(pending)
    expect(before.applied_input_bytes, 'Actual Native must accept later writes before the first ACK').toBe(64)
    expect(beforeFirstSettled).toBe(false)
    expect(afterOne.applied_input_bytes).toBe(65)
    expect(receipts.map(ack => ack.appliedByteRange)).toEqual(reports.map((_, index) => ({ startByte: index, endByte: index + 1 })))
    expect(await read()).toBe('READY' + reports.join(''))
    expect(status).not.toHaveBeenCalled()
    expect(requests.filter(type => type === 'open_input')).toHaveLength(2) // one wrong, one valid cold connection
    await observe(async () => inner.agentInputLanes.size, size => size === 0)
    expect(inner.agentInputLanes.size).toBe(0)
    // A slow original receipt must not retain completed later transactions.
    automatic = false
    const slow = h.write('x'); void slow.catch(() => {})
    await observe(async () => held.length, count => count === 1)
    const delayed = held.shift()!
    automatic = true
    await Promise.all(Array.from({ length: 16 }, () => h.write('y')))
    const pendingOnly = inner.agentInputLanes.get(h.session.agentSessionId)?.pending.size
    delayed.socket.write(delayed.line); await slow
    expect(pendingOnly).toBe(1)
    if (evidence) await writeFile(evidence, JSON.stringify({ daemonSHA256: createHash('sha256').update(await readFile(binary)).digest('hex'),
      runtime: await native.runtimeInfo(), beforeAck: before.applied_input_bytes, afterOne: afterOne.applied_input_bytes,
      reports: reports.length, statusReads: status.mock.calls.length, pendingOnly, receipts, inputOpenings: requests.filter(type => type === 'open_input').length }, null, 2))
    status.mockRestore()
  } finally {
    automatic = true; for (const frame of held.splice(0)) frame.socket.write(frame.line)
    await Promise.all(coreClients.map(core => core.dispose()))
    for (const socket of sockets) socket.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    for (const run of await activation.client.list()) {
      if (run.state.type === 'running') await activation.client.stop(await activation.client.prepareStop(run.id))
      await activation.client.remove(run.id)
    }
    await activation.shutdown(); await activation.dispose()
    vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true })
  }
}, 20_000)
