import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const desktopRequire = createRequire(join(repository, 'apps/desktop/package.json'))
const viteRequire = createRequire(desktopRequire.resolve('vite/package.json'))
const exec = promisify(execFile), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const output = process.argv.find(arg => arg.startsWith('--output='))?.slice(9)
const evidence = output ? resolve(repository, output) : join(repository, '.bagakit/editor-format-implementation/evidence/control-listener-native')
const diagnostic = process.argv.includes('--green-only')
const historicalRef = 'bbc905edc'
const producer = 'apps/desktop/scripts/verify-control-listener-native.mjs'
const core = join(repository, 'packages/core')
const historicalFiles = ['control-endpoint-publication', 'control-endpoint-listener-worker']
const sourceFiles = [producer, 'apps/desktop/scripts/probe-process.mjs', 'apps/desktop/package.json', 'pnpm-lock.yaml',
  'packages/core/package.json', 'packages/core/bin/amux', 'vitest.dist-freshness.ts']
async function treeHashes(root, prefix = '') {
  const result = {}
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile()) {
    const file = join(entry.parentPath, entry.name)
    result[prefix + relative(root, file)] = sha(await readFile(file))
  }
  assert.ok(Object.keys(result).length, 'Proof input directory is nonempty: ' + root)
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)))
}
async function sourceHashes() {
  return { ...Object.fromEntries(await Promise.all(sourceFiles.map(async file => [file, sha(await readFile(join(repository, file)))]))),
    ...await treeHashes(join(core, 'src'), 'packages/core/src/') }
}
async function inputs() {
  return { sources: await sourceHashes(), compiledCore: await treeHashes(join(core, 'dist'), 'dist/') }
}
const report = { schema: 'agentmux.control-listener-native.v1', passed: false, sharedTreeMutations: 0, cases: [],
  boundary: 'Official Electron 43.7.7 with a fresh private profile, actual compiled Core public server/client and independently spawned compiled amux CLI; observed handles are never manually closed. Historical transport is compiled only inside a private package copy.' }
await mkdir(evidence, { recursive: true })
if (process.argv.includes('--check')) {
  const receipt = JSON.parse(await readFile(join(evidence, 'receipt.json'), 'utf8'))
  assert.equal(receipt.passed, true); assert.deepEqual(receipt.sourceBefore, await inputs()); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  assert.deepEqual(receipt.cases.map(item => item.name), ['current-green', 'historical-red', 'restore-green'])
  for (const item of receipt.cases) {
    assert.equal(sha(await readFile(join(evidence, item.raw.native))), item.raw.nativeSha256)
    assert.equal(sha(await readFile(join(evidence, item.raw.processLog))), item.raw.processLogSha256)
    assert.equal(sha(await readFile(join(evidence, item.raw.audit))), item.raw.auditSha256)
    assert.equal(item.outcome.timedOut, false); assert.equal(item.outcome.interruption, null); assert.deepEqual(item.cleanup.remaining, [])
    if (item.name !== 'historical-red') { assert.equal(item.outcome.exitCode, 0); assert.equal(item.nativePassed, true); assert.equal(item.fatal, false) }
    else { assert.equal(item.nativePassed, false); assert.equal(item.assertion.name, 'AssertionError'); assert.match(item.assertion.message, /orphan Pipe/) }
  }
  console.log(JSON.stringify({ passed: true, receipt: join(evidence, 'receipt.json') })); process.exit(0)
}
if ((await readdir(evidence)).length) {
  report.previousAttempt = evidence + '-attempt-' + globalThis.crypto.randomUUID()
  await rename(evidence, report.previousAttempt); await mkdir(evidence)
}

// Installed before the real Core import in Main, CLI and the listener workers.
// Returning nextLoad's result unchanged observes actual bytes without patching modules.
function auditBootstrap() {
  const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
  const { fileURLToPath } = require('node:url'), { registerHooks } = require('node:module')
  const root = fs.realpathSync(process.env.AMX_LISTENER_CORE)
  const output = path.join(process.env.AMX_LISTENER_AUDIT, String(process.pid) + '.ndjson')
  registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context)
    if (url.startsWith('file:')) {
      const file = fs.realpathSync(fileURLToPath(url))
      if (file.startsWith(root + path.sep + 'dist' + path.sep) && file.endsWith('.js')) {
        if (result.source === undefined || result.source === null) throw Error('Actual Core source bytes were not observed: ' + file)
        fs.appendFileSync(output, JSON.stringify({ pid: process.pid, file, sha256: crypto.createHash('sha256').update(result.source).digest('hex') }) + '\n')
      }
    }
    return result
  } })
}

async function nativeMain() {
  const { app, BrowserWindow } = require('electron')
  const fs = require('node:fs/promises'), path = require('node:path'), assert = require('node:assert/strict')
  const { execFile } = require('node:child_process'), { promisify } = require('node:util')
  const { createConnection } = require('node:net'), { pathToFileURL } = require('node:url')
  const options = JSON.parse(require('node:fs').readFileSync(process.argv[2], 'utf8'))
  const { profile, evidence, core, node, runtime } = options
  app.setPath('userData', path.join(profile, 'user-data')); app.setPath('sessionData', path.join(profile, 'session-data'))
  app.on('window-all-closed', () => {})
  const report = { passed: false, pid: process.pid, electron: process.versions.electron, node: process.versions.node,
    core, cycles: [], leases: [], stdioGetterReads: false, userRunTouched: false }
  let win, server
  const files = [], ids = new WeakMap(); let nextId = 1
  const id = handle => { if (!ids.has(handle)) ids.set(handle, nextId++); return ids.get(handle) }
  function handles() {
    return process._getActiveHandles().map(handle => ({ id: id(handle), constructor: handle.constructor?.name,
      fd: Number.isInteger(handle.fd) ? handle.fd : Number.isInteger(handle._handle?.fd) ? handle._handle.fd : null,
      nestedConstructor: handle._handle?.constructor?.name ?? null }))
  }
  async function settle() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)) }
  const failure = error => ({ name: error.name, message: error.message, stack: error.stack })
  async function lsof() { return (await promisify(execFile)('/usr/sbin/lsof', ['-a', '-p', String(process.pid), '-Ffnt'], { maxBuffer: 1024 * 1024 })).stdout }
  async function exerciseFiles(stage) {
    for (const lease of files) {
      const text = 'Exact retained descriptor ' + lease.handle.fd + ' survives ' + stage
      await lease.handle.truncate(0); await lease.handle.write(Buffer.from(text), 0, Buffer.byteLength(text), 0); await lease.handle.sync()
      const buffer = Buffer.alloc(Buffer.byteLength(text)); const { bytesRead } = await lease.handle.read(buffer, 0, buffer.length, 0)
      assert.equal(bytesRead, buffer.length); assert.equal(buffer.toString(), text)
      report.leases.push({ stage, fd: lease.handle.fd, path: lease.path, text, bytesRead })
    }
  }
  app.whenReady().then(async () => {
    try {
      assert.equal(process.versions.electron, '43.7.7')
      const api = await import(pathToFileURL(path.join(core, 'dist/index.js')).href)
      report.loadedCoreEntry = pathToFileURL(path.join(core, 'dist/index.js')).href
      const html = path.join(profile, 'index.html')
      await fs.writeFile(html, '<!doctype html><meta charset="utf-8"><title>Private listener lifecycle</title><p>Private listener lifecycle</p>')
      win = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
      await win.loadFile(html); await settle()
      report.initialHandles = handles()
      const baselinePipes = new Set(report.initialHandles.filter(item => item.constructor === 'Pipe').map(item => item.id))
      const socketPath = path.join(runtime, 'control.sock')
      for (let cycle = 0; cycle < 3; cycle++) {
        await exerciseFiles('before-cycle-' + cycle)
        server = new api.AgentMuxControlServer({ socketPath }); await server.start()
        const row = { cycle, startHandles: handles() }; report.cycles.push(row)
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_')))
        Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: runtime, AGENTMUX_STATE_DIRECTORY: path.join(profile, 'core-state'),
          AGENTMUX_AGENT_SESSION_STORE: path.join(profile, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: path.join(profile, 'messages.ndjson') })
        delete env.ELECTRON_RUN_AS_NODE
        const args = [path.join(core, 'bin/amux'), 'system', 'endpoint', '--inspect']
        const cli = await promisify(execFile)(node, args, { env, timeout: 15000, maxBuffer: 1024 * 1024 })
        const envelope = JSON.parse(cli.stdout.trim()); assert.equal(envelope.ok, true)
        assert.equal(envelope.result.connection, 'responded'); assert.equal(envelope.result.publication.state, 'available')
        row.cli = { args, stdout: cli.stdout, stderr: cli.stderr, receipt: envelope }
        const rpc = await api.connectAgentMuxRpc({ endpoint: { transport: 'unix', path: socketPath } })
        try { row.rpc = await rpc.call('system.endpoint', {}); assert.equal(row.rpc.connection, 'responded') } finally { await rpc.dispose() }
        // Real framed socket sends its first bytes immediately, before accept/IPC handoff.
        const socket = createConnection(socketPath)
        const closed = new Promise(resolve => socket.once('close', resolve))
        const response = new Promise((resolve, reject) => {
          let bytes = ''; socket.on('error', reject)
          socket.on('data', chunk => { bytes += chunk; if (bytes.includes('\n')) { try { resolve(JSON.parse(bytes.slice(0, bytes.indexOf('\n')))) } catch (error) { reject(error) } } })
          socket.once('close', () => { if (!bytes.includes('\n')) reject(Error('First fragmented request closed without a response')) })
        })
        const request = JSON.stringify({ jsonrpc: '2.0', id: 'native-' + cycle, method: 'system.endpoint', params: {} }) + '\n'
        socket.write(request.slice(0, 19)); socket.write(request.slice(19))
        row.firstFrame = await response; assert.equal(row.firstFrame.id, 'native-' + cycle); assert.equal(row.firstFrame.result.connection, 'responded')
        row.beforeStop = handles(); await server.stop(); server = undefined; await closed; await settle()
        row.afterStop = handles()
        const orphanPipes = row.afterStop.filter(item => item.constructor === 'Pipe' && !baselinePipes.has(item.id))
        row.orphanPipes = orphanPipes
        const freed = new Set(row.beforeStop.filter(item => item.fd >= 3 && !row.afterStop.some(after => after.fd === item.fd)).map(item => item.fd))
        // A stale orphan reports a closed FD; include it so the actual file reuse
        // remains visible even though the stale Node object still claims ownership.
        for (const orphan of orphanPipes) if (orphan.fd >= 3) freed.add(orphan.fd)
        assert.ok(freed.size, 'A real transport descriptor was released by stop')
        const opened = []; let reused
        try {
          for (let attempt = 0; attempt < 128; attempt++) {
            const file = path.join(profile, 'reuse-' + cycle + '-' + attempt), handle = await fs.open(file, 'w+')
            opened.push({ path: file, handle })
            if (freed.has(handle.fd)) { reused = opened.at(-1); break }
          }
          assert.ok(reused, 'A private file reuses an actually released transport FD')
          files.push(reused); row.reused = { fd: reused.handle.fd, path: reused.path, targets: [...freed] }
        } finally { for (const lease of opened) if (lease !== reused) await lease.handle.close() }
        await exerciseFiles('after-stop-' + cycle)
        await win.webContents.executeJavaScript('sessionStorage.setItem("private-listener-cycle",' + JSON.stringify(String(cycle)) + ')')
        await win.webContents.session.flushStorageData()
        const until = Date.now() + 10000, log = path.join(app.getPath('sessionData'), 'Session Storage/LOG')
        while (true) { try { await fs.stat(log); break } catch (error) { if (error.code !== 'ENOENT' || Date.now() >= until) throw error; await new Promise(resolve => setTimeout(resolve, 10)) } }
        row.sessionStorageLog = log; row.fdPathsAfterStop = await lsof()
        assert.deepEqual(orphanPipes, [], 'Core stop leaves no orphan Pipe claiming a released descriptor')
      }
      report.passed = true
    } catch (error) { report.failure = failure(error) }
    finally {
      try {
        await server?.stop()
        if (win && !win.isDestroyed()) { const closed = new Promise(resolve => win.once('closed', resolve)); win.close(); await closed }
        await exerciseFiles('after-normal-window-close')
        for (const lease of files) await lease.handle.close()
        await settle(); report.finalHandles = handles(); report.finalFdPaths = await lsof()
      } catch (error) { report.passed = false; report.cleanupFailure = failure(error) }
      report.ordinaryQuitRequested = true
      await fs.writeFile(path.join(evidence, 'native.json'), JSON.stringify(report, null, 2))
      app.quit()
    }
  })
}

const temporary = await mkdtemp(_hygiene_fixturePath("tmp/amcp-native-"))
try {
  report.sourceBefore = await inputs()
  const { build, transform } = viteRequire('esbuild')
  const freshness = join(temporary, 'freshness.mjs')
  await build({ entryPoints: [join(repository, 'vitest.dist-freshness.ts')], outfile: freshness, platform: 'node', format: 'esm', bundle: true, logLevel: 'error' })
  const { staleDistComplaint } = await import('file://' + freshness)
  assert.equal(await staleDistComplaint(core), null, 'Native probe consumes current compiled Core')
  const electron = desktopRequire('electron'), manifestFile = desktopRequire.resolve('electron/package.json')
  assert.equal(JSON.parse(await readFile(manifestFile)).version, '43.7.7')
  report.electron = { executable: electron, executableSha256: sha(await readFile(electron)), packageSha256: sha(await readFile(manifestFile)), version: '43.7.7' }
  const audit = join(temporary, 'audit.cjs'), main = join(temporary, 'main.cjs')
  await writeFile(audit, '(' + auditBootstrap.toString() + ')()')
  await writeFile(main, '(' + nativeMain.toString() + ')()')
  await symlink(join(repository, 'apps/desktop/node_modules'), join(temporary, 'node_modules'))
  report.generated = { auditSha256: sha(await readFile(audit)), mainSha256: sha(await readFile(main)) }
  let oldCore
  if (!diagnostic) {
    oldCore = join(temporary, 'core-old'); await mkdir(oldCore)
    await cp(join(core, 'dist'), join(oldCore, 'dist'), { recursive: true })
    await cp(join(core, 'package.json'), join(oldCore, 'package.json')); await mkdir(join(oldCore, 'bin')); await cp(join(core, 'bin/amux'), join(oldCore, 'bin/amux'))
    await symlink(join(core, 'node_modules'), join(oldCore, 'node_modules'))
    const commit = (await exec('git', ['rev-parse', historicalRef], { cwd: repository })).stdout.trim()
    report.historical = { ref: historicalRef, commit, files: {}, compiler: { name: 'esbuild', version: viteRequire('esbuild/package.json').version, loader: 'ts', format: 'esm', target: 'node24' } }
    for (const name of historicalFiles) {
      const file = 'packages/core/src/' + name + '.ts'
      const source = (await exec('git', ['show', commit + ':' + file], { cwd: repository, maxBuffer: 1024 * 1024 })).stdout
      const compiled = await transform(source, { loader: 'ts', format: 'esm', target: 'node24' })
      await writeFile(join(oldCore, 'dist', name + '.js'), compiled.code)
      await writeFile(join(evidence, 'historical-' + name + '.ts'), source)
      report.historical.files[file] = { sourceSha256: sha(source), compiledSha256: sha(compiled.code), historicalSource: 'historical-' + name + '.ts' }
    }
    report.historical.compiledCore = await treeHashes(join(oldCore, 'dist'), 'dist/')
  }
  for (const [name, packagePath, expectedRed] of diagnostic ? [['current-green', core, false]] : [
    ['current-green', core, false], ['historical-red', oldCore, true], ['restore-green', core, false]]) {
    const directory = join(evidence, name), caseRoot = join(temporary, name), profile = join(caseRoot, 'profile'), runtime = join(caseRoot, 'r'), auditDirectory = join(directory, 'audit')
    await mkdir(profile, { recursive: true }); await mkdir(runtime); await mkdir(auditDirectory, { recursive: true })
    const options = join(caseRoot, 'options.json')
    await writeFile(options, JSON.stringify({ profile, evidence: directory, core: packagePath, node: process.execPath, runtime }))
    const env = { ...process.env, NODE_OPTIONS: '--require=' + audit, AMX_LISTENER_CORE: packagePath, AMX_LISTENER_AUDIT: auditDirectory }
    delete env.ELECTRON_RUN_AS_NODE
    const lines = [], outcome = await runProbeProcess(electron, [main, options], { temporaryRoot: temporary, cwd: repository, env, timeoutMs: 60000, onLine: line => lines.push(line) })
    const processLog = lines.join('\n'); await writeFile(join(directory, 'process.log'), processLog)
    const native = JSON.parse(await readFile(join(directory, 'native.json'), 'utf8'))
    const loaded = []
    for (const file of await readdir(auditDirectory)) for (const line of (await readFile(join(auditDirectory, file), 'utf8')).trim().split('\n').filter(Boolean)) loaded.push(JSON.parse(line))
    assert.ok(loaded.length, 'Actual compiled Core input set is nonempty')
    const compiled = expectedRed ? report.historical.compiledCore : report.sourceBefore.compiledCore
    const realCore = await realpath(packagePath)
    for (const entry of loaded) assert.equal(entry.sha256, compiled[relative(realCore, entry.file)], 'Actual loaded Core bytes: ' + entry.file)
    for (const name of historicalFiles) assert.ok(loaded.some(entry => entry.file.endsWith('/dist/' + name + '.js')), 'Actual listener module loaded: ' + name)
    await writeFile(join(directory, 'loaded-core.json'), JSON.stringify(loaded, null, 2))
    const remaining = await listProbeProcesses(-1, temporary); assert.deepEqual(remaining, [])
    const item = { name, nativePassed: native.passed, assertion: native.failure ?? null, outcome, fatal: /FATAL|SIGTRAP/.test(processLog),
      loadedCoreEntry: native.loadedCoreEntry, loadedCoreInputs: loaded.length, cleanup: { remaining },
      raw: { native: name + '/native.json', nativeSha256: sha(await readFile(join(directory, 'native.json'))),
        processLog: name + '/process.log', processLogSha256: sha(processLog), audit: name + '/loaded-core.json', auditSha256: sha(await readFile(join(directory, 'loaded-core.json'))) } }
    report.cases.push(item)
    assert.equal(outcome.timedOut, false); assert.equal(outcome.interruption, null); assert.equal(native.ordinaryQuitRequested, true)
    if (expectedRed) { assert.equal(native.passed, false); assert.equal(native.failure.name, 'AssertionError'); assert.match(native.failure.message, /orphan Pipe/) }
    else { assert.equal(outcome.exitCode, 0); assert.equal(native.passed, true, native.failure?.stack); assert.equal(item.fatal, false); assert.equal(native.cycles.length, 3); assert.ok(native.cycles.every(cycle => cycle.orphanPipes.length === 0 && cycle.reused)); assert.ok(native.leases.some(lease => lease.stage === 'after-normal-window-close')) }
    console.log(name + ': ' + (expectedRed ? 'actual loaded historical AssertionRED' : 'ordinary exit GREEN'))
  }
  report.sourceAfter = await inputs(); assert.deepEqual(report.sourceAfter, report.sourceBefore)
  if (diagnostic) report.diagnosticPassed = true
  else report.passed = true
} catch (error) { report.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  report.cleanup = { remaining: await listProbeProcesses(-1, temporary) }
  if (!report.cleanup.remaining.length) { await rm(temporary, { recursive: true, force: true }); report.cleanup.temporaryRemoved = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify({ passed: report.passed, diagnosticPassed: report.diagnosticPassed ?? false, receipt: join(evidence, 'receipt.json'), failure: report.failure ?? null }))
  process.exitCode = report.passed || report.diagnosticPassed ? 0 : 1
}
