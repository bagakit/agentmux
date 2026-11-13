import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
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
/**
 * The input is an assembled runtime Core: the Desktop's bundled copy, or one the packaging
 * owner materialized with each dependency's published files. Which files a package ships is
 * decided there once; this step only keeps the Linux Native payload and leaves out
 * Desktop-only launchers and helpers.
 */
async function materializeLinuxCore(source: string, destination: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
  if (Object.keys(manifest.dependencies ?? {}).length) {
    throw new AgentMuxError('Portable Core needs an assembled runtime Core, not a source checkout; build it with the packaging owner.', 'CORE_ARTIFACT_UNAVAILABLE')
  }
  const vendor = join(source, 'vendor', 'ctxmux')
  const desktopOnly = new Set([join(source, 'dist', 'native-socket-peer-darwin'), join(source, 'bin', 'agentmux'),
    ...(await readdir(vendor)).filter(name => name !== ARTIFACT_PLATFORM).map(name => join(vendor, name))])
  for (const entry of ['bin', 'dist', 'vendor', 'node_modules', 'src', 'package.json', 'release.json', 'THIRD_PARTY_NOTICES.md']) {
    try { await cp(join(source, entry), join(destination, entry), { recursive: true, dereference: true, filter: path => !desktopOnly.has(path) }) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
}
/** Offline, content-bound deployment; never fetches or executes npm lifecycle scripts. */
export async function createPortableCoreArtifact(directory: string, packageRoot = dirname(dirname(fileURLToPath(import.meta.url)))): Promise<PortableCoreArtifact> {
  const root = join(directory, 'core')
  await mkdir(root, { recursive: true })
  await materializeLinuxCore(packageRoot, root)
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
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
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
