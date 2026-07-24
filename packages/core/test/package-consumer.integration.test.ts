import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const packedConsumerFixture = fileURLToPath(new URL('./fixtures/packed-consumer.mjs', import.meta.url))
const controlFixture = fileURLToPath(new URL('./fixtures/ctxmux-terminal-control.mjs', import.meta.url))
const stubbornFixture = fileURLToPath(new URL('./fixtures/stubborn-process-tree.mjs', import.meta.url))
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

async function waitForSocket(
  path: string,
  daemon: ReturnType<typeof spawn>,
  stderr: () => string,
  spawnError: () => Error | null
): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() <= deadline) {
    if (spawnError()) throw spawnError()
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error(`Packed ctxmuxd exited before readiness: ${stderr()}`)
    }
    try {
      if ((await stat(path)).isSocket()) return
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  throw new Error(`Packed ctxmuxd did not create its socket: ${stderr()}`)
}

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')(
  'packed @agentmux/core ctxmux consumer',
  () => {
    it('runs the Shell vertical outside the checkout with the pinned SDK and binaries', async () => {
      const root = await mkdtemp('/private/tmp/agentmux-packed-ctxmux-')
      roots.push(root)
      const packDirectory = join(root, 'pack')
      const consumerDirectory = join(root, 'consumer')
      const runtimeDirectory = join(root, 'runtime')
      await Promise.all([
        mkdir(packDirectory),
        mkdir(consumerDirectory),
        mkdir(runtimeDirectory, { mode: 0o700 })
      ])
      await writeFile(join(consumerDirectory, 'package.json'), JSON.stringify({
        name: 'agentmux-external-consumer',
        private: true,
        type: 'module'
      }))

      const packed = await execFileAsync('pnpm', [
        '--filter',
        '@agentmux/core',
        'pack',
        '--pack-destination',
        packDirectory,
        '--json'
      ], {
        cwd: repositoryRoot,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, npm_config_ignore_scripts: 'true' }
      })
      const metadata = JSON.parse(packed.stdout) as {
        filename: string
        files: Array<{ path: string }>
      }
      const packedPaths = metadata.files.map((file) => file.path)
      expect(packedPaths).toContain('bin/agentmux.js')
      expect(packedPaths).not.toContain('bin/agentmuxd.js')
      expect(packedPaths).toContain('dist/index.d.ts')
      expect(packedPaths).toContain('vendor/ctxmux/darwin-arm64/manifest.json')
      expect(packedPaths).toContain('vendor/ctxmux/darwin-arm64/ctxmux-sdk-0.0.0.tgz')
      expect(packedPaths).toContain('vendor/ctxmux/darwin-arm64/bin/ctxmux')
      expect(packedPaths).toContain('vendor/ctxmux/darwin-arm64/bin/ctxmuxd')
      expect(packedPaths.some((path) => /agentmuxd|daemon-protocol|node-pty/u.test(path))).toBe(false)

      await execFileAsync('npm', [
        'install',
        '--offline',
        '--ignore-scripts',
        '--no-package-lock',
        '--no-save',
        metadata.filename
      ], {
        cwd: consumerDirectory,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024
      })
      await Promise.all([
        cp(packedConsumerFixture, join(consumerDirectory, 'packed-consumer.mjs')),
        cp(controlFixture, join(consumerDirectory, 'ctxmux-terminal-control.mjs')),
        cp(stubbornFixture, join(consumerDirectory, 'stubborn-process-tree.mjs'))
      ])

      const packageRoot = join(consumerDirectory, 'node_modules', '@agentmux', 'core')
      const resolvedPackageRoot = await realpath(packageRoot)
      expect(resolvedPackageRoot.startsWith(consumerDirectory)).toBe(true)
      expect(resolvedPackageRoot.startsWith(repositoryRoot)).toBe(false)
      const installedManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
      expect(installedManifest).toMatchObject({
        engines: { node: '>=22.0.0' },
        os: ['darwin'],
        cpu: ['arm64'],
        bin: {
          agentmux: './bin/agentmux.js',
          ctxmux: './vendor/ctxmux/darwin-arm64/bin/ctxmux',
          ctxmuxd: './vendor/ctxmux/darwin-arm64/bin/ctxmuxd'
        }
      })
      expect(installedManifest.dependencies).not.toHaveProperty('node-pty')
      expect(JSON.stringify(installedManifest)).not.toMatch(/(?:file|link):/u)

      const artifactManifest = JSON.parse(await readFile(
        join(packageRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'manifest.json'),
        'utf8'
      ))
      expect(artifactManifest.source).toMatchObject({
        commit: '3b94288c3a7896bb355e028135409c8e8bbaf764',
        tree: '58f3630477881e75f0f022d3fbb98a93ff2f46c4',
        worktree_clean: true
      })

      const socketPath = join(runtimeDirectory, 'ctxmux.sock')
      const stateDirectory = join(runtimeDirectory, 'state')
      const daemonPath = join(packageRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmuxd')
      const daemon = spawn(daemonPath, ['--socket', socketPath, '--state-dir', stateDirectory], {
        stdio: ['ignore', 'ignore', 'pipe']
      })
      let daemonStderr = ''
      let daemonSpawnError: Error | null = null
      daemon.once('error', (error) => { daemonSpawnError = error })
      daemon.stderr.setEncoding('utf8')
      daemon.stderr.on('data', (chunk) => { daemonStderr += chunk })
      try {
        await waitForSocket(socketPath, daemon, () => daemonStderr, () => daemonSpawnError)
        const result = await execFileAsync(process.execPath, ['packed-consumer.mjs'], {
          cwd: consumerDirectory,
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...process.env,
            AGENTMUX_CTXMUX_SOCKET: socketPath,
            AGENTMUX_CTXMUX_STATE: stateDirectory,
            AGENTMUX_CONTROL_FIXTURE: join(consumerDirectory, 'ctxmux-terminal-control.mjs'),
            AGENTMUX_STUBBORN_FIXTURE: join(consumerDirectory, 'stubborn-process-tree.mjs')
          }
        })
        expect(JSON.parse(result.stdout.trim())).toMatchObject({
          replayStartByte: 7,
          resize: '101x37',
          interruptStillLive: true,
          remote: 'unsupported'
        })
      } finally {
        if (daemon.pid && daemon.exitCode === null && daemon.signalCode === null) {
          const exited = once(daemon, 'exit')
          daemon.kill('SIGTERM')
          await exited.catch(() => {})
        }
      }
    }, 95_000)
  }
)
