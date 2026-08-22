import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { runProbeProcess } from './probe-process.mjs'

const require = createRequire(import.meta.url)
const desktopRoot = resolve(import.meta.dirname, '..')
const electronExecutable = require('electron')
const entry = join(desktopRoot, 'out', 'main', 'index.js')
const temporaryRoot = await mkdtemp(join(tmpdir(), `amx-attention-review-${process.pid}-`))
const userData = join(temporaryRoot, 'user-data')
const runtimeDirectory = join(temporaryRoot, 'runtime')

async function waitForFile(path, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try { return JSON.parse(await readFile(path, 'utf8')) } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 100)) }
  }
  throw new Error(`Timed out waiting for ${path}`)
}

async function launch(generation) {
  const readyFile = join(temporaryRoot, `ready-${generation}.json`)
  const execution = await runProbeProcess(electronExecutable, [entry], {
    temporaryRoot,
    cwd: desktopRoot,
    timeoutMs: 60_000,
    env: {
      ...process.env,
      AGENTMUX_DESKTOP_USER_DATA: userData,
      AGENTMUX_RUNTIME_DIRECTORY: runtimeDirectory,
      AGENTMUX_DESKTOP_READY_FILE: readyFile,
      AGENTMUX_DESKTOP_EXIT_AFTER_READY: '1'
    }
  })
  const ready = await waitForFile(readyFile)
  if (execution.exitCode !== 0 || execution.timedOut || execution.interruption) {
    throw new Error(`Attention review restart ${generation} exited unsuccessfully: ${JSON.stringify(execution)}`)
  }
  return { ...ready, generation }
}

try {
  const first = await launch(1)
  const second = await launch(2)
  if (first.executable !== second.executable) throw new Error('Restart changed the executable identity.')
  if (first.packaged !== second.packaged) throw new Error('Restart changed packaging state.')
  if (first.generation === second.generation) throw new Error('Restart generations were not distinct.')
  process.stdout.write(`${JSON.stringify({ event: 'attention-review-restart', first, second, sameUserData: true })}\n`)
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
