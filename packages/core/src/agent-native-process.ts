import { linuxNativeProcessEnvironment, linuxNativeProcessFiles } from './agent-native-process-linux.js'
import { runProcess } from './process-runner.js'
import { AgentMuxError } from './errors.js'
import { normalizeNativeTranscriptPath } from './agent-native-locator.js'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { Socket } from 'node:net'
import { isAbsolute } from 'node:path'

/** Named Unix endpoints held by this exact process; a connected peer is checked separately. */
export async function nativeProcessUnixSockets(processId: number, signal: AbortSignal): Promise<string[]> {
  return (await nativeProcessUnixSocketOwners(processId, signal)).map(value => value.path)
}

/** Kernel-observed Unix endpoint owners, bounded to one original process or Runtime group. */
export async function nativeProcessUnixSocketOwners(processId: number, signal: AbortSignal, scope: 'process' | 'run-group' = 'process'): Promise<{ processId: number; path: string }[]> {
  signal.throwIfAborted()
  if (process.platform !== 'darwin' || !Number.isSafeInteger(processId) || processId <= 0) throw unavailable('The original Unix endpoints are unconfirmed on this Host.')
  const options = { signal, timeoutMs: 2_000, maxOutputBytes: 64 * 1024 }
  if (scope === 'run-group') {
    const group = await runProcess('ps', ['-p', String(processId), '-o', 'pgid='], options)
    if (group.exitCode !== 0 || group.stderr || group.stdout.trim() !== String(processId)) throw unavailable('The original Unix endpoint process group changed.')
  }
  const output = await runProcess('lsof', ['-nP', '-a', scope === 'run-group' ? '-g' : '-p', String(processId), '-U', '-F0pgftn'], options)
  if (output.exitCode === 1 && !output.stdout && !output.stderr) return []
  if (output.exitCode !== 0 || output.stderr || !output.stdout.endsWith('\0\n')) throw unavailable('The original Unix endpoints could not be fully observed.')
  let pid = 0, group = 0, file: Record<string, string> = {}
  const paths = new Map<string, { processId: number; path: string }>()
  const finish = () => {
    if (!Object.keys(file).length) return
    if (!Number.isSafeInteger(pid) || pid <= 0 || (scope === 'process' ? pid !== processId : group !== processId) ||
        !/^\d+$/u.test(file.f ?? '') || file.t !== 'unix') throw unavailable('The Unix endpoint observation changed its process identity.')
    if (file.n && isAbsolute(file.n) && !/[\0\r\n]/u.test(file.n)) paths.set(JSON.stringify([pid, file.n]), { processId: pid, path: file.n })
    file = {}
  }
  for (const part of output.stdout.split('\0')) {
    const field = part.replace(/^\n/u, '')
    if (!field) continue
    if (field[0] === 'p') { finish(); pid = Number(field.slice(1)); group = 0 }
    else if (field[0] === 'g') group = Number(field.slice(1))
    else if (field[0] === 'f') { finish(); file.f = field.slice(1) }
    else if (field[0] === 't' || field[0] === 'n') file[field[0]] = field.slice(1)
    else throw unavailable('The Unix endpoint observation is incomplete.')
  }
  finish()
  signal.throwIfAborted()
  return [...paths.values()]
}

/** Inspect this connected descriptor without sending bytes or opening a replacement connection. */
export async function nativeUnixSocketPeerBirth(socket: Socket, processId: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const fd = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd
  if (process.platform !== 'darwin' || !Number.isSafeInteger(fd) || fd! < 0) throw unavailable('The connected native peer is unconfirmed.')
  const executable = fileURLToPath(new URL('../dist/native-socket-peer-darwin', import.meta.url))
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ['--socket-peer'], { stdio: [fd!, 'pipe', 'pipe'], signal, timeout: 2_000, killSignal: 'SIGKILL' })
    const chunks: Buffer[] = []
    let size = 0, invalid = false
    child.stdout!.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 4096) { invalid = true; child.kill('SIGKILL') } else chunks.push(chunk) })
    child.stderr!.on('data', () => { invalid = true })
    child.once('error', () => reject(unavailable('The connected native peer could not be observed.')))
    child.once('close', code => code === 0 && !invalid ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(unavailable('The connected native peer is unconfirmed.')))
  })
  signal.throwIfAborted()
  let value: unknown
  try { value = JSON.parse(output) } catch { throw unavailable('The connected native peer receipt is incomplete.') }
  return processBirthReceipt(value, processId, 'native-socket-peer')
}

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
  return processBirthReceipt(value, processId, 'native-process-identity')
}

function processBirthReceipt(value: unknown, processId: number, type: 'native-process-identity' | 'native-socket-peer' | 'native-process-environment'): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw unavailable('The kernel process identity receipt is incomplete.')
  const identity = value as Record<string, unknown>
  if (identity.type !== type || identity.schema !== 1 || identity.pid !== processId ||
      identity.uid !== process.getuid?.() || !Number.isSafeInteger(identity.uid) ||
      typeof identity.startSec !== 'string' || !/^[1-9]\d*$/u.test(identity.startSec) ||
      typeof identity.startUsec !== 'string' || !/^(?:0|[1-9]\d{0,5})$/u.test(identity.startUsec)) {
    throw unavailable('The kernel process identity receipt does not belong to the original process.')
  }
  return JSON.stringify(['darwin', processId, identity.uid, identity.startSec, identity.startUsec])
}

/** Private launch-environment observation. Never persist, publish or include these bytes in errors. */
export async function nativeProcessEnvironment(processId: number, signal: AbortSignal): Promise<Readonly<Record<string, string>>> {
  signal.throwIfAborted()
  if (!['darwin', 'linux'].includes(process.platform) || !Number.isSafeInteger(processId) || processId <= 0) throw unavailable('The original process environment is unavailable on this Host.')
  try {
    let bytes: Buffer
    if (process.platform === 'linux') bytes = await linuxNativeProcessEnvironment(processId, signal)
    else {
      const birth = await nativeProcessBirth(processId, signal)
      const helper = fileURLToPath(new URL('../dist/native-socket-peer-darwin', import.meta.url))
      // The C reader bounds its allocation and machine receipt by the kernel's KERN_ARGMAX.
      const result = await runProcess(helper, ['--process-environment', String(processId)], { signal, timeoutMs: 2_000 })
      if (result.exitCode !== 0 || result.stderr) throw unavailable('The original process environment is unconfirmed.')
      const receipt: unknown = JSON.parse(result.stdout)
      if (processBirthReceipt(receipt, processId, 'native-process-environment') !== birth) throw unavailable('The original process environment changed its identity.')
      const value = receipt as Record<string, unknown>
      if (Object.keys(value).some(key => !['type', 'schema', 'pid', 'uid', 'startSec', 'startUsec', 'environmentHex'].includes(key)) ||
          typeof value.environmentHex !== 'string' || !/^(?:[0-9a-f]{2})*$/u.test(value.environmentHex) ||
          await nativeProcessBirth(processId, signal) !== birth) throw unavailable('The original process environment receipt is incomplete.')
      bytes = Buffer.from(value.environmentHex, 'hex')
    }
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text && !text.endsWith('\0')) throw unavailable('The original process environment is incomplete.')
    const entries: Array<[string, string]> = [], seen = new Set<string>()
    for (const item of text ? text.slice(0, -1).split('\0') : []) {
      const at = item.indexOf('='), key = item.slice(0, at)
      if (at <= 0 || seen.has(key)) throw unavailable('The original process environment cannot be represented exactly.')
      seen.add(key); entries.push([key, item.slice(at + 1)])
    }
    signal.throwIfAborted()
    return Object.fromEntries(entries)
  } catch {
    signal.throwIfAborted()
    throw unavailable('The original process environment is unconfirmed. The Run and input are kept.')
  }
}
