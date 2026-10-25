import { linuxNativeProcessFiles } from './agent-native-process-linux.js'
import { runProcess } from './process-runner.js'
import { AgentMuxError } from './errors.js'
import { normalizeNativeTranscriptPath } from './agent-native-locator.js'
import { fileURLToPath } from 'node:url'

export type NativeProcessFile = {
  processId: number
  processGroup: number
  descriptor: string
  path: string
  device: bigint
  inode: bigint
  access?: 'r' | 'w' | 'u'
}

/** OS-owned listeners in this exact Runtime process group, independent of native logs. */
export async function nativeProcessTcpListeners(processId: number, signal: AbortSignal): Promise<{ processId: number; endpoint: string }[]> {
  signal.throwIfAborted()
  if (!['darwin', 'linux'].includes(process.platform) || !Number.isSafeInteger(processId) || processId <= 0) throw unavailable('The original Run process group is unavailable.')
  const options = { signal, timeoutMs: 2_000, maxOutputBytes: 64 * 1024 }
  const group = await runProcess('ps', ['-p', String(processId), '-o', 'pgid='], options)
  if (group.exitCode !== 0 || group.stderr || group.stdout.trim() !== String(processId)) throw unavailable('The original Run process group changed.')
  const output = await runProcess('lsof', ['-nP', '-a', '-g', String(processId), '-iTCP', '-sTCP:LISTEN', '-F0pgn'], options)
  if (output.exitCode === 1 && !output.stdout && !output.stderr) return []
  if (output.exitCode !== 0 || output.stderr || !output.stdout.endsWith('\0\n')) throw unavailable('The original Run listeners could not be fully observed.')
  const listeners: { processId: number; endpoint: string }[] = []
  let pid = 0, pgid = 0
  for (const part of output.stdout.split('\0')) {
    const field = part.replace(/^\n/u, '')
    if (!field) continue
    if (field[0] === 'p') { pid = Number(field.slice(1)); pgid = 0 }
    else if (field[0] === 'g') pgid = Number(field.slice(1))
    else if (field[0] === 'f' && /^\d+$/u.test(field.slice(1))) { /* lsof's original socket descriptor boundary */ }
    else if (field[0] === 'n') {
      if (pgid !== processId || !Number.isSafeInteger(pid) || pid <= 0) throw unavailable('A listener changed its original Run identity.')
      if (/^127\.0\.0\.1:[1-9]\d*$/u.test(field.slice(1))) listeners.push({ processId: pid, endpoint: `ws://${field.slice(1)}` })
    } else throw unavailable('The original listener observation is incomplete.')
  }
  return listeners
}

function unavailable(message: string): AgentMuxError {
  return new AgentMuxError(message, 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
}

/** OS metadata only. Providers interpret file names and their native records. */
export async function nativeProcessFiles(processId: number, signal: AbortSignal, scope: 'run-group' | 'process' = 'run-group'): Promise<NativeProcessFile[]> {
  signal.throwIfAborted()
  if (!['darwin', 'linux'].includes(process.platform) || !Number.isSafeInteger(processId) || processId <= 0) {
    throw unavailable('Read-only native process discovery is unavailable on this Host.')
  }
  if (process.platform === 'linux') return linuxNativeProcessFiles(processId, signal, scope)
  const options = { signal, timeoutMs: 2_000, maxOutputBytes: 1024 * 1024 }
  const observe = async (command: string, args: string[]) => {
    try { return await runProcess(command, args, options) } catch (error) {
      signal.throwIfAborted()
      throw unavailable(`Read-only ${command} observation is unavailable. Refresh can retry; the Run is kept.`)
    }
  }
  if (scope === 'run-group') {
    const group = await observe('ps', ['-p', String(processId), '-o', 'pgid='])
    if (group.exitCode !== 0 || group.stderr || group.stdout.trim() !== String(processId)) {
      throw unavailable('The original Run process group could not be confirmed. Its input remains available.')
    }
  }
  const output = await observe('lsof', ['-nP', '-a', scope === 'run-group' ? '-g' : '-p', String(processId), '-F0pgftnDia'])
  if (output.exitCode !== 0 || output.stderr || !output.stdout.endsWith('\0\n')) {
    throw unavailable('Open native records could not be fully observed. Refresh can retry; the Run is kept.')
  }
  const files: NativeProcessFile[] = []
  let pid = 0, pgid = 0
  let file: Record<string, string> = {}
  const finish = (): void => {
    if (!Object.keys(file).length) return
    if (file.t === 'REG' && (/^\d+$/u.test(file.f ?? '') || scope === 'process' && file.f === 'txt')) {
      const path = normalizeNativeTranscriptPath(file.n)
      if (!path || !/^\d+$/u.test(file.i ?? '') || !/^(?:0x)?[0-9a-f]+$/iu.test(file.D ?? '') ||
        !Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(pgid) || pgid <= 0 ||
        (scope === 'run-group' ? pgid !== processId : pid !== processId)) {
        throw unavailable('Open-file observation was incomplete; no native identity was inferred.')
      }
      files.push({ processId: pid, processGroup: pgid, descriptor: file.f!, path,
        device: BigInt('0x' + file.D!.replace(/^0x/iu, '')), inode: BigInt(file.i!),
        ...(['r', 'w', 'u'].includes(file.a ?? '') ? { access: file.a as 'r' | 'w' | 'u' } : {}) })
    }
    file = {}
  }
  for (const part of output.stdout.split('\0')) {
    const field = part.replace(/^\n/u, '')
    if (!field) continue
    const key = field[0]!, value = field.slice(1)
    if (key === 'p') { finish(); pid = Number(value); pgid = 0 }
    else if (key === 'g') pgid = Number(value)
    else if (key === 'f') { finish(); file.f = value }
    else if (['t', 'n', 'D', 'i', 'a'].includes(key)) file[key] = value
    else throw unavailable('Open-file observation contained an unsupported field.')
  }
  finish()
  signal.throwIfAborted()
  return files
}

/** Kernel executable identity, joined to this exact process's mapped file object.
 * An argv name, wrapper command or a replaced path cannot identify its binary. */
export async function nativeProcessExecutable(processId: number, signal: AbortSignal): Promise<Pick<NativeProcessFile, 'path' | 'device' | 'inode'>> {
  const birth = await nativeProcessBirth(processId, signal)
  const helper = fileURLToPath(new URL('../dist/native-socket-peer-darwin', import.meta.url))
  const result = await runProcess(helper, ['--process-executable', String(processId)], { signal, timeoutMs: 2_000, maxOutputBytes: 32 * 1024 })
  if (result.exitCode !== 0 || result.stderr) throw unavailable('The original native executable is unconfirmed.')
  let value: unknown
  try { value = JSON.parse(result.stdout) } catch { throw unavailable('The original native executable receipt is incomplete.') }
  const receipt = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  if (receipt.type !== 'native-process-executable' || receipt.schema !== 1 || receipt.pid !== processId || receipt.uid !== process.getuid?.() ||
      typeof receipt.pathHex !== 'string' || !/^(?:[0-9a-f]{2})+$/u.test(receipt.pathHex)) throw unavailable('The executable receipt does not belong to the original process.')
  let path: string
  try { path = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(receipt.pathHex, 'hex')) } catch { throw unavailable('The native executable path is unconfirmed.') }
  if (!path.startsWith('/') || path.includes('\0')) throw unavailable('The native executable path is invalid.')
  const candidates = (await nativeProcessFiles(processId, signal, 'process')).filter(file => file.descriptor === 'txt' && file.path === path)
  const unique = [...new Map(candidates.map(file => [JSON.stringify([file.path, String(file.device), String(file.inode)]), file])).values()]
  if (unique.length !== 1 || await nativeProcessBirth(processId, signal) !== birth) throw unavailable('The original mapped executable changed.')
  const file = unique[0]!
  return { path: file.path, device: file.device, inode: file.inode }
}

/** Ephemeral original process identity; never a persisted Session or Native actor ID.
 * The package-owned libproc helper supplies kernel identity. Clock-tick/date
 * projections cannot establish this identity on other Hosts. */
export async function nativeProcessBirth(processId: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  if (process.platform !== 'darwin' || !Number.isSafeInteger(processId) || processId <= 0) {
    throw unavailable('The original kernel process identity is unconfirmed on this Host. The Agent and saved native identity remain available.')
  }
  // Source and distributed modules share this package-owned build artifact.
  const executable = fileURLToPath(new URL('../dist/native-socket-peer-darwin', import.meta.url))
  const result = await runProcess(executable, ['--process-identity', String(processId)],
    { signal, timeoutMs: 2_000, maxOutputBytes: 4096 })
  signal.throwIfAborted()
  if (result.exitCode !== 0 || result.stderr) throw unavailable('The original kernel process identity is unconfirmed.')
  let value: unknown
  try { value = JSON.parse(result.stdout) } catch { throw unavailable('The kernel process identity receipt is incomplete.') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unavailable('The kernel process identity receipt is incomplete.')
  const identity = value as Record<string, unknown>
  if (identity.type !== 'native-process-identity' || identity.schema !== 1 || identity.pid !== processId ||
      identity.uid !== process.getuid?.() || !Number.isSafeInteger(identity.uid) ||
      typeof identity.startSec !== 'string' || !/^[1-9]\d*$/u.test(identity.startSec) ||
      typeof identity.startUsec !== 'string' || !/^(?:0|[1-9]\d{0,5})$/u.test(identity.startUsec)) {
    throw unavailable('The kernel process identity receipt does not belong to the original process.')
  }
  return JSON.stringify(['darwin', processId, identity.uid, identity.startSec, identity.startUsec])
}
