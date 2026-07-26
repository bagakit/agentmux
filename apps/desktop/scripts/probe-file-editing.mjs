import { execFile, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { materializeFileEditingFixture } from './file-editing-fixture.mjs'

const execFileAsync = promisify(execFile)

// Fast dev runner for the mounted file-editing E2E probe. Instead of the 15-minute package→sign→DMG→mount→
// LaunchServices path (package-macos.mjs), this launches the raw Electron binary directly on the freshly
// built out/main/index.js. The probe itself has NO isPackaged/branding check — the `ready.packaged === true`
// assertion lives only in the packaging gate — so a plain dev build exercises the exact same probe code path
// against the exact same fixture (shared file-editing-fixture.mjs). Seconds-to-a-minute debug loop.
//
// Isolation, so the user's real app is never touched:
//   - a temp userData dir (never ~/Library/Application Support/dev.agentmux.desktop)
//   - a short, unique AGENTMUX_RUNTIME_DIRECTORY under /private/tmp (unix socket path length limit) so the
//     spawned ctxmux daemon claims its own socket/state and cannot collide with a running AgentMux.app
//
// Cleanup is unconditional: the Electron process is SIGTERM→SIGKILL'd and every temp dir removed on success,
// failure, timeout, and SIGINT. No orphan process, no leftover socket.
//
// 【绿了不等于能发版】这个跑法只断言一件事：报告里的 `ok === true`。打包门禁除此之外还独立复查
// 一整套本跑法**结构上够不到**的东西，别拿这里的绿当发版凭据：
//   - 代码签名（codesign --verify --strict）与 DMG 的 create/verify/mount
//   - `app.isPackaged === true` 这条分支、产品名与可执行文件身份（本跑法是未打包的 dev 树）
//   - asar 打包（这里跑的是散装 out/）、以及从 .app 内部加载 vendored ctxmux daemon 的归属校验
//   - 经 LaunchServices 启动（这里直接 spawn 二进制）
//   - 应用在生命周期预算内自行退出（这里是我们主动杀掉它）
//   - 门禁对约 8 个 phase 不变量的**独立复查**——本跑法只信探针内部的 assertProbe，一条都不复查。
//     所以有人削弱了探针里的断言、而 payload 仍能序列化时，这里会绿、门禁仍会红。
// 公证（notarization）两边都不覆盖，打包输出里明写 notarized=false。

const require = createRequire(import.meta.url)
const desktopRoot = resolve(import.meta.dirname, '..')
const electronExecutable = require('electron')
const skipBuild = process.argv.includes('--no-build')
// The whole probe budget: ~50 sequential assertions, each waitFor bounded at 20s. A healthy run finishes in
// well under a minute; this ceiling only guards a wedged main process so the runner never hangs forever.
const OVERALL_TIMEOUT_MS = 240_000

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} ${args.join(' ')} exited with ${signal ?? code}`))
    })
  })
}

/**
 * Reap the detached ctxmuxd this run spawned, scoped by its unique socket path so it can never match the
 * user's real daemon. SIGTERM first, then SIGKILL any survivor. Best-effort: a failed `ps` or an already
 * exited daemon is not an error.
 */
async function reapProbeDaemon(runtimeRoot) {
  const socketPath = join(runtimeRoot, 'ctxmux.sock')
  const pidsFor = async () => {
    let stdout = ''
    try {
      ({ stdout } = await execFileAsync('ps', ['-axo', 'pid=,command=']))
    } catch {
      return []
    }
    return stdout.split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(.+)$/.exec(line)
      if (!match || !match[2].includes('ctxmuxd') || !match[2].includes(socketPath)) return []
      return [Number(match[1])]
    })
  }
  const signal = (pids, sig) => {
    for (const pid of pids) {
      try {
        process.kill(pid, sig)
      } catch {
        // ESRCH (already gone) or a race — nothing to do.
      }
    }
  }
  signal(await pidsFor(), 'SIGTERM')
  const deadline = Date.now() + 3_000
  let remaining = await pidsFor()
  while (remaining.length > 0 && Date.now() < deadline) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    remaining = await pidsFor()
  }
  if (remaining.length > 0) {
    signal(remaining, 'SIGKILL')
    process.stderr.write(`probe runner: SIGKILL'd surviving ctxmuxd ${remaining.join(', ')}\n`)
  }
}

async function main() {
  if (!skipBuild) {
    // Rebuild out/ so the probe runs against current source. `--no-build` reuses the existing out/ for the
    // tightest loop when only main-process TS changed and was already built.
    await run('pnpm', ['build'], { cwd: desktopRoot })
  }

  const temporaryRoot = await mkdtemp(join('/private/tmp', `amx-probe-${process.getuid()}-`))
  const userData = join(temporaryRoot, 'user-data')
  const workspace = join(temporaryRoot, 'workspace')
  const alternateWorkspace = join(temporaryRoot, 'alternate-workspace')
  const runtimeRoot = join(temporaryRoot, 'runtime')
  const readyFile = join(temporaryRoot, 'desktop-ready.json')
  const fileEditingReport = join(temporaryRoot, 'workspace-file-editing.json')

  await materializeFileEditingFixture({ userData, workspace, alternateWorkspace })

  let child = null
  let killTimer = null
  let overallTimer = null
  // The last probe description the probe reported "waiting" on but never "completed". If the run dies, this
  // names the exact assertion that hung — the whole point of streaming the progress lines.
  let lastWaiting = null
  let timedOut = false

  const cleanup = async () => {
    if (killTimer) clearTimeout(killTimer)
    if (overallTimer) clearTimeout(overallTimer)
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      await new Promise((resolveKill) => {
        const forceKill = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 3_000)
        forceKill.unref()
        child.once('exit', () => {
          clearTimeout(forceKill)
          resolveKill()
        })
      })
    }
    // Core spawns ctxmuxd DETACHED (the adopt model), so it outlives the Electron process — the same reason
    // package-macos.mjs reaps the daemon separately. Scope the reap to OUR unique runtime socket path so it
    // can never touch the user's real daemon. Without this the fast loop leaks a daemon per run.
    await reapProbeDaemon(runtimeRoot)
    await rm(temporaryRoot, { recursive: true, force: true })
  }

  // SIGINT (Ctrl-C) must still tear down the Electron child and temp dirs — otherwise a manual abort orphans
  // the daemon and leaks a socket. Clean up, then re-signal ourselves so the exit code reflects the signal.
  const onSigint = () => {
    void cleanup().finally(() => {
      process.removeListener('SIGINT', onSigint)
      process.kill(process.pid, 'SIGINT')
    })
  }
  process.on('SIGINT', onSigint)

  const exitCode = await new Promise((resolvePromise) => {
    child = spawn(electronExecutable, [join(desktopRoot, 'out', 'main', 'index.js')], {
      cwd: desktopRoot,
      stdio: ['ignore', 'inherit', 'pipe'],
      env: {
        ...process.env,
        AGENTMUX_DESKTOP_USER_DATA: userData,
        AGENTMUX_RUNTIME_DIRECTORY: runtimeRoot,
        AGENTMUX_DESKTOP_READY_FILE: readyFile,
        AGENTMUX_DESKTOP_FILE_EDITING_REPORT: fileEditingReport
      }
    })

    overallTimer = setTimeout(() => {
      timedOut = true
      process.stderr.write(`\nprobe runner: overall ${OVERALL_TIMEOUT_MS}ms budget exceeded — killing Electron\n`)
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 3_000)
      killTimer.unref()
    }, OVERALL_TIMEOUT_MS)
    overallTimer.unref()

    // The probe writes its progress to the child's stderr as `file_editing_probe_<status>=<json description>`
    // lines. Pass every stderr line through (so ordinary main-process logs stay visible) and additionally
    // track the last "waiting" that never "completed" so a hang can be named precisely.
    const stderr = createInterface({ input: child.stderr })
    stderr.on('line', (line) => {
      process.stderr.write(`${line}\n`)
      const match = /^file_editing_probe_(waiting|completed|timed-out)=(.*)$/.exec(line)
      if (!match) return
      const [, status, rawDescription] = match
      let description = rawDescription
      try {
        description = JSON.parse(rawDescription)
      } catch {
        // Leave the raw text if it is not valid JSON — better than dropping the signal.
      }
      if (status === 'waiting') lastWaiting = description
      else if (status === 'completed' && lastWaiting === description) lastWaiting = null
      else if (status === 'timed-out') lastWaiting = description
    })

    child.once('error', (error) => {
      process.stderr.write(`probe runner: failed to launch Electron: ${error.message}\n`)
      resolvePromise(1)
    })
    child.once('exit', (code, signal) => {
      resolvePromise(signal ? 1 : code ?? 1)
    })
  })

  // The report is the authority on pass/fail. `ok: true` is the only success; anything else (missing report,
  // a false report, a non-zero Electron exit) is a failure, and we surface the failing probe's description.
  let report = null
  try {
    report = JSON.parse(await readFile(fileEditingReport, 'utf8'))
  } catch {
    report = null
  }

  await cleanup()
  process.removeListener('SIGINT', onSigint)

  if (report?.ok === true) {
    process.stdout.write('file_editing_probe=ok\n')
    return 0
  }

  const failingProbe = lastWaiting ?? '(no probe reported waiting — check stderr above)'
  process.stderr.write('\n=== file-editing probe FAILED ===\n')
  process.stderr.write(`failing probe: ${failingProbe}\n`)
  if (report?.error) process.stderr.write(`report error: ${report.error}\n`)
  else if (report === null) process.stderr.write(`report: missing (Electron ${timedOut ? 'timed out' : `exited ${exitCode}`})\n`)
  else process.stderr.write(`report ok: ${report.ok}\n`)
  return 1
}

process.exitCode = await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  return 1
})
