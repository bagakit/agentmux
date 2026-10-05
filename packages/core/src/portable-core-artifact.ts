import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runProcess } from './process-runner.js'
import { AgentMuxError } from './errors.js'

export type PortableCoreArtifact = {
  digest: string
  sourceCommit: string | null
  protocolVersion: number
  nativeBuild: string
  nativeDigest: string
  archivePath: string
  archiveDigest: string
  files: { path: string; sha256: string; mode: number }[]
}
const sha = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex')
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
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  await mkdir(destination, { recursive: true })
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || core && !['bin', 'dist', 'vendor', 'examples', 'package.json', 'THIRD_PARTY_NOTICES.md', 'release.json'].includes(entry.name)) continue
    await cp(join(source, entry.name), join(destination, entry.name), { recursive: true, dereference: true })
  }
  // An installed Desktop has already materialized dependencies and strips workspace
  // dependency declarations. A source package resolves the same declared closure.
  if (Object.keys(manifest.dependencies ?? {}).length === 0) {
    try { await cp(join(source, 'node_modules'), join(destination, 'node_modules'), { recursive: true, dereference: true }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  } else for (const name of Object.keys(manifest.dependencies!).sort()) {
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
  let sourceCommit: string | null = null
  try {
    const release = JSON.parse(await readFile(join(packageRoot, 'release.json'), 'utf8')) as { sourceCommit?: string }
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
  const packed = await runProcess('tar', ['-czf', archivePath, '-C', root, '.'], { timeoutMs: 120_000 })
  if (packed.exitCode !== 0) throw new AgentMuxError(`Could not assemble portable Core: ${packed.stderr}`, 'CORE_ARTIFACT_UNAVAILABLE')
  const native = manifest.binaries.find(binary => binary.path === 'bin/ctxmuxd')
  if (!native) throw new AgentMuxError('Portable Core has no Native daemon artifact.', 'CORE_ARTIFACT_UNAVAILABLE')
  return { digest, sourceCommit, protocolVersion: manifest.product.protocol, nativeBuild: manifest.source.commit, nativeDigest: native.sha256,
    archivePath, archiveDigest: sha(await readFile(archivePath)), files }
}
