import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AgentMuxClient } from '../dist/daemon-client.js'

const execFileAsync = promisify(execFile)
const daemonEntry = resolve(import.meta.dirname, '../dist/agentmuxd.js')

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

function parseCpuTime(value) {
  const [dayPrefix, clock] = value.includes('-') ? value.split('-', 2) : ['0', value]
  const parts = clock.split(':').map(Number)
  const seconds = parts.pop() ?? 0
  const minutes = parts.pop() ?? 0
  const hours = parts.pop() ?? 0
  return (((Number(dayPrefix) * 24 + hours) * 60 + minutes) * 60 + seconds) * 1_000
}

async function readProcessSample(pid) {
  const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', 'rss=,time='], {
    timeout: 2_000,
    maxBuffer: 1024 * 1024
  })
  const [rssKiB, cpuTime] = stdout.trim().split(/\s+/)
  return { rssKiB: Number(rssKiB), cpuTimeMs: parseCpuTime(cpuTime) }
}

async function sampleProcess(pid) {
  const samples = []
  const startedAt = performance.now()
  for (let index = 0; index < 5; index += 1) {
    samples.push(await readProcessSample(pid))
    await delay(200)
  }
  const elapsedMs = performance.now() - startedAt
  const cpuDeltaMs = samples.at(-1).cpuTimeMs - samples[0].cpuTimeMs
  return {
    rssKiB: Math.round(samples.reduce((sum, sample) => sum + sample.rssKiB, 0) / samples.length),
    cpuPercent: Number((cpuDeltaMs / elapsedMs * 100).toFixed(2))
  }
}

async function connect(socketPath) {
  const client = new AgentMuxClient({ socketPath })
  await client.connect()
  return client
}

if (process.platform === 'win32') {
  throw new Error('The current daemon resource probe requires the POSIX ps command.')
}

const directory = await mkdtemp(join(tmpdir(), 'agentmuxd-resource-probe-'))
const socketPath = join(directory, 'agentmuxd.sock')
const daemon = spawn(process.execPath, [daemonEntry, 'serve', '--socket', socketPath], {
  stdio: ['ignore', 'pipe', 'inherit']
})
const clients = []
let stdout = ''
daemon.stdout.setEncoding('utf8')
daemon.stdout.on('data', (chunk) => { stdout += chunk })

try {
  await waitForCondition('agentmuxd readiness', () => stdout.includes('"type":"ready"'))
  const controller = await connect(socketPath)
  clients.push(controller)
  const idle = await sampleProcess(daemon.pid)

  const extraClients = await Promise.all(Array.from({ length: 16 }, async () => await connect(socketPath)))
  clients.push(...extraClients)
  const withClients = await sampleProcess(daemon.pid)

  const sessions = []
  for (let index = 0; index < 8; index += 1) {
    sessions.push(await controller.createTerminal({
      sessionId: `resource-session-${index}`,
      createOperationId: `resource-operation-${index}`,
      cwd: process.cwd()
    }))
  }
  const withSessions = await sampleProcess(daemon.pid)

  for (const session of sessions.slice(0, 4)) {
    await controller.detach(session)
    const source = "process.stdout.write('r'.repeat(300000))"
    await controller.write(session, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}\n`)
  }
  await waitForCondition('four bounded replay windows', async () => {
    const snapshots = await controller.listSessions()
    return snapshots.slice(0, 4).every((session) => session.latestSequence >= 300_000)
  })
  const withReplay = await sampleProcess(daemon.pid)

  for (const session of sessions) await controller.stop(session)
  for (const client of extraClients) client.disconnect()
  await waitForCondition('session release', async () => (await controller.listSessions()).length === 0)
  const afterRelease = await sampleProcess(daemon.pid)

  const replayMiB = 4 * 256 / 1024
  process.stdout.write(`${JSON.stringify({
    measuredAt: new Date().toISOString(),
    platform: `${process.platform}-${process.arch}`,
    node: process.version,
    daemonPid: daemon.pid,
    phases: { idle, withClients, withSessions, withReplay, afterRelease },
    estimates: {
      rssKiBPerClient: Math.round((withClients.rssKiB - idle.rssKiB) / 16),
      rssKiBPerSession: Math.round((withSessions.rssKiB - withClients.rssKiB) / 8),
      rssKiBPerMiBReplay: Math.round((withReplay.rssKiB - withSessions.rssKiB) / replayMiB)
    },
    verifiedCounts: {
      daemonProcesses: 1,
      clientsAtPeak: 17,
      sessionsAtPeak: 8,
      sessionsAfterRelease: 0,
      replayMiB
    }
  }, null, 2)}\n`)
} finally {
  for (const client of clients) client.disconnect()
  if (daemon.exitCode === null && daemon.signalCode === null) {
    daemon.kill('SIGTERM')
    await once(daemon, 'exit')
  }
  await rm(directory, { recursive: true, force: true })
}
