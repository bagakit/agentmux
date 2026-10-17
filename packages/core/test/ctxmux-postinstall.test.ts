import { fixturePath } from './helpers/fixture-values.js'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const exec = promisify(execFile)
const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const asset = 'src/ctxmux-artifact-contract.json'
const installer = 'bin/install-ctxmux.mjs'
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
const roots: string[] = []
function evidence(value: Record<string, unknown>) {
  const log = process.env.AGENTMUX_CORE_INSTALL_EVIDENCE
  if (log) appendFileSync(log, JSON.stringify(value) + '\n')
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(fixturePath('tmp/core-postinstall-'))
  roots.push(root)
  const source = join(root, 'source')
  const original = await readFile(join(packageRoot, installer), 'utf8')
  let code = original
  if (process.env.AGENTMUX_CORE_INSTALL_MUTATION === 'manifest-guard') {
    const guard = "if (createHash('sha256').update(manifestBytes).digest('hex') !== manifestSha256) {"
    expect(code.split(guard)).toHaveLength(2)
    code = code.replace(guard, 'if (false) {')
  }
  await mkdir(join(source, 'bin'), { recursive: true })
  await mkdir(join(source, 'src'), { recursive: true })
  await writeFile(join(source, installer), code)
  await copyFile(join(packageRoot, asset), join(source, asset))
  const contract = JSON.parse(await readFile(join(source, asset), 'utf8')) as {
    manifests: Record<string, string>; sources: Record<string, { commit: string; tree: string }>
  }
  const binaries: string[] = []
  for (const platform of Object.keys(contract.manifests)) {
    const target = join(source, 'vendor/ctxmux', platform)
    await mkdir(join(target, 'bin'), { recursive: true })
    await copyFile(join(packageRoot, 'vendor/ctxmux', platform, 'manifest.json'), join(target, 'manifest.json'))
    for (const name of ['ctxmux', 'ctxmuxd']) {
      const binary = join(target, 'bin', name)
      await copyFile(join(packageRoot, 'vendor/ctxmux', platform, 'bin', name), binary)
      await chmod(binary, 0o644)
      binaries.push(binary)
    }
  }
  const manifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
    files: string[]; scripts: { postinstall: string }
  }
  expect(manifest.scripts.postinstall).toBe('node bin/install-ctxmux.mjs')
  // This is a file-selection/lifecycle fixture, not a complete SDK package.
  // The original files and postinstall contract are retained; no build script
  // is run, disabled or claimed to have produced a complete published SDK.
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'agentmux-core-install-fixture',
    version: '0.0.0', private: true, files: manifest.files, scripts: { postinstall: manifest.scripts.postinstall } }))
  await writeFile(join(source, 'src/private-development-sentinel.ts'), 'not a published runtime asset\n')
  evidence({ event: 'fixture', source, originalInstallerSHA256: sha(original), executedInstallerSHA256: sha(code),
    mutation: process.env.AGENTMUX_CORE_INSTALL_MUTATION ?? null, contractSHA256: sha(await readFile(join(source, asset))),
    files: manifest.files, postinstall: manifest.scripts.postinstall, workerPid: process.pid })
  return { root, source, binaries, contract }
}

async function install(source: string) {
  const entry = join(source, installer)
  const entrySHA256 = sha(await readFile(entry))
  const operation = exec(process.execPath, [entry], { cwd: source, env: process.env, maxBuffer: 1024 * 1024 })
  evidence({ event: 'postinstall-spawn', executable: process.execPath, args: [entry],
    originalPid: operation.child.pid, entrySHA256 })
  try {
    const result = await operation
    evidence({ event: 'postinstall-result', originalPid: operation.child.pid, exitCode: 0, entrySHA256 })
    return result
  } catch (error) {
    const failure = error as Error & { code?: string | number; signal?: string; stderr?: string }
    evidence({ event: 'postinstall-result', originalPid: operation.child.pid, exitCode: failure.code ?? null,
      signal: failure.signal ?? null, entrySHA256, stderr: failure.stderr ?? failure.message })
    throw error
  }
}

it('Core installer succeeds from source-only contents without dist', async () => {
  const f = await fixture()
  await expect(stat(join(f.source, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.binaries).toHaveLength(4)
  await install(f.source)
  for (const binary of f.binaries) expect((await stat(binary)).mode & 0o777).toBe(0o755)
  await expect(stat(join(f.source, 'dist'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('Core installer survives actual npm file selection with only the source contract asset', async () => {
  const f = await fixture()
  const archiveDirectory = join(f.root, 'archives')
  await mkdir(archiveDirectory)
  const packed = await exec('npm', ['pack', '--json', '--pack-destination', archiveDirectory], {
    cwd: f.source, env: process.env, maxBuffer: 2 * 1024 * 1024
  })
  const metadata = JSON.parse(packed.stdout) as { filename: string; files: { path: string }[] }[]
  expect(metadata).toHaveLength(1)
  const selected = metadata[0]!.files.map(file => file.path)
  expect(selected.filter(file => file.startsWith('src/'))).toEqual([asset])
  expect(selected).toContain(installer)
  expect(selected.some(file => file.startsWith('dist/'))).toBe(false)
  const packedRoot = join(f.root, 'packed')
  await mkdir(packedRoot)
  const archive = join(archiveDirectory, metadata[0]!.filename)
  await exec('tar', ['-xzf', archive, '--strip-components=1', '-C', packedRoot])
  expect(sha(await readFile(join(packedRoot, asset)))).toBe(sha(await readFile(join(packageRoot, asset))))
  expect(sha(await readFile(join(packedRoot, installer)))).toBe(sha(await readFile(join(f.source, installer))))
  await expect(stat(join(packedRoot, 'src/private-development-sentinel.ts'))).rejects.toMatchObject({ code: 'ENOENT' })
  await install(packedRoot)
  for (const platform of Object.keys(f.contract.manifests)) for (const name of ['ctxmux', 'ctxmuxd']) {
    expect((await stat(join(packedRoot, 'vendor/ctxmux', platform, 'bin', name))).mode & 0o777).toBe(0o755)
  }
  evidence({ event: 'npm-selected-layout', selected, archiveSHA256: sha(await readFile(archive)),
    completeSdkPackage: false, realPostinstallExecuted: true })
})

it.each(['manifest', 'source', 'binary'] as const)('Core installer rejects damaged %s through its original guard', async kind => {
  const f = await fixture()
  const platform = Object.keys(f.contract.manifests)[0]!
  const manifestPath = join(f.source, 'vendor/ctxmux', platform, 'manifest.json')
  if (kind === 'manifest') {
    // Still valid JSON: removing its hash check must reach success, not a parser failure.
    await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')) + '\n')
  } else if (kind === 'source') {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.source.commit = 'unqualified-source'
    const bytes = JSON.stringify(manifest)
    await writeFile(manifestPath, bytes)
    // Admit the controlled manifest digest while keeping the expected source.
    f.contract.manifests[platform] = sha(bytes)
    await writeFile(join(f.source, asset), JSON.stringify(f.contract))
  } else {
    const bytes = await readFile(f.binaries[0]!)
    bytes[0] = bytes[0]! ^ 1
    await writeFile(f.binaries[0]!, bytes)
  }
  await expect(install(f.source)).rejects.toMatchObject({
    stderr: expect.stringContaining(`CtxMux installation ${kind} failed verification`)
  })
})
