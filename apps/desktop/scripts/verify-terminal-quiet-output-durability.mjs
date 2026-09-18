import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { listProbeProcesses } from './probe-process.mjs'

// This owning gate consumes the isolated Native source candidate, not the
// already-installed daemon. A private binary override binds causal tests.
const repositoryRoot = resolve('.')
const nativeRoot = join(repositoryRoot, '.tmp/ctxmux-quiet-output-worktree')
const args = process.argv.slice(2)
assert.ok(args.length === 0 || args.length === 2 && args[0] === '--daemon-binary')
const daemonPath = args.length ? resolve(args[1]) : join(nativeRoot, 'target/debug/ctxmuxd')
const sdkRoot = join(repositoryRoot, 'packages/core/node_modules/@ctxmux/sdk/dist')
const { CtxmuxClient, PROTOCOL_VERSION } = await import(pathToFileURL(join(sdkRoot, 'index.js')))
const exec = promisify(execFile), delay = ms => new Promise(done => setTimeout(done, ms))
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = [daemonPath, new URL(import.meta.url), new URL('./probe-process.mjs', import.meta.url),
  ...['Cargo.lock', 'crates/ctxmux-daemon/src/lib.rs', 'crates/ctxmux-daemon/src/persistence.rs', 'crates/ctxmux-sqlite-status/src/lib.rs'].map(name => join(nativeRoot, name)),
  ...['index.js', 'client.js', 'wire.js', 'validation.js', 'control.js', 'attachment.js'].map(name => join(sdkRoot, name))]
const hashes = async () => Object.fromEntries(await Promise.all(inputs.map(async path => [String(path), sha(await readFile(path))])))
const receipt = { schema: 'agentmux.terminal-quiet-output-durability.v1', passed: false, userRuntimeTouched: false, cases: [],
  limitations: ['Private generic PTYs and SDK18; no user Runtime operations.',
    'The burst commits naturally before any following input, resize, finalize, barrier or HUP.',
    'Ordinary daemon restart proves durable historical recovery, not original PTY survival.'] }
const inputBefore = await hashes()
receipt.inputsBefore = inputBefore
assert.equal(PROTOCOL_VERSION, 18)
receipt.nativeVersion = (await exec(daemonPath, ['--version'], { timeout: 3000, maxBuffer: 4096 })).stdout.trim()
assert.match(receipt.nativeVersion, /protocol 18[,)]/)
assert.match(receipt.nativeVersion, /handoff ctxmux[.]daemon-handoff[.]v4/)
async function identity(pid) {
  try { return (await exec('/bin/ps', ['-p', String(pid), '-o', 'pid=,pgid=,lstart='], { timeout: 1500, maxBuffer: 4096 })).stdout.trim() }
  catch (error) { if (error.code === 1) return ''; throw error }
}
async function waitFor(label, read, accept, budget = 15000) {
  const end = Date.now() + budget
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await delay(25) }
  throw new Error(`Private quiet output gate timed out: ${label}`)
}
const normalPython = `import os,termios
s=termios.tcgetattr(0);s[3]&=~(termios.ICANON|termios.ECHO);s[1]&=~termios.OPOST;termios.tcsetattr(0,termios.TCSANOW,s)
os.write(1,b'ROW000\\r\\n')
while True:
 d=os.read(0,1)
 if not d: break
 if d==b'g':
  payload=(b'\\x1b[1;1H'+b'A'*100)*50000
  while payload:
   n=os.write(1,payload);payload=payload[n:]
 else: os.write(1,b'INPUT:'+d)
 if d==b'q': break
`
const secondPython = `import os,termios
s=termios.tcgetattr(0);s[3]&=~(termios.ICANON|termios.ECHO);termios.tcsetattr(0,termios.TCSANOW,s)
while True:
 d=os.read(0,1)
 if not d or d==b'q': break
`
try {
  {
    const root = await mkdtemp('/tmp/amx-quiet-output-'), state = join(root, 'state'), socketPath = join(root, 'ctxmux.sock')
    const row = { kind: 'burst-quiet-ordinary-recovery', cleanup: { errors: [], remaining: [], rootRemoved: false } }
    receipt.cases.push(row)
    const owned = new Map(), daemons = [], attachments = []
    let client, daemon, diagnostics = '', failure, deadlineAction
    const deadline = setTimeout(() => {
      row.deadlineExceeded = true
      deadlineAction = (async () => {
        for (const [pid, birth] of owned) {
          try { if (await identity(pid) === birth) process.kill(pid, 'SIGTERM') }
          catch (error) { if (error.code !== 'ESRCH') row.cleanup.errors.push(`deadline ${pid}: ${error.message}`) }
        }
      })()
    }, 60000)
    deadline.unref()
    const own = async pid => { assert.ok(Number.isSafeInteger(pid) && pid > 1); const birth = await identity(pid); assert.ok(birth); owned.set(pid, birth); return birth }
    const launch = async () => {
      const child = spawn(daemonPath, ['--socket', socketPath, '--state-dir', state], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] })
      daemons.push(child); daemon = child
      let spawnError; child.on('error', error => { spawnError = error })
      child.stderr.on('data', bytes => { diagnostics = (diagnostics + bytes.toString()).slice(-16384) })
      await own(child.pid)
      client = new CtxmuxClient({ socketPath })
      return await waitFor('public ready', async () => { if (spawnError) throw spawnError; try { return await client.runtimeInfo() } catch { return null } }, Boolean)
    }
    const spec = name => ({ program: '/usr/bin/python3', args: ['-u', join(root, name)], cwd: root, env: {}, initial_size: { rows: 6, cols: 40 }, declared_inputs: [] })
    const raw = async (id, expected) => {
      const attachment = await client.attach(id, 0); attachments.push(attachment)
      const { run, replay } = attachment.snapshot
      assert.ok(replay.chunks.length > 0)
      let cursor = replay.first_available_byte
      const chunks = []
      for (const chunk of replay.chunks) {
        assert.equal(chunk.start_byte, cursor); assert.equal(chunk.end_byte - chunk.start_byte, chunk.data.byteLength)
        cursor = chunk.end_byte; chunks.push(Buffer.from(chunk.data))
      }
      assert.equal(cursor, run.durable_output_bytes)
      assert.equal(cursor, expected.length)
      const body = Buffer.concat(chunks)
      assert.ok(body.equals(expected.subarray(replay.first_available_byte)), 'exact original retained suffix')
      attachment.close()
      return { latest: cursor, firstAvailable: replay.first_available_byte, bytes: body.length, sha256: sha(body) }
    }
    try {
      await mkdir(state, { mode: 0o700 })
      await writeFile(join(root, 'worker.py'), normalPython)
      await writeFile(join(root, 'second.py'), secondPython)
      const runtime = await launch(), daemonBirth = owned.get(daemon.pid)
      row.runtime = runtime; row.daemonPid = daemon.pid
      const first = await client.start(spec('worker.py'), 'quiet-proof-first'); await own(first.pid)
      row.first = { id: first.id, pid: first.pid }
      const prefixBytes = Buffer.from('ROW000\r\n')
      const prefix = await waitFor('committed prefix', () => client.status(first.id), run => run.latest_output_bytes === prefixBytes.length && run.durable_output_bytes === prefixBytes.length)
      assert.equal(prefix.state.type, 'running'); assert.equal(prefix.pid, first.pid)
      assert.equal(prefix.applied_input_bytes, 0)
      const input = await client.input(first.id, Uint8Array.of(103)); assert.equal(input.receipt.written_bytes, 1)
      const expected = Buffer.concat([prefixBytes, Buffer.concat(Array.from({ length: 50000 }, () => Buffer.from('\x1b[1;1H' + 'A'.repeat(100))))])
      const burst = await waitFor('quiet bytes naturally committed', async () => { const run = await client.status(first.id); row.outputObservation = {latest: run.latest_output_bytes, durable: run.durable_output_bytes, state: run.state.type, pid: run.pid}; return run }, run => run.latest_output_bytes === expected.length && run.durable_output_bytes === expected.length, 30000)
      assert.equal(burst.pid, first.pid); assert.equal(burst.state.type, 'running')
      assert.ok(burst.first_available_byte > 0)
      row.original = await raw(first.id, expected)
      const terminal = await client.attachTerminal(first.id, 0); attachments.push(terminal)
      assert.equal(terminal.snapshot.run.id, first.id); assert.equal(terminal.snapshot.terminal.type, 'basic_vt')
      row.terminal = { type: terminal.snapshot.terminal.type, checkpoint: terminal.snapshot.terminal.checkpoint.through_byte }
      terminal.close()
      const second = await client.start(spec('second.py'), 'quiet-proof-second'); await own(second.pid)
      row.second = { id: second.id, pid: second.pid }
      assert.equal((await client.input(first.id, Uint8Array.of(122))).receipt.written_bytes, 1)
      const withZ = Buffer.concat([expected, Buffer.from('INPUT:z')])
      const healthy = await waitFor('same first PTY input/output', () => client.status(first.id), run => run.applied_input_bytes === 2 && run.durable_output_bytes === withZ.length)
      assert.equal(healthy.pid, first.pid); assert.equal(healthy.state.type, 'running')
      assert.equal(await identity(daemon.pid), daemonBirth)
      row.healthy = await raw(first.id, withZ)
      assert.ok((await stat(join(state, 'state.sqlite3-wal'))).size <= 16 * 1024 * 1024)
      await client.input(second.id, Uint8Array.of(113)); await client.input(first.id, Uint8Array.of(113))
      const ended = await waitFor('both natural child exits', async () => [await client.status(first.id), await client.status(second.id)], runs => runs.length === 2 && runs.every(run => run.state.type === 'exited' && run.latest_output_bytes === run.durable_output_bytes))
      assert.equal(ended[0].latest_output_bytes, withZ.length + 7)
      const completed = Buffer.concat([withZ, Buffer.from('INPUT:q')])
      for (const attachment of attachments) attachment.close()
      process.kill(daemon.pid, 'SIGINT')
      await waitFor('ordinary daemon exit', async () => ({ code: daemon.exitCode, signal: daemon.signalCode }), result => result.code !== null || result.signal !== null)
      assert.equal(daemon.exitCode, 0); assert.equal(daemon.signalCode, null)
      row.firstExit = { code: daemon.exitCode, signal: daemon.signalCode }
      const firstDaemonPid = daemon.pid, recoveredRuntime = await launch()
      assert.notEqual(daemon.pid, firstDaemonPid); assert.equal(recoveredRuntime.runtimeId, runtime.runtimeId)
      const recovered = await client.status(first.id)
      assert.equal(recovered.id, first.id); assert.equal(recovered.state.type, 'exited')
      row.recovered = await raw(first.id, completed)
      row.secondProcess = { pid: daemon.pid, runtime: recoveredRuntime }
      process.kill(daemon.pid, 'SIGINT')
      await waitFor('second ordinary daemon exit', async () => daemon.exitCode, code => code !== null)
      assert.equal(daemon.exitCode, 0); assert.equal(daemon.signalCode, null)
      row.secondExit = { code: daemon.exitCode, signal: daemon.signalCode }
    } catch (error) { failure = error; row.failure = { name: error.name, message: error.message, stack: error.stack } }
    finally {
      clearTimeout(deadline)
      if (deadlineAction) await deadlineAction
      if (row.deadlineExceeded) row.cleanup.errors.push("Private quiet output case exceeded its 60-second deadline")
      // Every cleanup is independent: a failed SDK/control call cannot skip the
      // exact captured PID/birth cleanup or the unique argv-root child scan.
      for (const attachment of attachments) try { attachment.close() } catch (error) { row.cleanup.errors.push(`attachment: ${error.message}`) }
      for (const [pid, birth] of [...owned].reverse()) try { if (await identity(pid) === birth) process.kill(pid, 'SIGTERM') } catch (error) { if (error.code !== 'ESRCH') row.cleanup.errors.push(`term ${pid}: ${error.message}`) }
      await delay(250)
      for (const [pid, birth] of [...owned].reverse()) try { if (await identity(pid) === birth) process.kill(pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') row.cleanup.errors.push(`kill ${pid}: ${error.message}`) }
      for (const child of daemons) await Promise.race([new Promise(done => child.exitCode !== null || child.signalCode !== null ? done() : child.once('exit', done)), delay(1500)])
      let scanned = false
      try {
        for (const signal of ['SIGTERM', 'SIGKILL']) {
          for (const pid of await listProbeProcesses(-1, root)) { const birth = await identity(pid); if (birth && await identity(pid) === birth) process.kill(pid, signal) }
          await delay(200)
        }
        row.cleanup.remaining = await listProbeProcesses(-1, root); scanned = true
      } catch (error) { row.cleanup.errors.push(`root scan: ${error.message}`) }
      for (const pid of owned.keys()) if (await identity(pid) && !row.cleanup.remaining.includes(pid)) row.cleanup.remaining.push(pid)
      if (scanned && row.cleanup.remaining.length === 0) try { await rm(root, { recursive: true }); row.cleanup.rootRemoved = true } catch (error) { row.cleanup.errors.push(`remove: ${error.message}`) }
      row.cleanup.uniqueRootScanned = scanned
      row.diagnostics = diagnostics
    }
    assert.deepEqual(row.cleanup.errors, []); assert.deepEqual(row.cleanup.remaining, []); assert.equal(row.cleanup.rootRemoved, true)
    if (failure) throw failure
  }
  assert.equal(receipt.cases.length, 1)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  receipt.inputsAfter = await hashes()
  receipt.inputsUnchanged = JSON.stringify(receipt.inputsBefore) === JSON.stringify(receipt.inputsAfter)
  if (!receipt.inputsUnchanged) receipt.passed = false
  await mkdir(join(repositoryRoot, '.tmp'), { recursive: true })
  await writeFile(join(repositoryRoot, '.tmp/terminal-quiet-output-durability-last.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify(receipt, null, 2))
  if (!receipt.passed) process.exitCode = 1
}
