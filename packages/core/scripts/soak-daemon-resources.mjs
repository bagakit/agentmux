import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AgentMuxDaemonClient } from '../dist/daemon-client.js'
import { mean } from './run-kernel-statistics.mjs'

const execFileAsync = promisify(execFile)
const daemonEntry = resolve(import.meta.dirname, '../dist/agentmuxd.js')
const seed = Number.parseInt(process.env.AGENTMUX_STRESS_SEED ?? '7007', 10)
const cycles = Number.parseInt(process.env.AGENTMUX_STRESS_CYCLES ?? '20', 10)
const sessionsPerCycle = 4
const maxRssGrowthKiB = 64 * 1024
const maxSettledGrowthKiB = 32 * 1024
const maxOpenFileGrowth = 64

if (!Number.isSafeInteger(seed) || !Number.isSafeInteger(cycles) || cycles < 10 || cycles > 100) {
  throw new Error('AGENTMUX_STRESS_SEED must be an integer and AGENTMUX_STRESS_CYCLES must be from 10 to 100.')
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms))
}

async function waitForCondition(description, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await delay(20)
  }
  throw new Error(`Timed out waiting for ${description}.`)
}

async function readRssKiB(pid) {
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'rss='], {
    timeout: 2_000,
    maxBuffer: 1024 * 1024
  })
  return Number(stdout.trim())
}

async function readOpenFiles(pid) {
  if (process.platform === 'linux') return (await readdir(`/proc/${pid}/fd`)).length
  const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-Fn'], {
    timeout: 3_000,
    maxBuffer: 4 * 1024 * 1024
  })
  return stdout.split('\n').filter((line) => /^f\d+$/.test(line)).length
}

async function sample(pid) {
  return { rssKiB: await readRssKiB(pid), openFiles: await readOpenFiles(pid) }
}

async function connect(socketPath) {
  const client = new AgentMuxDaemonClient({ socketPath })
  await client.connect()
  return client
}

if (process.platform === 'win32') {
  throw new Error('AgentMux daemon soak supports the package target platforms: macOS and Linux.')
}

const directory = await mkdtemp(join(tmpdir(), 'agentmuxd-resource-soak-'))
const socketPath = join(directory, 'agentmuxd.sock')
const daemon = spawn(process.execPath, [daemonEntry, 'serve', '--socket', socketPath], {
  stdio: ['ignore', 'pipe', 'inherit']
})
const suiteTimeout = setTimeout(() => {
  process.stderr.write('AgentMux daemon soak exceeded the 120 second suite timeout.\n')
  daemon.kill('SIGTERM')
}, 120_000)
suiteTimeout.unref()
let stdout = ''
daemon.stdout.setEncoding('utf8')
daemon.stdout.on('data', (chunk) => { stdout += chunk })
let controller = null

try {
  await waitForCondition('agentmuxd readiness', () => stdout.includes('"type":"ready"'))
  controller = await connect(socketPath)
  const baseline = await sample(daemon.pid)
  const samples = []

  for (let cycle = 0; cycle < cycles; cycle += 1) {
    const sessions = []
    for (let index = 0; index < sessionsPerCycle; index += 1) {
      const session = await controller.createTerminal({
        sessionId: `soak-${seed}-${cycle}-${index}`,
        createOperationId: `soak-operation-${seed}-${cycle}-${index}`,
        cwd: process.cwd()
      })
      sessions.push(session)
      await controller.detach(session)
      const source = "process.stdout.write('r'.repeat(65536))"
      await controller.write(session, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}\n`)
    }
    await waitForCondition(`cycle ${cycle} replay`, async () => {
      const snapshots = await controller.listSessions()
      return snapshots.length === sessionsPerCycle && snapshots.every((session) => session.latestSequence >= 64 * 1024)
    })

    const observers = await Promise.all(Array.from({ length: 8 }, async () => await connect(socketPath)))
    try {
      for (const observer of observers) {
        for (const session of sessions) {
          const attached = await observer.attach(session.sessionId)
          await observer.detach(attached.session)
        }
      }
    } finally {
      for (const observer of observers) observer.disconnect()
    }

    await Promise.all(sessions.map(async (session) => await controller.stop(session)))
    await waitForCondition(`cycle ${cycle} release`, async () => (await controller.listSessions()).length === 0)
    await delay(25)
    samples.push({ cycle, ...await sample(daemon.pid) })
  }

  const final = samples.at(-1)
  const peakRssKiB = Math.max(...samples.map((entry) => entry.rssKiB))
  const peakOpenFiles = Math.max(...samples.map((entry) => entry.openFiles))
  const window = Math.min(5, Math.floor(samples.length / 2))
  const earlyMeanRssKiB = Math.round(mean(samples.slice(0, window).map((entry) => entry.rssKiB)))
  const lateMeanRssKiB = Math.round(mean(samples.slice(-window).map((entry) => entry.rssKiB)))
  const report = {
    measuredAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    seed,
    cycles,
    sessionsPerCycle,
    budgets: { maxRssGrowthKiB, maxSettledGrowthKiB, maxOpenFileGrowth },
    baseline,
    peak: { rssKiB: peakRssKiB, openFiles: peakOpenFiles },
    final,
    settled: { earlyMeanRssKiB, lateMeanRssKiB },
    verified: {
      sessionsAfterEveryCycle: 0,
      clientsConnectedPerCycle: 9,
      replayBytesPerCycleAtLeast: sessionsPerCycle * 64 * 1024
    }
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  if (peakRssKiB - baseline.rssKiB > maxRssGrowthKiB) throw new Error('Daemon soak exceeded the peak RSS budget.')
  if (lateMeanRssKiB - earlyMeanRssKiB > maxSettledGrowthKiB) throw new Error('Daemon soak RSS did not settle within budget.')
  if (peakOpenFiles - baseline.openFiles > maxOpenFileGrowth) throw new Error('Daemon soak exceeded the open-file budget.')
  if (final.openFiles > baseline.openFiles + 4) throw new Error('Daemon soak did not release file descriptors.')
} finally {
  clearTimeout(suiteTimeout)
  controller?.disconnect()
  if (daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGTERM')
    await once(daemon, 'exit')
  }
  await rm(directory, { recursive: true, force: true })
}
