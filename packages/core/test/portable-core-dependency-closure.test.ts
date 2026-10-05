import { fixturePath } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createPortableCoreArtifact } from '../src/portable-core-artifact.js'

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
  await put(join(packageRoot, 'package.json'), JSON.stringify({ name: '@agentmux/core', version: '0.0.0', dependencies }))
  await put(join(packageRoot, 'release.json'), JSON.stringify({ sourceCommit: 'private-source-fixture' }))
  await put(join(packageRoot, 'dist', 'agentmux.js'), 'export const privateFixture = true\n')
  const native = 'private Native artifact bytes; not executable\n'
  const manifest = { source: { commit: 'private-native-fixture' }, product: { protocol: 1 }, binaries: [{ path: 'bin/ctxmuxd', sha256: sha(native) }] }
  const bytes = JSON.stringify(manifest)
  await put(join(packageRoot, 'vendor', 'ctxmux', 'linux-x64', 'manifest.json'), bytes)
  await put(join(packageRoot, 'vendor', 'ctxmux', 'linux-x64', 'bin', 'ctxmuxd'), native)
  await put(join(packageRoot, 'dist', 'ctxmux-artifact-contract.json'), JSON.stringify({
    protocol: 1, manifests: { 'linux-x64': sha(bytes) }, sources: { 'linux-x64': manifest.source }
  }))
  return packageRoot
}

it.each([undefined, {}])('omits non-Core development node_modules when runtime dependencies are %j', async dependencies => {
  const root = await mkdtemp(fixturePath("tmp/amux-portable-leaf-"))
  try {
    const packageRoot = await coreFixture(root, { 'portable-leaf': '0.0.0' })
    const leaf = join(packageRoot, 'node_modules', 'portable-leaf')
    await put(join(leaf, 'package.json'), JSON.stringify({ name: 'portable-leaf', version: '0.0.0', dependencies, devDependencies: { typescript: '0.0.0' } }))
    await put(join(leaf, 'runtime.js'), 'export const runtime = "retained"\n')
    const developmentPath = 'node_modules/portable-leaf/node_modules/typescript/dev-only-sentinel.txt'
    await put(join(packageRoot, developmentPath), 'development dependency must not ship\n')

    const artifact = await createPortableCoreArtifact(join(root, 'artifact'), packageRoot)
    const files = artifact.files.map(file => file.path)
    expect(files).toContain('node_modules/portable-leaf/runtime.js')
    expect(files).not.toContain(developmentPath)
    expect(files.some(file => file.startsWith('node_modules/portable-leaf/node_modules/'))).toBe(false)
    expect(await readFile(join(root, 'artifact', 'core', 'node_modules', 'portable-leaf', 'runtime.js'), 'utf8')).toBe('export const runtime = "retained"\n')
    const packed = (await exec('tar', ['-tzf', artifact.archivePath])).stdout
    expect(packed).toContain('./node_modules/portable-leaf/runtime.js')
    expect(packed).not.toContain('dev-only-sentinel')
  } finally { await rm(root, { recursive: true, force: true }) }
})

it('retains already-materialized production node_modules for a stripped Core manifest', async () => {
  const root = await mkdtemp(fixturePath("tmp/amux-portable-stripped-core-"))
  try {
    const packageRoot = await coreFixture(root)
    const productionPath = 'node_modules/materialized-runtime/runtime.js'
    const runtime = 'export const installedProductionDependency = true\n'
    await put(join(packageRoot, productionPath), runtime)
    const artifact = await createPortableCoreArtifact(join(root, 'artifact'), packageRoot)
    expect(artifact.files).toContainEqual(expect.objectContaining({ path: productionPath, sha256: sha(runtime) }))
    expect(await readFile(join(root, 'artifact', 'core', productionPath), 'utf8')).toBe(runtime)
    expect((await exec('tar', ['-tzf', artifact.archivePath])).stdout).toContain('./' + productionPath)
  } finally { await rm(root, { recursive: true, force: true }) }
})
