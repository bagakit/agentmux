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
const workspaceRoot = resolve(desktopRoot, '..', '..')
const electronExecutable = require('electron')
// `--no-build` reuses the existing out/ and packages/core/dist for the tightest loop, when only main-process
// TS changed and was already built. It also skips the prebuild move-helper step.
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
  // A daemon only becomes findable once execve has replaced its argv with `ctxmuxd --socket <path>`; between
  // core's fork and that execve the child still wears Electron's command line and matches nothing. If the run
  // dies mid-`connect()`, a single snapshot can land in that window and miss the daemon entirely. So when the
  // first sweep comes up empty, look again a few times before concluding there is nothing to reap. The window
  // is microseconds wide, so the common "no daemon spawned at all" case costs a handful of cheap `ps` calls.
  let pids = await pidsFor()
  for (let attempt = 0; pids.length === 0 && attempt < 6; attempt += 1) {
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
    pids = await pidsFor()
  }
  signal(pids, 'SIGTERM')
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

// Electron helpers are not children in the OS process tree on macOS. Reap every process that still
// points at this run's isolated user-data directory, otherwise a failed probe leaks renderer/GPU
// processes and can exhaust the host before the next attempt.
async function reapProbeProcesses(userData) {
  let stdout = ''
  try { ({ stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='])) } catch { return }
  const pids = stdout.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    return match && match[2].includes(userData) ? [Number(match[1])] : []
  })
  for (const pid of pids) { try { process.kill(pid, 'SIGKILL') } catch {} }
}

async function main() {
  if (!skipBuild) {
    // Rebuild BOTH halves so the probe runs against current source. `@agentmux/core` is externalized by
    // electron-vite and loaded at runtime from the workspace symlink into packages/core/dist — so a desktop-only
    // build leaves core's dist stale, and an edit to the adapter / runtime-paths / endpoint logic would be
    // invisible here while the package gate (which builds both, package-macos.mjs) still goes red. That gap
    // would break the one promise this runner makes: green here means green there.
    await run('pnpm', ['--filter', '@agentmux/core', 'build'], { cwd: workspaceRoot })
    await run('pnpm', ['build'], { cwd: desktopRoot })
  }

  const temporaryRoot = await mkdtemp(join('/private/tmp', `amx-probe-${process.getuid()}-`))
  const userData = join(temporaryRoot, 'user-data')
  const workspace = join(temporaryRoot, 'workspace')
  const alternateWorkspace = join(temporaryRoot, 'alternate-workspace')
  const runtimeRoot = join(temporaryRoot, 'runtime')
  const readyFile = join(temporaryRoot, 'desktop-ready.json')
  const fileEditingReport = join(temporaryRoot, 'workspace-file-editing.json')

  // Between `mkdtemp` and the point where `cleanup`/SIGINT are wired below, nothing else would remove this
  // directory — so a throw in here (full disk, permissions, a fixture bug) would leave a tree under
  // /private/tmp on every failed run. Nothing is spawned yet, so the temp dir is the only thing to undo.
  try {
    await materializeFileEditingFixture({ userData, workspace, alternateWorkspace })
  } catch (error) {
    await rm(temporaryRoot, { recursive: true, force: true })
    throw error
  }

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
    await reapProbeProcesses(userData)
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

  // The report is the authority on whether the FEATURE works, but it is written before `app.quit()`, so it
  // cannot speak for teardown. `before-quit` disposes the runtime (client + daemon); if that throws, the main
  // process exits 1 *after* a truthful `ok:true` landed. Gating on the report alone would paint a broken
  // daemon disposal — exactly the resource-safety class this repo cares about — bright green. Success
  // therefore requires all three: a report saying ok, a clean Electron exit, and no timeout.
  let report = null
  try {
    report = JSON.parse(await readFile(fileEditingReport, 'utf8'))
  } catch {
    report = null
  }

  await cleanup()
  process.removeListener('SIGINT', onSigint)

  if (report?.ok === true && exitCode === 0 && !timedOut) {
    process.stdout.write('file_editing_probe=ok\n')
    return 0
  }

  const failingProbe = lastWaiting ?? '(no probe reported waiting — check stderr above)'
  process.stderr.write('\n=== file-editing probe FAILED ===\n')
  if (report?.ok === true) {
    // The assertions all passed; the failure is in shutdown. Say so plainly, or the next reader wastes their
    // time hunting a probe that never failed.
    process.stderr.write(
      timedOut
        ? 'all probes passed, but Electron did not exit within the budget — it wedged during teardown\n'
        : `all probes passed, but Electron exited ${exitCode} — teardown (runtime/daemon disposal) failed\n`
    )
    return 1
  }
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
