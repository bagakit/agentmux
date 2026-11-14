import { spawnClaudeNativeInputProducer } from './helpers/claude-native-input-producer.js'
import { once } from 'node:events'
import { chmod, mkdtemp, readFile, realpath, rename, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { prepareClaudeNativeInput } from '../src/providers/claude-native-input.js'
import { createClaudeProvider } from '../src/providers/claude.js'
import { defineAgentProvider } from '../src/agent-provider.js'
import * as native from '../src/agent-native-process.js'
import * as runner from '../src/process-runner.js'

const boundary = vi.hoisted(() => ({ helper: '' }))
vi.mock('node:child_process', async original => {
  const actual = await original<typeof import('node:child_process')>()
  return { ...actual, spawn: ((command: string, args: readonly string[], options: import('node:child_process').SpawnOptions) =>
    actual.spawn(command.endsWith('/native-socket-peer-darwin') && boundary.helper ? boundary.helper : command, args, options)) as typeof actual.spawn }
})

let helperRoot = ''
beforeAll(async () => {
  if (process.platform !== 'darwin') return
  helperRoot = await mkdtemp(join(tmpdir(), 'amux-claude-peer-'))
  boundary.helper = join(helperRoot, 'peer')
  expect(await runner.runProcess('cc', ['-Wall', '-Wextra', '-Werror',
    fileURLToPath(new URL('../native/native-socket-peer.c', import.meta.url)), '-lproc', '-o', boundary.helper], { timeoutMs: 10_000 }))
    .toMatchObject({ exitCode: 0, stderr: '' })
})
afterAll(async () => { if (helperRoot) await rm(helperRoot, { recursive: true, force: true }) })
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanups.splice(0).reverse()) await close() })

/** An independent socket/file producer, not a mock of Provider admission. It speaks the native
 * auth/user frames and records their exact fields; the real CLI producer is qualified separately. */
async function fixture(openTranscript = true, extraEndpoints = 0) {
  const root = await realpath(await mkdtemp('/tmp/amux-ci-')), id = 'original-main', path = join(root, 'in.sock')
  const sourcePath = join(root, 'config', 'projects', 'project', `${id}.jsonl`)
  const child = spawnClaudeNativeInputProducer({ root, id, socketPath: path, sourcePath, keepOpen: openTranscript, extraEndpoints })
  const frames: Record<string, any>[] = []
  child.on('message', value => { if (value && typeof value === 'object' && 'frame' in value) frames.push((value as { frame: Record<string, any> }).frame) })
  const [ready] = await once(child, 'message') as [{ ready: boolean; key: string }]
  expect(ready.ready).toBe(true)
  cleanups.push(async () => {
    if (child.exitCode === null && child.signalCode === null) { const ended = once(child, 'exit'); child.disconnect(); await ended }
    await rm(root, { recursive: true, force: true })
  })
  const actual = runner.runProcess
  vi.spyOn(runner, 'runProcess').mockImplementation((command, args, options) =>
    actual(command.endsWith('/native-socket-peer-darwin') ? boundary.helper : command, args, options))
  const context = { processId: child.pid!, workspacePath: root, signal: AbortSignal.timeout(15_000),
    nativeHandle: { kind: 'provider' as const, providerId: 'claude', sessionId: id, transcriptPath: sourcePath } }
  const target = { providerId: 'claude', nativeSessionId: id }
  return { root, context, target, frames, keyPath: ready.key, sourcePath, child, socketPath: path, registryPath: join(root, 'config', 'sessions', `${child.pid}.json`) }
}

it('declares manual interaction-safe native input without promising an idle queue', () => {
  const provider = createClaudeProvider(defineAgentProvider)
  expect(provider.prepareNativeInput).toBe(prepareClaudeNativeInput)
  expect(provider.catalog.capabilities.nativeConversationInput).toEqual({ managedRuns: true, interactionQueue: true, idleQueue: false })
})

it.each([{ idleOnly: true as const }, { expectedTurnId: 'turn' }, { providerId: 'other' }])('rejects unsupported target %j before observing or touching a socket', async extra => {
  const observe = vi.spyOn(native, 'nativeProcessBirth').mockRejectedValue(new Error('No IO authorized'))
  await expect(prepareClaudeNativeInput({ processId: 1, workspacePath: '/private', signal: new AbortController().signal },
    { providerId: 'claude', nativeSessionId: 'source', ...extra })).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect(observe).not.toHaveBeenCalled()
})

it.runIf(process.platform === 'darwin')('writes exact target and opaque original correlation once, leaves no-ACK unknown, and accepts a fresh operation', async () => {
  const f = await fixture()
  for (const correlation of ['amux-input-v1.Original_BASE64', 'amux-input-v1.Next_BASE64']) {
    // A selected native identity need not have retained a locator; its live exact writer
    // supplies that fact. An existing locator, when supplied, must still agree.
    const { transcriptPath: _path, ...handle } = f.context.nativeHandle
    const prepared = await prepareClaudeNativeInput(correlation.includes('Next') ? { ...f.context, nativeHandle: handle } : f.context, f.target)
    try {
      expect(prepared.plan).toMatchObject({ operation: 'start-or-steer', interactionQueue: true, threadId: f.target.nativeSessionId })
      await expect(prepared.send('exact private prompt\n第二行', { ...prepared.plan, clientCorrelation: correlation })).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    } finally { await prepared.dispose() }
  }
  await vi.waitFor(() => expect(f.frames).toHaveLength(4))
  const secret = JSON.parse(await readFile(f.keyPath, 'utf8')).peerToken
  expect(f.frames.filter(frame => frame.type === 'auth')).toEqual([{ type: 'auth', token: secret }, { type: 'auth', token: secret }])
  expect(f.frames.filter(frame => frame.type === 'user')).toEqual(['amux-input-v1.Original_BASE64', 'amux-input-v1.Next_BASE64'].map(uuid => ({
    type: 'user', session_id: f.target.nativeSessionId, uuid, priority: 'next', message: { role: 'user', content: 'exact private prompt\n第二行' }
  })))
  expect(f.child.exitCode).toBeNull()
})

it.runIf(process.platform === 'darwin')('refuses a replaced original key before sending even when its token agrees', async () => {
  const f = await fixture(), prepared = await prepareClaudeNativeInput(f.context, f.target)
  const path = f.keyPath, contents = await readFile(path)
  await rename(path, path + '.original'); await writeFile(path, contents, { mode: 0o600 })
  try {
    await expect(prepared.send('never sent', { ...prepared.plan, clientCorrelation: 'amux-input-v1.private' })).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
    expect(f.frames).toHaveLength(0); expect(f.child.exitCode).toBeNull()
  } finally { await prepared.dispose() }
})

it.runIf(process.platform === 'darwin')('checks the connected descriptor before disclosing either credential or prompt', async () => {
  const f = await fixture(), prepared = await prepareClaudeNativeInput(f.context, f.target)
  const peer = vi.spyOn(native, 'nativeUnixSocketPeerBirth').mockResolvedValue('another kernel process')
  try {
    await expect(prepared.send('never disclosed', { ...prepared.plan, clientCorrelation: 'amux-input-v1.private' })).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
    expect(peer).toHaveBeenCalledOnce(); expect(f.frames).toHaveLength(0)
  } finally { await prepared.dispose() }
})

it.runIf(process.platform === 'darwin')('reads the actual connected OS peer and refuses another expected PID without sending bytes', async () => {
  const f = await fixture(), socket = createConnection(f.socketPath)
  try {
    await once(socket, 'connect')
    expect(await native.nativeProcessUnixSockets(f.child.pid!, f.context.signal)).toContain(f.socketPath)
    const original = await native.nativeProcessBirth(f.child.pid!, f.context.signal)
    expect(await native.nativeUnixSocketPeerBirth(socket, f.child.pid!, f.context.signal)).toBe(original)
    await expect(native.nativeUnixSocketPeerBirth(socket, process.pid, f.context.signal)).rejects.toMatchObject({ code: 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE' })
    expect(f.frames).toHaveLength(0)
  } finally { socket.destroy() }
})

it.runIf(process.platform === 'darwin')('uses the native actor registry when Claude closes its transcript descriptor during a permission menu', async () => {
  const f = await fixture(false), prepared = await prepareClaudeNativeInput(f.context, f.target)
  try {
    expect((await native.nativeProcessFiles(f.child.pid!, f.context.signal)).filter(value => value.path === f.sourcePath)).toEqual([])
    await expect(prepared.send('closed descriptor remains healthy', { ...prepared.plan, clientCorrelation: 'amux-input-v1.closed' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    await vi.waitFor(() => expect(f.frames.filter(value => value.type === 'user')).toHaveLength(1))
  } finally { await prepared.dispose() }
})

it.runIf(process.platform === 'darwin').each(['pid', 'sessionId', 'messagingSocketPath', 'procStart'] as const)('refuses changed native registry %s without trusting its display status', async field => {
  const f = await fixture(false), prepared = await prepareClaudeNativeInput(f.context, f.target)
  const row = JSON.parse(await readFile(f.registryPath, 'utf8'))
  row[field] = field === 'pid' ? f.child.pid! + 1 : 'another original actor'
  await writeFile(f.registryPath, JSON.stringify(row))
  try {
    await expect(prepared.send('never disclosed', { ...prepared.plan, clientCorrelation: 'amux-input-v1.registry' })).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
    expect(f.frames).toHaveLength(0)
  } finally { await prepared.dispose() }
})

it.runIf(process.platform === 'darwin')('keeps the same native actor available when only mutable registry status changes', async () => {
  const f = await fixture(false), prepared = await prepareClaudeNativeInput(f.context, f.target)
  const row = JSON.parse(await readFile(f.registryPath, 'utf8'))
  await writeFile(f.registryPath, JSON.stringify({ ...row, status: 'busy', updatedAt: Date.now() }))
  try {
    await expect(prepared.send('status does not revoke a queue', { ...prepared.plan, clientCorrelation: 'amux-input-v1.status' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    await vi.waitFor(() => expect(f.frames.filter(value => value.type === 'user')).toHaveLength(1))
  } finally { await prepared.dispose() }
})

it.runIf(process.platform === 'darwin').each(['missing', 'large', 'rotated', 'unreadable'] as const)('keeps a registry-qualified actor writable when its known transcript becomes %s', async change => {
  const f = await fixture(false)
  if (change === 'missing') await unlink(f.sourcePath)
  else if (change === 'large') await writeFile(f.sourcePath, 'x'.repeat(128 * 1024))
  else if (change === 'rotated') { await rename(f.sourcePath, f.sourcePath + '.original'); await writeFile(f.sourcePath, 'new log generation') }
  else await chmod(f.sourcePath, 0)
  const prepared = await prepareClaudeNativeInput(f.context, f.target)
  try {
    await expect(prepared.send('the native actor still owns this target', { ...prepared.plan, clientCorrelation: 'amux-input-v1.log' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    await vi.waitFor(() => expect(f.frames.filter(value => value.type === 'user')).toHaveLength(1))
    expect(f.frames.find(value => value.type === 'user')?.session_id).toBe(f.target.nativeSessionId)
  } finally { await prepared.dispose() }
})

it.runIf(process.platform === 'darwin')('rejects a relative native locator rather than selecting config files through cwd', async () => {
  const f = await fixture(false)
  await expect(prepareClaudeNativeInput({ ...f.context, nativeHandle: { ...f.context.nativeHandle, transcriptPath: 'projects/project/original-main.jsonl' } }, f.target)).rejects.toMatchObject({ code: 'AGENT_NATIVE_INPUT_UNAVAILABLE' })
  expect(f.frames).toHaveLength(0)
})

it.runIf(process.platform === 'darwin')('uses the exact registered inbox with more than sixteen unrelated named tool sockets', async () => {
  const f = await fixture(false, 20), prepared = await prepareClaudeNativeInput(f.context, f.target)
  try {
    expect((await native.nativeProcessUnixSockets(f.child.pid!, f.context.signal)).length).toBeGreaterThan(16)
    await expect(prepared.send('only the native inbox receives this', { ...prepared.plan, clientCorrelation: 'amux-input-v1.tools' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    await vi.waitFor(() => expect(f.frames.filter(value => value.type === 'user')).toHaveLength(1))
  } finally { await prepared.dispose() }
})

it.runIf(process.platform === 'darwin')('retains the exact native actor when an unrelated same-group process has a damaged registry', async () => {
  const f = await fixture(false), ready = once(f.child, 'message')
  f.child.send('start unrelated socket owner')
  const [reply] = await ready as [{ unrelatedPid: number }]
  expect((await native.nativeProcessUnixSocketOwners(f.child.pid!, f.context.signal, 'run-group')).some(value => value.processId === reply.unrelatedPid)).toBe(true)
  const prepared = await prepareClaudeNativeInput(f.context, f.target)
  try {
    await expect(prepared.send('the identified native actor stays available', { ...prepared.plan, clientCorrelation: 'amux-input-v1.unrelated' })).rejects.toMatchObject({ code: 'AGENT_PROMPT_INPUT_UNCONFIRMED' })
    await vi.waitFor(() => expect(f.frames.filter(value => value.type === 'user')).toHaveLength(1))
  } finally { await prepared.dispose() }
})
