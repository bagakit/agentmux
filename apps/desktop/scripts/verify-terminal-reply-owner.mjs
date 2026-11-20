import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs, promisify } from 'node:util'
import { fixturePath } from './lib/fixture-values.mjs'
import { listProbeProcesses, stopProbeProcesses } from './probe-process.mjs'

// Manual Native acceptance. Run it against the pinned product or a private candidate.
// The cross-layer Desktop and Core consumers require their own product verification.
const { values: options } = parseArgs({ options: {
  'daemon-binary': { type: 'string' },
  'cli-binary': { type: 'string' },
  'sdk-entry': { type: 'string' }
} })
const vendor = fileURLToPath(new URL(`../../../packages/core/vendor/ctxmux/${process.platform}-${process.arch}/`, import.meta.url))
const sdk = options['sdk-entry'] ? resolve(options['sdk-entry'])
  : fileURLToPath(new URL('../../../packages/core/node_modules/@ctxmux/sdk/dist/index.js', import.meta.url))
const daemonPath = options['daemon-binary'] ? resolve(options['daemon-binary']) : join(vendor, 'bin/ctxmuxd')
const cliPath = options['cli-binary'] ? resolve(options['cli-binary']) : join(vendor, 'bin/ctxmux')
const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/xterm')
const { CtxmuxClient, PROTOCOL_VERSION } = await import(pathToFileURL(sdk).href)
const exec = promisify(execFile)
const sha256 = data => createHash('sha256').update(data).digest('hex')
const manifest = JSON.parse(await readFile(join(vendor, 'manifest.json'), 'utf8'))
const binaryIdentity = await Promise.all([
  ['ctxmuxd', daemonPath, options['daemon-binary']], ['ctxmux', cliPath, options['cli-binary']]
].map(async ([name, path, override]) => {
  const digest = sha256(await readFile(path))
  if (!override) assert.equal(digest, manifest.binaries.find(binary => binary.name === name)?.sha256)
  return { name, sha256: digest, source: override ? null : manifest.source.commit }
}))
const receipt = {
  schema: 'agentmux.terminal-reply-owner.native.v1', passed: false,
  binaries: binaryIdentity, sdkEntrySha256: sha256(await readFile(sdk)),
  xtermEntrySha256: sha256(await readFile(require.resolve('@xterm/xterm'))),
  cases: [], failures: []
}

const ESC = '\x1b'
const dsr = `${ESC}[3;7R`
const da = `${ESC}[?1;2c`
const reply = Buffer.from(dsr + da)
const ready = 'REPLY_FIXTURE_READY'
const phases = Object.fromEntries(['A', 'C', 'D'].map(command => [command,
  `${ESC}[2J${ESC}[3;7H${ESC}[6n${ESC}[cREPLY_FIXTURE_${command}`
]))
const grid = { rows: 24, cols: 80 }
const root = await mkdtemp(fixturePath('tmp/amux-reply-owner-'))
const state = join(root, 'state')
const socket = join(root, 'runtime.sock')
const transcriptPath = join(root, 'child-input')
const views = []
const client = new CtxmuxClient({ socketPath: socket })
let daemon, daemonExit, diagnostics = '', original
let expectedRaw = ready
let inputCursor = 0
let nativeReplies = false

async function waitFor(label, read, accepts) {
  const deadline = performance.now() + 5_000
  do {
    const observed = await read()
    if (accepts(observed)) return observed
    await delay(20)
  } while (performance.now() < deadline)
  throw new Error(`Private terminal reply probe timed out: ${label}`)
}

function start(program, args, initial_size = grid, terminal_replies) {
  return client.start({ program, args, cwd: root, env: { TERM: 'xterm-256color' }, initial_size, declared_inputs: [],
    ...(terminal_replies === undefined ? {} : { terminal_replies }) })
}

async function assertOriginalOutput() {
  const current = await waitFor('original output fence', () => client.status(original.id),
    run => run.latest_output_bytes >= Buffer.byteLength(expectedRaw))
  assert.equal(current.pid, original.pid)
  assert.equal(current.state.type, 'running')
  return current
}

async function openView(size, initialMarker) {
  // A second Native PTY supplies a real controlling terminal to the physical
  // CLI. xterm interprets that PTY's displayed bytes and actually auto-replies.
  const run = await start(cliPath, ['--socket', socket, 'attach', original.id], size)
  const attachment = await client.attach(run.id)
  const terminal = new Terminal({ ...size, logLevel: 'off' })
  const view = { run, attachment, terminal, text: '', relay: Promise.resolve(), failure: null }
  views.push(view)
  view.subscription = terminal.onData(bytes => {
    view.relay = view.relay.then(() => client.input(run.id, bytes)).catch(error => { view.failure = error })
  })
  const consume = async chunk => {
    await new Promise(done => terminal.write(chunk.data, done))
    view.text += Buffer.from(chunk.data).toString('utf8')
  }
  for (const chunk of attachment.snapshot.replay.chunks) await consume(chunk)
  view.following = (async () => {
    for await (const event of attachment.events()) {
      if (event.type === 'output') await consume(event.chunk)
    }
  })().catch(error => { view.failure = error })
  await waitFor('interactive CLI painted retained output', () => view.text, text => text.includes(initialMarker))
  return view
}

async function fence(view, byte) {
  await view.relay
  if (view.failure) throw view.failure
  // The child receives this ordinary input through the same CLI stdin after
  // everything that xterm generated for the already painted output.
  await client.input(view.run.id, byte)
}

async function observe(label, expected, operation, presenting) {
  const command = await operation()
  const markers = presenting.length ? ['!', '@'].slice(0, presenting.length) : ['#']
  if (presenting.length) await Promise.all(presenting.map((view, index) => fence(view, markers[index])))
  else await client.input(original.id, markers[0])
  const transcript = await waitFor(`${label} input fences`, async () => (await readFile(transcriptPath)).subarray(inputCursor),
    bytes => markers.every(marker => bytes.includes(marker)))
  inputCursor += transcript.length
  const terminalBytes = Buffer.from(transcript.filter(byte => !markers.includes(String.fromCharCode(byte))))
  const commandAccepted = !command || terminalBytes[0] === command.charCodeAt(0)
  const actual = command && commandAccepted ? terminalBytes.subarray(1) : terminalBytes
  const markersAccepted = markers.every(marker => transcript.indexOf(marker) === transcript.lastIndexOf(marker))
  const passed = commandAccepted && markersAccepted && actual.equals(expected)
  receipt.cases.push({ label, presentations: presenting.length, expectedHex: expected.toString('hex'), actualHex: actual.toString('hex'),
    receivedDsr: actual.toString('latin1').split(dsr).length - 1, receivedDa: actual.toString('latin1').split(da).length - 1, passed })
  if (!passed) receipt.failures.push(`${label}: original child input differs from the expected reply bytes`)
}

async function live(command, presenting, label) {
  const fromOutput = Buffer.byteLength(expectedRaw)
  const fromInput = inputCursor
  await observe(label, reply, async () => {
    await client.input(original.id, command)
    expectedRaw += phases[command]
    const current = await assertOriginalOutput()
    if (presenting.length === 0) assert.equal(current.attachments, 0)
    await Promise.all(presenting.map(view => waitFor('interactive CLI painted live output', () => view.text,
      text => text.includes(`REPLY_FIXTURE_${command}`))))
    return command
  }, presenting)
  if (nativeReplies) {
    const { observation } = await client.observeTerminalReplies(original.id, fromOutput)
    const phase = phases[command]
    const dsrEnd = fromInput + 1 + Buffer.byteLength(dsr)
    const daEnd = dsrEnd + Buffer.byteLength(da)
    assert.equal(observation.run_id, original.id)
    assert.equal(observation.process_id, original.pid)
    assert.ok(observation.covers_after_output_byte <= fromOutput)
    assert.equal(observation.through_output_byte, Buffer.byteLength(expectedRaw))
    assert.equal(observation.applied_input_bytes, inputCursor)
    assert.deepEqual(observation.replies, [
      { query_end_byte: fromOutput + phase.indexOf(`${ESC}[6n`) + 4,
        outcome: { state: 'applied', applied_range: { start_byte: fromInput + 1, end_byte: dsrEnd } } },
      { query_end_byte: fromOutput + phase.indexOf(`${ESC}[c`) + 3,
        outcome: { state: 'applied', applied_range: { start_byte: dsrEnd, end_byte: daEnd } } }
    ])
    receipt.cases.at(-1).nativeReplyRangesVerified = true
  }
}

try {
  await mkdir(state, { mode: 0o700 })
  daemon = spawn(daemonPath, ['--socket', socket, '--state-dir', state], {
    detached: true, stdio: ['ignore', 'ignore', 'pipe'], env: { PATH: process.env.PATH }
  })
  daemon.stderr.on('data', bytes => { diagnostics += bytes })
  daemonExit = new Promise(done => {
    daemon.once('exit', (code, signal) => done({ code, signal }))
    daemon.once('error', error => done({ error: String(error) }))
  })
  const runtime = await waitFor('private daemon ready', () => client.runtimeInfo().catch(() => null), Boolean)
  assert.equal(runtime.protocolGeneration, PROTOCOL_VERSION)
  receipt.protocol = runtime.protocolGeneration
  nativeReplies = (runtime.capabilities['native.terminal_replies'] ?? 0) >= 1

  const child = fileURLToPath(new URL('./fixtures/terminal-reply-owner/child.cjs', import.meta.url))
  original = await start(process.execPath, [child, transcriptPath, ready, JSON.stringify(phases)], grid,
    nativeReplies ? 'native_dsr_da' : undefined)
  assert.ok(original.pid > 0)
  assert.equal(original.spec.terminal_replies, nativeReplies ? 'native_dsr_da' : undefined)
  receipt.original = { runId: original.id, pid: original.pid }
  await assertOriginalOutput()
  await live('A', [], 'live with no attachment')
  await observe('history at matching geometry', Buffer.alloc(0), async () => {
    await openView(grid, 'REPLY_FIXTURE_A')
  }, views)
  await live('C', views, 'live with one interactive CLI')
  await observe('history at differing geometry', Buffer.alloc(0), async () => {
    await openView({ rows: 39, cols: 101 }, 'REPLY_FIXTURE_C')
  }, views)
  await live('D', views, 'live with two interactive CLIs')
  await observe('manual input shaped like a device reply', Buffer.from(dsr), async () => {
    await client.input(views[0].run.id, dsr)
  }, views)

  await client.input(original.id, 'q')
  const ended = await waitFor('original child exited', () => client.status(original.id), run => run.state.type === 'exited')
  assert.equal(ended.pid, original.pid)
  assert.equal(ended.state.code, 0)
  assert.deepEqual((await readFile(transcriptPath)).subarray(inputCursor), Buffer.from('q'))
  const raw = await client.attach(original.id)
  try {
    assert.equal(raw.snapshot.replay.truncated, false)
    assert.deepEqual(Buffer.concat(raw.snapshot.replay.chunks.map(chunk => Buffer.from(chunk.data))), Buffer.from(expectedRaw))
  } finally {
    raw.close()
  }
  const { stdout } = await exec(cliPath, ['--socket', socket, 'attach', original.id], {
    cwd: root, timeout: 5_000, encoding: 'buffer'
  })
  assert.deepEqual(stdout, Buffer.from(expectedRaw))
  receipt.raw = { sdkAndPipedCliByteExact: true, bytes: stdout.length, sha256: sha256(stdout) }
} catch (error) {
  receipt.failures.push(error.message)
  if (diagnostics) receipt.daemonDiagnostics = diagnostics
} finally {
  for (const view of views) {
    view.subscription.dispose()
    view.attachment.close()
    await view.following
    view.terminal.dispose()
  }
  try {
    if (daemon?.pid) await stopProbeProcesses(daemon.pid, root)
    const remaining = await listProbeProcesses(daemon?.pid ?? -1, root)
    assert.deepEqual(remaining, [])
    await rm(root, { recursive: true, force: true })
    receipt.cleanup = { remaining, rootRemoved: true, daemonExit: await daemonExit }
  } catch (error) {
    receipt.cleanup = { root, failure: error.message }
    receipt.failures.push('Private cleanup did not finish')
  }
}

receipt.passed = receipt.failures.length === 0
console.log(JSON.stringify(receipt, null, 2))
if (!receipt.passed) process.exitCode = 1
