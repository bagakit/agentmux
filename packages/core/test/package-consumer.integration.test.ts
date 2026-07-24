import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
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
const ownerReceiptFailureFixture = fileURLToPath(new URL('./fixtures/ctxmux-owner-receipt-failure.mjs', import.meta.url))
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

function processIsGone(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ESRCH') return true
    throw error
  }
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

async function stopDaemonRuns(cliPath: string, daemon: DaemonProcess): Promise<void> {
  const listed = await execFileAsync(cliPath, ['--socket', daemon.socketPath, 'list'], {
    timeout: 5_000,
    maxBuffer: 4 * 1024 * 1024
  })
  const runningRunIds = listed.stdout.split('\n').flatMap((line) => {
    const [runId, state] = line.split('\t')
    return runId && state === 'running' ? [runId] : []
  })
  const stopped = await Promise.allSettled(runningRunIds.map(async (runId) => {
    await execFileAsync(cliPath, ['--socket', daemon.socketPath, 'stop', runId], {
      timeout: 10_000,
      maxBuffer: 256 * 1024
    })
  }))
  const errors = stopped.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length > 0) {
    throw new AggregateError(errors, 'Packed consumer cleanup could not stop every live CtxMux Run.')
  }
}

async function stopDaemonAndRuns(cliPath: string, daemon: DaemonProcess): Promise<void> {
  let failure: unknown = null
  try {
    await stopDaemonRuns(cliPath, daemon)
  } catch (error) {
    failure = error
  }
  try {
    await stopDaemon(daemon)
  } catch (error) {
    failure = failure
      ? new AggregateError([failure, error], 'Packed consumer Run and daemon cleanup both failed.')
      : error
  }
  if (failure) throw failure
}

async function waitForNoDaemon(daemonPath: string, runtimeDirectory: string): Promise<void> {
  const deadline = Date.now() + 5_000
  while (Date.now() <= deadline) {
    if ((await daemonProcesses(daemonPath, runtimeDirectory)).length === 0) return
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20))
  }
  throw new Error('AgentMux left a ctxmuxd process after failed owner receipt commit.')
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
      const packedHeadless = await execFileAsync('npm', [
        'pack',
        resolve(repositoryRoot, 'packages/core/node_modules/@xterm/headless'),
        '--pack-destination',
        packDirectory
      ], {
        cwd: repositoryRoot,
        timeout: 60_000,
        maxBuffer: 8 * 1024 * 1024
      })
      const headlessArchive = join(packDirectory, packedHeadless.stdout.trim().split(/\r?\n/u).at(-1)!)
      const packedPaths = metadata.files.map((file) => file.path)
      expect(packedPaths).toContain('bin/agentmux')
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
        headlessArchive,
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
        cp(runtimeScopePreloadFixture, join(consumerDirectory, 'runtime-scope-preload.mjs')),
        cp(ownerReceiptFailureFixture, join(consumerDirectory, 'ctxmux-owner-receipt-failure.mjs'))
      ])

      const packageRoot = join(consumerDirectory, 'node_modules', '@agentmux', 'core')
      const resolvedPackageRoot = await realpath(packageRoot)
      expect(resolvedPackageRoot.startsWith(consumerDirectory)).toBe(true)
      expect(resolvedPackageRoot.startsWith(repositoryRoot)).toBe(false)
      const installedManifest = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'))
      expect(installedManifest).toMatchObject({
        license: 'UNLICENSED',
        repository: {
          type: 'git',
          url: 'git+ssh://git@github.com/bagakit/agentmux.git',
          directory: 'packages/core'
        },
        engines: { node: '>=22.0.0' },
        os: ['darwin'],
        cpu: ['arm64'],
        exports: {
          '.': { types: './dist/index.d.ts', import: './dist/index.js' },
          './runtime': { types: './dist/runtime.d.ts', import: './dist/runtime.js' }
        },
        bin: {
          agentmux: './bin/agentmux',
          ctxmux: './vendor/ctxmux/darwin-arm64/bin/ctxmux',
          ctxmuxd: './vendor/ctxmux/darwin-arm64/bin/ctxmuxd'
        }
      })
      expect(installedManifest.dependencies).not.toHaveProperty('node-pty')
      expect(installedManifest.dependencies).toEqual({ '@xterm/headless': '5.5.0' })
      expect(JSON.stringify(installedManifest)).not.toMatch(/(?:file|link):/u)
      await Promise.all([
        writeFile(join(consumerDirectory, 'consumer.ts'), [
          "import type { AgentMuxAgentSession, AgentMuxRuntimeDiagnostics } from '@agentmux/core'",
          "const platform: AgentMuxRuntimeDiagnostics['platform'] = 'darwin'",
          'const session = null as AgentMuxAgentSession | null',
          'void platform',
          'void session',
          ''
        ].join('\n')),
        writeFile(join(consumerDirectory, 'tsconfig.json'), `${JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ES2022',
            module: 'NodeNext',
            moduleResolution: 'NodeNext',
            lib: ['ES2022', 'DOM'],
            types: [],
            skipLibCheck: false
          },
          files: ['consumer.ts']
        }, null, 2)}\n`)
      ])
      await execFileAsync(join(repositoryRoot, 'node_modules', '.bin', 'tsc'), [
        '--project', join(consumerDirectory, 'tsconfig.json')
      ], {
        cwd: consumerDirectory,
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024
      })

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
      let cleanupSentinelPid: number | null = null
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
        const consumerReceipt = JSON.parse(result.stdout.trim()) as { cleanupSentinelPid: number }
        expect(consumerReceipt).toMatchObject({
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
          doctor: true,
          cliResolveKinds: ['agent-session', 'provider-native', 'acp-native', 'run'],
          externalSwitch: true,
          naturalTerminalStop: true,
          crashRecovery: true,
          remote: 'unsupported'
        })
        cleanupSentinelPid = consumerReceipt.cleanupSentinelPid
        expect(Number.isInteger(cleanupSentinelPid) && cleanupSentinelPid > 0).toBe(true)

        activeDaemon = await waitForDaemonProcess(daemonPath, runtimeDirectory)
        await stopDaemon(activeDaemon)
        const missingDaemonPath = `${daemonPath}.doctor-missing`
        await rename(daemonPath, missingDaemonPath)
        try {
          const doctorEnvironment = {
            ...runtimeEnvironment,
            PATH: `${join(consumerDirectory, 'bin')}:${process.env.PATH ?? ''}`
          }
          const jsonFailure = await execFileAsync(
            join(consumerDirectory, 'node_modules', '.bin', 'agentmux'),
            ['doctor', '--json'],
            { cwd: consumerDirectory, env: doctorEnvironment }
          ).then(
            () => null,
            (error: NodeJS.ErrnoException & { stdout?: string }) => error
          )
          expect(jsonFailure?.code).toBe(1)
          expect(JSON.parse(jsonFailure?.stdout ?? '')).toMatchObject({
            ok: false,
            host: {
              reachable: false,
              action: 'Verify the bundled ctxmux artifacts, then rerun doctor.'
            },
            hosts: {
              local: { status: 'unavailable' },
              remote: { status: 'unsupported' }
            }
          })
          const plainFailure = await execFileAsync(
            join(consumerDirectory, 'node_modules', '.bin', 'agentmux'),
            ['doctor'],
            { cwd: consumerDirectory, env: doctorEnvironment }
          ).then(
            () => null,
            (error: NodeJS.ErrnoException & { stdout?: string }) => error
          )
          expect(plainFailure?.code).toBe(1)
          expect(plainFailure?.stdout).toContain('Host action: Verify the bundled ctxmux artifacts')
          expect(plainFailure?.stdout).toContain('Remote action: Remote is unsupported')
          expect(plainFailure?.stdout).toContain('Action: Restore the Runtime connection')
        } finally {
          await rename(missingDaemonPath, daemonPath)
        }
        const ownerReceiptPath = join(runtimeDirectory, 'owner.json')
        await rm(ownerReceiptPath, { force: true })
        await mkdir(ownerReceiptPath)
        const receiptFailure = await execFileAsync(
          process.execPath,
          ['ctxmux-owner-receipt-failure.mjs'],
          {
            cwd: consumerDirectory,
            timeout: 15_000,
            maxBuffer: 2 * 1024 * 1024,
            env: runtimeEnvironment
          }
        )
        expect(JSON.parse(receiptFailure.stdout.trim())).toMatchObject({ rejected: true })
        await waitForNoDaemon(daemonPath, runtimeDirectory)
        expect((await readdir(runtimeDirectory)).some((entry) => entry.startsWith('.owner-'))).toBe(false)
        await rm(ownerReceiptPath, { recursive: true, force: true })

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
          await stopDaemonAndRuns(cliPath, daemon)
        }
      }
      if (cleanupSentinelPid !== null) {
        expect(processIsGone(cleanupSentinelPid)).toBe(true)
      }
    }, 95_000)
  }
)
