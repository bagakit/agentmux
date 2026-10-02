import { runProcess } from './process-runner.js'
import { AgentMuxError } from './errors.js'
import { normalizeNativeTranscriptPath } from './agent-native-locator.js'

export type NativeProcessFile = {
  processId: number
  processGroup: number
  descriptor: string
  path: string
  device: bigint
  inode: bigint
}

function unavailable(message: string): AgentMuxError {
  return new AgentMuxError(message, 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
}

/** OS metadata only. Providers interpret file names and their native records. */
export async function nativeProcessFiles(processId: number, signal: AbortSignal): Promise<NativeProcessFile[]> {
  signal.throwIfAborted()
  if (!['darwin', 'linux'].includes(process.platform) || !Number.isSafeInteger(processId) || processId <= 0) {
    throw unavailable('Read-only native process discovery is unavailable on this Host.')
  }
  const options = { signal, timeoutMs: 2_000, maxOutputBytes: 1024 * 1024 }
  const observe = async (command: string, args: string[]) => {
    try { return await runProcess(command, args, options) } catch (error) {
      signal.throwIfAborted()
      throw unavailable(`Read-only ${command} observation is unavailable. Refresh can retry; the Run is kept.`)
    }
  }
  const group = await observe('ps', ['-p', String(processId), '-o', 'pgid='])
  if (group.exitCode !== 0 || group.stderr || group.stdout.trim() !== String(processId)) {
    throw unavailable('The original Run process group could not be confirmed. Its input remains available.')
  }
  const output = await observe('lsof', ['-a', '-g', String(processId), '-F0pgftnDi'])
  if (output.exitCode !== 0 || output.stderr || !output.stdout.endsWith('\0\n')) {
    throw unavailable('Open native records could not be fully observed. Refresh can retry; the Run is kept.')
  }
  const files: NativeProcessFile[] = []
  let pid = 0, pgid = 0
  let file: Record<string, string> = {}
  const finish = (): void => {
    if (!Object.keys(file).length) return
    if (file.t === 'REG' && /^\d+$/u.test(file.f ?? '')) {
      const path = normalizeNativeTranscriptPath(file.n)
      if (!path || !/^\d+$/u.test(file.i ?? '') || !/^(?:0x)?[0-9a-f]+$/iu.test(file.D ?? '') ||
        !Number.isSafeInteger(pid) || pid <= 0 || pgid !== processId) {
        throw unavailable('Open-file observation was incomplete; no native identity was inferred.')
      }
      files.push({ processId: pid, processGroup: pgid, descriptor: file.f!, path,
        device: BigInt('0x' + file.D!.replace(/^0x/iu, '')), inode: BigInt(file.i!) })
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
    else if (['t', 'n', 'D', 'i'].includes(key)) file[key] = value
    else throw unavailable('Open-file observation contained an unsupported field.')
  }
  finish()
  signal.throwIfAborted()
  return files
}
