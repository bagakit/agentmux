import { open, readFile, readdir, readlink, stat, type FileHandle } from 'node:fs/promises'
import { AgentMuxError } from './errors.js'
import { normalizeNativeTranscriptPath } from './agent-native-locator.js'
import { runProcess } from './process-runner.js'
import type { NativeProcessFile } from './agent-native-process.js'

const unavailable = (message: string) => new AgentMuxError(message, 'AGENT_SESSION_HISTORY_IDENTITY_UNAVAILABLE')
function processStat(value: string, pid: number): { group: number; start: string } {
  // comm may itself contain spaces, newlines and closing parentheses.
  const end = value.lastIndexOf(') '), fields = value.slice(end + 2).trim().split(/\s+/u)
  if (!value.startsWith(`${pid} (`) || end < 0 || fields.length < 20 || !/^[A-Za-z]$/u.test(fields[0]!) ||
      !/^[1-9]\d*$/u.test(fields[2]!) || !/^\d+$/u.test(fields[19]!)) throw unavailable('The original Linux process stat is incomplete.')
  const group = Number(fields[2])
  if (!Number.isSafeInteger(group)) throw unavailable('The original Linux process group is unconfirmed.')
  return { group, start: fields[19]! }
}
function descriptorInfo(value: string): { inode: bigint; flags: bigint } {
  const inode = [...value.matchAll(/^ino:\s*(\d+)$/gmu)], flags = [...value.matchAll(/^flags:\s*([0-7]+)$/gmu)]
  if (inode.length !== 1 || flags.length !== 1) throw unavailable('The original Linux descriptor metadata is incomplete.')
  return { inode: BigInt(inode[0]![1]!), flags: BigInt('0o' + flags[0]![1]!) }
}
const sameList = (left: string[], right: string[]) => left.length === right.length && left.every((value, index) => value === right[index])
async function descriptors(directory: string): Promise<string[]> {
  const values = await readdir(directory + '/fd')
  if (values.some(value => !/^(?:0|[1-9]\d*)$/u.test(value))) throw unavailable('The original Linux descriptor list is incomplete.')
  return values.sort()
}

/** Only target process objects are opened. A pinned proc directory never resolves a reused PID
 * to its replacement: https://docs.kernel.org/filesystems/proc.html#process-specific-subdirectories
 * starttime is a within-observation consistency check, not a durable/native process identity. */
export async function linuxNativeProcessFiles(processId: number, signal: AbortSignal, scope: 'run-group' | 'process'): Promise<NativeProcessFile[]> {
  signal.throwIfAborted()
  const handles: FileHandle[] = []
  try {
    const members = async (): Promise<number[]> => {
      if (scope === 'process') return [processId]
      // procps pgrep selects the exact process group without a command-name pattern.
      const result = await runProcess('pgrep', ['-g', String(processId)], { signal, timeoutMs: 2_000, maxOutputBytes: 1024 * 1024 })
      if (result.exitCode !== 0 || result.stderr || !/^\s*\d+(?:\s+\d+)*\s*$/u.test(result.stdout)) throw unavailable('The original Linux Run group could not be observed.')
      const pids = result.stdout.trim().split(/\s+/u).map(Number).sort((a, b) => a - b)
      if (!pids.includes(processId) || new Set(pids).size !== pids.length || pids.some(pid => !Number.isSafeInteger(pid) || pid <= 0)) throw unavailable('The original Linux Run group is unconfirmed.')
      return pids
    }
    const pin = async (pid: number) => {
      signal.throwIfAborted()
      const handle = await open(`/proc/${pid}`, 'r'); handles.push(handle)
      const object = await handle.stat({ bigint: true }), directory = `/proc/self/fd/${handle.fd}`
      if (!object.isDirectory()) throw unavailable('The original Linux process object is unavailable.')
      const identity = processStat(await readFile(directory + '/stat', { encoding: 'utf8', signal }), pid)
      if (scope === 'run-group' && identity.group !== processId) throw unavailable('A process left the original Linux Run group.')
      return { pid, handle, object, directory, identity }
    }
    // Pin the leader before querying membership: a reused group number must not
    // replace the original group while the selector is running.
    const leader = await pin(processId), pids = await members(), processes = [leader]
    for (const pid of pids) if (pid !== processId) processes.push(await pin(pid))
    const files: NativeProcessFile[] = []
    for (const process of processes) {
      const { pid, directory, identity } = process, before = await descriptors(directory)
      for (const descriptor of [...before, ...(scope === 'process' ? ['txt'] : [])]) {
        signal.throwIfAborted()
        const link = directory + (descriptor === 'txt' ? '/exe' : '/fd/' + descriptor)
        const object = await stat(link, { bigint: true })
        let file: NativeProcessFile | undefined
        if (object.isFile()) {
          const path = await readlink(link), normalized = normalizeNativeTranscriptPath(path)
          if (normalized !== path) throw unavailable('The original Linux file locator is unconfirmed.')
          const info = descriptor === 'txt' ? undefined : descriptorInfo(await readFile(`${directory}/fdinfo/${descriptor}`, { encoding: 'utf8', signal }))
          if (info && (info.inode !== object.ino || (info.flags & 3n) > 2n)) throw unavailable('The original Linux descriptor object changed.')
          file = { processId: pid, processGroup: identity.group, descriptor, path, device: object.dev, inode: object.ino,
            ...(info ? { access: (['r', 'w', 'u'] as const)[Number(info.flags & 3n)]! } : {}) }
          const after = descriptor === 'txt' ? undefined : descriptorInfo(await readFile(`${directory}/fdinfo/${descriptor}`, { encoding: 'utf8', signal }))
          if (await readlink(link) !== path || info && (after!.inode !== info.inode || after!.flags !== info.flags)) throw unavailable('The original Linux descriptor changed while being read.')
        }
        const after = await stat(link, { bigint: true })
        if (after.dev !== object.dev || after.ino !== object.ino || after.isFile() !== object.isFile()) throw unavailable('The original Linux file object changed while being read.')
        if (file) files.push(file)
      }
      if (!sameList(before, await descriptors(directory))) throw unavailable('The original Linux descriptor set changed while being read.')
    }
    if (!sameList(pids.map(String), (await members()).map(String))) throw unavailable('The original Linux Run group membership changed.')
    for (const { pid, handle, object, directory, identity } of processes) {
      const after = processStat(await readFile(directory + '/stat', { encoding: 'utf8', signal }), pid), pinned = await handle.stat({ bigint: true })
      if (after.group !== identity.group || after.start !== identity.start || pinned.dev !== object.dev || pinned.ino !== object.ino) throw unavailable('The original Linux process changed during file observation.')
    }
    signal.throwIfAborted()
    return files
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof AgentMuxError) throw error
    throw unavailable('Open native records on the original Linux process could not be fully observed. Refresh can retry; the Run is kept.')
  } finally { await Promise.allSettled(handles.map(handle => handle.close())) }
}
