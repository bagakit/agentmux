import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

import { CTXMUX_MANIFEST_SHA256 } from '../src/runtime-paths.js'

const execFileAsync = promisify(execFile)
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const packedConsumerFixture = fileURLToPath(new URL('./fixtures/packed-consumer.mjs', import.meta.url))
const compatibleRuntimeFixture = fileURLToPath(new URL('./fixtures/ctxmux-compatible-runtime.mjs', import.meta.url))
const controlFixture = fileURLToPath(new URL('./fixtures/ctxmux-terminal-control.mjs', import.meta.url))
const stubbornFixture = fileURLToPath(new URL('./fixtures/stubborn-process-tree.mjs', import.meta.url))
const fakeCodexFixture = fileURLToPath(new URL('./fixtures/fake-codex-cli.mjs', import.meta.url))
const lifecycleCrashFixture = fileURLToPath(new URL('./fixtures/lifecycle-crash-worker.mjs', import.meta.url))
const promptCrashFixture = fileURLToPath(new URL('./fixtures/prompt-submit-crash-worker.mjs', import.meta.url))
const interactionCrashFixture = fileURLToPath(new URL('./fixtures/interaction-response-crash-worker.mjs', import.meta.url))
const runtimeScopePreloadFixture = fileURLToPath(new URL('./fixtures/runtime-scope-preload.mjs', import.meta.url))
const ownerRelocationFixture = fileURLToPath(new URL('./fixtures/ctxmux-owner-relocation.mjs', import.meta.url))
const liveRuntimeFenceFixture = fileURLToPath(new URL('./fixtures/ctxmux-live-runtime-fence.mjs', import.meta.url))
const stopResponseLossFixture = fileURLToPath(new URL('./fixtures/ctxmux-stop-response-loss-worker.mjs', import.meta.url))
const stopRecoveryFixture = fileURLToPath(new URL('./fixtures/ctxmux-stop-recovery-worker.mjs', import.meta.url))
const ctxmuxRuntimeId = createHash('sha256').update(CTXMUX_MANIFEST_SHA256).digest('hex').slice(0, 24)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

/**
 * 等打包出来的 ctxmuxd 起来接受 ping。
 *
 * **没有挂钟预算。** 三条真正的终止条件都在环内：spawn 失败、进程自己退出、ping 成功。这三条覆盖了
 * 所有失败模式，剩下的"还没起来"只是慢。上界由外层持有——这条 it 自己声明了 95 秒。
 *
 * 原先环上另有一个 5 秒 deadline。它在机器被压满时会**先于**外层触发，把"慢"报成"起不来"：实测
 * 2026-09-01 负载 ~120 时，同一份构建里解一个 84KB tarball 花了 3 分 42 秒挂钟而只用 0.01 秒 CPU，
 * 纯调度饥饿。两个预算守同一件事时，短的那个只贡献假阴性。
 *
 * ping 自身保留 `timeout`：那是**对端可能永不回答**的调用（socket 在但守护进程卡住），而这一层的
 * 循环会重试，所以砍掉一次慢 ping 不丢信息。这正是挂钟预算该用的地方，与上面那个删掉的不同。
 */
async function waitForDaemonReady(
  path: string,
  cliPath: string,
  daemon: ReturnType<typeof spawn>,
  stderr: () => string,
  spawnError: () => Error | null
): Promise<void> {
  for (;;) {
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

async function readJsonLine(
  lines: AsyncIterator<string>,
  label: string
): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const result = await Promise.race([
      lines.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), 5_000)
      })
    ])
    if (result.done) throw new Error(`Packed child closed before ${label}.`)
    const parsed: unknown = JSON.parse(result.value)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`Packed child emitted an invalid ${label}.`)
    }
    return parsed as Record<string, unknown>
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type StopResponseLossProxy = {
  dropped: Promise<void>
  restore(): Promise<void>
}

async function installStopResponseLossProxy(socketPath: string): Promise<StopResponseLossProxy> {
  const upstreamPath = join(dirname(socketPath), `.stop-${randomUUID().slice(0, 8)}.sock`)
  await rename(socketPath, upstreamPath)
  const pairs = new Set<{ downstream: Socket; upstream: Socket }>()
  let settled = false
  let resolveDropped!: () => void
  let rejectDropped!: (error: Error) => void
  const dropped = new Promise<void>((resolve, reject) => {
    resolveDropped = resolve
    rejectDropped = reject
  })
  void dropped.catch(() => {})
  const fail = (error: Error): void => {
    if (settled) return
    settled = true
    rejectDropped(error)
  }
  const server: Server = createServer((downstream) => {
    const upstream = createConnection(upstreamPath)
    const pair = { downstream, upstream }
    pairs.add(pair)
    let requestWindow = ''
    let responseBuffer = ''
    let recoverableStopRequested = false
    const remove = (): void => { pairs.delete(pair) }
    downstream.on('data', (chunk: Buffer) => {
      requestWindow = `${requestWindow}${chunk.toString('utf8')}`.slice(-64 * 1024)
      if (requestWindow.includes('"type":"attach_recoverable_stop"')) {
        recoverableStopRequested = true
      }
      if (!upstream.destroyed) upstream.write(chunk)
    })
    upstream.on('data', (chunk: Buffer) => {
      responseBuffer += chunk.toString('utf8')
      while (true) {
        const newline = responseBuffer.indexOf('\n')
        if (newline < 0) return
        const line = responseBuffer.slice(0, newline)
        responseBuffer = responseBuffer.slice(newline + 1)
        let frame: unknown = null
        try { frame = JSON.parse(line) } catch {}
        if (
          recoverableStopRequested &&
          typeof frame === 'object' &&
          frame !== null &&
          !Array.isArray(frame) &&
          (frame as { type?: unknown }).type === 'response'
        ) {
          if (!settled) {
            settled = true
            resolveDropped()
          }
          downstream.destroy()
          upstream.destroy()
          return
        }
        if (!downstream.destroyed) downstream.write(`${line}\n`)
      }
    })
    downstream.once('error', (error) => {
      upstream.destroy()
      if (!recoverableStopRequested) fail(error)
    })
    upstream.once('error', (error) => {
      downstream.destroy()
      if (!recoverableStopRequested) fail(error)
    })
    downstream.once('close', remove)
    upstream.once('close', remove)
    downstream.once('end', () => upstream.end())
    upstream.once('end', () => downstream.end())
  })
  server.once('error', fail)
  try {
    server.listen(socketPath)
    await once(server, 'listening')
  } catch (error) {
    await rm(socketPath, { force: true })
    await rename(upstreamPath, socketPath)
    throw error
  }
  let restored = false
  return {
    dropped,
    async restore() {
      if (restored) return
      restored = true
      for (const pair of pairs) {
        pair.downstream.destroy()
        pair.upstream.destroy()
      }
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
      await rm(socketPath, { force: true })
      await rename(upstreamPath, socketPath)
    }
  }
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

      // 这个包必须由**已经存在的** dist 打成，绝不能让 pack 顺手重建它。
      //
      // 之前走 `pnpm --filter @agentmux/core pack`，pnpm 一定跑 prepack（= `pnpm build`），而 build
      // 的第一步是 scripts/clean-build.mjs 对整个 dist/ 做 rm -rf，再由 tsc 重建——留下约 2 秒 dist
      // 为空的窗口（实测 0.15s 采样抓到连续 14 次 GONE）。同一批跑的 agentmux-cli-help.test.ts 正好
      // execFile bin/agentmux，而那个文件只有一行 `import '../dist/agentmux.js'`，于是成片红在
      // ERR_MODULE_NOT_FOUND——症状像构建坏了，真因是共享可变状态。单跑 15/15 绿，组合跑 13 红。
      //
      // 换成 `npm pack --ignore-scripts` 是消除那份共享可变状态，不是靠排程回避：dist 不再被这个测试
      // 写，于是任何读 dist 的测试都能与它同批跑。`npm_config_ignore_scripts: 'true'` 这个环境变量对
      // pnpm 无效（实测 prepack 照跑，stderr 里能看到 `$ pnpm build`），`pnpm pack` 也没有跳过脚本的
      // 开关（`--ignore-scripts` 被它当未知选项拒绝），所以只能走 npm 的 pack。
      //
      // 代价是一个此前隐式、现在必须显式的前提：dist 得是当前源码的产物。测试脚本本来就是
      // `pnpm build && vitest run`，但那个顺序过去由 prepack 兜底，现在不再有。这个前提由
      // `vitest.dist-freshness.ts` 的 globalSetup 钉住，对**每一次** vitest 运行生效（含只点名单个
      // 文件的那种），所以这里不再自己断言一遍。此前这道判据是本文件的一个私有函数，被三重关住
      // ——只在 `runIf(darwin && arm64)` 里调、文件被 test:fast 排掉、唯一会跑它的 test:native 又
      // 自己前置了 build——也就是永远不可能红。搬到 globalSetup 才让它真的守到东西。
      // 下面这些 `execFileAsync` 都没有挂钟预算，判据同 `waitForDaemonReady` 那段（见 :92 起）：
      // npm 的 pack/install、tsc、以及本测试自己起的那几个 worker fixture，都是**本机对固定输入的
      // 确定性步骤**——它们一定会答，被压满时只是慢。期限由外层 `it(…, 95_000)` 持有；再插一个更短的
      // 预算只贡献假阴性，而且 `execFile` 的超时错误从不说自己是超时，会把「慢」伪装成「坏」。
      // 保留 `timeout` 的是另一类：`ps`、以及经 socket 找/停守护进程那几处——socket 在而进程卡住时，
      // 对端可能永不回答。
      const packed = await execFileAsync('npm', [
        'pack',
        '--ignore-scripts',
        '--pack-destination',
        packDirectory,
        '--json'
      ], {
        cwd: resolve(repositoryRoot, 'packages/core'),
        maxBuffer: 8 * 1024 * 1024
      })
      // npm pack --json 给的是数组（一次可打多个包），pnpm 给的是单个对象。
      const packedManifests = JSON.parse(packed.stdout) as Array<{
        filename: string
        files: Array<{ path: string }>
      }>
      expect(packedManifests).toHaveLength(1)
      const metadata = packedManifests[0]!
      // npm pack 的 filename 是裸文件名（pnpm 给的是可解析路径）。下面 npm install 的 cwd 是
      // consumerDirectory，裸名会被当成 consumer 目录里的文件而找不到，所以在这里拼成绝对路径。
      const packedArchive = join(packDirectory, metadata.filename)
      const packedHeadless = await execFileAsync('npm', [
        'pack',
        resolve(repositoryRoot, 'packages/core/node_modules/@xterm/headless'),
        '--pack-destination',
        packDirectory
      ], {
        cwd: repositoryRoot,
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
        packedArchive
      ], {
        cwd: consumerDirectory,
        maxBuffer: 8 * 1024 * 1024
      })
      await Promise.all([
        cp(packedConsumerFixture, join(consumerDirectory, 'packed-consumer.mjs')),
        cp(compatibleRuntimeFixture, join(consumerDirectory, 'ctxmux-compatible-runtime.mjs')),
        cp(controlFixture, join(consumerDirectory, 'ctxmux-terminal-control.mjs')),
        cp(stubbornFixture, join(consumerDirectory, 'stubborn-process-tree.mjs')),
        cp(fakeCodexFixture, join(consumerDirectory, 'bin', 'codex')),
        cp(lifecycleCrashFixture, join(consumerDirectory, 'lifecycle-crash-worker.mjs')),
        cp(promptCrashFixture, join(consumerDirectory, 'prompt-submit-crash-worker.mjs')),
        cp(interactionCrashFixture, join(consumerDirectory, 'interaction-response-crash-worker.mjs')),
        cp(runtimeScopePreloadFixture, join(consumerDirectory, 'runtime-scope-preload.mjs')),
        cp(ownerRelocationFixture, join(consumerDirectory, 'ctxmux-owner-relocation.mjs')),
        cp(liveRuntimeFenceFixture, join(consumerDirectory, 'ctxmux-live-runtime-fence.mjs')),
        cp(stopResponseLossFixture, join(consumerDirectory, 'ctxmux-stop-response-loss-worker.mjs')),
        cp(stopRecoveryFixture, join(consumerDirectory, 'ctxmux-stop-recovery-worker.mjs'))
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
        engines: { node: '>=24.0.0' },
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
      expect(installedManifest.dependencies).toEqual({ '@xterm/headless': '5.5.0', yaml: '2.9.0' })
      expect(JSON.stringify(installedManifest)).not.toMatch(/(?:file|link):/u)
      await Promise.all([
        writeFile(join(consumerDirectory, 'consumer.ts'), [
          "import type { AgentMuxAgentSession, AgentMuxRuntimeDiagnostics } from '@agentmux/core'",
          // 整个导出面也要一起编。只 import 两个 type 时，其余 .d.ts 全靠 skipLibCheck:false 顺带扫到——
          // 那是碰巧，不是保证。types:[] 下这行让「导出面不依赖 Node 全局」变成显式契约：
          // 任何一处把 Buffer / NodeJS.* 写进公共签名，这条立刻红（durable-write 就这么漏过一次）。
          "import type * as AgentMuxCore from '@agentmux/core'",
          "const platform: AgentMuxRuntimeDiagnostics['platform'] = 'darwin'",
          'const session = null as AgentMuxAgentSession | null',
          'const surface = null as unknown as typeof AgentMuxCore',
          'void platform',
          'void session',
          'void surface',
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
      // tsc 把诊断写在 stdout，execFile 的 Error 只带一句 "Command failed"。吞掉诊断会让「打包出去的
      // .d.ts 编不过」退化成一条无从下手的报错——把诊断原样抛出来，失败时才指得到具体那一行。
      try {
        await execFileAsync(join(repositoryRoot, 'node_modules', '.bin', 'tsc'), [
          '--project', join(consumerDirectory, 'tsconfig.json')
        ], {
          cwd: consumerDirectory,
          maxBuffer: 2 * 1024 * 1024
        })
      } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; message: string }
        throw new Error(`Packed @agentmux/core types do not compile for a consumer:\n${
          [failure.stdout, failure.stderr].filter(Boolean).join('\n').trim() || failure.message
        }`)
      }

      const artifactManifest = JSON.parse(await readFile(
        join(packageRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'manifest.json'),
        'utf8'
      ))
      expect(artifactManifest.source).toMatchObject({
        commit: 'aaadb6843ae2c8fa71565e2d72ddd4b4c6fede02',
        tree: '1d97495e717cce1c3ac588a3c0712d9555b5c871',
        worktree_clean: true
      })

      const daemonPath = join(packageRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmuxd')
      const cliPath = join(packageRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmux')
      // 这个测试靠合成 uid 把 runtime 目录（socket/state/hook-port）与真机隔离开。但隔离只管
      // **派生**的那些路径：`AGENTMUX_AGENT_SESSION_STORE` 等 env 是**覆盖**，会直接盖过派生值。
      // 当这条测试跑在一个已安装的 AgentMux.app 开出的终端里时，`...process.env` 会把 app 注入的
      // `AGENTMUX_AGENT_SESSION_STORE`（指向 Desktop 在 `~/Library/Application Support/` 下的 userData 目录）
      // 一路带进消费者，于是消费者读到的是**真机上那些活着的 Agent Session**。registry 非空 →
      // 每个 Client 在 open() 里都去 `tryRestoreHookIngress()` 抢 Hook 端口 → 先建的那个 Client
      // 一直占着，后面 `createAgent` 撞 EADDRINUSE，报成
      // `Another AgentMux client owns the Hook ingress`。报错句式指向"另一个 App"，真凶却是本进程
      // 自己先前那个 Client；2026-09-12 实测抓到五次 bind 全在同一个 pid 上。
      //
      // 这个测试本身从不读取环境里的 `AGENTMUX_*`——它要的每一个都在下面显式赋值。所以整族直接剥掉，
      // 别逐个点名：漏掉一个就是又一次静默串台，而新增的覆盖项会自动落在这条规则里。
      const ambientFreeEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_'))
      )
      const runtimeEnvironment = {
        ...ambientFreeEnvironment,
        NO_COLOR: '1',
        AGENTMUX_TEST_UID: testUid,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS,
          `--import=${join(consumerDirectory, 'runtime-scope-preload.mjs')}`
        ].filter(Boolean).join(' ')
      }
      let activeDaemon: DaemonProcess | null = null
      let replacement: ReturnType<typeof spawn> | null = null
      let liveRuntimeFence: ReturnType<typeof spawn> | null = null
      let stopResponseLossWorker: ReturnType<typeof spawn> | null = null
      let stopResponseLossProxy: StopResponseLossProxy | null = null
      let cleanupSentinelPid: number | null = null
      try {
        // 这里**没有**挂钟预算。期限由外层那个 `it(…, 95_000)` 持有，两个预算守同一件事时，短的
        // 那个只贡献假阴性：它一到点就 SIGTERM 掉整个消费者进程，而进程本来只是在被压满的机器上
        // 变慢。实测（2026-09-01，负载 ~55）：`[packed-consumer] still waiting for handshake race
        // controlled composer pending` 一路数到 50s，然后在 63.55s 整个测试失败——不是里面哪个
        // 等待放弃了，是这条 60 秒把它砍了。
        //
        // 更糟的是 `execFile` 的超时错误**从不说自己是超时**：它只报
        // `Command failed: … packed-consumer.mjs`，`code: null`、`killed: true`、`signal: SIGTERM`，
        // 消息里绝口不提。于是「消费者被外层砍掉」和「消费者自己崩了」长成同一个样子，这个 flake
        // 因此被登记成 handshake 超时并追错了位点。留下来的诊断行现在会点名卡住的那次等待。
        // 消费者的 stderr 边到边转发到本进程，**不能**只靠 execFile 把它攒在 buffer 里：vitest 在
        // 外层 95 秒掐掉这条 it 时，那个 buffer 连同 reject 一起被丢掉，于是最需要诊断的那条路径
        // （整体卡死）反而一行都不留。实测 2026-09-01 有三次 `Test timed out in 95000ms` 就是这样，
        // 明明 packed-consumer 一直在写 `still waiting for …`，日志里却什么都没有。
        const consumer = execFile(process.execPath, ['packed-consumer.mjs'], {
          cwd: consumerDirectory,
          maxBuffer: 8 * 1024 * 1024,
          env: {
            ...runtimeEnvironment,
            PATH: `${join(consumerDirectory, 'bin')}:${process.env.PATH ?? ''}`,
            AGENTMUX_CONTROL_FIXTURE: join(consumerDirectory, 'ctxmux-terminal-control.mjs'),
            AGENTMUX_STUBBORN_FIXTURE: join(consumerDirectory, 'stubborn-process-tree.mjs'),
            AGENTMUX_FAKE_CODEX: join(consumerDirectory, 'bin', 'codex'),
            AGENTMUX_LIFECYCLE_CRASH_FIXTURE: join(consumerDirectory, 'lifecycle-crash-worker.mjs'),
            AGENTMUX_PROMPT_CRASH_FIXTURE: join(consumerDirectory, 'prompt-submit-crash-worker.mjs'),
            AGENTMUX_INTERACTION_CRASH_FIXTURE: join(consumerDirectory, 'interaction-response-crash-worker.mjs'),
            AGENTMUX_CLI_PATH: join(consumerDirectory, 'node_modules', '.bin', 'agentmux')
          }
        })
        consumer.stderr?.pipe(process.stderr)
        const result = await new Promise<{ stdout: string }>((settle, fail) => {
          let stdout = ''
          consumer.stdout?.setEncoding('utf8')
          consumer.stdout?.on('data', (chunk: string) => { stdout += chunk })
          consumer.once('error', fail)
          consumer.once('close', (code, signal) => {
            if (code === 0) return settle({ stdout })
            fail(new Error(`packed-consumer.mjs exited with code=${code} signal=${signal}`))
          })
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
          semanticContinuity: 'conflict-resumed-retired',
          terminalHandshake: 'query-ack-prompt',
          stopEpochReadiness: [
            'missing-stop-rejected-before-payload',
            'tail-lookbehind-ready',
            'post-cursor-live-ready',
            'concurrent-single-consumer',
            'crash-recovered-once'
          ],
          promptCrashRecovery: true,
          interactionCrashRecovery: true,
          cliResolveKinds: ['agent-session', 'provider-native', 'acp-native', 'run'],
          cliControl: true,
          naturalTerminalStop: true,
          crashRecovery: true,
          remote: 'unsupported'
        })
        cleanupSentinelPid = consumerReceipt.cleanupSentinelPid
        expect(Number.isInteger(cleanupSentinelPid) && cleanupSentinelPid > 0).toBe(true)

        activeDaemon = await waitForDaemonProcess(daemonPath, runtimeDirectory)
        const ownerReceiptPath = join(runtimeDirectory, 'owner.json')
        const ownerReceipt = JSON.parse(await readFile(ownerReceiptPath, 'utf8')) as {
          daemonPath: string
          daemonSha256: string
          daemonInstanceId: string
        }

        stopResponseLossWorker = spawn(
          process.execPath,
          ['ctxmux-stop-response-loss-worker.mjs'],
          {
            cwd: consumerDirectory,
            env: {
              ...runtimeEnvironment,
              AGENTMUX_FAKE_CODEX: join(consumerDirectory, 'bin', 'codex')
            },
            stdio: ['pipe', 'pipe', 'pipe']
          }
        )
        const stopResponseLossExited = once(stopResponseLossWorker, 'exit')
        let stopResponseLossStderr = ''
        stopResponseLossWorker.stderr?.setEncoding('utf8')
        stopResponseLossWorker.stderr?.on('data', (chunk) => { stopResponseLossStderr += chunk })
        const stopResponseLossLines = createInterface({
          input: stopResponseLossWorker.stdout!,
          crlfDelay: Infinity
        })[Symbol.asyncIterator]()
        let stopResponseLossReady: Record<string, unknown>
        try {
          stopResponseLossReady = await readJsonLine(
            stopResponseLossLines,
            'recoverable Stop response-loss readiness'
          )
        } catch (error) {
          const [exitCode, signal] = await stopResponseLossExited
          throw new Error(
            `${error instanceof Error ? error.message : String(error)} ` +
            `(exit=${String(exitCode)}, signal=${String(signal)}): ${stopResponseLossStderr}`
          )
        }
        expect(stopResponseLossReady).toMatchObject({
          phase: 'ready',
          agentSessionId: 'packed-stop-response-loss'
        })
        const stopResponseLossRun = stopResponseLossReady.run as { runId: string }
        stopResponseLossProxy = await installStopResponseLossProxy(activeDaemon.socketPath)
        stopResponseLossWorker.stdin?.end('stop\n')
        const stopReservation = await readJsonLine(
          stopResponseLossLines,
          'persisted recoverable Stop operation'
        )
        expect(stopReservation).toMatchObject({
          phase: 'stop-reserved',
          operation: {
            daemonInstance: ownerReceipt.daemonInstanceId,
            runId: stopResponseLossRun.runId
          }
        })
        const stopResponseLossResult = await readJsonLine(
          stopResponseLossLines,
          'recoverable Stop lost response'
        )
        await stopResponseLossProxy.dropped
        expect(stopResponseLossResult).toMatchObject({
          phase: 'stop-result',
          ok: false,
          detail: 'unknown'
        })
        stopResponseLossWorker.kill('SIGKILL')
        const [, stopResponseLossSignal] = await stopResponseLossExited
        expect(stopResponseLossSignal).toBe('SIGKILL')
        expect(stopResponseLossStderr).toBe('')
        stopResponseLossWorker = null
        await stopResponseLossProxy.restore()
        stopResponseLossProxy = null

        const recoveredStop = await execFileAsync(
          process.execPath,
          ['ctxmux-stop-recovery-worker.mjs'],
          {
            cwd: consumerDirectory,
            maxBuffer: 2 * 1024 * 1024,
            env: runtimeEnvironment
          }
        )
        const recoveredStopReceipt = JSON.parse(recoveredStop.stdout.trim()) as {
          operation: unknown
          agentSessions: unknown[]
          recoveredRun: { state: { type: string } } | null
        }
        expect(recoveredStopReceipt.operation).toEqual(stopReservation.operation)
        expect(recoveredStopReceipt.agentSessions).toEqual([])
        expect(recoveredStopReceipt.recoveredRun?.state.type).not.toBe('running')
        expect((await waitForDaemonProcess(daemonPath, runtimeDirectory)).pid).toBe(activeDaemon.pid)

        const relocatedReceipt = {
          ...ownerReceipt,
          daemonPath: join(
            runtimeDirectory,
            'relocated',
            'AgentMux.app',
            'Contents',
            'Resources',
            'app',
            'node_modules',
            '@agentmux',
            'core',
            'vendor',
            'ctxmux',
            'darwin-arm64',
            'bin',
            'ctxmuxd'
          )
        }
        await writeFile(ownerReceiptPath, `${JSON.stringify(relocatedReceipt)}\n`)
        const relocated = await execFileAsync(process.execPath, ['ctxmux-owner-relocation.mjs'], {
          cwd: consumerDirectory,
          maxBuffer: 2 * 1024 * 1024,
          env: runtimeEnvironment
        })
        expect(JSON.parse(relocated.stdout.trim())).toMatchObject({
          instanceId: ownerReceipt.daemonInstanceId
        })
        expect((await waitForDaemonProcess(daemonPath, runtimeDirectory)).pid).toBe(activeDaemon.pid)

        liveRuntimeFence = spawn(process.execPath, ['ctxmux-live-runtime-fence.mjs'], {
          cwd: consumerDirectory,
          env: runtimeEnvironment,
          stdio: ['pipe', 'pipe', 'pipe']
        })
        const liveRuntimeFenceExited = once(liveRuntimeFence, 'exit')
        let liveRuntimeFenceStderr = ''
        liveRuntimeFence.stderr?.setEncoding('utf8')
        liveRuntimeFence.stderr?.on('data', (chunk) => { liveRuntimeFenceStderr += chunk })
        const liveRuntimeFenceLines = createInterface({
          input: liveRuntimeFence.stdout!,
          crlfDelay: Infinity
        })[Symbol.asyncIterator]()
        expect(await readJsonLine(liveRuntimeFenceLines, 'live Runtime fence readiness')).toMatchObject({
          phase: 'ready',
          identity: { instanceId: ownerReceipt.daemonInstanceId }
        })

        await writeFile(ownerReceiptPath, `${JSON.stringify({
          ...relocatedReceipt,
          daemonSha256: '0'.repeat(64)
        })}\n`)
        const artifactMismatch = await execFileAsync(process.execPath, ['ctxmux-compatible-runtime.mjs'], {
          cwd: consumerDirectory,
          maxBuffer: 2 * 1024 * 1024,
          env: runtimeEnvironment
        })
        expect(JSON.parse(artifactMismatch.stdout.trim())).toMatchObject({ instanceId: ownerReceipt.daemonInstanceId, ownership: 'unverified' })
        expect((await waitForDaemonProcess(daemonPath, runtimeDirectory)).pid).toBe(activeDaemon.pid)
        await rm(ownerReceiptPath)
        const missingReceipt = await execFileAsync(process.execPath, ['ctxmux-compatible-runtime.mjs'], {
          cwd: consumerDirectory, env: runtimeEnvironment
        })
        expect(JSON.parse(missingReceipt.stdout.trim())).toMatchObject({ instanceId: ownerReceipt.daemonInstanceId, ownership: 'unverified' })
        expect((await waitForDaemonProcess(daemonPath, runtimeDirectory)).pid).toBe(activeDaemon.pid)

        await stopDaemon(activeDaemon)
        await rm(ownerReceiptPath, { force: true })
        await mkdir(ownerReceiptPath)
        const receiptFailure = await execFileAsync(
          process.execPath,
          ['ctxmux-compatible-runtime.mjs'],
          {
            cwd: consumerDirectory,
            maxBuffer: 2 * 1024 * 1024,
            env: runtimeEnvironment
          }
        )
        expect(JSON.parse(receiptFailure.stdout.trim())).toMatchObject({ ownership: 'unverified' })
        // Failure to persist provenance must not kill the new, otherwise healthy daemon.
        const receiptlessDaemon = await waitForDaemonProcess(daemonPath, runtimeDirectory)
        await stopDaemon(receiptlessDaemon)
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
        liveRuntimeFence.stdin?.end('dispatch\n')
        const liveFenceResult = await readJsonLine(
          liveRuntimeFenceLines,
          'live Runtime replacement dispatch result'
        )
        expect(liveFenceResult).toMatchObject({
          phase: 'dispatch',
          ok: false,
          code: 'CTXMUX_UNAVAILABLE'
        })
        expect(liveFenceResult.message).toMatch(/reachable Runtime identity .* does not match expected/u)
        const replacementRuns = await execFileAsync(cliPath, [
          '--socket', activeDaemon.socketPath, 'list'
        ], {
          timeout: 5_000,
          maxBuffer: 256 * 1024
        })
        expect(replacementRuns.stdout.trim()).toBe('')
        const [liveRuntimeFenceExitCode] = await liveRuntimeFenceExited
        expect(liveRuntimeFenceExitCode).toBe(0)
        expect(liveRuntimeFenceStderr).toBe('')
        liveRuntimeFence = null
        const fenced = await execFileAsync(process.execPath, ['ctxmux-compatible-runtime.mjs'], {
          cwd: consumerDirectory,
          maxBuffer: 4 * 1024 * 1024,
          env: runtimeEnvironment
        })
        expect(JSON.parse(fenced.stdout.trim())).toMatchObject({ ownership: 'unverified' })
        expect(JSON.parse(fenced.stdout.trim()).instanceId).not.toBe(ownerReceipt.daemonInstanceId)
      } finally {
        if (
          stopResponseLossWorker?.pid &&
          stopResponseLossWorker.exitCode === null &&
          stopResponseLossWorker.signalCode === null
        ) {
          const exited = once(stopResponseLossWorker, 'exit')
          stopResponseLossWorker.kill('SIGKILL')
          await exited.catch(() => {})
        }
        await stopResponseLossProxy?.restore()
        if (
          liveRuntimeFence?.pid &&
          liveRuntimeFence.exitCode === null &&
          liveRuntimeFence.signalCode === null
        ) {
          const exited = once(liveRuntimeFence, 'exit')
          liveRuntimeFence.kill('SIGTERM')
          await exited.catch(() => {})
        }
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
