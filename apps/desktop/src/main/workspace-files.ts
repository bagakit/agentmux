import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { basename, dirname, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type {
  CreateWorkspacePathInput,
  RenameWorkspacePathInput,
  WorkspaceDirectoryEntry,
  WorkspaceFileReadResult,
  WorkspaceFileWriteInput,
  WorkspaceFileWriteResult,
  WorkspaceRecord
} from '../shared/contracts.js'

const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'out', '.worktrees'])
const LOCAL_WORKER_READY = 'AGENTMUX_WORKSPACE_READY'
const LOCAL_WORKER_OBSERVING = 'AGENTMUX_WORKSPACE_OBSERVING'
const LOCAL_WORKER_INVALIDATED = 'AGENTMUX_WORKSPACE_INVALIDATED'
const LOCAL_WORKER_ERROR = 'AGENTMUX_WORKSPACE_ERROR:'

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
  | { action: 'rename'; name: string; nextName: string }
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

export type WorkspaceFilesOptions = {
  beforeWrite?: (input: WorkspaceFileWriteInput) => Promise<void>
  localWriteFault?: 'temporary-write' | 'replace' | (() => 'temporary-write' | 'replace' | undefined)
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
import { constants, lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from 'node:fs/promises'
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
  } else if (request.action === 'rename') {
    try {
      await lstat(request.nextName)
      throw new Error('Destination already exists: ' + request.nextName)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    await rename(request.name, request.nextName)
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

async function localExistingPathWithin(root: string, requested: string): Promise<LocalExistingPath> {
  const lexicalTarget = localPathWithin(root, requested)
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(lexicalTarget)])
  assertRealPathWithin(realRoot, realTarget, sep)
  return { root: realRoot, target: realTarget }
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

async function runLocalObserver(
  cwd: string,
  root: string,
  name: string,
  invalidated: () => void
): Promise<() => void> {
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
    throw error
  }
  return () => {
    if (disposed) return
    disposed = true
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
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

export class WorkspaceFiles {
  private readonly writeTails = new Map<string, Promise<void>>()
  private readonly observers = new Map<string, {
    listeners: Set<() => void>
    disposeWorker: () => void
  }>()
  private readonly observerStarts = new Map<string, Promise<{
    listeners: Set<() => void>
    disposeWorker: () => void
  }>>()
  private disposed = false

  constructor(
    private readonly hostFor: (id: string) => ExecutionHost,
    private readonly options: WorkspaceFilesOptions = {}
  ) {}

  private async serializeWrite<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeTails.get(key) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolveCurrent) => {
      release = resolveCurrent
    })
    const tail = previous.catch(() => {}).then(async () => await current)
    this.writeTails.set(key, tail)
    await previous.catch(() => {})
    try {
      return await operation()
    } finally {
      release()
      if (this.writeTails.get(key) === tail) this.writeTails.delete(key)
    }
  }

  async observe(
    workspace: WorkspaceRecord,
    requestedPath: string,
    invalidated: () => void
  ): Promise<() => void> {
    if (this.disposed) throw new Error('WorkspaceFiles is disposed')
    const host = this.hostFor(workspace.hostId)
    if (host.kind !== 'local') {
      throw Object.assign(
        new Error('File observation is not available for remote workspaces.'),
        { code: 'REMOTE_WORKSPACE_FILE_OBSERVATION_UNSUPPORTED' }
      )
    }
    const resolved = await localExistingPathWithin(workspace.path, requestedPath)
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
        }).then((disposeWorker) => {
          if (this.disposed) {
            disposeWorker()
            throw new Error('WorkspaceFiles is disposed')
          }
          return { listeners, disposeWorker }
        })
        this.observerStarts.set(key, start)
      }
      try {
        entry = await start
        this.observers.set(key, entry)
      } finally {
        if (this.observerStarts.get(key) === start) this.observerStarts.delete(key)
      }
    }
    entry.listeners.add(invalidated)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      entry!.listeners.delete(invalidated)
      if (entry!.listeners.size !== 0 || this.observers.get(key) !== entry) return
      this.observers.delete(key)
      entry!.disposeWorker()
    }
  }

  dispose(): void {
    this.disposed = true
    for (const entry of this.observers.values()) entry.disposeWorker()
    this.observers.clear()
    for (const start of this.observerStarts.values()) {
      void start.then((entry) => entry.disposeWorker(), () => {})
    }
    this.observerStarts.clear()
  }

  async localPathForReveal(workspace: WorkspaceRecord, requestedPath: string): Promise<string> {
    const host = this.hostFor(workspace.hostId)
    if (host.kind !== 'local') throw new Error('Reveal in file manager is available only for local paths')
    const resolved = await localExistingPathWithin(workspace.path, requestedPath || '.')
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
    // 采用 Orca 的目录级读取边界，但保留 AgentMux 的 system-SSH transport。
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
      const result = await host.run('cat', ['--', path], {
        timeoutMs: 15_000,
        maxOutputBytes: 4 * 1024 * 1024
      })
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
      return await this.serializeWrite(key, async () => {
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

  async rename(workspace: WorkspaceRecord, input: RenameWorkspacePathInput): Promise<void> {
    const host = this.hostFor(workspace.hostId)
    if (host.kind === 'local') {
      const [path, nextPath] = await Promise.all([
        localMutablePathWithin(workspace.path, input.path),
        localMutablePathWithin(workspace.path, input.nextPath)
      ])
      if (path.root !== nextPath.root || path.parent !== nextPath.parent) {
        throw new Error('Local Workspace rename cannot move a path between directories')
      }
      await runLocalWorker(path.parent, path.root, {
        action: 'rename',
        name: path.name,
        nextName: nextPath.name
      })
      return
    }
    const [path, nextPath] = await Promise.all([
      remoteMutablePathWithin(host, workspace.path, input.path),
      remoteMutablePathWithin(host, workspace.path, input.nextPath)
    ])
    const result = await host.run(
      'sh',
      [
        '-c',
        'if [ -e "$2" ] || [ -L "$2" ]; then exit 17; fi; mv -- "$1" "$2"',
        'agentmux-rename',
        path,
        nextPath
      ],
      { timeoutMs: 15_000 }
    )
    if (result.exitCode !== 0) {
      throw new Error(
        result.exitCode === 17
          ? `Destination already exists: ${basename(nextPath)}`
          : result.stderr.trim() || `Could not rename ${basename(path)}`
      )
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
