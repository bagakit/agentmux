import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runProcess } from './process-runner.js'
import { AgentMuxError } from './errors.js'

export type PortableCoreArtifact = {
  digest: string
  sourceCommit: string | null
  version: string | null
  ownerProtocolVersion: number | null
  requiredNativeProtocolVersion: number
  nativeBuild: string
  nativeDigest: string
  archivePath: string
  archiveDigest: string
  files: { path: string; sha256: string; mode: number }[]
}
const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
const ARTIFACT_PLATFORM = 'linux-x64'
// Type declarations and source maps describe source files; the deployed Runtime never reads them.
const DEVELOPMENT_FILE = /\.(?:js\.map|d\.ts|d\.ts\.map)$/u
// npm always publishes these alongside a package's declared files.
const ALWAYS_PUBLISHED = /^(?:package\.json|readme|license|licence)(?:\.[^/]*)?$/iu
/** A dependency resolved outside node_modules is a source checkout (a workspace link):
 * ship its declared npm publication, never its src/, tests or local scratch files. */
async function publishedEntries(source: string, manifest: { name?: string; files?: unknown }): Promise<Set<string> | null> {
  if (source.split(sep).includes('node_modules')) return null
  const files = manifest.files
  if (!Array.isArray(files) || !files.length || files.some(entry => typeof entry !== 'string' || !entry ||
    entry.startsWith('!') || /[*?[\]{}]/u.test(entry) || entry.split('/').some(part => part === '..') || entry.startsWith('/'))) {
    throw new AgentMuxError(`Portable Core cannot select the published files of ${manifest.name ?? source}; declare plain package.json files.`, 'CORE_ARTIFACT_UNAVAILABLE')
  }
  const selected = new Set(files.map(entry => (entry as string).replace(/\/+$/u, '').split('/')[0]!))
  for (const entry of await readdir(source)) if (ALWAYS_PUBLISHED.test(entry)) selected.add(entry)
  return selected
}
async function resolveDependency(source: string, name: string): Promise<string> {
  for (let current = source; ; current = dirname(current)) {
    try { return await realpath(join(current, 'node_modules', name)) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    if (dirname(current) === current) throw new AgentMuxError(`Portable Core dependency is missing: ${name}`, 'CORE_ARTIFACT_UNAVAILABLE')
  }
}
async function materialize(source: string, destination: string, ancestry: readonly string[] = [], core = false): Promise<void> {
  const canonical = await realpath(source)
  if (ancestry.includes(canonical)) throw new AgentMuxError('Portable Core has a cyclic dependency.', 'CORE_ARTIFACT_UNAVAILABLE')
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { name?: string; files?: unknown; dependencies?: Record<string, string> }
  await mkdir(destination, { recursive: true })
  const published = core ? null : await publishedEntries(source, manifest)
  // Core and workspace checkouts are AgentMux's own code: drop development-only files, and
  // keep only this artifact's Native platform (its Darwin helper never runs on Linux).
  const own = core || published !== null
  let platforms: string[] = []
  if (core) {
    try { platforms = await readdir(join(source, 'vendor', 'ctxmux')) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  const foreignPlatform = core ? [join(source, 'dist', 'native-socket-peer-darwin'),
    ...platforms.filter(name => name !== ARTIFACT_PLATFORM).map(name => join(source, 'vendor', 'ctxmux', name))] : []
  const filter = (path: string) => !own || !DEVELOPMENT_FILE.test(path) && !foreignPlatform.includes(path)
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || core && !['bin', 'dist', 'vendor', 'examples', 'package.json', 'THIRD_PARTY_NOTICES.md', 'release.json'].includes(entry.name)) continue
    if (published && !published.has(entry.name)) continue
    await cp(join(source, entry.name), join(destination, entry.name), { recursive: true, dereference: true, filter })
  }
  if (core) {
    await mkdir(join(destination, 'src'), { recursive: true })
    await cp(join(source, 'src', 'ctxmux-artifact-contract.json'), join(destination, 'src', 'ctxmux-artifact-contract.json'))
  }
  // An installed Desktop has already materialized dependencies and strips workspace
  // dependency declarations. A source package resolves the same declared closure.
  if (core && Object.keys(manifest.dependencies ?? {}).length === 0) {
    try { await cp(join(source, 'node_modules'), join(destination, 'node_modules'), { recursive: true, dereference: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  } else for (const name of Object.keys(manifest.dependencies ?? {}).sort()) {
    await materialize(await resolveDependency(source, name), join(destination, 'node_modules', name), [...ancestry, canonical])
  }
}
/** Offline, content-bound deployment; never fetches or executes npm lifecycle scripts. */
export async function createPortableCoreArtifact(directory: string, packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))): Promise<PortableCoreArtifact> {
  const root = join(directory, 'core')
  await materialize(packageRoot, root, [], true)
  const manifestBytes = await readFile(join(root, 'vendor', 'ctxmux', 'linux-x64', 'manifest.json'))
  const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
    source: { commit: string }; product: { protocol: number }; binaries: { path: string; sha256: string }[]
  }
  const contract = JSON.parse(await readFile(join(root, 'dist', 'ctxmux-artifact-contract.json'), 'utf8')) as {
    protocol: number; manifests: Record<string, string>; sources: Record<string, { commit: string }>
  }
  if (sha(manifestBytes) !== contract.manifests['linux-x64'] || manifest.product.protocol !== contract.protocol || manifest.source.commit !== contract.sources['linux-x64']?.commit) {
    throw new AgentMuxError('The Linux candidate does not match the compiled Core Native contract.', 'CORE_ARTIFACT_UNAVAILABLE')
  }
  for (const binary of manifest.binaries) if (sha(await readFile(join(root, 'vendor', 'ctxmux', 'linux-x64', binary.path))) !== binary.sha256) {
    throw new AgentMuxError('The Linux Native artifact does not match its manifest.', 'CORE_ARTIFACT_UNAVAILABLE')
  }
  // Desktop's local bin may use Electron. The remote entry point always uses the
  // original qualified Node executable; its deployment wrapper is written remotely.
  await writeFile(join(root, 'bin', 'amux'), '#!/usr/bin/env node\nimport "../dist/agentmux.js"\n', { mode: 0o755 })
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version?: unknown }
  const version = typeof pkg.version === 'string' && pkg.version ? pkg.version : null
  let ownerProtocolVersion: number | null = null
  // Import only the candidate's finite, dependency-free declaration. The file is
  // included below in the content inventory and the serving Core imports it too.
  try {
    const declaration = await import(pathToFileURL(join(root, 'dist/runtime-owner-protocol.js')).href)
    if (Number.isSafeInteger(declaration.AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION) && declaration.AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION > 0) ownerProtocolVersion = declaration.AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error }
  let sourceCommit: string | null = null
  try {
    const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8')) as { sourceCommit?: string }
    sourceCommit = release.sourceCommit ?? null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const repository = await runProcess('git', ['rev-parse', '--show-toplevel'], { cwd: packageRoot })
    if (repository.exitCode === 0 && join(repository.stdout.trim(), 'packages', 'core') === packageRoot) {
      const dirty = await runProcess('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: packageRoot })
      if (dirty.exitCode === 0 && !dirty.stdout.trim()) {
        const revision = await runProcess('git', ['rev-parse', 'HEAD'], { cwd: packageRoot })
        if (revision.exitCode === 0) sourceCommit = revision.stdout.trim()
      }
    }
  }
  const files: PortableCoreArtifact['files'] = []
  async function visit(path: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) await visit(full)
      else {
        if (!entry.isFile()) throw new AgentMuxError('Portable Core contains an unsupported file.', 'CORE_ARTIFACT_UNAVAILABLE')
        files.push({ path: relative(root, full).split('\\').join('/'), sha256: sha(await readFile(full)), mode: (await stat(full)).mode & 0o777 })
      }
    }
  }
  await visit(root)
  const digest = sha(JSON.stringify(files))
  const archivePath = join(directory, 'core.tar.gz')
  // A Linux tar warns about macOS extended attributes and AppleDouble files; omit them.
  const metadata = process.platform === 'darwin' ? ['--no-xattrs', '--no-mac-metadata'] : []
  const packed = await runProcess('tar', [...metadata, '-czf', archivePath, '-C', root, '.'], { timeoutMs: 120_000, env: { COPYFILE_DISABLE: '1' } })
  if (packed.exitCode !== 0) throw new AgentMuxError(`Could not assemble portable Core: ${packed.stderr}`, 'CORE_ARTIFACT_UNAVAILABLE')
  const native = manifest.binaries.find(binary => binary.path === 'bin/ctxmuxd')
  if (!native) throw new AgentMuxError('Portable Core has no Native daemon artifact.', 'CORE_ARTIFACT_UNAVAILABLE')
  return { digest, sourceCommit, version, ownerProtocolVersion, requiredNativeProtocolVersion: manifest.product.protocol, nativeBuild: manifest.source.commit, nativeDigest: native.sha256,
    archivePath, archiveDigest: sha(await readFile(archivePath)), files }
}
