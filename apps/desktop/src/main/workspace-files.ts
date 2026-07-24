import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename as renamePath,
  rm,
  writeFile
} from 'node:fs/promises'
import { basename, dirname, relative, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type {
  CreateWorkspacePathInput,
  FileDocument,
  RenameWorkspacePathInput,
  WorkspaceDirectoryEntry,
  WorkspaceRecord
} from '../shared/contracts.js'

const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'out', '.worktrees'])

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

async function localExistingPathWithin(root: string, requested: string): Promise<string> {
  const lexicalTarget = localPathWithin(root, requested)
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(lexicalTarget)])
  assertRealPathWithin(realRoot, realTarget, sep)
  return realTarget
}

async function localMutablePathWithin(root: string, requested: string): Promise<string> {
  assertMutableRelativePath(requested)
  const lexicalTarget = localPathWithin(root, requested)
  const [realRoot, realParent] = await Promise.all([realpath(root), realpath(dirname(lexicalTarget))])
  assertRealPathWithin(realRoot, realParent, sep)
  return resolve(realParent, basename(lexicalTarget))
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

async function assertDestinationMissing(path: string): Promise<void> {
  try {
    await lstat(path)
    throw new Error(`Destination already exists: ${basename(path)}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export class WorkspaceFiles {
  constructor(private readonly hostFor: (id: string) => ExecutionHost) {}

  async readDirectory(
    workspace: WorkspaceRecord,
    requestedPath: string
  ): Promise<WorkspaceDirectoryEntry[]> {
    const host = this.hostFor(workspace.hostId)
    if (host.kind === 'local') {
      const directory = await localExistingPathWithin(workspace.path, requestedPath || '.')
      const entries = await readdir(directory, { withFileTypes: true })
      return sortDirectoryEntries(
        entries.flatMap((entry) => {
          if (IGNORED_NAMES.has(entry.name)) return []
          return [{
            name: entry.name,
            path: relativeEntryPath(requestedPath, entry.name),
            isDirectory: entry.isDirectory(),
            isSymlink: entry.isSymbolicLink()
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

  async read(workspace: WorkspaceRecord, requestedPath: string): Promise<FileDocument> {
    const host = this.hostFor(workspace.hostId)
    if (host.kind === 'local') {
      const path = await localExistingPathWithin(workspace.path, requestedPath)
      return { path: requestedPath, content: await readFile(path, 'utf8') }
    }
    const path = await remoteExistingPathWithin(host, workspace.path, requestedPath)
    const result = await host.run('cat', ['--', path], {
      timeoutMs: 15_000,
      maxOutputBytes: 4 * 1024 * 1024
    })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Could not read ${basename(path)}`)
    }
    return { path: requestedPath, content: result.stdout }
  }

  async write(workspace: WorkspaceRecord, document: FileDocument): Promise<void> {
    const host = this.hostFor(workspace.hostId)
    if (host.kind === 'local') {
      const path = await localExistingPathWithin(workspace.path, document.path)
      await writeFile(path, document.content, 'utf8')
      return
    }
    const path = await remoteExistingPathWithin(host, workspace.path, document.path)
    const result = await host.run('tee', ['--', path], {
      input: document.content,
      timeoutMs: 15_000
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Remote file write failed')
  }

  async create(workspace: WorkspaceRecord, input: CreateWorkspacePathInput): Promise<void> {
    const host = this.hostFor(workspace.hostId)
    if (host.kind === 'local') {
      const path = await localMutablePathWithin(workspace.path, input.path)
      if (input.kind === 'directory') await mkdir(path)
      else await writeFile(path, '', { flag: 'wx', encoding: 'utf8' })
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
      await assertDestinationMissing(nextPath)
      await renamePath(path, nextPath)
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
      const path = await localMutablePathWithin(workspace.path, requestedPath)
      await rm(path, { recursive: true, force: false })
      return
    }
    const path = await remoteMutablePathWithin(host, workspace.path, requestedPath)
    const result = await host.run('rm', ['-rf', '--', path], { timeoutMs: 15_000 })
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || `Could not delete ${basename(path)}`)
    }
  }
}
