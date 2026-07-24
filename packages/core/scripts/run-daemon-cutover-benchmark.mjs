import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, open, readFile, rm, stat } from 'node:fs/promises'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  mean,
  seededRandom,
  summarizeSamples
} from './run-kernel-statistics.mjs'

export const BENCHMARK_SCHEMA = 'agentmux.benchmark.daemon-cutover.v3'
export const PROTOCOL_REVISION = 3
export const RUNNER_VERSION = 3
export const FORMAL_RESULT_PREFIX = 'revision-3'
export const WORKLOAD_EXECUTION_ORDER = Object.freeze([
  'resources',
  'inputToVisible',
  'throughput',
  'attachReplay',
  'reconnect',
  'sessionScale',
  'stopCleanup'
])
export const CTXMUX_ARTIFACT = Object.freeze({
  commit: '2e32a9d647d627952ea5c455fb2efef6c636643a',
  tree: 'd60870c2481c9b153da6bf22f829d24afb8a81a8',
  version: '0.1.0',
  protocol: 9,
  manifestSha256: '15c0f54980ac339251017293cf4a21c94e2fb923d22cc3998b293f1a61a997d9'
})

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url))
const fixturePath = fileURLToPath(new URL('../test/fixtures/run-kernel-workload.mjs', import.meta.url))
const manifestPath = join(packageRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'manifest.json')
const daemonPath = join(packageRoot, 'vendor', 'ctxmux', 'darwin-arm64', 'bin', 'ctxmuxd')
const formalResultsDirectory = join(repositoryRoot, 'docs', 'benchmarks', 'results')
const geometry = Object.freeze({ cols: 120, rows: 36 })
const localeEnvironment = Object.freeze({ LANG: 'C', LC_ALL: 'C', TZ: 'UTC0' })
const outputLimit = 32 * 1024 * 1024
const fullConfig = Object.freeze({
  latency: { warmup: 20, samples: 120, pollMs: 750 },
  throughput: { warmup: 1, samples: 7, bytes: 4 * 1024 * 1024, pollMs: 750 },
  attach: { warmup: 20, samples: 100, bytes: 192 * 1024 },
  reconnect: { warmup: 20, samples: 100, bytes: 64 * 1024 },
  scale: { rounds: 5, sessions: 32, pollMs: 750 },
  stop: { samples: 10 },
  resources: { settleMs: 2_000, samples: 15, intervalMs: 200, sessions: 32, bytes: 4 * 1024 * 1024, pollMs: 750 }
})
const smokeConfig = Object.freeze({
  latency: { warmup: 1, samples: 2, pollMs: 20 },
  throughput: { warmup: 0, samples: 1, bytes: 64 * 1024, pollMs: 20 },
  attach: { warmup: 1, samples: 2, bytes: 32 * 1024 },
  reconnect: { warmup: 1, samples: 2, bytes: 16 * 1024 },
  scale: { rounds: 1, sessions: 2, pollMs: 20 },
  stop: { samples: 1 },
  resources: { settleMs: 20, samples: 2, intervalMs: 20, sessions: 2, bytes: 64 * 1024, pollMs: 20 }
})

function nowNs() {
  return process.hrtime.bigint()
}

function elapsedUs(start) {
  return Number(nowNs() - start) / 1_000
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds))
}

function errorRecord(error, phase) {
  return {
    phase,
    name: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : String(error),
    ...(
      error && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
        ? { code: error.code }
        : {}
    )
  }
}

async function runCommand(command, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000
  return await new Promise((resolveCommand, rejectCommand) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const stdout = []
    const stderr = []
    let stdoutBytes = 0
    let stderrBytes = 0
    let settled = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error(`${command} timed out after ${timeoutMs} ms`))
    }, timeoutMs)
    const finish = (error, code = null, signal = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) {
        rejectCommand(error)
        return
      }
      const result = {
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code,
        signal
      }
      if (code !== 0) {
        const failure = new Error(
          `${command} ${args.join(' ')} exited ${String(code)}${result.stderr ? `: ${result.stderr.trim()}` : ''}`
        )
        failure.code = `EXIT_${String(code)}`
        failure.result = result
        rejectCommand(failure)
      } else {
        resolveCommand(result)
      }
    }
    child.on('error', (error) => finish(error))
    child.on('close', (code, signal) => finish(null, code, signal))
    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length
      if (stdoutBytes > (options.maxBuffer ?? outputLimit)) {
        child.kill('SIGKILL')
        finish(new Error(`${command} stdout exceeded its bounded capture`))
      } else stdout.push(chunk)
    })
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length
      if (stderrBytes > (options.maxBuffer ?? outputLimit)) {
        child.kill('SIGKILL')
        finish(new Error(`${command} stderr exceeded its bounded capture`))
      } else stderr.push(chunk)
    })
    if (options.input === undefined) child.stdin.end()
    else child.stdin.end(options.input)
  })
}

async function commandOutput(command, args, options = {}) {
  return (await runCommand(command, args, options)).stdout.trim()
}

async function commandAvailable(command) {
  try {
    await runCommand('/usr/bin/env', ['which', command], { timeoutMs: 2_000, maxBuffer: 64 * 1024 })
    return true
  } catch {
    return false
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`
}

function inside(parent, child) {
  const path = relative(resolve(parent), resolve(child))
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path))
}

export function parseBenchmarkArguments(argv) {
  let round = null
  let smoke = false
  let output = null
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--') {
      continue
    } else if (argument === '--smoke') {
      smoke = true
    } else if (argument === '--round') {
      round = Number.parseInt(argv[++index] ?? '', 10)
    } else if (argument === '--output') {
      output = resolve(repositoryRoot, argv[++index] ?? '')
    } else if (argument === '--help') {
      return { help: true }
    } else {
      throw new Error(`Unknown benchmark argument: ${argument}`)
    }
  }
  if (round !== 1 && round !== 2) throw new Error('--round must be exactly 1 or 2')
  if (smoke && output === null) throw new Error('--smoke requires an explicit --output outside docs/benchmarks/results')
  if (smoke && inside(formalResultsDirectory, output)) {
    throw new Error('Smoke evidence cannot be written into docs/benchmarks/results')
  }
  return { help: false, mode: smoke ? 'smoke' : 'full', round, output }
}

export function benchmarkConfiguration(mode) {
  if (mode === 'full') return structuredClone(fullConfig)
  if (mode === 'smoke') return structuredClone(smokeConfig)
  throw new Error(`Unknown benchmark mode: ${String(mode)}`)
}

class OutputCollector {
  constructor(runId) {
    this.runId = runId
    this.chunks = new Map()
    this.gap = null
    this.failure = null
  }

  add(startByte, endByte, data) {
    if (this.failure) return
    if (
      !Number.isSafeInteger(startByte) ||
      !Number.isSafeInteger(endByte) ||
      startByte < 0 ||
      endByte < startByte ||
      Buffer.byteLength(data) !== endByte - startByte
    ) {
      this.failure = new Error(`Run ${this.runId} emitted an invalid byte range`)
      return
    }
    const existing = this.chunks.get(startByte)
    if (existing) {
      if (existing.endByte !== endByte || existing.data !== data) {
        this.failure = new Error(`Run ${this.runId} changed an already observed byte range`)
      }
      return
    }
    this.chunks.set(startByte, { startByte, endByte, data })
  }

  text() {
    if (this.failure) throw this.failure
    const chunks = [...this.chunks.values()].sort((left, right) => left.startByte - right.startByte)
    let cursor = 0
    let text = ''
    for (const chunk of chunks) {
      if (chunk.startByte !== cursor) {
        throw new Error(`Run ${this.runId} output is not continuous at byte ${cursor}`)
      }
      cursor = chunk.endByte
      text += chunk.data
    }
    return text
  }

  latestByte() {
    return [...this.chunks.values()].reduce((maximum, chunk) => Math.max(maximum, chunk.endByte), 0)
  }
}

async function waitForText(readText, marker, timeoutMs = 30_000, intervalMs = 5) {
  const deadline = Date.now() + timeoutMs
  let last = ''
  while (Date.now() <= deadline) {
    last = await readText()
    if (last.includes(marker)) return last
    await delay(intervalMs)
  }
  throw new Error(`Timed out waiting for marker ${marker}; retained ${Buffer.byteLength(last)} bytes`)
}

function verifiedMarkers(label, bytes) {
  const hash = createHash('sha256').update('x'.repeat(bytes)).digest('hex')
  return {
    hash,
    ready: `run-kernel-verified-ready:${label}:${bytes}:${hash}`,
    payload: `run-kernel-verified-payload:${label}`,
    end: `run-kernel-verified-end:${label}:${bytes}:${hash}`
  }
}

export function verifyBurstOutput(text, label, bytes) {
  const markers = verifiedMarkers(label, bytes)
  const readyIndex = text.indexOf(markers.ready)
  if (readyIndex < 0) throw new Error(`Missing verified ready marker for ${label}`)
  const payloadMarkerIndex = text.indexOf(markers.payload, readyIndex + markers.ready.length)
  if (payloadMarkerIndex < 0) throw new Error(`Missing payload marker for ${label}`)
  const payloadStart = text.indexOf('\n', payloadMarkerIndex + markers.payload.length)
  if (payloadStart < 0) throw new Error(`Missing payload boundary for ${label}`)
  const endIndex = text.indexOf(markers.end, payloadStart + 1)
  if (endIndex < 0) throw new Error(`Missing verified end marker for ${label}`)
  const payload = text.slice(payloadStart + 1, endIndex).replace(/\r?\n$/u, '')
  const actualBytes = Buffer.byteLength(payload)
  const actualHash = createHash('sha256').update(payload).digest('hex')
  if (actualBytes !== bytes || actualHash !== markers.hash) {
    throw new Error(
      `Payload oracle failed for ${label}: ${actualBytes}/${bytes} bytes, ${actualHash}/${markers.hash}`
    )
  }
  return { byteCount: actualBytes, sha256: actualHash }
}

class AgentMuxHarness {
  constructor(AgentMuxClient, runtimeDirectory) {
    this.AgentMuxClient = AgentMuxClient
    this.runtimeDirectory = runtimeDirectory
    this.client = new AgentMuxClient()
    this.collectors = new Map()
    this.trackedRuns = new Set()
    this.fixturePids = new Map()
    this.inputCursors = new Map()
    this.unsubscribe = null
    this.identity = null
  }

  async initialize() {
    await this.client.connect()
    this.identity = this.client.runtimeIdentity()
    this.unsubscribe = this.client.onEvent((event) => {
      if (event.type !== 'terminal-output') return
      const collector = this.collectors.get(event.run.runId)
      const range = event.evidence.outputByteRange
      if (collector && range) collector.add(range.startByte, range.endByte, event.data)
    })
  }

  async create(mode, label, bytes = null) {
    const args = [fixturePath, mode, label]
    if (bytes !== null) args.push(String(bytes))
    const run = await this.client.createTerminal({
      createOperationId: `benchmark-${randomUUID()}`,
      workspacePath: packageRoot,
      command: process.execPath,
      args,
      cols: geometry.cols,
      rows: geometry.rows,
      env: localeEnvironment
    })
    this.trackedRuns.add(run.runId)
    if (run.pid !== null) this.fixturePids.set(run.runId, run.pid)
    this.inputCursors.set(run.runId, run.acceptedInputBytes)
    const collector = new OutputCollector(run.runId)
    this.collectors.set(run.runId, collector)
    const attachment = await this.client.attachTerminal(run.runId, 0)
    if (attachment.gap) collector.gap = attachment.gap
    for (const chunk of attachment.replay) {
      collector.add(chunk.startByte, chunk.endByte, chunk.data)
    }
    return { ...run, label }
  }

  text(runId) {
    const collector = this.collectors.get(runId)
    if (!collector) throw new Error(`Unknown AgentMux benchmark Run: ${runId}`)
    if (collector.gap) throw new Error(`AgentMux Run ${runId} reported a replay Gap`)
    return collector.text()
  }

  async wait(runId, marker, timeoutMs = 30_000) {
    return await waitForText(() => this.text(runId), marker, timeoutMs)
  }

  async write(runId, data) {
    const expectedByte = this.inputCursors.get(runId)
    if (expectedByte === undefined) throw new Error(`Missing AgentMux Input cursor for ${runId}`)
    const receipt = await this.client.writeTerminal({ runId }, {
      ownerInstanceId: this.identity.instanceId,
      operationId: `benchmark-input-${randomUUID()}`,
      expectedByte,
      data
    })
    this.inputCursors.set(runId, receipt.acceptedThroughByte)
    return receipt
  }

  async attachReplay(runId) {
    return await this.client.attachTerminal(runId, 0)
  }

  async reconnectAndReplay(run) {
    const client = new this.AgentMuxClient()
    let attached = false
    try {
      const start = nowNs()
      await client.connect()
      const identity = client.runtimeIdentity()
      const replay = await client.attachTerminal(run.runId, 0)
      attached = true
      const durationUs = elapsedUs(start)
      if (identity.instanceId !== this.identity.instanceId) {
        throw new Error('AgentMux reconnect changed daemon identity')
      }
      if (replay.run.runId !== run.runId || replay.run.pid !== run.pid) {
        throw new Error('AgentMux reconnect changed Run identity or PID')
      }
      return { durationUs, replay }
    } finally {
      try {
        if (attached) await client.releaseRunAttachment({ runId: run.runId })
      } finally {
        await client.dispose()
      }
    }
  }

  async release(runId) {
    await this.client.releaseRunAttachment({ runId })
  }

  async stop(runId) {
    if (!this.trackedRuns.has(runId)) throw new Error(`Refusing to stop unowned AgentMux Run ${runId}`)
    try {
      await this.release(runId)
    } catch (error) {
      if (!(error && typeof error === 'object' && 'code' in error && error.code === 'CTXMUX_not_attached')) {
        throw error
      }
    }
    const current = (await this.client.listRuns()).find((run) => run.runId === runId)
    if (current?.state === 'running') await this.client.stopTerminal({ runId })
    this.trackedRuns.delete(runId)
    const pid = this.fixturePids.get(runId)
    if (pid !== undefined && await waitForStopped([pid], 500)) this.fixturePids.delete(runId)
  }

  async assertStopped(runs) {
    const ids = new Set(runs.map((run) => run.runId))
    const active = (await this.client.listRuns()).filter(
      (run) => ids.has(run.runId) && run.state === 'running'
    )
    const pids = runs.flatMap((run) => run.pid === null ? [] : [run.pid])
    return {
      noLiveOwnerObjects: active.length === 0,
      fixturePidsStopped: await waitForStopped(pids, 1_000)
    }
  }

  async cleanup() {
    const errors = []
    let listed = []
    try {
      listed = await this.client.listRuns()
    } catch (error) {
      errors.push(error)
    }
    for (const runId of [...this.trackedRuns]) {
      try {
        const run = listed.find((candidate) => candidate.runId === runId)
        if (run?.state === 'running') {
          try { await this.release(runId) } catch {}
          await this.client.stopTerminal({ runId })
        }
        this.trackedRuns.delete(runId)
        const pid = this.fixturePids.get(runId)
        if (pid !== undefined && await waitForStopped([pid], 500)) this.fixturePids.delete(runId)
      } catch (error) {
        errors.push(error)
      }
    }
    this.unsubscribe?.()
    try { await this.client.dispose() } catch (error) { errors.push(error) }
    if (errors.length > 0) throw new AggregateError(errors, 'AgentMux benchmark cleanup failed')
  }
}

class TmuxHarness {
  constructor(socketName, environment) {
    if (!/^agentmux-benchmark-[a-z0-9-]+$/u.test(socketName)) {
      throw new Error('Refusing unsafe tmux benchmark socket name')
    }
    this.socketName = socketName
    this.environment = environment
    this.sessions = new Set()
    this.fixturePids = new Map()
    this.counter = 0
    this.serverPid = null
    this.initialized = false
  }

  async command(args, options = {}) {
    return await runCommand('tmux', ['-L', this.socketName, ...args], {
      ...options,
      env: this.environment,
      maxBuffer: options.maxBuffer ?? outputLimit
    })
  }

  async initialize() {
    await this.command(['start-server', ';', 'set-option', '-g', 'exit-empty', 'off'])
    await this.command(['set-option', '-gw', 'history-limit', '50000'])
    this.serverPid = Number.parseInt(
      (await this.command(['display-message', '-p', '#{pid}'])).stdout.trim(),
      10
    )
    if (!Number.isSafeInteger(this.serverPid) || this.serverPid <= 1) {
      throw new Error('tmux did not report a safe server PID')
    }
    this.initialized = true
  }

  async create(mode, label, bytes = null) {
    const name = `bench-${String(++this.counter).padStart(5, '0')}`
    const argv = [fixturePath, mode, label]
    if (bytes !== null) argv.push(String(bytes))
    const shellCommand = [process.execPath, ...argv].map(shellQuote).join(' ')
    await this.command([
      'new-session', '-d', '-s', name,
      '-x', String(geometry.cols), '-y', String(geometry.rows), shellCommand
    ])
    this.sessions.add(name)
    await this.command(['set-option', '-w', '-t', `=${name}:0`, 'remain-on-exit', 'on'])
    await this.command(['set-option', '-w', '-t', `=${name}:0`, 'history-limit', '50000'])
    const pid = Number.parseInt(
      (await this.command(['list-panes', '-t', `=${name}`, '-F', '#{pane_pid}'])).stdout.trim(),
      10
    )
    if (Number.isSafeInteger(pid) && pid > 1) this.fixturePids.set(name, pid)
    return { name, runId: name, pid, label }
  }

  async capture(session) {
    return (await this.command([
      'capture-pane', '-p', '-e', '-J', '-S', '-50000', '-t', `=${session}:0.0`
    ])).stdout
  }

  async wait(session, marker, timeoutMs = 30_000, pollMs = 20) {
    return await waitForText(() => this.capture(session), marker, timeoutMs, pollMs)
  }

  async write(session, data) {
    const bufferName = `agentmux-benchmark-${randomUUID()}`
    await this.command(['load-buffer', '-b', bufferName, '-'], { input: data })
    await this.command(['paste-buffer', '-b', bufferName, '-d', '-t', `=${session}:0.0`])
  }

  async reconnectAndReplay(run) {
    const session = run.runId
    const start = nowNs()
    await this.command(['list-sessions'])
    const panes = await this.command([
      'list-panes', '-a', '-F', '#{session_name}|#{pane_pid}'
    ])
    await this.command(['show-environment', '-t', `=${session}`])
    const replay = await this.capture(session)
    const pane = panes.stdout.split('\n').find((line) => line.startsWith(`${session}|`))
    const pid = Number.parseInt(pane?.split('|')[1] ?? '', 10)
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      throw new Error(`tmux lost Pane identity for ${session}: ${JSON.stringify(panes.stdout)}`)
    }
    if (pid !== run.pid) throw new Error(`tmux reconnect changed fixture PID for ${session}`)
    return { durationUs: elapsedUs(start), replay, pid }
  }

  async stop(session) {
    if (!this.sessions.has(session)) throw new Error(`Refusing to stop unowned tmux Session ${session}`)
    await this.command(['kill-session', '-t', `=${session}`])
    this.sessions.delete(session)
    const pid = this.fixturePids.get(session)
    if (pid !== undefined && await waitForStopped([pid], 500)) this.fixturePids.delete(session)
  }

  async assertStopped(runs) {
    let listed = ''
    try {
      listed = (await this.command(['list-sessions', '-F', '#{session_name}'])).stdout
    } catch (error) {
      if (!(error instanceof Error && /no server sessions/u.test(error.message))) throw error
    }
    const liveNames = new Set(listed.split('\n').filter(Boolean))
    return {
      noLiveOwnerObjects: runs.every((run) => !liveNames.has(run.runId)),
      fixturePidsStopped: await waitForStopped(runs.map((run) => run.pid), 1_000)
    }
  }

  async cleanup() {
    const errors = []
    for (const session of [...this.sessions]) {
      try {
        await this.command(['kill-session', '-t', `=${session}`])
        const pid = this.fixturePids.get(session)
        if (pid !== undefined && await waitForStopped([pid], 500)) this.fixturePids.delete(session)
      } catch (error) { errors.push(error) }
      this.sessions.delete(session)
    }
    try {
      if (this.initialized) await this.command(['kill-server'])
    } catch (error) {
      if (!(error instanceof Error && /no server running/u.test(error.message))) errors.push(error)
    }
    if (errors.length > 0) throw new AggregateError(errors, 'tmux benchmark cleanup failed')
  }
}

function latencyOffsets(count, pollMs) {
  const random = seededRandom(8008)
  return Array.from({ length: count }, () => Math.floor(random() * pollMs))
}

async function runInputLatency(runtime, kind, config) {
  const run = await runtime.create('echo', `${kind}-latency`)
  await runtime.wait(run.runId, `run-kernel-ready:${kind}-latency`)
  const total = config.warmup + config.samples
  const offsets = latencyOffsets(total, config.pollMs)
  const attempts = []
  for (let index = 0; index < total; index += 1) {
    const marker = `latency:${index}`
    const visible = `run-kernel-input:${marker}`
    const periodStart = Date.now()
    await delay(offsets[index])
    const start = nowNs()
    try {
      await runtime.write(run.runId, `${marker}\n`)
      if (kind === 'tmux') {
        const firstCaptureAt = periodStart + config.pollMs
        await delay(Math.max(0, firstCaptureAt - Date.now()))
        await runtime.wait(run.runId, visible, 30_000, config.pollMs)
      } else {
        await runtime.wait(run.runId, visible)
      }
      attempts.push({ index, warmup: index < config.warmup, offsetMs: offsets[index], durationUs: elapsedUs(start), ok: true })
    } catch (error) {
      attempts.push({ index, warmup: index < config.warmup, offsetMs: offsets[index], durationUs: null, ok: false, error: errorRecord(error, 'input-to-visible') })
    }
  }
  await runtime.stop(run.runId)
  return {
    attempts,
    samplesUs: attempts.filter((attempt) => !attempt.warmup && attempt.ok).map((attempt) => attempt.durationUs),
    correctness: attempts.every((attempt) => attempt.ok)
  }
}

async function runThroughput(runtime, kind, config) {
  const attempts = []
  const total = config.warmup + config.samples
  for (let index = 0; index < total; index += 1) {
    const label = `${kind}-throughput-${index}-${randomUUID()}`
    const markers = verifiedMarkers(label, config.bytes)
    let run = null
    try {
      run = await runtime.create('verified-burst', label, config.bytes)
      await runtime.wait(run.runId, markers.ready)
      await runtime.write(run.runId, 'go\n')
      const start = nowNs()
      if (kind === 'tmux') await delay(config.pollMs)
      const text = await runtime.wait(run.runId, markers.end, 30_000, kind === 'tmux' ? config.pollMs : 5)
      const durationUs = elapsedUs(start)
      const oracle = verifyBurstOutput(text, label, config.bytes)
      attempts.push({
        index,
        warmup: index < config.warmup,
        durationUs,
        bytesPerSecond: config.bytes / (durationUs / 1_000_000),
        ok: true,
        oracle
      })
    } catch (error) {
      attempts.push({ index, warmup: index < config.warmup, durationUs: null, bytesPerSecond: null, ok: false, error: errorRecord(error, 'throughput') })
    } finally {
      if (run) {
        try { await runtime.stop(run.runId) } catch (error) {
          attempts.at(-1).ok = false
          attempts.at(-1).cleanupError = errorRecord(error, 'throughput-cleanup')
        }
      }
    }
  }
  return {
    attempts,
    samplesBytesPerSecond: attempts.filter((attempt) => !attempt.warmup && attempt.ok).map((attempt) => attempt.bytesPerSecond),
    correctness: attempts.every((attempt) => attempt.ok)
  }
}

async function prepareVerifiedRun(runtime, kind, purpose, bytes) {
  const label = `${kind}-${purpose}-${randomUUID()}`
  const markers = verifiedMarkers(label, bytes)
  const run = await runtime.create('verified-burst', label, bytes)
  await runtime.wait(run.runId, markers.ready)
  await runtime.write(run.runId, 'go\n')
  const text = await runtime.wait(run.runId, markers.end, 30_000, kind === 'tmux' ? 20 : 5)
  verifyBurstOutput(text, label, bytes)
  return { run, label }
}

function replayText(replay) {
  if (typeof replay === 'string') return replay
  if (replay.gap) throw new Error('AgentMux replay reported a Gap')
  return replay.replay.map((chunk) => chunk.data).join('')
}

async function runAttachReplay(runtime, kind, config) {
  const { run, label } = await prepareVerifiedRun(runtime, kind, 'attach', config.bytes)
  if (kind === 'agentmux') await runtime.release(run.runId)
  const attempts = []
  const total = config.warmup + config.samples
  for (let index = 0; index < total; index += 1) {
    const start = nowNs()
    let attached = false
    try {
      const replay = kind === 'agentmux'
        ? await runtime.attachReplay(run.runId)
        : await runtime.capture(run.runId)
      attached = kind === 'agentmux'
      const durationUs = elapsedUs(start)
      verifyBurstOutput(replayText(replay), label, config.bytes)
      attempts.push({ index, warmup: index < config.warmup, durationUs, ok: true })
    } catch (error) {
      attempts.push({ index, warmup: index < config.warmup, durationUs: null, ok: false, error: errorRecord(error, 'attach-replay') })
    } finally {
      if (attached) {
        try {
          await runtime.release(run.runId)
        } catch (error) {
          attempts.at(-1).ok = false
          attempts.at(-1).releaseError = errorRecord(error, 'attach-replay-release')
        }
      }
    }
  }
  await runtime.stop(run.runId)
  return {
    attempts,
    samplesUs: attempts.filter((attempt) => !attempt.warmup && attempt.ok).map((attempt) => attempt.durationUs),
    correctness: attempts.every((attempt) => attempt.ok)
  }
}

async function runReconnect(runtime, kind, config) {
  const { run, label } = await prepareVerifiedRun(runtime, kind, 'reconnect', config.bytes)
  if (kind === 'agentmux') await runtime.release(run.runId)
  const attempts = []
  const total = config.warmup + config.samples
  for (let index = 0; index < total; index += 1) {
    try {
      const result = await runtime.reconnectAndReplay(run)
      if (result.pid !== undefined && result.pid !== run.pid) {
        throw new Error(`${kind} reconnect changed fixture PID`)
      }
      verifyBurstOutput(replayText(result.replay), label, config.bytes)
      attempts.push({ index, warmup: index < config.warmup, durationUs: result.durationUs, pid: run.pid, ok: true })
    } catch (error) {
      attempts.push({ index, warmup: index < config.warmup, durationUs: null, pid: run.pid, ok: false, error: errorRecord(error, 'reconnect') })
    }
  }
  await runtime.stop(run.runId)
  return {
    attempts,
    samplesUs: attempts.filter((attempt) => !attempt.warmup && attempt.ok).map((attempt) => attempt.durationUs),
    correctness: attempts.every((attempt) => attempt.ok)
  }
}

async function processRssKiB(pid) {
  const output = await commandOutput('ps', ['-o', 'rss=', '-p', String(pid)], { timeoutMs: 2_000, maxBuffer: 64 * 1024 })
  const value = Number.parseInt(output, 10)
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Invalid RSS for PID ${pid}: ${output}`)
  return value
}

async function samplePeakRss(pid, operation) {
  const samplesKiB = []
  let active = true
  const sampler = (async () => {
    while (active) {
      try { samplesKiB.push(await processRssKiB(pid)) } catch {}
      await delay(10)
    }
  })()
  try {
    const value = await operation()
    return { value, samplesKiB, peakKiB: samplesKiB.length > 0 ? Math.max(...samplesKiB) : await processRssKiB(pid) }
  } finally {
    active = false
    await sampler
  }
}

async function runScale(runtime, kind, config, ownerPid) {
  const rounds = []
  for (let round = 0; round < config.rounds; round += 1) {
    const runs = []
    const start = nowNs()
    const creationErrors = []
    const measured = await samplePeakRss(ownerPid, async () => {
      const created = await Promise.allSettled(Array.from({ length: config.sessions }, async (_, index) => {
        const label = `${kind}-scale-${round}-${index}-${randomUUID()}`
        const run = await runtime.create('echo', label)
        if (kind === 'tmux') await delay(config.pollMs)
        await runtime.wait(
          run.runId,
          `run-kernel-ready:${label}`,
          30_000,
          kind === 'tmux' ? config.pollMs : 5
        )
        return run
      }))
      for (const result of created) {
        if (result.status === 'fulfilled') runs.push(result.value)
        else creationErrors.push(errorRecord(result.reason, 'scale-create'))
      }
    })
    const wallUs = elapsedUs(start)
    const errors = []
    for (const run of runs) {
      try { await runtime.stop(run.runId) } catch (error) { errors.push(errorRecord(error, 'scale-cleanup')) }
    }
    let cleanupOracle = { noLiveOwnerObjects: false, fixturePidsStopped: false }
    try {
      cleanupOracle = await runtime.assertStopped(runs)
    } catch (error) {
      errors.push(errorRecord(error, 'scale-cleanup-oracle'))
    }
    rounds.push({
      round: round + 1,
      wallUs,
      sessionsPerSecond: config.sessions / (wallUs / 1_000_000),
      peakRssKiB: measured.peakKiB,
      rssSamplesKiB: measured.samplesKiB,
      failures: [...creationErrors, ...errors],
      cleanupOracle,
      ok:
        runs.length === config.sessions &&
        creationErrors.length === 0 &&
        errors.length === 0 &&
        cleanupOracle.noLiveOwnerObjects &&
        cleanupOracle.fixturePidsStopped
    })
  }
  return {
    rounds,
    wallSamplesUs: rounds.filter((round) => round.ok).map((round) => round.wallUs),
    sessionsPerSecond: rounds.filter((round) => round.ok).map((round) => round.sessionsPerSecond),
    correctness: rounds.every((round) => round.ok)
  }
}

async function processState(pid) {
  try {
    return await commandOutput('ps', ['-o', 'stat=', '-p', String(pid)], { timeoutMs: 2_000, maxBuffer: 64 * 1024 })
  } catch {
    return ''
  }
}

async function processStopped(pid) {
  const state = await processState(pid)
  return state === '' || state.startsWith('Z')
}

async function waitForStopped(pids, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if ((await Promise.all(pids.map(processStopped))).every(Boolean)) return true
    await delay(10)
  }
  return false
}

function parseStubbornPids(text, label) {
  const match = new RegExp(`run-kernel-stubborn-ready:${label}:(\\d+):(\\d+)`, 'u').exec(text)
  if (!match) throw new Error(`Missing stubborn process tree marker for ${label}`)
  return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)]
}

async function runStopCleanup(runtime, kind, config, emergencyPids) {
  const attempts = []
  for (let index = 0; index < config.samples; index += 1) {
    const label = `${kind}-stop-${index}-${randomUUID()}`
    let run = null
    try {
      run = await runtime.create('stubborn-tree', label)
      const text = await runtime.wait(run.runId, `run-kernel-stubborn-ready:${label}`)
      const pids = parseStubbornPids(text, label)
      for (const pid of pids) emergencyPids.add(pid)
      const start = nowNs()
      await runtime.stop(run.runId)
      const cleanupSuccess = await waitForStopped(pids, 5_000)
      attempts.push({
        index,
        durationUs: elapsedUs(start),
        pids,
        cleanupSuccess,
        ok: cleanupSuccess
      })
      if (cleanupSuccess) {
        for (const pid of pids) emergencyPids.delete(pid)
      } else {
        attempts.at(-1).emergencyKilledPids = await emergencyStopFixturePids(new Set(pids))
        for (const pid of pids) emergencyPids.delete(pid)
      }
    } catch (error) {
      attempts.push({ index, durationUs: null, cleanupSuccess: false, ok: false, error: errorRecord(error, 'stop-cleanup') })
      if (run) {
        try { await runtime.stop(run.runId) } catch {}
      }
    }
  }
  return {
    attempts,
    samplesUs: attempts.filter((attempt) => attempt.ok).map((attempt) => attempt.durationUs),
    correctness: attempts.every((attempt) => attempt.cleanupSuccess)
  }
}

function parsePsTime(value) {
  const dayParts = value.trim().split('-')
  const days = dayParts.length === 2 ? Number.parseInt(dayParts[0], 10) : 0
  const clock = dayParts.at(-1).split(':').map(Number)
  if (clock.some((part) => !Number.isFinite(part))) throw new Error(`Invalid ps time: ${value}`)
  if (clock.length === 1) return days * 86_400 + clock[0]
  if (clock.length === 2) return days * 86_400 + clock[0] * 60 + clock[1]
  if (clock.length === 3) return days * 86_400 + clock[0] * 3_600 + clock[1] * 60 + clock[2]
  throw new Error(`Invalid ps time: ${value}`)
}

async function processCpuSeconds(pid) {
  return parsePsTime(await commandOutput('ps', ['-o', 'time=', '-p', String(pid)], { timeoutMs: 2_000, maxBuffer: 64 * 1024 }))
}

async function processFdCount(pid) {
  const output = await commandOutput('lsof', ['-a', '-p', String(pid), '-Fn'], {
    timeoutMs: 5_000,
    maxBuffer: 4 * 1024 * 1024
  })
  return output.split('\n').filter((line) => /^f/u.test(line)).length
}

async function sampleProcess(pid, config) {
  const rssSamplesKiB = []
  const cpuStart = await processCpuSeconds(pid)
  const wallStart = nowNs()
  for (let index = 0; index < config.samples; index += 1) {
    rssSamplesKiB.push(await processRssKiB(pid))
    if (index + 1 < config.samples) await delay(config.intervalMs)
  }
  const wallSeconds = Number(nowNs() - wallStart) / 1_000_000_000
  const cpuSeconds = await processCpuSeconds(pid) - cpuStart
  return {
    rssSamplesKiB,
    meanRssKiB: mean(rssSamplesKiB),
    fdCount: await processFdCount(pid),
    cpuSeconds,
    wallSeconds,
    cpuPercent: wallSeconds === 0 ? 0 : cpuSeconds / wallSeconds * 100
  }
}

async function runResources(runtime, kind, config, ownerPid) {
  await delay(config.settleMs)
  const idle = await sampleProcess(ownerPid, config)

  const oneLabel = `${kind}-resource-one-${randomUUID()}`
  const one = await runtime.create('echo', oneLabel)
  await runtime.wait(one.runId, `run-kernel-ready:${oneLabel}`)
  const oneSession = await sampleProcess(ownerPid, config)
  await runtime.stop(one.runId)

  const runs = await Promise.all(Array.from({ length: config.sessions }, async (_, index) => {
    const label = `${kind}-resource-scale-${index}-${randomUUID()}`
    const run = await runtime.create('echo', label)
    await runtime.wait(run.runId, `run-kernel-ready:${label}`)
    return run
  }))
  const manySessions = await sampleProcess(ownerPid, config)
  for (const run of runs) await runtime.stop(run.runId)

  const label = `${kind}-resource-throughput-${randomUUID()}`
  const markers = verifiedMarkers(label, config.bytes)
  const throughputRun = await runtime.create('verified-burst', label, config.bytes)
  await runtime.wait(throughputRun.runId, markers.ready)
  const fixtureRssKiB = Number.isSafeInteger(throughputRun.pid) && throughputRun.pid > 1
    ? await processRssKiB(throughputRun.pid)
    : null
  const measured = await samplePeakRss(ownerPid, async () => {
    await runtime.write(throughputRun.runId, 'go\n')
    if (kind === 'tmux') await delay(config.pollMs)
    const text = await runtime.wait(
      throughputRun.runId,
      markers.end,
      30_000,
      kind === 'tmux' ? config.pollMs : 5
    )
    verifyBurstOutput(text, label, config.bytes)
  })
  if (measured.samplesKiB.length === 0) {
    throw new Error(`${kind} produced no RSS sample during sustained output`)
  }
  const steady = {
    rssSamplesKiB: measured.samplesKiB,
    meanRssKiB: mean(measured.samplesKiB)
  }
  await runtime.stop(throughputRun.runId)
  const released = await sampleProcess(ownerPid, config)
  const resourceRunCount = config.sessions + 2
  const retainedHistoricalFdsPerRun = (released.fdCount - idle.fdCount) / resourceRunCount

  return {
    idle,
    oneSession,
    manySessions,
    steady,
    peakRssKiB: measured.peakKiB,
    peakRssSamplesKiB: measured.samplesKiB,
    fixtureRssKiB,
    released,
    retainedHistoricalFdsPerRun,
    perSessionRssKiB: (manySessions.meanRssKiB - idle.meanRssKiB) / config.sessions,
    oneSessionIncrementKiB: oneSession.meanRssKiB - idle.meanRssKiB,
    correctness: kind !== 'agentmux' || retainedHistoricalFdsPerRun <= 2.25
  }
}

function summarizeWorkloads(workloads) {
  const summary = {}
  for (const [name, metrics] of Object.entries({
    inputToVisible: { agentmux: workloads.inputToVisible.agentmux.samplesUs, tmux: workloads.inputToVisible.tmux.samplesUs },
    throughput: { agentmux: workloads.throughput.agentmux.samplesBytesPerSecond, tmux: workloads.throughput.tmux.samplesBytesPerSecond },
    attachReplay: { agentmux: workloads.attachReplay.agentmux.samplesUs, tmux: workloads.attachReplay.tmux.samplesUs },
    reconnect: { agentmux: workloads.reconnect.agentmux.samplesUs, tmux: workloads.reconnect.tmux.samplesUs },
    scaleWall: { agentmux: workloads.sessionScale.agentmux.wallSamplesUs, tmux: workloads.sessionScale.tmux.wallSamplesUs },
    scaleRate: { agentmux: workloads.sessionScale.agentmux.sessionsPerSecond, tmux: workloads.sessionScale.tmux.sessionsPerSecond },
    stopCleanup: { agentmux: workloads.stopCleanup.agentmux.samplesUs, tmux: workloads.stopCleanup.tmux.samplesUs }
  })) {
    summary[name] = {}
    for (const [runtime, samples] of Object.entries(metrics)) {
      summary[name][runtime] = samples.length > 0 ? summarizeSamples(samples) : null
    }
  }
  summary.resources = {
    agentmux: resourceSummary(workloads.resources.agentmux),
    tmux: resourceSummary(workloads.resources.tmux)
  }
  return summary
}

function resourceSummary(resources) {
  if (!resources || resources.correctness !== true) {
    return {
      idleCpuPercent: null,
      idleRssKiB: null,
      perSessionRssKiB: null,
      steadyRssKiB: null,
      peakRssKiB: null,
      releasedRssKiB: null
    }
  }
  return {
    idleCpuPercent: resources.idle.cpuPercent,
    idleRssKiB: resources.idle.meanRssKiB,
    perSessionRssKiB: resources.perSessionRssKiB,
    steadyRssKiB: resources.steady.meanRssKiB,
    peakRssKiB: resources.peakRssKiB,
    releasedRssKiB: resources.released.meanRssKiB
  }
}

function assessCorrectness(workloads) {
  const failures = []
  const qualitativeWins = []
  const skippedComparisons = []
  const workloadNames = [
    'inputToVisible',
    'throughput',
    'attachReplay',
    'reconnect',
    'sessionScale',
    'stopCleanup',
    'resources'
  ]
  for (const name of workloadNames) {
    if (workloads?.[name]?.agentmux?.correctness !== true) {
      failures.push(`correctness.agentmux.${name}`)
    }
  }
  for (const name of workloadNames.filter((name) => name !== 'stopCleanup')) {
    if (workloads?.[name]?.tmux?.correctness !== true) {
      failures.push(`correctness.tmux.${name}`)
    }
  }
  const tmuxStopCorrectness = workloads?.stopCleanup?.tmux?.correctness
  if (tmuxStopCorrectness === false) {
    if (workloads?.stopCleanup?.agentmux?.correctness === true) {
      qualitativeWins.push('stopCleanup.complete-process-tree')
      skippedComparisons.push('stopCleanup.p95')
    }
  } else if (tmuxStopCorrectness !== true) {
    failures.push('correctness.tmux.stopCleanup.missing')
  }
  return {
    failures,
    qualitativeWins,
    skippedComparisons,
    compareStopPerformance: tmuxStopCorrectness === true
  }
}

export function evaluateFullRound(workloads, summary, environmentMatches) {
  const failures = []
  const correctness = assessCorrectness(workloads)
  if (!environmentMatches) failures.push('environment')
  if (correctness.failures.length > 0) failures.push('correctness', ...correctness.failures)
  const metricPair = (name, metric) => ({
    agentmux: summary?.[name]?.agentmux?.[metric],
    tmux: summary?.[name]?.tmux?.[metric]
  })
  const less = (name, metric) => {
    const pair = metricPair(name, metric)
    if (!Number.isFinite(pair.agentmux) || !Number.isFinite(pair.tmux)) {
      failures.push(`${name}.${metric}.missing`)
    } else if (pair.agentmux >= pair.tmux) {
      failures.push(`${name}.${metric}`)
    }
  }
  const greater = (name, metric) => {
    const pair = metricPair(name, metric)
    if (!Number.isFinite(pair.agentmux) || !Number.isFinite(pair.tmux)) {
      failures.push(`${name}.${metric}.missing`)
    } else if (pair.agentmux <= pair.tmux) {
      failures.push(`${name}.${metric}`)
    }
  }
  for (const metric of ['p50', 'p95', 'p99']) {
    less('inputToVisible', metric)
    less('attachReplay', metric)
    less('reconnect', metric)
  }
  greater('throughput', 'p50')
  less('scaleWall', 'p50')
  greater('scaleRate', 'p50')
  if (correctness.compareStopPerformance) less('stopCleanup', 'p95')
  for (const metric of ['idleCpuPercent', 'idleRssKiB', 'perSessionRssKiB', 'steadyRssKiB', 'peakRssKiB', 'releasedRssKiB']) {
    less('resources', metric)
  }
  const budget = (metric, maximum) => {
    const value = summary?.resources?.agentmux?.[metric]
    if (!Number.isFinite(value)) {
      failures.push(`budget.${metric}.missing`)
    } else if (value > maximum) {
      failures.push(`budget.${metric}`)
    }
  }
  budget('idleCpuPercent', 1)
  budget('idleRssKiB', 96 * 1024)
  budget('peakRssKiB', 160 * 1024)
  return {
    verdict: failures.length === 0 ? 'pass' : 'fail',
    failures,
    qualitativeWins: correctness.qualitativeWins,
    skippedComparisons: correctness.skippedComparisons
  }
}

async function environmentManifest(mode) {
  const [gitSha, gitStatusResult, tmuxVersion, productVersion, darwinVersion, cpu, pnpmVersion] = await Promise.all([
    commandOutput('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot }),
    runCommand('git', ['status', '--porcelain=v1', '-z', '--untracked-files=normal'], { cwd: repositoryRoot }),
    commandOutput('tmux', ['-V']),
    commandOutput('sw_vers', ['-productVersion']),
    commandOutput('uname', ['-r']),
    commandOutput('sysctl', ['-n', 'machdep.cpu.brand_string']),
    commandOutput('pnpm', ['--version'])
  ])
  const statusEntries = gitStatusResult.stdout
    .split('\0')
    .filter(Boolean)
  const dirtyPaths = statusEntries.map((entry) => entry.slice(3))
  const trackedDirtyPaths = statusEntries
    .filter((entry) => !entry.startsWith('?? '))
    .map((entry) => entry.slice(3))
  const untrackedPaths = statusEntries
    .filter((entry) => entry.startsWith('?? '))
    .map((entry) => entry.slice(3))
  const environment = {
    os: `macOS ${productVersion}`,
    darwin: darwinVersion,
    platform: platform(),
    release: release(),
    arch: arch(),
    cpu,
    cpuCount: cpus().length,
    memoryBytes: totalmem(),
    node: process.version,
    pnpm: pnpmVersion,
    tmux: tmuxVersion,
    terminalGeometry: geometry,
    locale: localeEnvironment
  }
  const expected = {
    os: 'macOS 26.3.2',
    darwin: '25.3.0',
    arch: 'arm64',
    cpu: 'Apple M4 Pro',
    memoryBytes: 51_539_607_552,
    node: 'v24.14.1',
    pnpm: '11.5.1',
    tmux: 'tmux 3.6b'
  }
  const mismatches = Object.entries(expected).flatMap(([name, value]) => (
    environment[name] === value ? [] : [{ name, expected: value, actual: environment[name] }]
  ))
  if (mode === 'full' && trackedDirtyPaths.length > 0) {
    mismatches.push({ name: 'trackedDirtyPaths', expected: [], actual: trackedDirtyPaths })
  }
  return {
    gitSha,
    dirtyPaths,
    trackedDirtyPaths,
    untrackedPaths,
    environment,
    expected,
    mismatches,
    matches: mismatches.length === 0
  }
}

async function verifyCtxmuxArtifact(client) {
  const bytes = await readFile(manifestPath)
  const digest = createHash('sha256').update(bytes).digest('hex')
  const manifest = JSON.parse(bytes.toString('utf8'))
  const diagnostics = await client.runtimeDiagnostics()
  if (
    digest !== CTXMUX_ARTIFACT.manifestSha256 ||
    manifest.source.commit !== CTXMUX_ARTIFACT.commit ||
    manifest.source.tree !== CTXMUX_ARTIFACT.tree ||
    manifest.product.version !== CTXMUX_ARTIFACT.version ||
    manifest.product.protocol !== CTXMUX_ARTIFACT.protocol ||
    diagnostics.ctxmux.sourceCommit !== CTXMUX_ARTIFACT.commit ||
    diagnostics.ctxmux.version !== CTXMUX_ARTIFACT.version ||
    diagnostics.ctxmux.protocolVersion !== CTXMUX_ARTIFACT.protocol ||
    diagnostics.ctxmux.ready !== true
  ) {
    throw new Error('Candidate does not match the frozen CtxMux artifact and public diagnostic contract')
  }
  return { frozen: { ...CTXMUX_ARTIFACT }, publicDiagnostics: diagnostics.ctxmux }
}

export function parseOwnedDaemonProcesses(psOutput, expected) {
  const required = [expected.daemonPath, '--socket', expected.socketPath, '--state-dir', expected.stateDirectory]
  return psOutput.split('\n').flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line)
    if (!match) return []
    const command = match[2]
    let cursor = 0
    for (const token of required) {
      const next = command.indexOf(token, cursor)
      if (next < 0) return []
      cursor = next + token.length
    }
    const pid = Number.parseInt(match[1], 10)
    return Number.isSafeInteger(pid) && pid > 1 ? [pid] : []
  })
}

async function ownedDaemonPids(runtimeDirectory) {
  const ps = await commandOutput('ps', ['-axo', 'pid=,command='], { timeoutMs: 5_000, maxBuffer: 4 * 1024 * 1024 })
  return parseOwnedDaemonProcesses(ps, {
    daemonPath,
    socketPath: join(runtimeDirectory, 'ctxmux.sock'),
    stateDirectory: join(runtimeDirectory, 'state')
  })
}

async function stopOwnedDaemon(runtimeDirectory) {
  const pids = await ownedDaemonPids(runtimeDirectory)
  if (pids.length > 1) throw new Error('Multiple daemons matched the exact benchmark runtime scope')
  if (pids.length === 0) return { matchedPids: [], stopped: true }
  const [pid] = pids
  process.kill(pid, 'SIGTERM')
  if (!(await waitForStopped([pid], 2_000))) {
    process.kill(pid, 'SIGKILL')
    if (!(await waitForStopped([pid], 2_000))) throw new Error(`Owned CtxMux daemon ${pid} did not stop`)
  }
  return { matchedPids: pids, stopped: true }
}

async function emergencyStopFixturePids(pids) {
  const stopped = []
  for (const pid of pids) {
    if (await processStopped(pid)) continue
    let command
    try {
      command = await commandOutput('ps', ['-o', 'command=', '-p', String(pid)], {
        timeoutMs: 2_000,
        maxBuffer: 64 * 1024
      })
    } catch {
      continue
    }
    if (!command.includes(fixturePath)) continue
    process.kill(pid, 'SIGKILL')
    stopped.push(pid)
  }
  if (!(await waitForStopped(stopped, 2_000))) throw new Error('Benchmark-owned fixture cleanup did not converge')
  return stopped
}

async function runRuntimeWorkloads(agentmux, tmux, config, daemonPid, tmuxPid, emergencyPids) {
  const failed = (shape, error, phase) => ({
    ...structuredClone(shape),
    correctness: false,
    errors: [errorRecord(error, phase)]
  })
  const safe = async (operation, shape, phase) => {
    try {
      return await operation()
    } catch (error) {
      return failed(shape, error, phase)
    }
  }
  const paired = async (operation, shape, phase) => ({
    agentmux: await safe(async () => await operation(agentmux, 'agentmux'), shape, `${phase}.agentmux`),
    tmux: await safe(async () => await operation(tmux, 'tmux'), shape, `${phase}.tmux`)
  })
  const latencyShape = { attempts: [], samplesUs: [] }
  const throughputShape = { attempts: [], samplesBytesPerSecond: [] }
  const scaleShape = { rounds: [], wallSamplesUs: [], sessionsPerSecond: [] }
  const resourcesShape = {}
  const workloads = {}
  workloads.resources = {
    agentmux: await safe(
      async () => await runResources(agentmux, 'agentmux', config.resources, daemonPid),
      resourcesShape,
      'resources.agentmux'
    ),
    tmux: await safe(
      async () => await runResources(tmux, 'tmux', config.resources, tmuxPid),
      resourcesShape,
      'resources.tmux'
    )
  }
  workloads.inputToVisible = await paired(
    async (runtime, kind) => await runInputLatency(runtime, kind, config.latency),
    latencyShape,
    'input-to-visible'
  )
  workloads.throughput = await paired(
    async (runtime, kind) => await runThroughput(runtime, kind, config.throughput),
    throughputShape,
    'throughput'
  )
  workloads.attachReplay = await paired(
    async (runtime, kind) => await runAttachReplay(runtime, kind, config.attach),
    latencyShape,
    'attach-replay'
  )
  workloads.reconnect = await paired(
    async (runtime, kind) => await runReconnect(runtime, kind, config.reconnect),
    latencyShape,
    'reconnect'
  )
  workloads.sessionScale = {
    agentmux: await safe(
      async () => await runScale(agentmux, 'agentmux', config.scale, daemonPid),
      scaleShape,
      'scale.agentmux'
    ),
    tmux: await safe(
      async () => await runScale(tmux, 'tmux', config.scale, tmuxPid),
      scaleShape,
      'scale.tmux'
    )
  }
  workloads.stopCleanup = {
    agentmux: await safe(
      async () => await runStopCleanup(agentmux, 'agentmux', config.stop, emergencyPids),
      latencyShape,
      'stop.agentmux'
    ),
    tmux: await safe(
      async () => await runStopCleanup(tmux, 'tmux', config.stop, emergencyPids),
      latencyShape,
      'stop.tmux'
    )
  }
  if (Object.keys(workloads).some((name, index) => name !== WORKLOAD_EXECUTION_ORDER[index])) {
    throw new Error('Benchmark workload execution order drifted from Protocol Revision 3')
  }
  return workloads
}

async function writeExclusive(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
  } finally {
    await handle.close()
  }
}

function defaultOutputPath(round, gitSha) {
  const timestamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '')
  return join(
    formalResultsDirectory,
    `${FORMAL_RESULT_PREFIX}-round-${round}-${gitSha.slice(0, 8)}-${platform()}-${arch()}-${timestamp}.json`
  )
}

export async function runBenchmark(options) {
  if (platform() !== 'darwin' || arch() !== 'arm64') {
    throw new Error('Revision 3 is frozen for darwin-arm64 only')
  }
  if (!(await commandAvailable('tmux'))) throw new Error('tmux is required for the frozen baseline')
  const startedAt = new Date().toISOString()
  const runId = randomUUID()
  const root = await mkdtemp('/private/tmp/agentmux-benchmark-')
  const runtimeDirectory = join(root, 'agentmux-runtime')
  const tmuxDirectory = join(root, 'tmux')
  const socketName = `agentmux-benchmark-${runId.slice(0, 8)}`
  const hadRuntimeDirectory = Object.hasOwn(process.env, 'AGENTMUX_RUNTIME_DIRECTORY')
  const previousRuntimeDirectory = process.env.AGENTMUX_RUNTIME_DIRECTORY
  const emergencyPids = new Set()
  const cleanup = { agentmux: null, tmux: null, fixtures: null, daemon: null, rootRemoved: false, errors: [] }
  let config = null
  let environment = {
    gitSha: 'unresolved',
    dirtyPaths: [],
    trackedDirtyPaths: [],
    untrackedPaths: [],
    environment: null,
    expected: null,
    mismatches: [],
    matches: false
  }
  let agentmux = null
  let tmux = null
  let result
  try {
    const rootMetadata = await stat(root)
    if ((rootMetadata.mode & 0o077) !== 0) throw new Error('Benchmark root is not private')
    await Promise.all([
      mkdir(runtimeDirectory, { recursive: true, mode: 0o700 }),
      mkdir(tmuxDirectory, { recursive: true, mode: 0o700 })
    ])
    process.env.AGENTMUX_RUNTIME_DIRECTORY = runtimeDirectory
    config = benchmarkConfiguration(options.mode)
    const { AgentMuxClient } = await import(pathToFileURL(join(packageRoot, 'dist', 'index.js')).href)
    environment = await environmentManifest(options.mode)
    const tmuxEnvironment = { ...process.env, ...localeEnvironment, TMUX_TMPDIR: tmuxDirectory }
    agentmux = new AgentMuxHarness(AgentMuxClient, runtimeDirectory)
    tmux = new TmuxHarness(socketName, tmuxEnvironment)
    await agentmux.initialize()
    const ctxmux = await verifyCtxmuxArtifact(agentmux.client)
    await tmux.initialize()
    const daemonPids = await ownedDaemonPids(runtimeDirectory)
    if (daemonPids.length !== 1) throw new Error(`Expected one exact benchmark CtxMux daemon, found ${daemonPids.length}`)
    const workloads = await runRuntimeWorkloads(
      agentmux,
      tmux,
      config,
      daemonPids[0],
      tmux.serverPid,
      emergencyPids
    )
    const summary = summarizeWorkloads(workloads)
    const smokeCorrectness = assessCorrectness(workloads)
    const decision = options.mode === 'smoke'
      ? {
          verdict: 'smoke',
          failures: smokeCorrectness.failures,
          qualitativeWins: smokeCorrectness.qualitativeWins,
          skippedComparisons: smokeCorrectness.skippedComparisons
        }
      : evaluateFullRound(workloads, summary, environment.matches)
    result = {
      schema: BENCHMARK_SCHEMA,
      protocolRevision: PROTOCOL_REVISION,
      runnerVersion: RUNNER_VERSION,
      mode: options.mode,
      runId,
      round: options.round,
      manifest: {
        startedAt,
        endedAt: null,
        gitSha: environment.gitSha,
        dirtyPaths: environment.dirtyPaths,
        trackedDirtyPaths: environment.trackedDirtyPaths,
        untrackedPaths: environment.untrackedPaths,
        environment: environment.environment,
        expectedEnvironment: environment.expected,
        environmentMismatches: environment.mismatches,
        ctxmux,
        tmuxSocketName: socketName,
        runtimeScope: root,
        workloadConfig: config,
        statistics: {
          percentiles: 'nearest-rank',
          standardDeviation: 'population',
          bootstrap: { seed: 8008, iterations: 10_000, prng: 'mulberry32', confidence: 0.95 },
          outliers: 'retained'
        }
      },
      comparators: {
        tmux: { available: true, version: environment.environment.tmux },
        zellij: { available: await commandAvailable('zellij') },
        weztermMux: { available: await commandAvailable('wezterm') },
        orca: { status: 'not_comparable' },
        paseo: { status: 'not_comparable' }
      },
      workloads,
      correctness: Object.fromEntries(
        Object.entries(workloads).map(([name, pair]) => [name, {
          agentmux: pair.agentmux.correctness,
          tmux: pair.tmux.correctness
        }])
      ),
      summary,
      verdict: decision.verdict,
      verdictFailures: decision.failures,
      qualitativeWins: decision.qualitativeWins,
      skippedComparisons: decision.skippedComparisons,
      cleanup
    }
  } catch (error) {
    result = {
      schema: BENCHMARK_SCHEMA,
      protocolRevision: PROTOCOL_REVISION,
      runnerVersion: RUNNER_VERSION,
      mode: options.mode,
      runId,
      round: options.round,
      manifest: {
        startedAt,
        endedAt: null,
        gitSha: environment.gitSha,
        dirtyPaths: environment.dirtyPaths,
        trackedDirtyPaths: environment.trackedDirtyPaths,
        untrackedPaths: environment.untrackedPaths,
        environment: environment.environment,
        expectedEnvironment: environment.expected,
        environmentMismatches: environment.mismatches,
        runtimeScope: root,
        workloadConfig: config
      },
      comparators: {},
      workloads: {},
      correctness: { runner: false },
      summary: {},
      verdict: options.mode === 'smoke' ? 'smoke' : 'fail',
      verdictFailures: ['runner'],
      qualitativeWins: [],
      skippedComparisons: [],
      runnerError: errorRecord(error, 'runner'),
      cleanup
    }
  } finally {
    try {
      if (agentmux) {
        try { await agentmux.cleanup(); cleanup.agentmux = { stoppedTrackedRuns: true } } catch (error) { cleanup.errors.push(errorRecord(error, 'agentmux-cleanup')) }
      }
      if (tmux) {
        try { await tmux.cleanup(); cleanup.tmux = { killedExactSocket: socketName } } catch (error) { cleanup.errors.push(errorRecord(error, 'tmux-cleanup')) }
      }
      for (const pid of [
        ...(agentmux ? agentmux.fixturePids.values() : []),
        ...(tmux ? tmux.fixturePids.values() : [])
      ]) emergencyPids.add(pid)
      try { cleanup.fixtures = { emergencyKilledPids: await emergencyStopFixturePids(emergencyPids) } } catch (error) { cleanup.errors.push(errorRecord(error, 'fixture-cleanup')) }
      try { cleanup.daemon = await stopOwnedDaemon(runtimeDirectory) } catch (error) { cleanup.errors.push(errorRecord(error, 'daemon-cleanup')) }
      if (cleanup.errors.length === 0) {
        try {
          await rm(root, { recursive: true })
          cleanup.rootRemoved = true
        } catch (error) {
          cleanup.errors.push(errorRecord(error, 'root-cleanup'))
        }
      }
    } finally {
      if (hadRuntimeDirectory) process.env.AGENTMUX_RUNTIME_DIRECTORY = previousRuntimeDirectory
      else delete process.env.AGENTMUX_RUNTIME_DIRECTORY
    }
  }
  result.manifest.endedAt = new Date().toISOString()
  result.correctness.cleanup = cleanup.errors.length === 0
  if (cleanup.errors.length > 0) {
    if (!result.verdictFailures.includes('cleanup')) result.verdictFailures.push('cleanup')
    if (options.mode === 'full') result.verdict = 'fail'
  }
  const output = options.output ?? defaultOutputPath(options.round, result.manifest.gitSha)
  await writeExclusive(output, result)
  return { output, result }
}

function printHelp() {
  process.stdout.write(`Usage:\n  pnpm benchmark:daemon-cutover -- --round <1|2>\n  pnpm benchmark:daemon-cutover:smoke -- --round 1 --output /private/tmp/result.json\n`)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  try {
    const options = parseBenchmarkArguments(process.argv.slice(2))
    if (options.help) {
      printHelp()
    } else {
      const receipt = await runBenchmark(options)
      process.stdout.write(`${JSON.stringify({ output: receipt.output, verdict: receipt.result.verdict })}\n`)
      if (receipt.result.verdict === 'fail') process.exitCode = 1
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
