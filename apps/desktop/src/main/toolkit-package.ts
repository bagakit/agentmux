import { constants } from 'node:fs'
import { mkdir, open, lstat, readdir, realpath, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, posix, resolve } from 'node:path'
import { AgentMuxError, durableWriteFile } from '@agentmux/core'
import { parseToolkitPackageManifest, parseToolkitToolDefinition,
  type ToolkitPackageConfiguration, type ToolkitPackageManifest, type ToolkitToolDefinition } from '@agentmux/core/control'
import { TOOLKIT_ICON_IDS } from '../shared/toolkit-preferences.js'

const MAX_FILES = 128, MAX_BYTES = 1024 * 1024, MAX_DIRECTORIES = 128
const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
const decoder = new TextDecoder('utf-8', { fatal: true })
const fail = (message: string): never => { throw new AgentMuxError(message, 'TOOLKIT_PACKAGE_UNAVAILABLE') }
const signature = (s: Awaited<ReturnType<typeof lstat>>) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
function entryPath(value: string): string {
  if (!value || value.includes('\\') || /[\x00-\x1f\x7f]/u.test(value) || posix.isAbsolute(value)) fail('Package entries must be relative paths inside the package.')
  const path = posix.normalize(value)
  if (path === '.' || path === '..' || path.startsWith('../') || path.length > 1024 || path.split('/').includes('.git')) fail('Package entry escapes its supported local file set.')
  return path
}
async function bytesAt(path: string, max: number): Promise<{ bytes: Buffer; identity: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > max) fail('Package files must be bounded regular files; links and special files are not package sources.')
    const bytes = await file.readFile()
    if (bytes.length > max || signature(before) !== signature(await file.stat())) fail('Package file changed while being captured. Inspect it again before running.')
    return { bytes, identity: signature(before) }
  } finally { await file.close() }
}
function iconOf(manifest: ToolkitPackageManifest): { icon: string; warning: string | null } {
  return TOOLKIT_ICON_IDS.includes(manifest.icon as typeof TOOLKIT_ICON_IDS[number])
    ? { icon: manifest.icon, warning: null }
    : { icon: 'terminal', warning: 'This package icon is unavailable; using the default tool icon.' }
}
export async function readToolkitPackageMetadata(record: ToolkitPackageConfiguration) {
  const root = await realpath(record.packagePath)
  const { bytes } = await bytesAt(join(root, 'manifest.json'), 32 * 1024)
  const manifest = parseToolkitPackageManifest(JSON.parse(decoder.decode(bytes)))
  const icon = iconOf(manifest)
  return { manifest, ...icon }
}
export type CapturedToolkitPackage = {
  definition: ToolkitToolDefinition
  files: ReadonlyMap<string, Buffer>
  manifest: ToolkitPackageManifest
  warning: string | null
}
/** Read only the requested package. No watchers, discovery crawl or execution. */
export async function captureToolkitPackage(record: ToolkitPackageConfiguration): Promise<CapturedToolkitPackage> {
  const root = await realpath(record.packagePath), files = new Map<string, Buffer>()
  const identities = new Map<string, string>(), directories = new Map<string, string>()
  let size = 0
  async function walk(relative: string, depth: number): Promise<void> {
    if (depth > 16 || directories.size >= MAX_DIRECTORIES) fail('Package directory budget exceeded.')
    const path = join(root, relative), before = await lstat(path)
    if (!before.isDirectory() || before.isSymbolicLink()) fail('Package directories must be ordinary local directories.')
    directories.set(path, signature(before))
    const entries = await readdir(path, { withFileTypes: true })
    if (entries.length > MAX_FILES + MAX_DIRECTORIES) fail('Package directory budget exceeded.')
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name === '.git') continue
      const name = entryPath(relative ? `${relative}/${entry.name}` : entry.name), absolute = join(root, name)
      if (entry.isDirectory()) await walk(name, depth + 1)
      else {
        if (!entry.isFile() || files.size >= MAX_FILES) fail('Package contains links, special files or too many files.')
        const file = await bytesAt(absolute, MAX_BYTES - size)
        size += file.bytes.length; files.set(name, file.bytes); identities.set(absolute, file.identity)
      }
    }
  }
  await walk('', 0)
  for (const [path, expected] of [...identities, ...directories]) {
    if (signature(await lstat(path)) !== expected) fail('Package changed during capture. Inspect it again before running.')
  }
  const manifestBytes = files.get('manifest.json')
  if (!manifestBytes || manifestBytes.length > 32 * 1024) fail('Package needs a bounded manifest.json.')
  const manifest = parseToolkitPackageManifest(JSON.parse(decoder.decode(manifestBytes)))
  const entry = entryPath(manifest.entry), actionEntries = (manifest.actions ?? []).map(action => ({ id: action.id, entry: entryPath(action.entry) }))
  function script(path: string) {
    const bytes = files.get(path)
    if (!bytes || bytes.length > 32 * 1024) fail('Package entry is absent or exceeds the script budget.')
    return decoder.decode(bytes)
  }
  const contentSHA256 = sha(JSON.stringify([...files].map(([path, bytes]) => [path, sha(bytes)])))
  const revision = sha(`${record.revision}\0${contentSHA256}`), icon = iconOf(manifest)
  const definition = parseToolkitToolDefinition({ id: record.id, revision,
    name: manifest.name, icon: icon.icon, enabled: record.enabled, statusBar: record.statusBar,
    workspacePath: record.workspacePath, script: script(entry), args: record.args,
    actions: (manifest.actions ?? []).map((action, i) => ({ id: action.id, label: action.label, script: script(actionEntries[i]!.entry), args: action.args ?? [] })),
    package: { path: record.packagePath, configRevision: record.revision, contentSHA256, entry, actionEntries } })
  return { definition, files, manifest, warning: icon.warning }
}
/** An owned, per-admission copy. It survives process restart and any live package edits. */
export async function writeToolkitPackageSnapshot(root: string, executionId: string, capture: CapturedToolkitPackage): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 })
  const directory = snapshotDirectory(root, executionId)
  await mkdir(directory, { mode: 0o700 })
  const identity = signature(await lstat(directory))
  try {
    await durableWriteFile(join(directory, 'owner.json'), JSON.stringify({ schema: 'agentmux.toolkit.snapshot.v1', executionId,
      contentSHA256: capture.definition.package!.contentSHA256 }))
    const files = join(directory, 'files')
    await mkdir(files, { mode: 0o700 })
    for (const [path, bytes] of capture.files) {
      const destination = join(files, path)
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 })
      await durableWriteFile(destination, bytes)
    }
    return files
  } catch (error) {
    // Cleanup only the directory this call created. Unknown ownership retains evidence.
    const current = await lstat(directory).catch(() => null)
    if (current && current.dev + ':' + current.ino === identity.split(':').slice(0, 2).join(':')) await rm(directory, { recursive: true })
    throw error
  }
}

/** A generic protocol identity is not a filesystem component. */
function snapshotDirectory(root: string, executionId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(executionId)) fail('Snapshot execution identity is not a local directory component.')
  const base = resolve(root), directory = resolve(base, executionId)
  if (dirname(directory) !== base) fail('Snapshot directory escapes its owner.')
  return directory
}
/** The receipt owner calls this only after terminal result and exact Run cleanup are durable. */
export async function removeToolkitPackageSnapshot(root: string, executionId: string, contentSHA256?: string): Promise<void> {
  const directory = snapshotDirectory(root, executionId)
  const stat = await lstat(directory).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  })
  if (!stat) return
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('Snapshot directory ownership is unconfirmed.')
  const marker = await bytesAt(join(directory, 'owner.json'), 1024)
  const owner = JSON.parse(decoder.decode(marker.bytes))
  if (owner?.schema !== 'agentmux.toolkit.snapshot.v1' || owner.executionId !== executionId ||
      typeof owner.contentSHA256 !== 'string' || !/^[a-f0-9]{64}$/u.test(owner.contentSHA256) ||
      (contentSHA256 !== undefined && owner.contentSHA256 !== contentSHA256)) fail('Snapshot owner is unconfirmed; retaining files.')
  const current = await lstat(directory)
  if (current.dev !== stat.dev || current.ino !== stat.ino) fail('Snapshot directory changed; retaining files.')
  await rm(directory, { recursive: true })
}
