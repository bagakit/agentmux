import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath, stat } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { ExecutionHost } from '@agentmux/core'
import type {
  CreateWorkspacePathInput,
  MoveWorkspacePathInput,
  WorkspaceDirectoryEntry,
  WorkspaceFileReadResult,
  WorkspaceFileWriteInput,
  WorkspaceFileWriteResult,
  WorkspacePathMoveResult,
  WorkspaceRecord
} from '../shared/contracts.js'

const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'out', '.worktrees'])
const LOCAL_WORKER_READY = 'AGENTMUX_WORKSPACE_READY'
const LOCAL_WORKER_OBSERVING = 'AGENTMUX_WORKSPACE_OBSERVING'
const LOCAL_WORKER_INVALIDATED = 'AGENTMUX_WORKSPACE_INVALIDATED'
const LOCAL_WORKER_ERROR = 'AGENTMUX_WORKSPACE_ERROR:'
const WORKSPACE_MOVE_HELPER = resolve(
  import.meta.dirname,
  '../../resources/bin/agentmux-workspace-move'
)

type LocalWorkerRequest =
  | { action: 'read'; name: string }
  | { action: 'list' }
  | { action: 'reveal'; name: string | null }
  | { action: 'observe'; name: string }
  | {
      action: 'write'
      name: string
      expectedRevision: string | null
      fault?: 'temporary-write' | 'replace'
    }
  | { action: 'create'; name: string; kind: 'file' | 'directory' }
  | { action: 'delete'; name: string }

type LocalExistingPath = {
  root: string
  target: string
}

type LocalMutablePath = {
  root: string
  parent: string
  name: string
}

type LocalObserverEntry = {
  listeners: Set<() => void>
  disposeWorker: () => Promise<void>
}

export type WorkspaceFilesOptions = {
  beforeWrite?: (input: WorkspaceFileWriteInput) => Promise<void>
  localWriteFault?: 'temporary-write' | 'replace' | (() => 'temporary-write' | 'replace' | undefined)
  localMoveHelperPath?: string
  beforeLocalMoveCommit?: () => Promise<void>
  afterLocalMoveCommit?: () => Promise<void>
  onReadDirectoryStart?: (workspace: WorkspaceRecord, requestedPath: string) => void
}

let activeLocalFileObservers = 0

export function workspaceFileObserverCount(): number {
  return activeLocalFileObservers
}

// Node does not expose openat(2), and Darwin's /dev/fd directory handles cannot
// be used as path prefixes. A short Node worker gives each operation a kernel-
// pinned cwd. It validates that physical cwd after spawn, then touches only one
// basename; replacing the original parent path with a symlink cannot redirect
// the operation after that point.
const LOCAL_WORKER_SOURCE = String.raw`
import { createHash, randomBytes } from 'node:crypto'
import { watch } from 'node:fs'
import { constants, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
import { join, sep } from 'node:path'

const request = JSON.parse(process.argv[1] ?? '')
const expectedRoot = process.argv[2]

async function currentDirectory() {
  const cwd = await realpath('.')
  if (cwd !== expectedRoot && !cwd.startsWith(expectedRoot + sep)) {
    throw Object.assign(new Error('Path escapes the workspace root'), { code: 'WORKSPACE_PATH_ESCAPE' })
  }
  return cwd
}

async function inputBytes() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks)
}

async function openRegularFile(name, flags) {
  const handle = await open(name, flags | constants.O_NOFOLLOW)
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Workspace path is not a regular file')
    return handle
  } catch (error) {
    await handle.close()
    throw error
  }
}

function revisionFor(bytes) {
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex')
}

async function currentFile(name) {
  try {
    const handle = await openRegularFile(name, constants.O_RDONLY)
    try {
      const [bytes, info] = await Promise.all([handle.readFile(), handle.stat()])
      return { revision: revisionFor(bytes), mode: info.mode & 0o7777 }
    } finally {
      await handle.close()
    }
  } catch (error) {
    if (error?.code === 'ENOENT') return { revision: null, mode: null }
    throw error
  }
}

try {
  await currentDirectory()
  process.stderr.write('${LOCAL_WORKER_READY}\n')
  const input = await inputBytes()
  const cwd = await currentDirectory()

  if (request.action === 'read') {
    const handle = await openRegularFile(request.name, constants.O_RDONLY)
    try { process.stdout.write(await handle.readFile()) } finally { await handle.close() }
  } else if (request.action === 'list') {
    const entries = await readdir('.', { withFileTypes: true })
    process.stdout.write(JSON.stringify(entries.map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory(),
      isSymlink: entry.isSymbolicLink()
    }))))
  } else if (request.action === 'reveal') {
    if (request.name !== null) {
      const handle = await open(request.name, constants.O_RDONLY | constants.O_NOFOLLOW)
      await handle.close()
    }
    process.stdout.write(request.name === null ? cwd : join(cwd, request.name))
  } else if (request.action === 'observe') {
    const watcher = watch('.', { persistent: true }, (_eventType, filename) => {
      if (filename === request.name) process.stdout.write('${LOCAL_WORKER_INVALIDATED}\n')
    })
    watcher.on('error', (error) => {
      process.stderr.write('${LOCAL_WORKER_ERROR}' + JSON.stringify({
        message: error instanceof Error ? error.message : String(error),
        code: error && typeof error === 'object' && 'code' in error ? error.code : null
      }) + '\n')
      process.exitCode = 1
      watcher.close()
    })
    process.once('SIGTERM', () => {
      watcher.close()
      process.exit(0)
    })
    process.stdout.write('${LOCAL_WORKER_OBSERVING}\n')
  } else if (request.action === 'write') {
    const before = await currentFile(request.name)
    if (before.revision !== request.expectedRevision) {
      process.stdout.write(JSON.stringify({ status: 'conflict', observedRevision: before.revision }))
    } else {
      const temporaryName = '.' + request.name + '.agentmux-' + process.pid + '-' + randomBytes(8).toString('hex')
      let handle = null
      let temporaryExists = false
      try {
        handle = await open(
          temporaryName,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          before.mode ?? 0o666
        )
        temporaryExists = true
        if (before.mode !== null) await handle.chmod(before.mode)
        if (request.fault === 'temporary-write') {
          throw Object.assign(new Error('Injected temporary write failure'), { code: 'INJECTED_TEMPORARY_WRITE' })
        }
        await handle.writeFile(input)
        await handle.sync()
        await handle.close()
        handle = null

        const immediatelyBeforeReplace = await currentFile(request.name)
        if (immediatelyBeforeReplace.revision !== request.expectedRevision) {
          process.stdout.write(JSON.stringify({
            status: 'conflict',
            observedRevision: immediatelyBeforeReplace.revision
          }))
        } else {
          if (request.fault === 'replace') {
            throw Object.assign(new Error('Injected atomic replace failure'), { code: 'INJECTED_REPLACE' })
          }
          await rename(temporaryName, request.name)
          temporaryExists = false
          process.stdout.write(JSON.stringify({ status: 'written', revision: revisionFor(input) }))
        }
      } finally {
        if (handle) await handle.close().catch(() => {})
        if (temporaryExists) await unlink(temporaryName).catch(() => {})
      }
    }
  } else if (request.action === 'create') {
    if (request.kind === 'directory') await mkdir(request.name)
    else {
      const handle = await open(
        request.name,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o666
      )
      await handle.close()
    }
  } else if (request.action === 'delete') {
    await rm(request.name, { recursive: true, force: false })
  } else {
    throw new Error('Unknown local Workspace operation')
  }
} catch (error) {
  process.stderr.write('${LOCAL_WORKER_ERROR}' + JSON.stringify({
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === 'object' && 'code' in error ? error.code : null
  }) + '\n')
  process.exitCode = 1
}
`

function localPathWithin(root: string, requested: string): string {
  const normalizedRoot = resolve(root)
  const target = resolve(normalizedRoot, requested)
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}${sep}`)) {
    throw new Error('Path escapes the workspace root')
  }
  return target
}

function remotePathWithin(root: string, requested: string): string {
  const normalizedRoot = posix.resolve(root)
  const target = posix.resolve(normalizedRoot, requested)
  if (target !== normalizedRoot && !target.startsWith(`${normalizedRoot}/`)) {
    throw new Error('Path escapes the workspace root')
  }
  return target
}

function assertRealPathWithin(root: string, target: string, separator: string): void {
  if (target !== root && !target.startsWith(`${root}${separator}`)) {
    throw new Error('Path escapes the workspace root')
  }
}

function assertMutableRelativePath(requested: string): void {
  if (!requested.trim() || requested === '.' || requested === '/') {
    throw new Error('The workspace root cannot be changed')
  }
}

function assertCanonicalWorkspacePath(requested: string): void {
  assertMutableRelativePath(requested)
  if (requested.startsWith('/') || posix.normalize(requested) !== requested) {
    throw Object.assign(new Error(`Workspace path must be a canonical relative path: ${requested}`), {
      code: 'WORKSPACE_MOVE_INVALID_PATH'
    })
  }
}

function isRelativePathWithin(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`)
}

async function localExistingPathWithin(root: string, requested: string): Promise<LocalExistingPath> {
  const lexicalTarget = localPathWithin(root, requested)
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(lexicalTarget)])
  assertRealPathWithin(realRoot, realTarget, sep)
  return { root: realRoot, target: realTarget }
}

// Reveal must survive a deleted target: the file being gone is the most common reason it "won't
// open", and a second error would answer nothing. Walk up to the nearest ancestor that still exists
// inside the workspace so the caller can reveal the folder the file used to live in. Every candidate
// is realpath-confined, so an intermediate symlink escaping the root still throws rather than reveals.
export async function localExistingAncestorWithin(root: string, requested: string): Promise<LocalExistingPath> {
  const realRoot = await realpath(root)
  let lexicalTarget = localPathWithin(root, requested)
  for (;;) {
    try {
      const realTarget = await realpath(lexicalTarget)
      assertRealPathWithin(realRoot, realTarget, sep)
      return { root: realRoot, target: realTarget }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error
      const parent = dirname(lexicalTarget)
      if (parent === lexicalTarget) throw error
      lexicalTarget = parent
    }
  }
}

async function localMutablePathWithin(root: string, requested: string): Promise<LocalMutablePath> {
  assertMutableRelativePath(requested)
  const lexicalTarget = localPathWithin(root, requested)
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(lexicalTarget))])
  assertRealPathWithin(realRoot, realParent, sep)
  return { root: realRoot, parent: realParent, name: basename(lexicalTarget) }
}

async function runLocalWorker(
  cwd: string,
  root: string,
  request: LocalWorkerRequest,
  input?: string
): Promise<Buffer> {
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete environment.NODE_OPTIONS
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    LOCAL_WORKER_SOURCE,
    JSON.stringify(request),
    root
  ], {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const stdout: Buffer[] = []
  let stderr = ''
  let inputSent = false
  child.stdout.on('data', (chunk: Buffer) => stdout.push(Buffer.from(chunk)))
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk
    if (!inputSent && stderr.split('\n').includes(LOCAL_WORKER_READY)) {
      inputSent = true
      child.stdin.end(input ?? '')
    }
  })

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  if (result.code === 0) return Buffer.concat(stdout)
  const record = stderr.split('\n').find((line) => line.startsWith(LOCAL_WORKER_ERROR))
  if (record) {
    const detail = JSON.parse(record.slice(LOCAL_WORKER_ERROR.length)) as {
      message: string
      code: string | null
    }
    throw Object.assign(new Error(detail.message), detail.code ? { code: detail.code } : {})
  }
  throw new Error(
    `Local Workspace operation failed${result.signal ? ` with ${result.signal}` : ` with exit ${result.code}`}`
  )
}

type AtomicMoveError = Error & {
  code: string
  definitelyUnchanged: boolean
}

function atomicMoveErrorCode(errno: number): string {
  if (errno === 2) return 'WORKSPACE_MOVE_PATH_NOT_FOUND'
  if (errno === 17) return 'WORKSPACE_MOVE_DESTINATION_EXISTS'
  if (errno === 18) return 'WORKSPACE_MOVE_CROSS_DEVICE'
  if (errno === 22) return 'WORKSPACE_MOVE_INVALID_PATH'
  if (errno === 62) return 'WORKSPACE_PATH_ESCAPE'
  return `WORKSPACE_MOVE_ERRNO_${errno}`
}

async function runAtomicLocalMove(
  helperPath: string,
  root: string,
  rootDevice: bigint,
  rootInode: bigint,
  sourcePath: string,
  destinationPath: string,
  beforeCommit?: () => Promise<void>,
  afterCommit?: () => Promise<void>
): Promise<void> {
  const child = spawn(helperPath, [
    root,
    rootDevice.toString(),
    rootInode.toString(),
    sourcePath,
    destinationPath,
    ...(beforeCommit ? ['--before-commit-barrier'] : []),
    ...(afterCommit ? ['--after-commit-barrier'] : [])
  ], {
    stdio: [
      'ignore',
      'ignore',
      'pipe',
      beforeCommit ? 'pipe' : 'ignore',
      beforeCommit ? 'pipe' : 'ignore',
      afterCommit ? 'pipe' : 'ignore',
      afterCommit ? 'pipe' : 'ignore'
    ]
  })
  const errorOutput = child.stdio[2] as Readable
  let stderr = ''
  errorOutput.setEncoding('utf8')
  errorOutput.on('data', (chunk: string) => { stderr += chunk })
  let beforeBarrierError: unknown
  if (beforeCommit) {
    const ready = child.stdio[3] as Readable
    const release = child.stdio[4] as Writable
    release.on('error', () => {})
    ready.once('data', () => {
      void beforeCommit().then(
        () => release.end('G'),
        (error) => {
          beforeBarrierError = error
          child.kill('SIGTERM')
        }
      )
    })
  }
  let afterBarrierError: unknown
  if (afterCommit) {
    const committed = child.stdio.at(5) as Readable
    const release = child.stdio.at(6) as Writable
    release.on('error', () => {})
    committed.once('data', () => {
      void afterCommit().then(
        () => release.end('G'),
        (error) => {
          afterBarrierError = error
          child.kill('SIGTERM')
        }
      )
    })
  }

  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveResult, reject) => {
    child.once('error', (error) => reject(Object.assign(error, {
      code: 'WORKSPACE_MOVE_HELPER_UNAVAILABLE',
      definitelyUnchanged: true
    } satisfies Pick<AtomicMoveError, 'code' | 'definitelyUnchanged'>)))
    child.once('close', (code, signal) => resolveResult({ code, signal }))
  })
  if (beforeBarrierError) {
    throw Object.assign(
      beforeBarrierError instanceof Error ? beforeBarrierError : new Error(String(beforeBarrierError)),
      { code: 'WORKSPACE_MOVE_COMMIT_HOOK_FAILED', definitelyUnchanged: true }
    ) satisfies AtomicMoveError
  }
  if (afterBarrierError) {
    throw Object.assign(
      afterBarrierError instanceof Error ? afterBarrierError : new Error(String(afterBarrierError)),
      { code: 'WORKSPACE_MOVE_RESULT_UNKNOWN', definitelyUnchanged: false }
    ) satisfies AtomicMoveError
  }
  if (result.code === 0) return
  const errno = Number(stderr.match(/errno=(\d+)/)?.[1])
  if (Number.isInteger(errno)) {
    const operation = stderr.match(/operation=([^\s]+)/)?.[1]
    throw Object.assign(
      new Error(stderr.match(/message=([^\n]+)/)?.[1] ?? `Atomic Workspace move failed with errno ${errno}`),
      {
        code: operation?.startsWith('after-commit-')
          ? 'WORKSPACE_MOVE_RESULT_UNKNOWN'
          : atomicMoveErrorCode(errno),
        definitelyUnchanged: !operation?.startsWith('after-commit-')
      }
    ) satisfies AtomicMoveError
  }
  throw Object.assign(
    new Error(`Atomic Workspace move helper failed${result.signal ? ` with ${result.signal}` : ` with exit ${result.code}`}`),
    { code: 'WORKSPACE_MOVE_RESULT_UNKNOWN', definitelyUnchanged: false }
  ) satisfies AtomicMoveError
}

async function runLocalObserver(
  cwd: string,
  root: string,
  name: string,
  invalidated: () => void
): Promise<() => Promise<void>> {
  const environment: NodeJS.ProcessEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
  delete environment.NODE_OPTIONS
  const child = spawn(process.execPath, [
    '--input-type=module',
    '--eval',
    LOCAL_WORKER_SOURCE,
    JSON.stringify({ action: 'observe', name } satisfies LocalWorkerRequest),
    root
  ], {
    cwd,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  let inputSent = false
  let observing = false
  let settled = false
  let disposed = false
  const closed = new Promise<void>((resolveClosed) => {
    child.once('close', () => resolveClosed())
  })

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      rejectReady(error instanceof Error ? error : new Error(String(error)))
    }
    child.once('error', fail)
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk
      if (!inputSent && stderr.split('\n').includes(LOCAL_WORKER_READY)) {
        inputSent = true
        child.stdin.end()
      }
      const record = stderr.split('\n').find((line) => line.startsWith(LOCAL_WORKER_ERROR))
      if (record) {
        const detail = JSON.parse(record.slice(LOCAL_WORKER_ERROR.length)) as {
          message: string
          code: string | null
        }
        fail(Object.assign(new Error(detail.message), detail.code ? { code: detail.code } : {}))
      }
    })
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk
      const lines = stdout.split('\n')
      stdout = lines.pop() ?? ''
      for (const line of lines) {
        if (line === LOCAL_WORKER_OBSERVING && !settled) {
          observing = true
          settled = true
          activeLocalFileObservers += 1
          resolveReady()
        } else if (line === LOCAL_WORKER_INVALIDATED && observing && !disposed) {
          invalidated()
        }
      }
    })
    child.once('close', (code, signal) => {
      if (observing) {
        observing = false
        activeLocalFileObservers -= 1
      }
      if (!disposed) {
        fail(new Error(
          `Local Workspace observer failed${signal ? ` with ${signal}` : ` with exit ${code}`}`
        ))
      }
    })
  })

  try {
    await ready
  } catch (error) {
    disposed = true
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    await closed
    throw error
  }
  return async () => {
    if (!disposed) {
      disposed = true
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    }
    await closed
  }
}

async function remoteRealPath(host: ExecutionHost, path: string): Promise<string> {
  const result = await host.run('realpath', ['--', path], { timeoutMs: 15_000 })
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `Could not resolve ${basename(path)}`)
  }
  return result.stdout.trim()
}

async function remoteExistingPathWithin(
  host: ExecutionHost,
  root: string,
  requested: string
): Promise<string> {
  const lexicalTarget = remotePathWithin(root, requested)
  const [realRoot, realTarget] = await Promise.all([
    remoteRealPath(host, root),
    remoteRealPath(host, lexicalTarget)
  ])
  assertRealPathWithin(realRoot, realTarget, '/')
  return realTarget
}

async function remoteMutablePathWithin(
  host: ExecutionHost,
  root: string,
  requested: string
): Promise<string> {
  assertMutableRelativePath(requested)
  const lexicalTarget = remotePathWithin(root, requested)
  const [realRoot, realParent] = await Promise.all([
    remoteRealPath(host, root),
    remoteRealPath(host, posix.dirname(lexicalTarget))
  ])
  assertRealPathWithin(realRoot, realParent, '/')
  return posix.join(realParent, posix.basename(lexicalTarget))
}

function relativeEntryPath(parent: string, name: string): string {
  return parent ? posix.join(parent, name) : name
}

function sortDirectoryEntries(entries: WorkspaceDirectoryEntry[]): WorkspaceDirectoryEntry[] {
  return entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  })
}

function revisionFor(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

function resultError(error: unknown): { status: 'error'; code: string; message: string } {
  return {
    status: 'error',
    code: typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'WORKSPACE_FILE_ERROR',
    message: error instanceof Error ? error.message : String(error)
  }
}

function moveError(
  error: unknown,
  finalLocation: 'source' | 'unknown'
): Extract<WorkspacePathMoveResult, { status: 'error' }> {
  const result = resultError(error)
  return { ...result, finalLocation }
}

export class WorkspaceFiles {
  private readonly writeRequestTails = new Map<string, Promise<void>>()
  private readonly writeTails = new Map<string, Promise<void>>()
  private readonly observers = new Map<string, LocalObserverEntry>()
  private readonly observerStarts = new Map<string, Promise<LocalObserverEntry>>()
  private readonly observerDisposals = new Map<LocalObserverEntry, Promise<void>>()
  private disposed = false
  private disposal: Promise<void> | undefined

  constructor(
    private readonly hostFor: (id: string) => ExecutionHost,
    private readonly options: WorkspaceFilesOptions = {}
  ) {}

  private disposeObserver(entry: LocalObserverEntry): Promise<void> {
    let disposal = this.observerDisposals.get(entry)
    if (!disposal) {
      disposal = entry.disposeWorker()
      this.observerDisposals.set(entry, disposal)
      void disposal.finally(() => this.observerDisposals.delete(entry)).catch(() => {})
    }
    return disposal
  }

  private async serializeWrite<T>(
    tails: Map<string, Promise<void>>,
    key: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const previous = tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent
    })
    const tail = previous.catch(() => {}).then(async () => await current)
    tails.set(key, tail)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  }

  async observe(
    workspace: WorkspaceRecord,
    requestedPath: string,
    invalidated: () => void
  ): Promise<() => Promise<void>> {
    if (this.disposed) throw new Error('WorkspaceFiles is disposed')
    const host = this.hostFor(workspace.hostId)
    if (host.kind !== 'local') {
      throw Object.assign(
        new Error('File observation is not available for remote workspaces.'),
        { code: 'REMOTE_WORKSPACE_FILE_OBSERVATION_UNSUPPORTED' }
      )
    }
    const resolved = await localExistingPathWithin(workspace.path, requestedPath)
    if (this.disposed) throw new Error('WorkspaceFiles is disposed')
    const parent = dirname(resolved.target)
    const name = basename(resolved.target)
    const key = `${resolved.root}\0${parent}\0${name}`
    let entry = this.observers.get(key)
    if (!entry) {
      let start = this.observerStarts.get(key)
      if (!start) {
        const listeners = new Set<() => void>()
        start = runLocalObserver(parent, resolved.root, name, () => {
          for (const listener of listeners) listener()
        }).then(async (disposeWorker) => {
          const startedEntry = { listeners, disposeWorker }
          if (this.disposed) {
            await this.disposeObserver(startedEntry)
            throw new Error('WorkspaceFiles is disposed')
          }
          return startedEntry
        })
        this.observerStarts.set(key, start)
      }
      try {
        entry = await start
        if (this.disposed) {
          await this.disposeObserver(entry)
          throw new Error('WorkspaceFiles is disposed')
        }
        this.observers.set(key, entry)
      } finally {
        if (this.observerStarts.get(key) === start) this.observerStarts.delete(key)
      }
    }
    entry.listeners.add(invalidated)
    let disposed = false
    return async () => {
      if (disposed) return
      disposed = true
      entry!.listeners.delete(invalidated)
      if (entry!.listeners.size !== 0 || this.observers.get(key) !== entry) return
      this.observers.delete(key)
      await this.disposeObserver(entry!)
    }
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.disposed = true
      const observers = [...this.observers.values()]
      const starts = [...this.observerStarts.values()]
      this.observers.clear()
      this.observerStarts.clear()
      this.disposal = Promise.allSettled([
        ...this.observerDisposals.values(),
        ...observers.map((entry) => this.disposeObserver(entry)),
        ...starts.map(async (start) => {
          try {
            await this.disposeObserver(await start)
          } catch {
            // Failed starts already close their worker before rejecting.
          }
        })
      ]).then(() => {})
    }
    return this.disposal
  }

  async localPathForReveal(workspace: WorkspaceRecord, requestedPath: string): Promise<string> {
    const host = this.hostFor(workspace.hostId)
    if (host.kind !== 'local') throw new Error('Reveal in file manager is available only for local paths')
    const resolved = await localExistingAncestorWithin(workspace.path, requestedPath || '.')
    if (resolved.target === resolved.root) {
      return (await runLocalWorker(resolved.root, resolved.root, { action: 'reveal', name: null })).toString('utf8')
    }
    return (await runLocalWorker(dirname(resolved.target), resolved.root, {
      action: 'reveal',
      name: basename(resolved.target)
    })).toString('utf8')
  }

  async readDirectory(
    workspace: WorkspaceRecord,
    requestedPath: string
  ): Promise<WorkspaceDirectoryEntry[]> {
    this.options.onReadDirectoryStart?.(workspace, requestedPath)
    const host = this.hostFor(workspace.hostId)
    if (host.kind === 'local') {
      const directory = await localExistingPathWithin(workspace.path, requestedPath || '.')
      const entries = JSON.parse((await runLocalWorker(
        directory.target,
        directory.root,
        { action: 'list' }
      )).toString('utf8')) as Array<{ name: string; isDirectory: boolean; isSymlink: boolean }>
      return sortDirectoryEntries(
        entries.flatMap((entry) => {
          if (IGNORED_NAMES.has(entry.name)) return []
          return [{
            name: entry.name,
            path: relativeEntryPath(requestedPath, entry.name),
            isDirectory: entry.isDirectory,
            isSymlink: entry.isSymlink
          }]
        })
      )
    }

    const directory = await remoteExistingPathWithin(host, workspace.path, requestedPath || '.')
    // Directory-scoped reads keep system-SSH under the same Workspace boundary.
    // Script 是固定源码，目录由 argv 传入；NUL framing 可正确承载空格和换行文件名。
    const script = [
      'for path do',
      'name=${path##*/}',
      'if [ -L "$path" ]; then kind=l',
      'elif [ -d "$path" ]; then kind=d',
      'elif [ -f "$path" ]; then kind=f',
      'else continue',
      'fi',
      "printf '%s\\0%s\\0' \"$name\" \"$kind\"",
      'done'
    ].join('\n')
    const result = await host.run(
      'find',
      [directory, '!', '-path', directory, '-prune', '-exec', 'sh', '-c', script, 'agentmux-list', '{}', '+'],
      { timeoutMs: 15_000, maxOutputBytes: 2 * 1024 * 1024 }
    )
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || 'Remote directory listing failed')
    }
    const fields = result.stdout.split('\0')
    const entries: WorkspaceDirectoryEntry[] = []
    for (let index = 0; index + 1 < fields.length; index += 2) {
      const name = fields[index]
      const kind = fields[index + 1]
      if (!name || !kind || IGNORED_NAMES.has(name)) continue
      entries.push({
        name,
        path: relativeEntryPath(requestedPath, name),
        isDirectory: kind === 'd',
        isSymlink: kind === 'l'
      })
    }
    return sortDirectoryEntries(entries)
  }

  async read(workspace: WorkspaceRecord, requestedPath: string): Promise<WorkspaceFileReadResult> {
    try {
      const host = this.hostFor(workspace.hostId)
      if (host.kind === 'local') {
        const resolved = await localExistingPathWithin(workspace.path, requestedPath)
        // A directory is not a read failure: the caller reveals it in the file tree. Only Main can
        // tell — path detection in the Renderer is pure-string. `resolved.target` is already the
        // root-confined realpath, so this stat classifies exactly the object the worker would open.
        if ((await stat(resolved.target)).isDirectory()) return { status: 'directory' }
        const bytes = await runLocalWorker(dirname(resolved.target), resolved.root, {
          action: 'read',
          name: basename(resolved.target)
        })
        return {
          status: 'read',
          document: {
            path: requestedPath,
            content: bytes.toString('utf8'),
            revision: revisionFor(bytes)
          }
        }
      }
      const path = await remoteExistingPathWithin(host, workspace.path, requestedPath)
      // Ask once: if the target is a directory, exit 3 so the caller can reveal it; otherwise stream
      // it. Folding the classification into the same round-trip avoids a locale-fragile "Is a
      // directory" stderr parse and keeps directory a first-class answer, not a decoded error.
      const result = await host.run(
        'sh',
        ['-c', 'if [ -d "$1" ]; then exit 3; fi; exec cat -- "$1"', 'agentmux-read', path],
        {
          timeoutMs: 15_000,
          maxOutputBytes: 4 * 1024 * 1024
        }
      )
      if (result.exitCode === 3) return { status: 'directory' }
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.trim() || `Could not read ${basename(path)}`)
      }
      const bytes = Buffer.from(result.stdout)
      return {
        status: 'read',
        document: { path: requestedPath, content: result.stdout, revision: revisionFor(bytes) }
      }
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        return { status: 'deleted' }
      }
      return resultError(error)
    }
  }

  async write(
    workspace: WorkspaceRecord,
    input: WorkspaceFileWriteInput
  ): Promise<WorkspaceFileWriteResult> {
    const requestKey = `${workspace.hostId}\0${workspace.path}\0${input.path}`
    return await this.serializeWrite(this.writeRequestTails, requestKey, async () => {
      try {
        const host = this.hostFor(workspace.hostId)
        if (host.kind !== 'local') {
          return {
            status: 'error',
            code: 'REMOTE_WORKSPACE_FILE_WRITE_UNSUPPORTED',
            message: 'Revision-aware atomic save is not available for remote workspaces.'
          }
        }
        const resolved = await localMutablePathWithin(workspace.path, input.path)
        const key = `${resolved.root}\0${resolved.parent}\0${resolved.name}`
        return await this.serializeWrite(this.writeTails, key, async () => {
          try {
            await this.options.beforeWrite?.(input)
            const fault = typeof this.options.localWriteFault === 'function'
              ? this.options.localWriteFault()
              : this.options.localWriteFault
            return JSON.parse((await runLocalWorker(resolved.parent, resolved.root, {
              action: 'write',
              name: resolved.name,
              expectedRevision: input.expectedRevision,
              ...(fault ? { fault } : {})
            }, input.content)).toString('utf8')) as WorkspaceFileWriteResult
          } catch (error) {
            return resultError(error)
          }
        })
      } catch (error) {
        return resultError(error)
      }
    })
  }

  async create(workspace: WorkspaceRecord, input: CreateWorkspacePathInput): Promise<void> {
    const host = this.hostFor(workspace.hostId)
    if (host.kind === 'local') {
      const resolved = await localMutablePathWithin(workspace.path, input.path)
      await runLocalWorker(resolved.parent, resolved.root, {
        action: 'create',
        name: resolved.name,
        kind: input.kind
      })
      return
    }
    const path = await remoteMutablePathWithin(host, workspace.path, input.path)
    const result =
      input.kind === 'directory'
        ? await host.run('mkdir', ['--', path], { timeoutMs: 15_000 })
        : await host.run(
            'sh',
            ['-c', 'umask 077; set -C; : > "$1"', 'agentmux-create', path],
            { timeoutMs: 15_000 }
          )
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Could not create ${basename(path)}`)
    }
  }

  async move(
    sourceWorkspace: WorkspaceRecord,
    destinationWorkspace: WorkspaceRecord,
    input: MoveWorkspacePathInput
  ): Promise<WorkspacePathMoveResult> {
    try {
      if (input.source.workspaceId !== sourceWorkspace.id ||
          input.destination.workspaceId !== destinationWorkspace.id) {
        throw Object.assign(new Error('Workspace move references do not match their resolved owners'), {
          code: 'WORKSPACE_MOVE_OWNER_MISMATCH'
        })
      }
      if (sourceWorkspace.hostId !== destinationWorkspace.hostId) {
        throw Object.assign(new Error('Moving paths between hosts is not supported'), {
          code: 'WORKSPACE_MOVE_CROSS_HOST'
        })
      }
      if (sourceWorkspace.id !== destinationWorkspace.id) {
        throw Object.assign(new Error('Moving paths between workspaces is not supported'), {
          code: 'WORKSPACE_MOVE_CROSS_WORKSPACE'
        })
      }
      assertCanonicalWorkspacePath(input.source.path)
      assertCanonicalWorkspacePath(input.destination.path)
      if (input.source.path === input.destination.path) {
        throw Object.assign(new Error('Move source and destination must be different'), {
          code: 'WORKSPACE_MOVE_SAME_PATH'
        })
      }
      if (isRelativePathWithin(input.destination.path, input.source.path)) {
        throw Object.assign(new Error('A Workspace path cannot be moved into itself'), {
          code: 'WORKSPACE_MOVE_INTO_SELF'
        })
      }

      const host = this.hostFor(sourceWorkspace.hostId)
      if (host.kind === 'local') {
        if (process.platform !== 'darwin') {
          return moveError(
            Object.assign(new Error('Atomic confined Workspace move is not available on this platform'), {
              code: 'LOCAL_WORKSPACE_FILE_MOVE_UNSUPPORTED'
            }),
            'source'
          )
        }
        const root = await realpath(sourceWorkspace.path)
        const rootInfo = await stat(root, { bigint: true })
        try {
          await runAtomicLocalMove(
            this.options.localMoveHelperPath ?? WORKSPACE_MOVE_HELPER,
            root,
            rootInfo.dev,
            rootInfo.ino,
            input.source.path,
            input.destination.path,
            this.options.beforeLocalMoveCommit,
            this.options.afterLocalMoveCommit
          )
          return { status: 'moved' }
        } catch (error) {
          if (typeof error === 'object' && error !== null &&
              'definitelyUnchanged' in error && error.definitelyUnchanged === true) {
            return moveError(error, 'source')
          }
          // Path occupancy cannot identify the moved object or bind a probe to
          // the helper's pinned root. The Renderer will refresh both parents
          // through this owner, but the move result remains unknown.
          return moveError(error, 'unknown')
        }
      }

      return moveError(
        Object.assign(new Error('Workspace move is not available for remote workspaces'), {
          code: 'REMOTE_WORKSPACE_FILE_MOVE_UNSUPPORTED'
        }),
        'source'
      )
    } catch (error) {
      return moveError(error, 'source')
    }
  }

  async delete(workspace: WorkspaceRecord, requestedPath: string): Promise<void> {
    const host = this.hostFor(workspace.hostId)
    if (host.kind === 'local') {
      const resolved = await localMutablePathWithin(workspace.path, requestedPath)
      await runLocalWorker(resolved.parent, resolved.root, {
        action: 'delete',
        name: resolved.name
      })
      return
    }
    const path = await remoteMutablePathWithin(host, workspace.path, requestedPath)
    const result = await host.run('rm', ['-rf', '--', path], { timeoutMs: 15_000 })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Could not delete ${basename(path)}`)
    }
  }
}
