import { execFile } from 'node:child_process'
import { chmod, cp, mkdtemp, mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const packedConsumerFixture = fileURLToPath(new URL('./fixtures/packed-consumer.mjs', import.meta.url))
const fakeSshFixture = fileURLToPath(new URL('./fixtures/fake-system-ssh.mjs', import.meta.url))
const roots: string[] = []
const supported = (
  (process.platform === 'darwin' || process.platform === 'linux') &&
  (process.arch === 'arm64' || process.arch === 'x64')
)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

describe.runIf(supported)('packed @agentmux/core consumer', () => {
  it('uses only public AgentMux Runtime APIs across Local, Agent, Doctor, and SSH lifecycles', async () => {
    const root = await mkdtemp('/tmp/agentmux-packed-consumer-test-')
    roots.push(root)
    const packDirectory = join(root, 'pack')
    const consumerDirectory = join(root, 'package')
    const deploymentDirectory = join(root, 'deployment')
    const remoteHome = join(root, 'remote-home')
    await Promise.all([
      mkdir(packDirectory),
      mkdir(remoteHome, { mode: 0o700 })
    ])
    const packed = await execFileAsync('pnpm', [
      '--filter',
      '@agentmux/core',
      'pack',
      '--pack-destination',
      packDirectory,
      '--json'
    ], {
      cwd: repositoryRoot,
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, npm_config_ignore_scripts: 'true' }
    })
    const metadata = JSON.parse(packed.stdout) as { filename: string; files: Array<{ path: string }> }
    const packedPaths = metadata.files.map((file) => file.path)
    expect(packedPaths).toContain('bin/agentmux.js')
    expect(packedPaths).toContain('bin/agentmuxd.js')
    expect(packedPaths).toContain('dist/index.d.ts')
    expect(packedPaths.some((path) => path.includes('tmux-client'))).toBe(false)

    await execFileAsync('tar', ['-xzf', metadata.filename, '-C', root])
    await execFileAsync('pnpm', [
      '--filter',
      '@agentmux/core',
      'deploy',
      '--legacy',
      deploymentDirectory
    ], { cwd: repositoryRoot, timeout: 30_000, maxBuffer: 4 * 1024 * 1024 })
    await rename(join(deploymentDirectory, 'node_modules'), join(consumerDirectory, 'node_modules'))
    await Promise.all([
      cp(packedConsumerFixture, join(consumerDirectory, 'packed-consumer.mjs')),
      cp(fakeSshFixture, join(consumerDirectory, 'fake-system-ssh.mjs'))
    ])
    await chmod(join(consumerDirectory, 'fake-system-ssh.mjs'), 0o755)

    const installedManifest = JSON.parse(await readFile(
      join(consumerDirectory, 'package.json'),
      'utf8'
    ))
    expect(installedManifest).toMatchObject({
      engines: { node: '>=22.0.0' },
      os: ['darwin', 'linux'],
      cpu: ['x64', 'arm64'],
      dependencies: { 'node-pty': '1.2.0-beta.15' },
      bin: { agentmux: './bin/agentmux.js', agentmuxd: './bin/agentmuxd.js' }
    })
    expect((await stat(join(consumerDirectory, 'bin', 'agentmux.js'))).mode & 0o111).not.toBe(0)

    const result = await execFileAsync(process.execPath, ['packed-consumer.mjs'], {
      cwd: consumerDirectory,
      timeout: 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, AGENTMUX_FAKE_SSH_HOME: remoteHome }
    })
    const summary = JSON.parse(result.stdout.trim())
    expect(summary).toMatchObject({
      local: { kind: 'local', reachable: true, hostId: 'local' },
      remote: { kind: 'ssh', reachable: true, hostId: 'packed-remote' },
      pty: { version: '1.2.0-beta.15', ready: true }
    })
    expect(summary.packageRoot).toContain(consumerDirectory)
    expect(summary.packageRoot).not.toContain(repositoryRoot)
  }, 95_000)
})
