import type { ExecutionHost } from '@agentmux/core'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, readdir, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { WorkspaceRecord } from '../shared/contracts.js'
import type { FileBuildKind, FileBuildRequest, FileBuildSnapshot } from '../shared/file-build.js'
import { WORKSPACE_FILE_MAX_BYTES } from '../shared/workspace-file-bytes.js'
import type { WorkspaceFiles } from './workspace-files.js'

const BUILD_LOG_MAX_BYTES = 1024 * 1024
const TERMINATE_GRACE_MS = 1000

type Job = {
  workspace: WorkspaceRecord
  snapshot: FileBuildSnapshot
  cancelled: boolean
  invalidated: boolean
  process?: ChildProcessWithoutNullStreams
  done: Promise<void>
  stop?: () => void
}

type FileBuildOptions = {
  commands?: Partial<Record<FileBuildKind, string>>
  env?: NodeJS.ProcessEnv
}

/** Explicit, local document jobs. A job owns its process group, logs and private artifacts. */
export class FileBuilds {
  private readonly jobs = new Map<string, Job>()
  private readonly pending = new Set<Promise<void>>()
  private disposed = false

  constructor(
    private readonly hostFor: (id: string) => ExecutionHost,
    private readonly currentWorkspace: (id: string) => WorkspaceRecord | undefined,
    private readonly files: Pick<WorkspaceFiles, 'localPathForSystemOpen'>,
    private readonly options: FileBuildOptions = {}
  ) {}

  start(workspace: WorkspaceRecord, request: FileBuildRequest): FileBuildSnapshot {
    if (this.disposed) throw new Error('Document builds have closed.')
    if (!request.id || this.jobs.has(request.id)) throw new Error('A build requires a new job id.')
    if (!['latex', 'typst'].includes(request.kind)) throw new Error('Unknown document compiler.')
    if (request.resource.hostId !== workspace.hostId || request.resource.path !== workspace.path) throw new Error('The original File Workspace changed. Retry build.')
    const host = this.hostFor(workspace.hostId)
    const job: Job = {
      workspace: { ...workspace }, cancelled: false, invalidated: false,
      snapshot: { id: request.id, kind: request.kind, workspaceId: workspace.id, path: request.path, status: 'running', log: '', message: null },
      done: Promise.resolve()
    }
    this.jobs.set(request.id, job)
    if (host.kind !== 'local') {
      job.snapshot.status = 'unavailable'
      job.snapshot.message = 'Document builds are unavailable on this remote Host. No local compiler was started.'
    } else {
      job.done = this.run(job, request)
      this.pending.add(job.done)
      void job.done.finally(() => this.pending.delete(job.done))
    }
    return this.copy(job)
  }

  inspect(id: string): FileBuildSnapshot | undefined {
    const job = this.jobs.get(id)
    if (!job) return undefined
    if (!this.current(job)) { job.invalidated = true; delete job.snapshot.pdf; job.snapshot.message = 'The original File Workspace changed. Retry build.'; if (job.snapshot.status === 'running') job.stop?.(); else job.snapshot.status = 'failed' }
    return this.copy(job)
  }

  /** The config owner calls this on a real Host/root mutation, including A → B → A. */
  invalidateWorkspace(workspaceId: string): void {
    for (const job of this.jobs.values()) {
      if (job.workspace.id === workspaceId) {
        job.invalidated = true
        delete job.snapshot.pdf
        job.snapshot.message = 'The original File Workspace changed. Retry build.'
        if (job.snapshot.status === 'running') job.stop?.()
        else job.snapshot.status = 'failed'
      }
    }
  }

  async cancel(id: string): Promise<FileBuildSnapshot | undefined> {
    const job = this.jobs.get(id)
    if (!job) return undefined
    if (job.snapshot.status === 'running') { job.cancelled = true; job.stop?.(); await job.done }
    return this.jobs.get(id) === job ? this.copy(job) : undefined
  }

  async release(id: string): Promise<void> {
    const job = this.jobs.get(id)
    if (!job) return
    this.jobs.delete(id)
    job.cancelled = true
    job.stop?.()
    await job.done
  }

  async releaseAll(): Promise<void> {
    await Promise.all([...this.jobs.keys()].map(id => this.release(id)))
    await Promise.all(this.pending)
  }

  async dispose(): Promise<void> {
    this.disposed = true
    await this.releaseAll()
  }

  private copy(job: Job): FileBuildSnapshot {
    const { pdf, ...snapshot } = job.snapshot
    return { ...snapshot, ...(snapshot.status === 'succeeded' && pdf ? { pdf: new Uint8Array(pdf) } : {}) }
  }

  private current(job: Job): boolean {
    const workspace = this.currentWorkspace(job.workspace.id)
    return !job.invalidated && workspace?.hostId === job.workspace.hostId && workspace.path === job.workspace.path
  }

  private check(job: Job): void {
    if (job.cancelled || this.disposed) throw new Error('Document build was cancelled.')
    if (!this.current(job)) { job.invalidated = true; throw new Error('The original File Workspace changed. Retry build.') }
  }

  private async run(job: Job, request: FileBuildRequest): Promise<void> {
    let directory: string | undefined
    let succeeded = false
    try {
      this.check(job)
      if (Buffer.byteLength(request.content) > WORKSPACE_FILE_MAX_BYTES) throw new Error('This draft exceeds the 16 MiB document transfer budget. Source was kept.')
      const source = await this.files.localPathForSystemOpen(job.workspace, request.path)
      this.check(job)
      if (!(await stat(source)).isFile()) throw new Error('The build source must be a regular Workspace file.')
      directory = await mkdtemp(join(tmpdir(), 'agentmux-file-build-'))
      this.check(job)
      const command = this.options.commands?.[request.kind] ?? (request.kind === 'latex' ? 'tectonic' : 'typst')
      const output = join(directory, request.kind === 'latex' ? 'texput.pdf' : 'output.pdf')
      const input = request.kind === 'typst' ? await this.typstOverlay(job, source, directory, request.content) : '-'
      this.check(job)
      const args = request.kind === 'latex'
        ? ['-X', 'compile', '--only-cached', '--untrusted', '--outdir', directory, '--print', '-']
        : ['compile', '--root', join(directory, 'workspace'), input, output]
      const result = await this.compile(job, command, args, dirname(source), request.kind === 'latex' ? request.content : '')
      this.check(job)
      if (result !== 0) throw new Error(`The ${request.kind === 'latex' ? 'Tectonic' : 'Typst'} compiler exited with status ${result}. See the build log.`)
      const artifact = await open(output, constants.O_RDONLY | constants.O_NOFOLLOW)
      try {
        const info = await artifact.stat()
        if (!info.isFile() || info.size > WORKSPACE_FILE_MAX_BYTES) throw new Error('The build PDF exceeds the 16 MiB preview budget or is not a regular file.')
        const bytes = await artifact.readFile()
        if (bytes.byteLength !== info.size || bytes.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('The compiler did not produce a valid PDF artifact.')
        this.check(job)
        job.snapshot.pdf = bytes
        succeeded = true
      } finally { await artifact.close() }
    } catch (error) {
      delete job.snapshot.pdf
      job.snapshot.status = job.invalidated ? 'failed' : job.cancelled || this.disposed ? 'cancelled' : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'unavailable' : 'failed'
      job.snapshot.message = job.invalidated ? 'The original File Workspace changed. Retry build.' : error instanceof Error ? error.message : String(error)
    } finally {
      if (directory) {
        try { await rm(directory, { recursive: true, force: true }) }
        catch (error) { job.snapshot.status = 'unknown'; job.snapshot.message = `Build ended, but temporary artifact cleanup failed: ${String(error)}`; delete job.snapshot.pdf }
      }
      if (succeeded && job.snapshot.status === 'running') {
        if (job.cancelled || this.disposed || !this.current(job)) {
          delete job.snapshot.pdf
          job.snapshot.status = job.cancelled || this.disposed ? 'cancelled' : 'failed'
          job.snapshot.message = job.snapshot.status === 'cancelled' ? 'Document build was cancelled.' : 'The original File Workspace changed. Retry build.'
        } else job.snapshot.status = 'succeeded'
      }
    }
  }

  /** Only the source ancestor chain is expanded; all other entries refer to the original Host. */
  private async typstOverlay(job: Job, source: string, directory: string, content: string): Promise<string> {
    const root = await realpath(job.workspace.path)
    const path = relative(root, source)
    if (!path || path.startsWith(`..${sep}`) || path === '..') throw new Error('The Typst source leaves its original Workspace.')
    const parts = path.split(sep)
    let original = root, overlay = join(directory, 'workspace')
    for (let depth = 0; depth < parts.length; depth++) {
      this.check(job)
      await mkdir(overlay)
      for (const entry of await readdir(original)) {
        this.check(job)
        if (entry !== parts[depth]) await symlink(join(original, entry), join(overlay, entry))
      }
      original = join(original, parts[depth]!)
      overlay = join(overlay, parts[depth]!)
    }
    this.check(job)
    await writeFile(overlay, content, { flag: 'wx', mode: 0o600 })
    return overlay
  }

  private compile(job: Job, command: string, args: string[], cwd: string, content: string): Promise<number> {
    this.check(job)
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env: { ...process.env, ...this.options.env, TECTONIC_UNTRUSTED_MODE: '1' }, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
      job.process = child
      let failure: Error | undefined, bytes = 0, timer: NodeJS.Timeout | undefined
      const out = new StringDecoder('utf8'), err = new StringDecoder('utf8')
      const signal = (name: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, name)
          else child.kill(name)
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= error as Error }
      }
      job.stop = () => {
        signal('SIGTERM')
        timer ??= setTimeout(() => signal('SIGKILL'), TERMINATE_GRACE_MS)
      }
      const append = (decoder: StringDecoder, chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > BUILD_LOG_MAX_BYTES) { failure ??= new Error('The compiler exceeded the 1 MiB live log budget. Source was kept.'); job.stop?.(); return }
        job.snapshot.log += decoder.write(chunk)
      }
      child.stdout.on('data', (chunk: Buffer) => append(out, chunk))
      child.stderr.on('data', (chunk: Buffer) => append(err, chunk))
      child.stdin.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'EPIPE') failure ??= error })
      child.once('error', error => { failure = error })
      child.once('close', code => {
        if (timer) clearTimeout(timer)
        // A cancelled parent may exit before a descendant; finish the exact owned group too.
        if (job.cancelled || job.invalidated || failure || this.disposed) signal('SIGKILL')
        delete job.process; delete job.stop
        job.snapshot.log += out.end() + err.end()
        if (failure) reject(failure)
        else resolve(code ?? 1)
      })
      child.stdin.end(content)
      if (job.cancelled || job.invalidated || this.disposed) job.stop()
    })
  }
}
