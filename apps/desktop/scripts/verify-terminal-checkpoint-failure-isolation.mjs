import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses } from './probe-process.mjs'

// Run from the repository root. A binary override is only a private owning-test input;
// the normal gate consumes the actual main vendor artifact and public packaged SDK.
const repositoryRoot = resolve('.')
const vendorRoot = join(repositoryRoot, 'packages/core/vendor/ctxmux/darwin-arm64')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--daemon-binary'), 'Expected only --daemon-binary <private native artifact>')
const daemonPath = args.length ? resolve(args[1]) : join(vendorRoot, 'bin/ctxmuxd')
const sdkRoot = join(repositoryRoot, 'packages/core/node_modules/@ctxmux/sdk/dist')
const { CtxmuxClient, PROTOCOL_VERSION } = await import(pathToFileURL(join(sdkRoot, 'index.js')))
const exec = promisify(execFile), delay = ms => new Promise(done => setTimeout(done, ms))
const digest = async path => createHash('sha256').update(await readFile(path)).digest('hex')
const sourcePath = new URL(import.meta.url)
const inputs = [daemonPath, sourcePath, new URL('./probe-process.mjs', import.meta.url), ...['index.js', 'client.js', 'wire.js', 'validation.js'].map(name => join(sdkRoot, name))]
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async path => [String(path), await digest(path)])))
const receipt = { schema: 'agentmux.terminal-checkpoint-failure-isolation.v1', passed: false, cases: [], userRuntimeTouched: false,
  limitations: ['Private generic PTYs, not user Runs or native Agent behavior.', 'Intentional derived checkpoint I/O refusal; this does not identify the earlier Desktop failure trigger.', 'Explicit test binaries are recorded; only the default input is asserted against the current vendor manifest.'] }
const inputBefore = await hashes()
receipt.inputsBefore = inputBefore
receipt.nativeVersion = (await exec(daemonPath, ['--version'], { maxBuffer: 4096 })).stdout.trim()
assert.equal(PROTOCOL_VERSION, 18)
assert.match(receipt.nativeVersion, /protocol 18[,)]/)
receipt.binaryOverride = args.length > 0
if (!receipt.binaryOverride) {
  const manifestPath = join(vendorRoot, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const binary = manifest.binaries.find(item => item.name === 'ctxmuxd')
  assert.ok(binary)
  assert.equal(inputBefore[daemonPath], binary.sha256)
  receipt.manifest = { sha256: await digest(manifestPath), source: manifest.source, build: manifest.build }
}
async function identity(pid) {
  try { return (await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='], { timeout: 1500, maxBuffer: 4096 })).stdout.trim() }
  catch (error) { if (error.code === 1) return ''; throw error }
}
async function waitFor(label, read, accept, budget = 15_000) {
  const end = Date.now() + budget
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await delay(25) }
  throw new Error(`Private checkpoint isolation timed out: ${label}`)
}
const python = `import os,termios
settings=termios.tcgetattr(0);settings[3]&=~(termios.ICANON|termios.ECHO);settings[1]&=~termios.OPOST;termios.tcsetattr(0,termios.TCSANOW,settings)
payload=b'ROW000\\r\\n'+(b'\\x1b[1;1H'+b'X'*100)*47000
while payload:
 count=os.write(1,payload);payload=payload[count:]
while True:
 data=os.read(0,1)
 if not data: break
 os.write(1,b'PRIVATE-INPUT-ACK:'+data)
`
try {
  for (const closePipe of [false, true]) {
    const root = await mkdtemp('/tmp/ctxmux-checkpoint-isolation-')
    const socketPath = join(root, 'ctxmux.sock'), state = join(root, 'state')
    const row = { stderrClosedAfterReady: closePipe, cleanup: { errors: [], remaining: [], rootRemoved: false } }
    receipt.cases.push(row)
    const owned = new Map()
    let daemon, diagnostics = '', caseFailure
    try {
      await mkdir(state, { mode: 0o700 })
      // Raw SQLite remains usable; only its separate derived checkpoint directory is denied.
      await writeFile(join(state, 'terminal-checkpoints'), 'private derived-state I/O refusal', { mode: 0o600 })
      await writeFile(join(root, 'worker.py'), python)
      await writeFile(join(root, 'second.py'), 'import os\nwhile os.read(0,1): pass\n')
      daemon = spawn(daemonPath, ['--socket', socketPath, '--state-dir', state], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
      let spawnError
      daemon.on('error', error => { spawnError = error })
      row.daemonPid = daemon.pid
      assert.ok(Number.isSafeInteger(daemon.pid) && daemon.pid > 1)
      daemon.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-8192) })
      const birth = await identity(daemon.pid); assert.ok(birth); owned.set(daemon.pid, birth)
      const client = new CtxmuxClient({ socketPath })
      row.runtime = await waitFor('handshake', async () => { if (spawnError) throw spawnError; try { return await client.runtimeInfo() } catch { return null } }, Boolean)
      row.daemonPid = daemon.pid
      if (closePipe) daemon.stderr.destroy() // Exact post-readiness Core parent behavior.
      const spec = { program: '/usr/bin/python3', args: ['-u', join(root, 'worker.py')], cwd: root, env: {}, initial_size: { rows: 6, cols: 40 }, declared_inputs: [] }
      const first = await client.start(spec, 'private-checkpoint-isolation-first')
      assert.ok(Number.isSafeInteger(first.pid) && first.pid > 1)
      const firstBirth = await identity(first.pid); assert.ok(firstBirth); owned.set(first.pid, firstBirth)
      row.firstRunId = first.id; row.firstPid = first.pid
      const before = await waitFor('first output beyond retained prefix', () => client.status(first.id), run => run.latest_output_bytes === 8 + 106 * 47000)
      assert.equal(before.state.type, 'running'); assert.equal(before.pid, first.pid)
      assert.ok(before.first_available_byte > 0); assert.equal(before.applied_input_bytes, 0)
      row.firstOutput = { latest: before.latest_output_bytes, head: before.first_available_byte }
      // Pressure cutting uses a best-effort offer; explicitly re-offer through the public
      // geometry owner once the original output is complete, rather than assume a queue slot.
      await client.resize(first.id, { rows: 7, cols: 40 })
      row.checkpointTrigger = 'Public resize after the complete original payload'
      // In the positive warning case, bind the actual failed derived write before continuing.
      if (!closePipe) await waitFor('actual checkpoint rejection', async () => diagnostics, text => text.includes('terminal checkpoint') && text.includes('was not saved'))
      await delay(150)
      let second, secondFailure
      try { second = await client.start({ ...spec, args: ['-u', join(root, 'second.py')] }, 'private-checkpoint-isolation-second') }
      catch (error) { secondFailure = { name: error.name, message: error.message } }
      row.secondAccepted = Boolean(second); row.secondFailure = secondFailure ?? null
      if (second) { const secondBirth = await identity(second.pid); assert.ok(secondBirth); owned.set(second.pid, secondBirth); row.secondRunId = second.id; row.secondPid = second.pid }
      assert.equal(row.secondAccepted, true, 'A failed checkpoint diagnostic must not stop the actor or reject the next healthy Run')
      await client.input(first.id, Uint8Array.from([122]))
      const after = await waitFor('original PTY input and output', () => client.status(first.id), run => run.applied_input_bytes === 1 && run.latest_output_bytes === before.latest_output_bytes + 19)
      assert.equal(after.state.type, 'running'); assert.equal(after.pid, first.pid)
      assert.equal(await identity(daemon.pid), birth)
      row.firstInput = { acceptedBytes: after.applied_input_bytes, outputIncreased: after.latest_output_bytes > before.latest_output_bytes, samePid: after.pid === first.pid }
      row.daemonSameBirth = true
      row.warningObserved = diagnostics.includes('terminal checkpoint') && diagnostics.includes('was not saved')
    } catch (error) { caseFailure = error; row.failure = { name: error.name, message: error.message, stack: error.stack } }
    finally {
      for (const [pid, birth] of [...owned].reverse()) {
        try { if (await identity(pid) === birth) process.kill(pid, 'SIGTERM') }
        catch (error) { if (error.code !== 'ESRCH') row.cleanup.errors.push(`terminate ${pid}: ${error.message}`) }
      }
      await delay(350)
      for (const [pid, birth] of [...owned].reverse()) {
        try { if (await identity(pid) === birth) process.kill(pid, 'SIGKILL') }
        catch (error) { if (error.code !== 'ESRCH') row.cleanup.errors.push(`kill ${pid}: ${error.message}`) }
      }
      if (daemon) await Promise.race([new Promise(done => daemon.exitCode !== null || daemon.signalCode !== null ? done() : daemon.once('exit', done)), delay(2000)])
      // A lost public start reply or unavailable birth must not hide an owned child.
      // Every private executable argv contains this unique root; do not scan other Runtime paths.
      let scanned = false
      try {
        for (const pid of await listProbeProcesses(-1, root)) {
          const birth = await identity(pid)
          if (birth && await identity(pid) === birth) process.kill(pid, 'SIGTERM')
        }
        await delay(250)
        for (const pid of await listProbeProcesses(-1, root)) {
          const birth = await identity(pid)
          if (birth && await identity(pid) === birth) process.kill(pid, 'SIGKILL')
        }
        await delay(250)
        row.cleanup.remaining = await listProbeProcesses(-1, root)
        scanned = true
      } catch (error) { row.cleanup.errors.push(`owned-root cleanup: ${error.message}`) }
      for (const pid of owned.keys()) if (await identity(pid) && !row.cleanup.remaining.includes(pid)) row.cleanup.remaining.push(pid)
      row.cleanup.uniqueRootScanned = scanned
      if (scanned && row.cleanup.remaining.length === 0) {
        try { await rm(root, { recursive: true, force: true }); row.cleanup.rootRemoved = true }
        catch (error) { row.cleanup.errors.push(`remove: ${error.message}`) }
      }
      row.diagnostics = closePipe ? 'Pipe deliberately closed after readiness; post-readiness diagnostics unavailable.' : diagnostics
    }
    assert.deepEqual(row.cleanup.errors, []); assert.deepEqual(row.cleanup.remaining, []); assert.equal(row.cleanup.rootRemoved, true)
    if (caseFailure) throw caseFailure
  }
  assert.equal(receipt.cases.length, 2)
  receipt.passed = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack }
} finally {
  receipt.inputsAfter = await hashes()
  receipt.inputsUnchanged = JSON.stringify(receipt.inputsBefore) === JSON.stringify(receipt.inputsAfter)
  if (!receipt.inputsUnchanged) receipt.passed = false
  await mkdir(join(repositoryRoot, '.tmp'), { recursive: true })
  await writeFile(join(repositoryRoot, '.tmp/terminal-checkpoint-failure-isolation-last.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
  if (!receipt.passed) process.exitCode = 1
}
