import { readdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, relative, resolve, sep } from 'node:path'
import { posix } from 'node:path'
import type { ExecutionHost } from '@agentmux/core'
import type { FileDocument, WorkspaceRecord } from '../shared/contracts.js'

const IGNORED_NAMES = new Set(['.git', 'node_modules', 'dist', 'out', '.worktrees'])
const MAX_FILES = 5_000
const MAX_DEPTH = 8

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

async function localExistingPathWithin(root: string, requested: string): Promise<string> {
  const lexicalTarget = localPathWithin(root, requested)
  const [realRoot, realTarget] = await Promise.all([realpath(root), realpath(lexicalTarget)])
  assertRealPathWithin(realRoot, realTarget, sep)
  return realTarget
}

async function remoteRealPath(host: ExecutionHost, path: string): Promise<string> {
  const result = await host.run('realpath', ['--', path], { timeoutMs: 15_000 })
  if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not resolve ${basename(path)}`)
  return result.stdout.trim()
}

async function remoteExistingPathWithin(host: ExecutionHost, root: string, requested: string): Promise<string> {
  const lexicalTarget = remotePathWithin(root, requested)
  const [realRoot, realTarget] = await Promise.all([
    remoteRealPath(host, root),
    remoteRealPath(host, lexicalTarget)
  ])
  assertRealPathWithin(realRoot, realTarget, '/')
  return realTarget
}

async function listLocalFiles(root: string): Promise<string[]> {
  const files: string[] = []
  async function visit(directory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH || files.length >= MAX_FILES) return
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      if (IGNORED_NAMES.has(entry.name) || files.length >= MAX_FILES) continue
      const fullPath = resolve(directory, entry.name)
      if (entry.isDirectory()) await visit(fullPath, depth + 1)
      else if (entry.isFile()) files.push(relative(root, fullPath).split(sep).join('/'))
    }
  }
  await visit(root, 0)
  return files
}

export class WorkspaceFiles {
  constructor(private readonly hostFor: (id: string) => ExecutionHost) {}

  async list(workspace: WorkspaceRecord): Promise<string[]> {
    const host = this.hostFor(workspace.hostId)
    if (host.kind === 'local') return await listLocalFiles(await realpath(localPathWithin(workspace.path, '.')))
    const root = await remoteRealPath(host, workspace.path)
    const result = await host.run(
      'find',
      [root, '-maxdepth', String(MAX_DEPTH), '-type', 'f'],
      { timeoutMs: 15_000, maxOutputBytes: 2 * 1024 * 1024 }
    )
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Remote file listing failed')
    const prefix = `${posix.resolve(root)}/`
    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((path) => posix.resolve(path))
      .filter((path) => path.startsWith(prefix))
      .map((path) => path.slice(prefix.length))
      .filter((path) => !path.split('/').some((part) => IGNORED_NAMES.has(part)))
      .slice(0, MAX_FILES)
      .sort()
  }

  async read(workspace: WorkspaceRecord, requestedPath: string): Promise<FileDocument> {
    const host = this.hostFor(workspace.hostId)
    if (host.kind === 'local') {
      const path = await localExistingPathWithin(workspace.path, requestedPath)
      return { path: requestedPath, content: await readFile(path, 'utf8') }
    }
    const path = await remoteExistingPathWithin(host, workspace.path, requestedPath)
    const result = await host.run('cat', ['--', path], { timeoutMs: 15_000, maxOutputBytes: 4 * 1024 * 1024 })
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || `Could not read ${basename(path)}`)
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
    const result = await host.run('tee', ['--', path], { input: document.content, timeoutMs: 15_000 })
    if (result.exitCode !== 0) throw new Error(result.stderr.trim() || 'Remote file write failed')
  }
}
