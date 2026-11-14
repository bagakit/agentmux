import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { createConnection, type Socket } from 'node:net'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { AgentMuxError } from '../errors.js'
import type { AgentProvider } from '../agent-provider.js'
import { nativeProcessBirth, nativeProcessUnixSocketOwners, nativeUnixSocketPeerBirth } from '../agent-native-process.js'
import { normalizeNativeTranscriptPath } from '../agent-native-locator.js'
import { nativeInputSourceId } from '../native-input-correlation.js'
import { runProcess } from '../process-runner.js'
import { locateClaudeNativeSessions } from './claude-native-sources.js'

const PROTOCOL_ID = 'claude-uds-user-v1'
const unavailable = () => new AgentMuxError('The exact native conversation input source is unconfirmed. The Agent, original permission request and terminal remain available.', 'AGENT_NATIVE_INPUT_UNAVAILABLE')
const unknown = () => new AgentMuxError('The native conversation input was sent, but its adoption is unconfirmed. The original input is retained and will not be replayed.', 'AGENT_PROMPT_INPUT_UNCONFIRMED')
const identity = (value: BigIntStats) => [value.dev, value.ino, value.mode, value.uid, value.size, value.mtimeNs, value.ctimeNs].join(':')

/** Native grammar from an exact Provider locator, never from cwd or a default HOME. */
function configRoot(path: string, id: string): string {
  const normalized = normalizeNativeTranscriptPath(path)
  if (!normalized || !isAbsolute(normalized)) throw unavailable()
  const canonical = resolve(normalized), project = dirname(canonical), projects = dirname(project)
  if (basename(projects) !== 'projects' || basename(canonical) !== `${id}.jsonl` || !basename(project)) throw unavailable()
  return dirname(projects)
}

/** Registry/key reads stay on one owned file object. Status updates may replace a registry file;
 * the caller compares native actor bindings, rather than freezing its mutable status or mtime. */
async function readOwnedRecord(path: string, maximum: number, secret = false): Promise<{ identity: string; value: Record<string, unknown> }> {
  const input = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await input.stat({ bigint: true })
    if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || (before.mode & (secret ? 0o077n : 0o022n)) !== 0n || before.size > maximum) throw unavailable()
    const bytes = Buffer.alloc(maximum), { bytesRead } = await input.read(bytes, 0, bytes.length, 0)
    let value: unknown
    try { value = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')) } catch { throw unavailable() }
    if (!value || typeof value !== 'object' || Array.isArray(value) || bytesRead !== Number(before.size) ||
        identity(await input.stat({ bigint: true })) !== identity(before) || identity(await lstat(path, { bigint: true })) !== identity(before)) throw unavailable()
    return { identity: identity(before), value: value as Record<string, unknown> }
  } finally { await input.close() }
}

async function socketIdentity(path: string): Promise<string> {
  const value = await lstat(path, { bigint: true })
  if (!value.isSocket() || value.uid !== BigInt(process.getuid!()) || (value.mode & 0o077n) !== 0n) throw unavailable()
  return identity(value)
}

async function readKey(path: string): Promise<{ identity: string; token: string; procStart: string }> {
  const { identity, value: record } = await readOwnedRecord(path, 4096, true)
  if (typeof record.peerToken !== 'string' || !/^[0-9a-f]{32}$/u.test(record.peerToken) ||
      typeof record.procStart !== 'string' || !record.procStart || record.procStartFt !== undefined ||
      record.pidDomain !== undefined && typeof record.pidDomain !== 'string') throw unavailable()
  return { identity, token: record.peerToken, procStart: record.procStart }
}

async function registryBinding(path: string, pid: number, sessionId: string): Promise<{ socket: string; procStart: string } | undefined> {
  const { value } = await readOwnedRecord(path, 256 * 1024)
  if (value.pid !== pid || value.sessionId !== sessionId) return
  if (typeof value.messagingSocketPath !== 'string' || !isAbsolute(value.messagingSocketPath) ||
      typeof value.procStart !== 'string' || !value.procStart || value.procStartFt !== undefined) throw unavailable()
  return { socket: value.messagingSocketPath, procStart: value.procStart }
}

/** Claude's existing native inbox queues manual input independently of terminal permission menus.
 * Its auth token proves our client to Claude; the connected descriptor's OS peer proves the target.
 * A successful socket write is not native adoption and deliberately has no invented enqueue ACK. */
export const prepareClaudeNativeInput: NonNullable<AgentProvider['prepareNativeInput']> = async (context, target) => {
  // This wire has no exact-turn steer or atomic idle-only operation. Refuse before any IO.
  if (process.platform !== 'darwin' || target.providerId !== 'claude' || target.idleOnly || target.expectedTurnId !== undefined) throw unavailable()
  const { processId, signal } = context
  signal.throwIfAborted()
  const runBirth = await nativeProcessBirth(processId, signal), handle = context.nativeHandle
  if (handle && (handle.kind !== 'provider' || handle.providerId !== 'claude' || handle.sessionId !== target.nativeSessionId)) throw unavailable()
  let path = handle?.kind === 'provider' ? handle.transcriptPath : undefined
  if (!path) {
    const records = await locateClaudeNativeSessions(context)
    if (records.length !== 1 || records[0]!.id !== target.nativeSessionId) throw unavailable()
    path = records[0]!.file.path
  }
  const root = configRoot(path, target.nativeSessionId)
  const endpoints = await nativeProcessUnixSocketOwners(processId, signal, 'run-group')
  const owners = new Map<number, Set<string>>()
  for (const value of endpoints) {
    const paths = owners.get(value.processId) ?? new Set<string>()
    paths.add(value.path); owners.set(value.processId, paths)
  }
  const candidates: Array<{ processId: number; path: string; socket: string; registryPath: string; keyPath: string; key: Awaited<ReturnType<typeof readKey>> }> = []
  for (const [pid, paths] of owners) {
    const registryPath = join(root, 'sessions', `${pid}.json`)
    let registry: Awaited<ReturnType<typeof registryBinding>>
    try { registry = await registryBinding(registryPath, pid, target.nativeSessionId) }
    catch { signal.throwIfAborted(); continue }
    if (!registry || !paths.has(registry.socket)) continue
    const keyPath = join(root, 'sessions', `${pid}.${createHash('sha256').update(resolve(registry.socket)).digest('hex')}.key`)
    try {
      const key = await readKey(keyPath)
      if (key.procStart !== registry.procStart) throw unavailable()
      candidates.push({ processId: pid, path: registry.socket, registryPath, keyPath, key, socket: await socketIdentity(registry.socket) })
    } catch { signal.throwIfAborted(); throw unavailable() }
  }
  if (candidates.length !== 1) throw unavailable()
  const endpoint = candidates[0]!, actorBirth = await nativeProcessBirth(endpoint.processId, signal)
  // Native registry/key use this exact encoding; kernel birth remains the lifetime fence.
  const start = await runProcess('ps', ['-o', 'lstart=', '-p', String(endpoint.processId)],
    { signal, env: { LC_ALL: 'C', TZ: 'UTC' }, timeoutMs: 2_000, maxOutputBytes: 4096 })
  if (start.exitCode !== 0 || start.stderr || start.stdout.trim() !== endpoint.key.procStart) throw unavailable()
  const assertFiles = async () => {
    signal.throwIfAborted()
    const registry = await registryBinding(endpoint.registryPath, endpoint.processId, target.nativeSessionId)
    if (registry?.socket !== endpoint.path || registry.procStart !== endpoint.key.procStart ||
        await socketIdentity(endpoint.path) !== endpoint.socket || (await readKey(endpoint.keyPath)).identity !== endpoint.key.identity) throw unavailable()
  }
  let disposed = false, socket: Socket | undefined
  const assertCurrent = async () => {
    signal.throwIfAborted()
    if (disposed || await nativeProcessBirth(processId, signal) !== runBirth || await nativeProcessBirth(endpoint.processId, signal) !== actorBirth) throw unavailable()
    if (!(await nativeProcessUnixSocketOwners(processId, signal, 'run-group')).some(value => value.processId === endpoint.processId && value.path === endpoint.path)) throw unavailable()
    await assertFiles()
  }
  await assertCurrent()
  const plan = { kind: 'native-rpc' as const, protocolId: PROTOCOL_ID, sourceId: nativeInputSourceId(target),
    actorId: createHash('sha256').update(JSON.stringify([actorBirth, endpoint.path, endpoint.socket])).digest('hex'),
    threadId: target.nativeSessionId, operation: 'start-or-steer' as const, interactionQueue: true as const }
  return { plan, assertCurrent, dispose() { disposed = true; socket?.destroy() },
    async send(prompt, frozen) {
      if (frozen.protocolId !== plan.protocolId || frozen.sourceId !== plan.sourceId || frozen.actorId !== plan.actorId ||
          frozen.threadId !== plan.threadId || frozen.operation !== plan.operation || frozen.expectedTurnId !== undefined ||
          frozen.interactionQueue !== true || !frozen.clientCorrelation) throw unavailable()
      await assertCurrent()
      try {
        socket = createConnection({ path: endpoint.path, signal })
        socket.setTimeout(2_000, () => socket?.destroy(unavailable()))
        await new Promise<void>((accept, reject) => { socket!.once('connect', accept); socket!.once('error', reject); socket!.once('close', () => reject(unavailable())) })
        if (await nativeUnixSocketPeerBirth(socket, endpoint.processId, signal) !== actorBirth) throw unavailable()
        await assertFiles()
        const payload = JSON.stringify({ type: 'auth', token: endpoint.key.token }) + '\n' + JSON.stringify({ type: 'user',
          session_id: frozen.threadId, uuid: frozen.clientCorrelation, priority: 'next', message: { role: 'user', content: prompt } }) + '\n'
        await new Promise<void>((accept, reject) => { socket!.once('error', reject); socket!.once('close', () => reject(unavailable())); socket!.end(payload, accept) })
        // No ACK exists for normal inbox enqueue. Core keeps this exact frozen claim as unknown,
        // releases its lane, and may later adopt only this UUID's original consumer record.
        throw unknown()
      } finally { socket?.destroy(); socket = undefined }
    } }
}
