import { fixturePath } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { createPortableCoreArtifact } from '../src/portable-core-artifact.js'
vi.mock('node:fs/promises', async original => {
  const fs = await original<typeof import('node:fs/promises')>()
  return { ...fs, cp: vi.fn(fs.cp) }
})

const exec = promisify(execFile)
const sha = (text: string) => createHash('sha256').update(text).digest('hex')
async function put(path: string, text: string) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, text)
}

/** Tiny, internally consistent artifact bytes; never runs a Native or a lifecycle script. */
async function coreFixture(root: string, dependencies?: Record<string, string>) {
  const packageRoot = join(root, 'package')
  await mkdir(join(packageRoot, 'bin'), { recursive: true })
  await put(join(packageRoot, 'package.json'), JSON.stringify({ name: '@agentmux/core', type: 'module', version: '0.0.0', dependencies }))
  await put(join(packageRoot, 'dist', 'runtime-owner-protocol.js'), 'export const AGENTMUX_RUNTIME_OWNER_PROTOCOL_VERSION = 7\n')
  await put(join(packageRoot, 'release.json'), JSON.stringify({ sourceCommit: 'private-source-fixture' }))
  await put(join(packageRoot, 'dist', 'agentmux.js'), 'export const privateFixture = true\n')
  const native = 'private Native artifact bytes; not executable\n'
  const manifest = { source: { commit: 'private-native-fixture' }, product: { protocol: 1 }, binaries: [{ path: 'bin/ctxmuxd', sha256: sha(native) }] }
  const bytes = JSON.stringify(manifest)
  await put(join(packageRoot, 'vendor', 'ctxmux', 'linux-x64', 'manifest.json'), bytes)
  await put(join(packageRoot, 'vendor', 'ctxmux', 'linux-x64', 'bin', 'ctxmuxd'), native)
  const contract = JSON.stringify({
    protocol: 1, manifests: { 'linux-x64': sha(bytes) }, sources: { 'linux-x64': manifest.source }
  })
  await put(join(packageRoot, 'dist', 'ctxmux-artifact-contract.json'), contract)
  await put(join(packageRoot, 'src', 'ctxmux-artifact-contract.json'), contract)
  return packageRoot
}

it('candidate source metadata stays bound to materialized bytes when the source package changes after copying', async () => {
  const root = await mkdtemp(fixturePath('tmp/amux-portable-source-'))
  try {
    const packageRoot = await coreFixture(root, {})
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises'), originalCopy = fs.cp
    const copy = vi.mocked(cp).mockImplementation(async (...args) => {
      await originalCopy(...args)
      if (args[0] === join(packageRoot, 'release.json')) await writeFile(join(packageRoot, 'release.json'), JSON.stringify({ sourceCommit: 'changed-after-copy' }))
    })
    try {
      const artifact = await createPortableCoreArtifact(join(root, 'artifact'), packageRoot)
      expect(artifact.sourceCommit).toBe('private-source-fixture')
      const release = artifact.files.find(file => file.path === 'release.json')!
      expect(release.sha256).toBe(sha(await readFile(join(root, 'artifact/core/release.json'), 'utf8')))
      expect(JSON.parse(await readFile(join(packageRoot, 'release.json'), 'utf8')).sourceCommit).toBe('changed-after-copy')
    } finally { copy.mockImplementation(originalCopy) }
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('ships an assembled runtime Core with its installed dependencies, keeping only the Linux Native payload', async () => {
  const root = await mkdtemp(fixturePath('tmp/amux-portable-runtime-'))
  try {
    const packageRoot = await coreFixture(root)
    const runtime = 'export const installedProductionDependency = true\n'
    await put(join(packageRoot, 'node_modules/materialized-runtime/runtime.js'), runtime)
    // Desktop-only pieces of the bundled Core never reach a Linux Host.
    await put(join(packageRoot, 'dist', 'native-socket-peer-darwin'), 'darwin helper\n')
    await put(join(packageRoot, 'bin', 'agentmux'), 'exec /Applications/AgentMux.app/Contents/MacOS/AgentMux\n')
    await put(join(packageRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmuxd'), 'darwin native\n')
    const artifact = await createPortableCoreArtifact(join(root, 'artifact'), packageRoot)
    expect(artifact).toMatchObject({ version: '0.0.0', ownerProtocolVersion: 7, requiredNativeProtocolVersion: 1, sourceCommit: 'private-source-fixture' })
    const files = artifact.files.map(file => file.path)
    expect(artifact.files).toContainEqual(expect.objectContaining({ path: 'node_modules/materialized-runtime/runtime.js', sha256: sha(runtime) }))
    expect(files).toEqual(expect.arrayContaining(['dist/agentmux.js', 'src/ctxmux-artifact-contract.json', 'vendor/ctxmux/linux-x64/bin/ctxmuxd', 'bin/amux']))
    for (const absent of ['dist/native-socket-peer-darwin', 'bin/agentmux', 'vendor/ctxmux/darwin-arm64/bin/ctxmuxd']) expect(files, absent).not.toContain(absent)
    const packed = (await exec('tar', ['-tzf', artifact.archivePath])).stdout
    expect(packed).toContain('./node_modules/materialized-runtime/runtime.js')
    expect(packed).not.toContain('darwin')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('refuses a source checkout instead of guessing which of its files ship', async () => {
  const root = await mkdtemp(fixturePath('tmp/amux-portable-checkout-'))
  try {
    const packageRoot = await coreFixture(root, { '@agentmux/identity': 'workspace:*' })
    await expect(createPortableCoreArtifact(join(root, 'artifact'), packageRoot)).rejects.toMatchObject({ code: 'CORE_ARTIFACT_UNAVAILABLE' })
  } finally { await rm(root, { recursive: true, force: true }) }
})
