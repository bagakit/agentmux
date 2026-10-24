import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createInterface } from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import ts from 'typescript'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(packageRoot, '../..')
assert.equal(process.platform, 'darwin', 'Socket publication verification requires real Darwin bind behavior')
// Darwin's sockaddr_un path is short, including the per-user temporary prefix.
const temporary = await mkdtemp(join(tmpdir(), 'amux-sp-'))
const reportRoot = join(root, '.local/state/native-desktop/socket-publication')
await mkdir(reportRoot, { recursive: true })
const reportDirectory = await mkdtemp(join(reportRoot, 'run-'))
const report = { scope: 'Swift socket publication and production Node protocol client; no AppKit, OS capture, peer signature or TCC proof', passed: false }
const execute = (command, args) => {
  const result = spawnSync(command, args, { cwd: packageRoot, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, `${basename(command)} failed: ${result.stderr}`)
  return result.stdout
}
const corePath = join(packageRoot, 'macos/Sources/AgentMuxNativeMacOSCore/UnixSocketPathSafety.swift')
const fixture = join(packageRoot, 'macos/Verification/SocketPublicationProducer.swift')
const mainPath = join(packageRoot, 'macos/Sources/AgentMuxNativeMacOS/main.swift')
const initializer = 'UnixSocketPathSafety.initializePrivateCreationMask()'

async function checkProductionEntry() {
  const source = await readFile(mainPath, 'utf8')
  assert.equal(source.split(initializer).length, 2, 'Production entry must initialize private creation exactly once')
  // A Swift top-level call before declarations precedes the AppKit run modes and listener threads.
  assert.match(source.slice(0, source.indexOf(initializer)), /^(?:import [A-Za-z]+\r?\n|\s|\/\/[^\n]*\n)*$/)
  const entry = await readFile(join(packageRoot, 'src/client.ts'), 'utf8')
  const tree = ts.createSourceFile('client.ts', entry, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  assert.equal(tree.parseDiagnostics.length, 0)
  assert.match(entry, /code !== 'ENOENT' && code !== 'ECONNREFUSED'/)
  assert.doesNotMatch(entry, /code !== 'unsafe_socket'/)
}

async function verifyProducer(executable) {
  const directory = await mkdtemp(join(temporary, 'socket-'))
  const socketPath = join(directory, 'native.sock'), token = 'isolated-publication-token'
  const child = spawn(executable, [socketPath, token], { stdio: ['pipe', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
  const closed = new Promise(resolveClose => {
    child.once('error', error => { stderr += error.message })
    child.once('close', (code, signal) => resolveClose({ code, signal }))
  })
  child.stdin.on('error', error => { stderr += error.message })
  const lines = createInterface({ input: child.stdout })
  const events = [], waiters = []
  lines.on('line', line => {
    try {
      const event = JSON.parse(line)
      events.push(event)
      waiters.splice(0).forEach(wake => wake())
    } catch (error) { stderr += String(error); waiters.splice(0).forEach(wake => wake()) }
  })
  const event = async kind => {
    for (;;) {
      const found = events.find(value => value.event === kind)
      if (found) { assert.equal(found.pid, child.pid); return found }
      const failed = events.find(value => value.event === 'failed')
      assert.equal(failed, undefined, `Socket producer failed: ${JSON.stringify(failed)}`)
      const outcome = await Promise.race([
        new Promise(resolveWake => waiters.push(() => resolveWake('event'))),
        closed.then(() => 'closed'), delay(5000).then(() => 'timeout')
      ])
      assert.equal(outcome, 'event', `Producer ${kind} unavailable (${outcome}): ${stderr}`)
    }
  }
  let connection, primaryError
  try {
    await event('bound')
    const { lstat } = await import('node:fs/promises')
    const info = await lstat(socketPath)
    assert.ok(info.isSocket())
    assert.equal(info.uid, process.getuid())
    const { NativeConnection } = await import('../dist/index.js')
    if (info.mode & 0o077) {
      await assert.rejects(NativeConnection.connect({ socketPath, token }), { code: 'unsafe_socket' })
    }
    assert.equal(info.mode & 0o077, 0, 'Socket is public between bind and chmod')
    await assert.rejects(NativeConnection.connect({ socketPath, token }), { code: 'ECONNREFUSED' })
    child.stdin.write('continue\n')
    await event('listening')
    assert.equal((await lstat(socketPath)).mode & 0o777, 0o600)
    connection = await NativeConnection.connect({ socketPath, token, requestTimeoutMs: 1000 })
    const operationId = 'publication-capture'
    assert.deepEqual(await connection.request('captureScreenshot', { mode: 'selection' }, { operationId }), { state: 'cancelled' })
    assert.equal(connection.inspectOperation(operationId).state, 'completed')
    const served = await event('served')
    assert.equal(served.requestCount, 2, 'One handshake and one original capture must be submitted')
    assert.equal(served.operationId, operationId)
    assert.equal(served.instanceId, connection.instanceId)
    return { initialMode: (info.mode & 0o777).toString(8), finalMode: '600', requests: served.requestCount }
  } catch (error) { primaryError = error; throw error }
  finally {
    connection?.close()
    child.stdin.end('close\n')
    let result = await Promise.race([closed, delay(2000).then(() => null)])
    if (!result) { child.kill('SIGTERM'); result = await Promise.race([closed, delay(2000).then(() => null)]) }
    lines.close()
    if (!result || (!primaryError && (result.code !== 0 || result.signal))) {
      const cleanup = new Error(`Original socket producer closure unconfirmed: ${JSON.stringify(result)} ${stderr}`)
      if (primaryError) throw new AggregateError([primaryError, cleanup], 'Socket verification and cleanup failed')
      throw cleanup
    }
  }
}

try {
  const inputs = [corePath, mainPath, fixture, fileURLToPath(import.meta.url), join(packageRoot, 'src/client.ts')]
  report.inputs = Object.fromEntries(await Promise.all(inputs.map(async path => [path.slice(root.length + 1), createHash('sha256').update(await readFile(path)).digest('hex')])))
  await checkProductionEntry()
  execute(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', join(packageRoot, 'tsconfig.json')])
  const moduleCache = join(temporary, 'module-cache')
  const compile = (source, executable) => execute('swiftc', ['-module-cache-path', moduleCache, source, fixture, '-o', executable])
  const binary = join(temporary, 'publication')
  compile(corePath, binary)
  report.baseline = await verifyProducer(binary)
  const original = await readFile(corePath, 'utf8'), anchor = 'Darwin.umask(mode_t(0o077))'
  assert.equal(original.split(anchor).length, 2, 'Private creation mutation must change one actual production branch')
  const mutant = join(temporary, 'UnixSocketPathSafety.swift'), mutantBinary = join(temporary, 'public-creation')
  await writeFile(mutant, original.replace(anchor, 'Darwin.umask(mode_t(0o022))'))
  compile(mutant, mutantBinary)
  await assert.rejects(verifyProducer(mutantBinary), /Socket is public between bind and chmod/)
  report.mutation = { changedBranches: 1, unsafeSocketReproduced: true, killedBy: 'real pre-chmod socket mode assertion' }
  report.passed = true
} catch (error) {
  report.error = { name: error.name, message: error.message }
  throw error
} finally {
  await writeFile(join(reportDirectory, 'receipt.json'), JSON.stringify(report, null, 2) + '\n')
  await rm(temporary, { recursive: true, force: true })
}
console.log(JSON.stringify(report))
