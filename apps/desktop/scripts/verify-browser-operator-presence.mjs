import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir, realpath, stat, symlink } from 'node:fs/promises'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fixturePath } from './lib/fixture-values.mjs'
import { runProbeProcess, stopProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const baselineOnly = process.argv.includes('--baseline')
const osCapture = process.argv.includes('--os-capture')
const receiptIndex = process.argv.indexOf('--receipt')
const rendererIndex = process.argv.indexOf('--renderer-receipt')
const proofIndex = process.argv.indexOf('--native-proof')
assert.ok(process.argv.slice(2).every((arg, index, args) => ['--baseline', '--receipt', '--renderer-receipt', '--os-capture', '--native-proof'].includes(arg) || index > 0 && ['--receipt', '--renderer-receipt', '--native-proof'].includes(args[index - 1])))
assert.ok(!baselineOnly || rendererIndex < 0, 'The baseline diagnostic qualifies only its original native Main consumer')
assert.ok(!osCapture || !baselineOnly && rendererIndex < 0 && proofIndex >= 0 && process.platform === 'darwin', 'OS capture joins an explicit existing source proof on macOS')
assert.ok(osCapture || proofIndex < 0, 'The native proof join belongs to OS capture only')
const receiptPath = resolve(receiptIndex < 0 ? join(root, '.tmp/browser-agent-collaboration/operator-presence-proof/receipt.json') : process.argv[receiptIndex + 1])
const out = join(dirname(receiptPath), 'attempt-' + randomUUID())
await mkdir(out, { recursive: true })
const temporary = await realpath(await mkdtemp(fixturePath('tmp/amx-operator-presence-')))
const projection = join(temporary, 'source'), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 24 * 1024 * 1024 })
const candidate = git(['rev-parse', 'HEAD']).toString().trim(), tree = git(['rev-parse', 'HEAD^{tree}']).toString().trim()
const receipt = { schema: 'agentmux.browser-operator-presence.v1', candidate, tree, passed: false, diagnostic: baselineOnly || osCapture,
  taskComplete: false, qualifications: { nativeMain: false, rendererPngGeneration: 'not-tested', osWindowAesthetics: 'not-tested', physicalInput: 'not-tested' },
  sources: {}, externalInputs: {}, runs: [], sharedSourceMutations: 0, cleanup: {},
  boundary: 'Stock Electron, committed Main source, real BVM/dispatcher/script worker, private native documents, ConfigStore/ConfigOwner save observer and actual validated avatar setter. Native page capturePage pixels are not OS whole-window or aesthetic proof. No user App, Browser, Run, upstream model or business message.' }
let preservePrivateRoot = false
const sourceInputs = new Map(), externalInputs = new Map()
const mutations = [
  { id: 'waiting-cue-revokes-owner-glow', file: 'apps/desktop/src/main/browser-operation-feedback.ts',
    from: 'const active = this.input.isCurrent(), navigationId = this.input.navigationId()',
    to: "const active = this.input.isCurrent() && this.mode !== 'clear', navigationId = this.input.navigationId()",
    assertion: 'Waiting retains the actual current owner glow' },
  { id: 'glow-loses-three-native-edges', file: 'apps/desktop/src/main/browser-control-feedback.ts',
    from: '.amux-browser-agent-glow{mix-blend-mode:normal}', to: '.amux-browser-agent-glow{mix-blend-mode:normal;bottom:auto;height:12px}',
    assertion: 'All four actual page edges must contain the saved green glow' },
  { id: 'avatar-accepts-foreign-owner', file: 'apps/desktop/src/main/browser-view-manager.ts',
    from: 'entry.activity.operation.operator.id !== input.operatorId || entry.view.webContents.isDestroyed()',
    to: 'entry.view.webContents.isDestroyed()', assertion: 'A foreign operator cannot decorate the actual live owner' },
  { id: 'avatar-accepts-other-decoded-size', file: 'apps/desktop/src/main/browser-operator-avatar.ts',
    from: 'if (image.width !== 64 || image.height !== 64) return undefined', to: 'if (false) return undefined',
    assertion: 'The actual setter rejects a different decoded size' }
]
async function bind(path, sourceRoot = root) {
  const bytes = await readFile(path), key = relative(sourceRoot, path), digest = sha(bytes)
  const existing = sourceInputs.get(key)
  if (existing) assert.equal(existing.sha256, digest, 'Source changed during the original proof: ' + key)
  else sourceInputs.set(key, { path, sha256: digest, bytes: bytes.length })
}
try {
  let avatar
  if (osCapture) {
    const proofFile = resolve(process.argv[proofIndex + 1]), bytes = await readFile(proofFile), proof = JSON.parse(bytes)
    assert.equal(proof.schema, receipt.schema); assert.equal(proof.passed, true)
    assert.equal(proof.qualifications.nativeMain, true); assert.equal(proof.qualifications.rendererPngGeneration, true)
    assert.deepEqual(proof.sourceDrift, []); assert.equal(proof.sharedSourceMutations, 0)
    const original = proof.renderer?.actual?.runs.find(run => run.label === 'native-baseline')?.actual
    assert.equal(proof.renderer?.actual?.presenceDiagnosticComplete, true); assert.equal(original?.presence?.passed, true)
    assert.ok(original.ipc.every(call => call.channel !== 'sessions:submitPrompt'))
    const accepted = original.presence.accepted
    assert.equal(accepted.channel, 'browser:setOperatorAvatar'); assert.equal(accepted.exactSender, true); assert.equal(accepted.exactFrame, true); assert.equal(accepted.result, true)
    const products = Object.entries(proof.sources).filter(([file]) => file.startsWith('apps/desktop/src/') || file.startsWith('packages/'))
    assert.ok(products.length > 10)
    for (const [file, value] of products) {
      await bind(join(root, file))
      assert.equal(sourceInputs.get(file).sha256, value.sha256, 'The prior native/Renderer product input remains original: ' + file)
    }
    avatar = { png: accepted.args[0].png, operator: original.presence.report.report.runOperation.operator }
    assert.equal(avatar.operator.id, accepted.args[0].operatorId)
    receipt.sourceProof = { path: proofFile, sha256: sha(bytes), candidate: proof.candidate, productInputs: Object.fromEntries(products),
      rendererReceiptSha256: proof.renderer.sha256, avatarSha256: sha(Buffer.from(avatar.png.split(',')[1], 'base64')),
      boundary: 'Reuses only the completed source-bound native and actual Renderer artwork facts. OS images below are new observations, not replay of the original operation.' }
    await writeFile(join(out, 'source-proof.json'), bytes)
    await writeFile(join(temporary, 'original-artwork.json'), JSON.stringify(avatar))
  }
  const fixtures = (await readdir(join(root, 'apps/desktop/scripts/fixtures/browser-operator-presence'))).filter(name => name.endsWith('.ts')).map(name => 'apps/desktop/scripts/fixtures/browser-operator-presence/' + name)
  for (const path of [import.meta.filename, join(root, 'apps/desktop/scripts/probe-process.mjs'), ...fixtures.map(path => join(root, path))]) await bind(path)
  const projected = ['apps/desktop/src/main', 'apps/desktop/src/shared', 'apps/desktop/browser-extension',
    'apps/desktop/resources/toolkit', 'apps/desktop/package.json', 'package.json']
  for (const name of await readdir(join(root, 'packages'))) {
    for (const leaf of ['src', 'package.json']) {
      const path = 'packages/' + name + '/' + leaf
      try { git(['cat-file', '-e', candidate + ':' + path]); projected.push(path) } catch {}
    }
  }
  await mkdir(projection)
  execFileSync('tar', ['-x', '-C', projection], { input: git(['archive', candidate, ...projected]) })
  receipt.projection = { commit: candidate, tree, uncommittedPeerSourceConsumed: false, paths: projected }
  const fixture = 'apps/desktop/scripts/fixtures/browser-operator-presence/main.ts'
  await mkdir(dirname(join(projection, fixture)), { recursive: true })
  for (const path of fixtures) await writeFile(join(projection, path), await readFile(join(root, path)))
  const aliases = []
  for (const folder of ['', 'apps/desktop', ...projected.filter(path => path.endsWith('/package.json')).map(path => dirname(path)).filter(path => path.startsWith('packages/'))]) {
    try { await symlink(join(root, folder, 'node_modules'), join(projection, folder, 'node_modules')) } catch (error) { if (error.code !== 'EEXIST') throw error }
    if (!folder.startsWith('packages/')) continue
    const pkg = JSON.parse(await readFile(join(projection, folder, 'package.json'), 'utf8'))
    for (const [key, value] of Object.entries(pkg.exports ?? {})) {
      const target = typeof value === 'string' ? value : value.browser ?? value.import
      if (!target) continue
      const source = resolve(projection, folder, target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
      const name = pkg.name + (key === '.' ? '' : key.slice(1)), wildcard = name.includes('*')
      try {
        if (!wildcard) await stat(source)
        aliases.push({ name, wildcard, find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)') + '$'), replacement: source.replace('*', '$1') })
      } catch {}
    }
  }
  aliases.sort((left, right) => Number(left.wildcard) - Number(right.wildcard) || right.name.length - left.name.length)
  const { build } = await import(pathToFileURL(require.resolve('vite')))
  const executable = require('electron'), electronEntry = require.resolve('electron')
  receipt.engine = { version: require('electron/package.json').version, executable, sha256: sha(await readFile(executable)), entrySha256: sha(await readFile(electronEntry)) }
  await symlink(join(root, 'node_modules'), join(temporary, 'node_modules'))
  if (osCapture) {
    const helper = join(root, 'apps/desktop/scripts/fixtures/browser-contextual-composer/native-window.swift')
    await bind(helper)
    execFileSync('xcrun', ['swiftc', helper, '-o', join(temporary, 'native-window')])
  }
  async function bundle(label, mutation) {
    let applied = false, transformation = null
    await build({ configFile: false, root: projection, logLevel: 'error', ssr: { noExternal: true }, resolve: { alias: aliases },
      plugins: [{ name: 'original-operator-source', enforce: 'pre', async resolveId(id, importer) {
        if (!importer || id.startsWith('.') || isAbsolute(id) || id.startsWith('\0') || isBuiltin(id) || id === 'electron' || id.startsWith('@agentmux/')) return
        const resolved = await this.resolve(id, importer, { skipSelf: true })
        assert.ok(resolved && isAbsolute(resolved.id), 'Actual package entry for ' + id)
        externalInputs.set(resolved.id, sha(await readFile(resolved.id)))
        return { id: resolved.id, external: true }
      }, resolveImportMeta(property, { moduleId }) {
        if (!isAbsolute(moduleId)) return
        if (property === 'url') return JSON.stringify(pathToFileURL(moduleId).href)
        if (property === 'filename') return JSON.stringify(moduleId)
        if (property === 'dirname') return JSON.stringify(dirname(moduleId))
      }, async transform(code, id) {
        const path = id.split('?')[0]
        if (!path.startsWith(projection + '/') || path.includes('/node_modules/')) return
        await bind(path, projection)
        if (!mutation || relative(projection, path) !== mutation.file) return
        assert.equal(code.split(mutation.from).length, 2, 'Unique production mutation ' + mutation.id)
        assert.equal(sha(code), sourceInputs.get(mutation.file).sha256, 'The transformed module is the original committed source')
        applied = true
        const changed = code.replace(mutation.from, mutation.to)
        transformation = { file: mutation.file, before: sha(code), after: sha(changed), from: mutation.from, to: mutation.to }
        return { code: changed, map: null }
      } }], build: { ssr: true, outDir: join(temporary, label), minify: false, sourcemap: false,
        rollupOptions: { input: join(projection, fixture), external: id => id === 'electron' || isBuiltin(id), output: { format: 'es', entryFileNames: 'main.mjs',
          banner: "import {createRequire as __probeRequire} from 'node:module';const require=__probeRequire(import.meta.url);" } } } })
    assert.equal(applied, Boolean(mutation), 'The owning source must actually consume its mutation')
    return { entry: join(temporary, label, 'main.mjs'), transformation }
  }
  async function native(label, mutation) {
    let processOutcome
    const { entry, transformation } = await bundle(label, mutation), privateRoot = join(temporary, label, 'private'), nativeFile = join(out, label + '.json')
    await mkdir(privateRoot, { recursive: true })
    const bootstrap = join(temporary, label, 'bootstrap.cjs')
    await writeFile(bootstrap, `const {app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(privateRoot)};const fail=error=>{console.error(error);try{fs.writeFileSync(${JSON.stringify(nativeFile)},JSON.stringify({passed:false,cases:[],failure:{name:error.name,message:error.message,stack:error.stack}}))}finally{app.exit(1)}};try{for(const key of ['home','appData','userData','sessionData']){const value=path.join(root,key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}app.commandLine.appendSwitch('site-per-process');app.commandLine.appendSwitch('no-proxy-server');app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(entry).href)})).catch(fail)}catch(error){fail(error)};`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { AGENTMUX_PRESENCE_PRIVATE: privateRoot, AGENTMUX_PRESENCE_OUTPUT: out, AGENTMUX_PRESENCE_RECEIPT: nativeFile, AGENTMUX_PRESENCE_LABEL: label })
    if (osCapture) Object.assign(env, { AGENTMUX_PRESENCE_OS: '1', AGENTMUX_PRESENCE_HANDOFF: temporary })
    const lines = []
    try {
      processOutcome = await runProbeProcess(executable, [bootstrap], { cwd: privateRoot, env, timeoutMs: osCapture ? 240_000 : 90_000,
        onLine: line => { lines.push(line); process.stderr.write(line + '\n') } })
      receipt.nativeProcesses ??= []
      receipt.nativeProcesses.push({ label, privateRoot, ...processOutcome, cleanupConfirmed: false })
      await stopProbeProcesses(processOutcome.originalPid, privateRoot)
      receipt.nativeProcesses.at(-1).cleanupConfirmed = true
    } catch (error) {
      preservePrivateRoot = !error.probe?.exitConfirmed || Boolean(processOutcome)
      throw error
    } finally { await writeFile(join(out, label + '.log'), lines.join('\n')) }
    const actual = JSON.parse(await readFile(nativeFile, 'utf8'))
    for (const [path, input] of Object.entries(actual.loadedExternalInputs ?? {})) {
      const digest = sha(await readFile(path))
      assert.equal(digest, input.sha256, 'The actual native require input remains original: ' + path)
      if (externalInputs.has(path)) assert.equal(digest, externalInputs.get(path))
      externalInputs.set(path, digest)
    }
    const row = { label, mutation: mutation?.id ?? null, transformation, process: processOutcome, receipt: nativeFile, sha256: sha(await readFile(nativeFile)), actual }
    receipt.runs.push(row)
    assert.equal(processOutcome.timedOut, false, 'A timeout is not a semantic RED')
    assert.equal(processOutcome.exitSignal, null, 'A signal is not a semantic RED')
    assert.equal(actual.versions?.electron, receipt.engine.version, 'The actual native consumer uses the bound stock Electron')
    assert.equal(actual.cleanupComplete, true, 'The original native consumer confirms its final cleanup and input binding')
    assert.deepEqual(actual.cleanup, [], 'Cleanup or source observation failures cannot qualify as semantic RED')
    assert.ok(actual.cases.length > 0, 'The original native consumer cases are nonempty')
    if (mutation) {
      assert.notEqual(processOutcome.exitCode, 0, 'The production mutation must change the owning behavior')
      assert.equal(actual.failure?.name, 'AssertionError', 'Setup failures cannot qualify as semantic RED')
      assert.ok(actual.failure.message.includes(mutation.assertion), 'The intended owning behavior must turn RED: ' + mutation.assertion)
      row.owningAssertion = { message: mutation.assertion, status: 'AssertionRED' }
    } else {
      assert.equal(processOutcome.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true, actual.failure?.message)
      if (osCapture) {
        assert.equal(actual.cases.length, 8, 'Eight native window contexts are nonempty')
        assert.equal(actual.captures.length, 9, 'Eight ownership images and one ordinary completed cue are observed once')
        assert.equal(actual.captureQualified, true, 'Original native-window and cue lifetime observations qualify')
      } else {
        assert.equal(actual.cases.length, 16, 'The original native ownership, preferences, avatar, two frame and invalidation consumers are complete')
        assert.ok(actual.cases.every(test => test.passed))
        assert.equal(actual.cases.filter(test => test.name === 'saved-preferences-native-pixels').length, 8)
        assert.deepEqual(actual.cases.filter(test => test.name === 'actual-frame-pointer-label-and-ack').map(test => test.kind), ['local', 'separate'])
      }
    }
    await rm(join(temporary, label), { recursive: true, force: true })
    return actual
  }
  async function nodeConsumer(label, entry, args) {
    await bind(entry)
    const chunks = []
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, [entry, ...args], { cwd: root, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', value => chunks.push(value)); child.stderr.on('data', value => chunks.push(value))
      child.once('error', reject); child.once('exit', (code, signal) => done({ code, signal }))
    })
    await writeFile(join(out, label + '.log'), Buffer.concat(chunks))
    assert.equal(result.signal, null, 'An interrupted consumer is not product evidence: ' + label)
    assert.equal(result.code, 0, 'The original consumer must finish successfully: ' + label)
  }
  if (osCapture) console.error('operator-os-handoff: ' + temporary)
  const actual = await native(osCapture ? 'os-window' : 'baseline')
  receipt.qualifications.nativeMain = actual.passed
  if (osCapture) {
    receipt.qualifications.osWindowCapture = actual.captureQualified
    receipt.qualifications.rendererPngGeneration = 'reused-source-bound-proof'
    receipt.qualifications.osWindowAesthetics = 'independent-review-pending'
    receipt.osDiagnosticComplete = true
  } else if (!baselineOnly) {
    for (const mutation of mutations) await native(mutation.id, mutation)
    await native('restored')
    const unit = join(root, 'apps/desktop/scripts/verify-browser-operator-presence-unit.mjs'), unitOut = join(out, 'unit')
    await nodeConsumer('unit', unit, [unitOut])
    const unitFile = join(unitOut, 'receipt.json'), unitReceipt = JSON.parse(await readFile(unitFile, 'utf8'))
    receipt.unit = { receipt: unitFile, sha256: sha(await readFile(unitFile)), actual: unitReceipt }
    assert.equal(unitReceipt.schema, 'agentmux.browser-operator-presence-unit.v1')
    assert.equal(unitReceipt.passed, true); assert.equal(unitReceipt.sourceUnchanged, true); assert.equal(unitReceipt.sharedSourceMutations, 0)
    for (const [path, digest] of Object.entries(unitReceipt.sourceBefore)) {
      await bind(join(root, path))
      assert.equal(digest, sourceInputs.get(path).sha256, 'The unit and original native consumer use the same production bytes: ' + path)
    }
    assert.ok(unitReceipt.runs.length >= 9 && unitReceipt.runs.every(run => run.total >= 75), 'The actual unit consumers and seven semantic mutations are nonempty')
    const rendererFile = rendererIndex >= 0 ? resolve(process.argv[rendererIndex + 1]) : join(out, 'renderer/receipt.json')
    if (rendererIndex < 0) await nodeConsumer('renderer', join(root, 'apps/desktop/scripts/verify-browser-contextual-composer.mjs'), ['--presence-only', '--output', dirname(rendererFile)])
    const rendererBytes = await readFile(rendererFile), rendererReceipt = JSON.parse(rendererBytes)
    const rendererSnapshot = join(out, 'renderer-consumer.json')
    await writeFile(rendererSnapshot, rendererBytes)
    receipt.renderer = { receipt: rendererSnapshot, originalReceipt: rendererFile, sha256: sha(rendererBytes), actual: rendererReceipt,
      reused: rendererIndex >= 0, boundary: 'The original presence diagnostic remains diagnostic. Its native artwork/IPC facts do not qualify OS input or whole-window aesthetics.' }
    assert.equal(rendererReceipt.schema, 'agentmux.browser-contextual-composer.proof.v1')
    assert.equal(rendererReceipt.mode, 'operator-presence'); assert.equal(rendererReceipt.presenceDiagnosticComplete, true)
    assert.equal(rendererReceipt.sharedTreeMutations, 0); assert.equal(rendererReceipt.failure, undefined)
    assert.ok(rendererReceipt.runs.length > 0 && Object.keys(rendererReceipt.sources).length > 10)
    const original = rendererReceipt.runs.find(run => run.label === 'native-baseline')?.actual
    assert.equal(original?.passed, true); assert.equal(original?.presence?.passed, true)
    assert.ok(original.ipc.every(call => call.channel !== 'sessions:submitPrompt'), 'The presence-only consumer sends no business opinion')
    for (const [path, digest] of Object.entries(rendererReceipt.sources)) {
      await bind(join(root, path))
      assert.equal(sourceInputs.get(path).sha256, digest, 'The original Renderer diagnostic uses the same current source: ' + path)
    }
    receipt.qualifications.nativeMain = true
    receipt.qualifications.unitConsumers = true
    receipt.qualifications.rendererPngGeneration = true
    receipt.qualifications.nativeAnimationProgress = receipt.runs.filter(run => !run.mutation).every(run => {
      const frames = run.actual.cases.filter(test => test.timeline)
      return frames.length === 2 && frames.every(test => test.timeline.elapsedMotion === 'observed')
    }) ? 'observed' : 'not-observed'
    receipt.passed = true
  }
  receipt.diagnosticCompleted = true
} catch (error) {
  receipt.failure = { name: error.name, message: error.message, stack: error.stack, ...(error.probe ? { probe: error.probe } : {}) }
} finally {
  receipt.sources = Object.fromEntries([...sourceInputs].map(([key, value]) => [key, { sha256: value.sha256, bytes: value.bytes }]))
  receipt.externalInputs = Object.fromEntries(externalInputs)
  const drift = []
  for (const [key, value] of sourceInputs) if (sha(await readFile(value.path)) !== value.sha256) drift.push(key)
  for (const [path, digest] of externalInputs) if (sha(await readFile(path)) !== digest) drift.push(path)
  receipt.sourceDrift = drift
  if (drift.length) { receipt.passed = false; receipt.failure ??= { message: 'Actual loaded source changed during this invocation' } }
  if (preservePrivateRoot) receipt.cleanup.retainedPrivateRoot = temporary
  else { await rm(temporary, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2))
  await mkdir(dirname(receiptPath), { recursive: true }); await writeFile(receiptPath, JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify({ passed: receipt.passed, nativeMain: receipt.qualifications.nativeMain, diagnosticCompleted: receipt.diagnosticCompleted ?? false, receipt: receiptPath }))
if (receipt.failure || !baselineOnly && !osCapture && !receipt.passed) process.exitCode = 1
