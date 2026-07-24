import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
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
const ownerFenceFixture = fileURLToPath(new URL('./fixtures/ctxmux-owner-fence.mjs', import.meta.url))
const controlFixture = fileURLToPath(new URL('./fixtures/ctxmux-terminal-control.mjs', import.meta.url))
const stubbornFixture = fileURLToPath(new URL('./fixtures/stubborn-process-tree.mjs', import.meta.url))
const fakeCodexFixture = fileURLToPath(new URL('./fixtures/fake-codex-cli.mjs', import.meta.url))
const lifecycleCrashFixture = fileURLToPath(new URL('./fixtures/lifecycle-crash-worker.mjs', import.meta.url))
const promptCrashFixture = fileURLToPath(new URL('./fixtures/prompt-submit-crash-worker.mjs', import.meta.url))
const runtimeScopePreloadFixture = fileURLToPath(new URL('./fixtures/runtime-scope-preload.mjs', import.meta.url))
const ctxmuxRuntimeId = '88e8377ecc4341b655d47306'
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

async function waitForDaemonReady(
  path: string,
  cliPath: string,
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
      if ((await stat(path)).isSocket()) {
        await execFileAsync(cliPath, ['--socket', path, 'ping'], {
          timeout: 2_000,
          maxBuffer: 64 * 1024
        })
        return
      }
    } catch {}
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  throw new Error(`Packed ctxmuxd did not become ready: ${stderr()}`)
}

type DaemonProcess = {
  pid: number
  socketPath: string
  stateDirectory: string
}

async function daemonProcesses(daemonPath: string, runtimeDirectory: string): Promise<DaemonProcess[]> {
  const result = await execFileAsync('ps', ['-axo', 'pid=,command='], {
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024
  })
  return result.stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
    if (!match) return []
    const args = match[2]!.trim().split(/\s+/u)
    const executableIndex = args.indexOf(daemonPath)
    const socketIndex = args.indexOf('--socket')
    const stateIndex = args.indexOf('--state-dir')
    const socketPath = args[socketIndex + 1]
    const stateDirectory = args[stateIndex + 1]
    if (
      executableIndex < 0 ||
      socketIndex < 0 ||
      stateIndex < 0 ||
      !socketPath?.startsWith(runtimeDirectory) ||
      !stateDirectory?.startsWith(runtimeDirectory)
    ) return []
    return [{
      pid: Number(match[1]),
      socketPath,
      stateDirectory
    }]
  })
}

async function waitForDaemonProcess(
  daemonPath: string,
  runtimeDirectory: string
): Promise<DaemonProcess> {
  const deadline = Date.now() + 5_000
  while (Date.now() <= deadline) {
    const processes = await daemonProcesses(daemonPath, runtimeDirectory)
    if (processes.length === 1) return processes[0]!
    if (processes.length > 1) throw new Error('Multiple packed ctxmuxd owners share one runtime root.')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  throw new Error('AgentMux did not activate its packed ctxmuxd owner.')
}

async function stopDaemon(daemon: DaemonProcess): Promise<void> {
  try {
    process.kill(daemon.pid, 'SIGTERM')
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
  }
  const deadline = Date.now() + 5_000
  while (Date.now() <= deadline) {
    try {
      process.kill(daemon.pid, 0)
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return
      throw error
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  throw new Error(`CtxMux daemon ${daemon.pid} did not stop.`)
}

describe.runIf(process.platform === 'darwin' && process.arch === 'arm64')(
  'packed @agentmux/core ctxmux consumer',
  () => {
    it('runs the Shell vertical outside the checkout with the pinned SDK and binaries', async () => {
      const root = await mkdtemp('/private/tmp/agentmux-packed-ctxmux-')
      roots.push(root)
      const packDirectory = join(root, 'pack')
      const consumerDirectory = join(root, 'consumer')
      const testUid = `t${process.pid}-${randomUUID().slice(0, 8)}`
      const runtimeDirectory = join('/private/tmp', `amx-${testUid}-${ctxmuxRuntimeId}`)
      roots.push(runtimeDirectory)
      await Promise.all([
        mkdir(packDirectory),
        mkdir(consumerDirectory, { recursive: true }),
        mkdir(join(consumerDirectory, 'bin'), { recursive: true }),
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
        cp(ownerFenceFixture, join(consumerDirectory, 'ctxmux-owner-fence.mjs')),
        cp(controlFixture, join(consumerDirectory, 'ctxmux-terminal-control.mjs')),
        cp(stubbornFixture, join(consumerDirectory, 'stubborn-process-tree.mjs')),
        cp(fakeCodexFixture, join(consumerDirectory, 'bin', 'codex')),
        cp(lifecycleCrashFixture, join(consumerDirectory, 'lifecycle-crash-worker.mjs')),
        cp(promptCrashFixture, join(consumerDirectory, 'prompt-submit-crash-worker.mjs')),
        cp(runtimeScopePreloadFixture, join(consumerDirectory, 'runtime-scope-preload.mjs'))
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
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          './runtime': { types: './dist/runtime.d.ts', import: './dist/runtime.js' }
        },
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
        commit: '2e32a9d647d627952ea5c455fb2efef6c636643a',
        tree: 'd60870c2481c9b153da6bf22f829d24afb8a81a8',
        worktree_clean: true
      })

      const daemonPath = join(packageRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmuxd')
      const cliPath = join(packageRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmux')
      const runtimeEnvironment = {
        ...process.env,
        NO_COLOR: '1',
        AGENTMUX_TEST_UID: testUid,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--import=${join(consumerDirectory, 'runtime-scope-preload.mjs')}`
        ].filter(Boolean).join(' ')
      }
      let activeDaemon: DaemonProcess | null = null
      let replacement: ReturnType<typeof spawn> | null = null
      try {
        const result = await execFileAsync(process.execPath, ['packed-consumer.mjs'], {
          cwd: consumerDirectory,
          timeout: 60_000,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...runtimeEnvironment,
            PATH: `${join(consumerDirectory, 'bin')}:${process.env.PATH ?? ''}`,
            AGENTMUX_CONTROL_FIXTURE: join(consumerDirectory, 'ctxmux-terminal-control.mjs'),
            AGENTMUX_STUBBORN_FIXTURE: join(consumerDirectory, 'stubborn-process-tree.mjs'),
            AGENTMUX_FAKE_CODEX: join(consumerDirectory, 'bin', 'codex'),
            AGENTMUX_LIFECYCLE_CRASH_FIXTURE: join(consumerDirectory, 'lifecycle-crash-worker.mjs'),
            AGENTMUX_PROMPT_CRASH_FIXTURE: join(consumerDirectory, 'prompt-submit-crash-worker.mjs'),
            AGENTMUX_CLI_PATH: join(consumerDirectory, 'node_modules', '.bin', 'agentmux')
          }
        })
        expect(JSON.parse(result.stdout.trim())).toMatchObject({
          replayStartByte: 7,
          sharedReplayWhileAttached: true,
          agentSharedReplayWhileAttached: true,
          multiViewAcknowledgementMonotonic: true,
          resize: '101x37',
          interruptStillLive: true,
          dedupOccurrences: 1,
          codexSemanticSession: 'codex-semantic-1',
          codexNativeSession: 'native-codex-semantic-1',
          terminalHandshake: 'query-ack-prompt',
          stopEpochReadiness: [
            'missing-stop-rejected-before-payload',
            'tail-lookbehind-ready',
            'post-cursor-live-ready',
            'concurrent-single-consumer',
            'crash-recovered-once'
          ],
          promptCrashRecovery: true,
          cliResolveKinds: ['agent-session', 'provider-native', 'acp-native', 'run'],
          externalSwitch: true,
          naturalTerminalStop: true,
          crashRecovery: true,
          remote: 'unsupported'
        })

        activeDaemon = await waitForDaemonProcess(daemonPath, runtimeDirectory)
        await stopDaemon(activeDaemon)
        const replacementStateDirectory = join(runtimeDirectory, 'replacement-state')
        await mkdir(replacementStateDirectory, { mode: 0o700 })
        replacement = spawn(daemonPath, [
          '--socket', activeDaemon.socketPath,
          '--state-dir', replacementStateDirectory
        ], { stdio: ['ignore', 'ignore', 'pipe'] })
        let replacementStderr = ''
        let replacementError: Error | null = null
        replacement.once('error', (error) => { replacementError = error })
        replacement.stderr?.setEncoding('utf8')
        replacement.stderr?.on('data', (chunk) => { replacementStderr += chunk })
        await waitForDaemonReady(
          activeDaemon.socketPath,
          cliPath,
          replacement,
          () => replacementStderr,
          () => replacementError
        )
        const fenced = await execFileAsync(process.execPath, ['ctxmux-owner-fence.mjs'], {
          cwd: consumerDirectory,
          timeout: 15_000,
          maxBuffer: 4 * 1024 * 1024,
          env: runtimeEnvironment
        })
        expect(fenced.stdout.trim()).toBe('ctxmux-owner-fence-ok')
      } finally {
        if (replacement?.pid && replacement.exitCode === null && replacement.signalCode === null) {
          const exited = once(replacement, 'exit')
          replacement.kill('SIGTERM')
          await exited.catch(() => {})
        }
        for (const daemon of await daemonProcesses(daemonPath, runtimeDirectory)) {
          await stopDaemon(daemon)
        }
      }
    }, 95_000)
  }
)
