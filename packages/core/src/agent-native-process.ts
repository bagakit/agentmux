import { runProcess } from './process-runner.js'
import { AgentMuxError } from './errors.js'
import { normalizeNativeTranscriptPath } from './agent-native-locator.js'
import { constants } from 'node:fs'
import { open, mkdtemp, rm, type FileHandle } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

export type NativeProcessFile = {
  processId: number
  processGroup: number
  descriptor: string
  path: string
  device: bigint
  inode: bigint
  access?: 'r' | 'w' | 'u'
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
    if (file.t === 'REG' && /^\d+$/u.test(file.f ?? '')) {
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

/** Read one OS-reported birth without interpreting an executable or arguments. */
export async function nativeProcessBirth(processId: number, signal: AbortSignal): Promise<string> {
  const result = await runProcess('ps', ['-p', String(processId), '-o', 'lstart='],
    { signal, timeoutMs: 2_000, maxOutputBytes: 4096, env: { LC_ALL: 'C' } })
  const birth = result.stdout.trim()
  if (result.exitCode !== 0 || result.stderr || !birth || birth.includes('\n')) throw unavailable('The original process birth is unconfirmed.')
  return birth
}

export type NativeProcessImage = {
  file: FileHandle
  identity: string
  assertCurrent(signal?: AbortSignal): Promise<void>
}

/** Execute only --version from a private, byte-identical copy of the exact mapped image.
 * Darwin does not allow exec of /dev/fd; neither argv nor a PATH replacement can
 * stand in for the actual image. The copy is never used as a conversation writer. */
export async function readNativeProcessVersion(processId: number, signal: AbortSignal): Promise<string> {
  const image = await openNativeProcessImage(processId, signal)
  let directory: string | undefined
  try {
    await image.assertCurrent(signal)
    directory = await mkdtemp(join(tmpdir(), 'agentmux-native-version-'))
    const path = join(directory, 'image'), target = await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o700)
    try {
      const sourceHash = createHash('sha256'), copyHash = createHash('sha256'), bytes = Buffer.alloc(1024 * 1024)
      const size = Number((await image.file.stat({ bigint: true })).size)
      if (!Number.isSafeInteger(size) || size <= 0) throw unavailable('The mapped image size is unconfirmed.')
      for (let position = 0; position < size;) {
        signal.throwIfAborted()
        const read = await image.file.read(bytes, 0, Math.min(bytes.length, size - position), position)
        if (read.bytesRead === 0) throw unavailable('The mapped image ended during version qualification.')
        sourceHash.update(bytes.subarray(0, read.bytesRead))
        for (let written = 0; written < read.bytesRead;) {
          const result = await target.write(bytes, written, read.bytesRead - written, position + written)
          if (!result.bytesWritten) throw unavailable('The private image copy is incomplete.')
          written += result.bytesWritten
        }
        position += read.bytesRead
      }
      await target.chmod(0o500)
      for (let position = 0; position < size;) {
        signal.throwIfAborted()
        const read = await target.read(bytes, 0, Math.min(bytes.length, size - position), position)
        if (!read.bytesRead) throw unavailable('The private image copy is incomplete.')
        copyHash.update(bytes.subarray(0, read.bytesRead)); position += read.bytesRead
      }
      if (sourceHash.digest('hex') !== copyHash.digest('hex') || Number((await target.stat()).size) !== size) throw unavailable('The private mapped-image copy differs.')
      // Release the writable descriptor before exec: Darwin code-signature
      // validation can wait for that writer even though the copy is complete.
      await target.close()
      await image.assertCurrent(signal)
      const probe = await runProcess(path, ['--version'], { signal, timeoutMs: 15_000, maxOutputBytes: 4096,
        env: { HOME: directory, CODEX_HOME: directory, LC_ALL: 'C' } })
      signal.throwIfAborted(); await image.assertCurrent(signal)
      if (probe.exitCode !== 0 || probe.stderr) throw unavailable('The mapped native image version is unconfirmed.')
      return probe.stdout
    } finally { await target.close() }
  } finally { await image.file.close(); if (directory) await rm(directory, { recursive: true, force: true }) }
}

/** Open the exact OS-mapped entry image, not an argv/PATH or launcher guess. */
export async function openNativeProcessImage(processId: number, signal: AbortSignal): Promise<NativeProcessImage> {
  signal.throwIfAborted()
  if (!Number.isSafeInteger(processId) || processId <= 0 || !['darwin', 'linux'].includes(process.platform)) {
    throw unavailable('The current native executable image is unavailable on this Host.')
  }
  const stamp = async (file: FileHandle): Promise<string> => {
    const stat = await file.stat({ bigint: true })
    if (!stat.isFile()) throw unavailable('The current native image is not a regular file.')
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].map(String))
  }
  let file: FileHandle | undefined
  if (process.platform === 'linux') {
    // This is the kernel's executable link. O_NOFOLLOW would reject every Linux
    // process instead of opening its authoritative mapped image, including deleted ones.
    file = await open(`/proc/${processId}/exe`, constants.O_RDONLY)
  } else {
    const result = await runProcess('lsof', ['-nP', '-a', '-p', String(processId), '-d', 'txt', '-F0pftnDi'],
      { signal, timeoutMs: 2_000, maxOutputBytes: 1024 * 1024 })
    if (result.exitCode !== 0 || result.stderr || !result.stdout.endsWith('\0\n')) {
      throw unavailable('The current mapped native image could not be fully observed.')
    }
    let owner = 0, record: Record<string, string> = {}
    const candidates: FileHandle[] = []
    const inspect = async (): Promise<void> => {
      if (record.f !== 'txt' || record.t !== 'REG' || owner !== processId) return
      const path = normalizeNativeTranscriptPath(record.n)
      if (!path || !/^\d+$/u.test(record.i ?? '') || !/^(?:0x)?[0-9a-f]+$/iu.test(record.D ?? '')) {
        throw unavailable('The mapped native image identity is incomplete.')
      }
      let candidate: FileHandle
      try { candidate = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
      catch { return } // Unlinked non-entry mappings (for example SQLite shm) are ordinary.
      let keep = false
      try {
        const stat = await candidate.stat({ bigint: true })
        if (stat.dev !== BigInt('0x' + record.D!.replace(/^0x/iu, '')) || stat.ino !== BigInt(record.i!)) return
        const header = Buffer.alloc(16)
        const read = await candidate.read(header, 0, header.length, 0)
        if (read.bytesRead !== header.length) return
        const fileType = (h: Buffer): number | undefined => {
          const magic = h.readUInt32LE(0)
          return magic === 0xfeedfacf || magic === 0xfeedface ? h.readUInt32LE(12)
            : magic === 0xcffaedfe || magic === 0xcefaedfe ? h.readUInt32BE(12) : undefined
        }
        let executable = fileType(header) === 2
        // Universal Mach-O is one mapped file, with an entry header per slice.
        // Its table is bounded metadata; never read or retain executable bodies.
        const fat = header.readUInt32BE(0), wide = fat === 0xcafebabf || fat === 0xbfbafeca
        if ([0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(fat)) {
          const little = fat === 0xbebafeca || fat === 0xbfbafeca
          const count = little ? header.readUInt32LE(4) : header.readUInt32BE(4), width = wide ? 32 : 20
          if (!count || count * width > 64 * 1024) return
          const table = Buffer.alloc(count * width)
          if ((await candidate.read(table, 0, table.length, 8)).bytesRead !== table.length) return
          executable = true
          for (let n = 0; n < count; n++) {
            const at = n * width + 8
            const offset = wide ? (little ? table.readBigUInt64LE(at) : table.readBigUInt64BE(at))
              : BigInt(little ? table.readUInt32LE(at) : table.readUInt32BE(at))
            if (offset > stat.size - 16n || offset > BigInt(Number.MAX_SAFE_INTEGER)) { executable = false; break }
            const slice = Buffer.alloc(16)
            if ((await candidate.read(slice, 0, slice.length, Number(offset))).bytesRead !== slice.length || fileType(slice) !== 2) { executable = false; break }
          }
        }
        if (!executable) return // MH_EXECUTE; dyld and libraries are not entry images.
        candidates.push(candidate); keep = true
      } finally { if (!keep) await candidate.close() }
    }
    try {
      for (const part of result.stdout.split('\0')) {
        const field = part.replace(/^\n/u, '')
        if (!field) continue
        const key = field[0]!, value = field.slice(1)
        if (key === 'p') { await inspect(); record = {}; owner = Number(value) }
        else if (key === 'f') { await inspect(); record = { f: value } }
        else if (['t', 'n', 'D', 'i'].includes(key)) record[key] = value
        else throw unavailable('The mapped native image observation contained an unsupported field.')
      }
      await inspect()
      if (candidates.length !== 1) throw unavailable('No single current native entry image was confirmed.')
      file = candidates.pop()!
    } finally { await Promise.all(candidates.map(candidate => candidate.close())) }
  }
  try {
    const identity = await stamp(file)
    signal.throwIfAborted()
    return { file, identity, async assertCurrent(currentSignal = signal) {
      const current = await openNativeProcessImage(processId, currentSignal)
      try {
        if (current.identity !== identity || await stamp(file!) !== identity) {
          throw unavailable('The mapped native executable changed during its version observation.')
        }
      } finally { await current.file.close() }
    } }
  } catch (error) { await file.close(); throw error }
}
