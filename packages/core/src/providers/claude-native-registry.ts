import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { nativeProcessBirth } from '../agent-native-process.js'
import { linuxNativeProcessStart } from '../agent-native-process-linux.js'
import { AgentMuxError } from '../errors.js'
import { runProcess } from '../process-runner.js'
import type { AgentProviderNativeSessionDiscoveryContext, AgentProviderNativeSessionWitness } from '../types.js'

const unavailable = (detail: string) => new AgentMuxError(
  `Claude native process registration could not confirm the current conversation: ${detail}. The original Run and input are kept.`,
  'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')

/** Native sessions/PID.json binds sessionId to procStart. Its mutable status/name
 * is not identity. A retained transcript supplies only the exact config location. */
export async function discoverClaudeRegisteredSession(context: AgentProviderNativeSessionDiscoveryContext): Promise<AgentProviderNativeSessionWitness | null> {
  const { nativeHandle: handle, processId, signal } = context
  if (handle?.kind !== 'provider' || handle.providerId !== 'claude' || !handle.transcriptPath ||
      !isAbsolute(handle.transcriptPath) || basename(handle.transcriptPath) !== `${handle.sessionId}.jsonl` ||
      basename(dirname(dirname(handle.transcriptPath))) !== 'projects' || !['linux', 'darwin'].includes(process.platform)) return null
  const registryPath = join(dirname(dirname(dirname(handle.transcriptPath))), 'sessions', `${processId}.json`)
  try { await lstat(registryPath) }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }

  const readBinding = async () => {
    signal.throwIfAborted()
    const input = await open(registryPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await input.stat({ bigint: true })
      // One small native registry record, independent of accumulated conversation history.
      if (!before.isFile() || before.uid !== BigInt(process.getuid!()) || (before.mode & 0o022n) !== 0n || before.size > 256 * 1024) throw unavailable('registration file is not an owned native record')
      const bytes = Buffer.alloc(Number(before.size)), { bytesRead } = await input.read(bytes, 0, bytes.length, 0)
      const after = await input.stat({ bigint: true }), current = await lstat(registryPath, { bigint: true })
      if (bytesRead !== bytes.length || after.ino !== before.ino || after.dev !== before.dev ||
          after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs ||
          current.ino !== before.ino || current.dev !== before.dev) throw unavailable('registration changed during its read; check the source again')
      let value: unknown
      try { value = JSON.parse(bytes.toString('utf8')) } catch { throw unavailable('registration record is incomplete') }
      const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
      if (record.pid !== processId || typeof record.sessionId !== 'string' || !record.sessionId || typeof record.procStart !== 'string' ||
          !record.procStart || record.procStartFt !== undefined) throw unavailable('registered process or conversation differs from the retained target')
      return { sessionId: record.sessionId, start: record.procStart }
    } finally { await input.close() }
  }
  const processStart = async () => {
    if (process.platform === 'linux') {
      const process = await linuxNativeProcessStart(processId, signal)
      return { start: process.startTicks, lifetime: process.lifetime, assertCurrent: process.assertCurrent, dispose: process.dispose }
    }
    const birth = await nativeProcessBirth(processId, signal)
    const start = await runProcess('ps', ['-o', 'lstart=', '-p', String(processId)],
      { signal, env: { LC_ALL: 'C', TZ: 'UTC' }, timeoutMs: 2_000, maxOutputBytes: 4096 })
    if (start.exitCode !== 0 || start.stderr || !start.stdout.trim()) throw unavailable('native process start is unavailable')
    return { start: start.stdout.trim(), lifetime: birth, assertCurrent: async () => {
      if (await nativeProcessBirth(processId, signal) !== birth) throw unavailable('original process lifetime changed')
    }, dispose: async () => {} }
  }
  // Keep only a recheckable value between calls; no process handle or new observation owner leaks.
  const assertBinding = async (expected?: { start: string; lifetime: string }) => {
    const process = await processStart()
    try {
      const registered = await readBinding()
      if (registered.start !== process.start || expected !== undefined &&
          (registered.start !== expected.start || process.lifetime !== expected.lifetime)) throw unavailable('native process start does not match the registration')
      await process.assertCurrent()
      if (registered.sessionId !== handle.sessionId) throw new AgentMuxError(
        'The current Claude process registration confirms a different native conversation. Check the original Session source; its Run and input are kept.',
        'AGENT_NATIVE_IDENTITY_UNCONFIRMED')
      return { start: registered.start, lifetime: process.lifetime }
    } finally { await process.dispose() }
  }
  const start = await assertBinding()
  return { handle: { ...handle }, assertCurrent: async () => { await assertBinding(start) },
    assertPresent: async () => { await assertBinding(start) } }
}
