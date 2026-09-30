import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile, readdir, rm, symlink, stat, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess } from './probe-process.mjs'
import { execFileSync } from 'node:child_process'

// A thin actual Main consumer. It never builds/installs Desktop or owns a user Run.
const repositoryRoot = resolve(import.meta.dirname, '../../..')
const desktopRoot = join(repositoryRoot, 'apps/desktop')
const fixtures = join(desktopRoot, 'scripts/fixtures/browser-operation-feedback')
const require = createRequire(join(desktopRoot, 'package.json'))
const nativeScope = process.env.AGENTMUX_FEEDBACK_NATIVE_SCOPE ?? 'full'
assert.ok(['full', 'motion'].includes(nativeScope), 'AGENTMUX_FEEDBACK_NATIVE_SCOPE must be full or motion')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const out = resolve(process.env.AGENTMUX_FEEDBACK_EVIDENCE_ROOT ?? join(repositoryRoot, '.tmp/browser-operation-feedback-native', `attempt-${Date.now()}`))
const temporaryRoot = await mkdtemp('/tmp/amx-feedback-native-')
const projectionRoot = join(await realpath(temporaryRoot), 'projection')
const receipt = { schema: nativeScope === 'motion' ? 'agentmux.browser-operation-feedback-native.v2' : 'agentmux.browser-operation-feedback-native.v1', passed: false, taskComplete: false,
  author: '/root/browser_surfaces', actualExecutor: '/root', scope: 'stock Electron / actual BrowserViewManager / original native pages / private profile',
  desktopTabRegionFocusRestore: 'not-tested', healthyCoreRunRestore: 'not-tested', userAuthentication: 'not-tested',
  nativeScope,
  source: {}, phases: [], cleanup: {}, visual: { captureOnly: true, aestheticReview: 'not-performed' } }
let server, failure
await mkdir(out, { recursive: true })
async function sizeOf(path) {
  let total = 0
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const p = join(path, entry.name)
    if (entry.isSymbolicLink()) continue
    total += entry.isDirectory() ? await sizeOf(p) : (await stat(p)).size
  }
  return total
}
const sourceInputs = new Map()
const externalInputs = new Map()
const actualPhases = [] // Raw cases live only in their actual process files, never a second serialized copy.
try {
  const git = args => execFileSync('git', args, { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 })
  const commit = git(['rev-parse', 'HEAD']).toString().trim()
  const tree = git(['rev-parse', commit + '^{tree}']).toString().trim()
  const projectedPaths = ['apps/desktop/src/main', 'apps/desktop/src/shared', 'packages/core/src', 'packages/core/bin',
    'package.json', 'apps/desktop/package.json', 'packages/core/package.json']
  await mkdir(projectionRoot, { recursive: true })
  execFileSync('tar', ['-x', '-C', projectionRoot], { input: git(['archive', commit, ...projectedPaths]) })
  const owningFixturePath = join(projectionRoot, 'apps/desktop/scripts/fixtures/browser-operation-feedback/main.ts')
  await mkdir(dirname(owningFixturePath), { recursive: true })
  const owningFixturePaths = new Set([owningFixturePath, join(dirname(owningFixturePath), 'motion.ts')])
  for (const fixture of owningFixturePaths) await writeFile(fixture, await readFile(join(fixtures, fixture.split('/').at(-1))))
  for (const rel of ['', 'apps/desktop', 'packages/core']) {
    await symlink(join(repositoryRoot, rel, 'node_modules'), join(projectionRoot, rel, 'node_modules'))
  }
  receipt.source.candidate = { kind: 'current-main-git-tree-private-source-projection', commit, tree, projectedPaths,
    fixtureOrigin: join(fixtures, 'main.ts'), uncommittedPeerSourceConsumed: false }
  const expected = { 'browser-operation-feedback.ts': 'e30d06cd287f3642153c03287850dfd70c3ee62939ad212b0dc31c3406812e16',
    'browser-page-dispatch.ts': 'e1426edc674c383154c3abcc3156cdb744dda1f2388e21838eca2610adc85cf1',
    'browser-view-manager.ts': 'f561f35f4a389bfe89b50c9a679b2e2427e7260165e0d1d3772530fc44b0b9f6' }
  for (const [name, sha] of Object.entries(expected)) assert.equal(digest(await readFile(join(projectionRoot, 'apps/desktop/src/main', name))), sha,
    'The immutable Main Browser leaf matches the independently reviewed Source: ' + name)
  const electronWrapper = require.resolve('electron'), executable = require('electron')
  receipt.engine = { sdkEntry: electronWrapper, sdkEntrySha256: digest(await readFile(electronWrapper)), executable,
    executableSha256: digest(await readFile(executable)), executableBytes: (await stat(executable)).size,
    packageVersion: require('electron/package.json').version, expectedElectron: '43.7.7' }
  assert.equal(receipt.engine.packageVersion, '43.7.7', 'The selected dependency is stock 43.7.7; the actual process separately proves its engine version')
  await symlink(join(repositoryRoot, 'node_modules'), join(temporaryRoot, 'node_modules'))
  const { build } = await import(pathToFileURL(require.resolve('vite')))
  const input = owningFixturePath
  await build({ configFile: false, root: projectionRoot, logLevel: 'warn',
    ssr: { noExternal: true },
    resolve: { alias: { '@agentmux/core': join(projectionRoot, 'packages/core/src/index.ts') } },
    plugins: [{ name: 'actual-feedback-source-inputs', enforce: 'pre', async resolveId(id, importer) {
      if (!importer || id.startsWith('\0') || id === 'electron' || id.startsWith('node:') || id.startsWith('.') || isAbsolute(id) || id.startsWith('@agentmux/core')) return
      // pnpm exposes dependencies in their owning package, not at the workspace root.
      const resolved = await this.resolve(id, importer, { skipSelf: true })
      assert.ok(resolved && isAbsolute(resolved.id), `The owning import resolves an actual package entry: ${id}`)
      const path = resolved.id
      const bytes = await readFile(path)
      externalInputs.set(path, { specifier: id, path, sha256: digest(bytes), bytes: bytes.length })
      return { id: path, external: true }
    }, resolveImportMeta(property, { moduleId }) {
      // Keep the actual owning module's Node file identity in this thin bundle.
      if (!isAbsolute(moduleId)) return
      if (property === 'url') return JSON.stringify(pathToFileURL(moduleId).href)
      if (property === 'filename') return JSON.stringify(moduleId)
      if (property === 'dirname') return JSON.stringify(dirname(moduleId))
    }, async transform(code, id) {
      const p = id.split('?')[0]
      if (!isAbsolute(p) || !p.startsWith(projectionRoot + '/') || p.includes('/node_modules/')) return
      const bytes = await readFile(p)
      const rel = p.slice(projectionRoot.length + 1), snapshot = join(out, 'source-inputs', rel)
      await mkdir(dirname(snapshot), { recursive: true }); await writeFile(snapshot, bytes)
      const assetUrl = id.endsWith('?url')
      sourceInputs.set(p, { path: p, relativePath: rel, sha256: digest(bytes), bytes: bytes.length, snapshot,
        transformKind: assetUrl ? 'vite-asset-url' : 'raw-source', loadedTextSha256: digest(Buffer.from(code)),
        origin: owningFixturePaths.has(p) ? { kind: 'owned-fixture', path: join(fixtures, p.split('/').at(-1)) } : { kind: 'git-tree-blob', commit, tree, path: rel } })
      if (!assetUrl) assert.equal(digest(Buffer.from(code)), digest(bytes), `Raw actual loaded Source differs: ${p}`)
    } }],
    build: { ssr: true, outDir: join(temporaryRoot, 'bundle'), emptyOutDir: true, minify: false, sourcemap: false,
      rollupOptions: { input, external: id => id === 'electron' || id.startsWith('node:'),
      output: { format: 'cjs', entryFileNames: 'main.cjs' } } } })
  assert.ok(sourceInputs.size > 0, 'The real production Source input set is nonempty')
  assert.ok([...sourceInputs.keys()].some(p => p.endsWith('/src/main/browser-operation-feedback.ts')), 'The new production feedback must be bundled')
  receipt.source.inputs = [...sourceInputs.values()]
  receipt.source.externalEntryInputs = [...externalInputs.values()]
  const actualBundle = await readFile(join(temporaryRoot, 'bundle/main.cjs'))
  receipt.source.bundlePath = join(out, 'probe-main.cjs')
  receipt.source.bundleBytes = actualBundle.length
  receipt.source.bundleSha256 = digest(actualBundle)
  await writeFile(receipt.source.bundlePath, actualBundle)
  for (const path of [resolve(import.meta.filename), join(desktopRoot, 'scripts/probe-process.mjs')]) {
    const bytes = await readFile(path), relativePath = path.slice(repositoryRoot.length + 1), snapshot = join(out, 'source-inputs', relativePath)
    await mkdir(dirname(snapshot), { recursive: true }); await writeFile(snapshot, bytes)
    sourceInputs.set(path, { path, relativePath, sha256: digest(bytes), bytes: bytes.length, snapshot })
  }
  receipt.source.inputs = [...sourceInputs.values()]
  await writeFile(join(out, 'source-before.json'), JSON.stringify(receipt.source))
  const page = await readFile(join(fixtures, 'page.html'), 'utf8')
  const frame = await readFile(join(fixtures, 'frame.html'), 'utf8')
  let base, cross
  const requests = []
  server = createServer(async (request, response) => {
    requests.push({ host: request.headers.host, url: request.url, at: Date.now() })
    try {
      const url = new URL(request.url, base)
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; frame-src http://127.0.0.1:* http://localhost:*; require-trusted-types-for 'script'; trusted-types 'none'")
      if (url.pathname === '/' || url.pathname === '/page.html') {
        response.setHeader('Content-Type', 'text/html'); response.end(page.replace('__CROSS_FRAME__', cross + '/frame.html'))
      } else if (url.pathname === '/work.bin') {
        response.setHeader('Content-Type', 'application/octet-stream'); response.end(Buffer.alloc(4 * 1024 * 1024, 73))
      } else if (url.pathname === '/frame.html') {
        response.setHeader('Content-Type', 'text/html'); response.end(frame.replace('Embedded action', request.headers.host.startsWith('localhost:') ? 'Second embedded action' : 'First embedded action'))
      } else if (url.pathname === '/page.css' || url.pathname === '/page.js') {
        response.setHeader('Content-Type', url.pathname.endsWith('css') ? 'text/css' : 'application/javascript'); response.end(await readFile(join(fixtures, url.pathname.slice(1))))
      } else { response.statusCode = 404; response.end('Not found') }
    } catch (error) { response.statusCode = 500; response.end(String(error)) }
  })
  await new Promise(done => server.listen(0, '0.0.0.0', done))
  base = `http://127.0.0.1:${server.address().port}`; cross = `http://localhost:${server.address().port}`
  const fixtureInputs = []
  for (const name of ['main.ts', 'motion.ts', 'page.html', 'page.css', 'page.js', 'frame.html', 'scenario.md']) {
    const path = join(fixtures, name), bytes = await readFile(path)
    fixtureInputs.push({ path, sha256: digest(bytes), bytes: bytes.length })
  }
  receipt.fixture = { base, cross, strictCsp: true, trustedTypesRequired: true, inputs: fixtureInputs, requests }
  const retained = join(temporaryRoot, 'retained-browser.json')
  for (const phase of ['first', 'second']) {
    const phaseFile = join(out, `${phase}-receipt.json`)
    const env = { ...process.env, AGENTMUX_FEEDBACK_PROBE_ROOT: temporaryRoot, AGENTMUX_FEEDBACK_PHASE: phase,
      AGENTMUX_FEEDBACK_OUT: out, AGENTMUX_FEEDBACK_URL: base + '/page.html', AGENTMUX_FEEDBACK_RETAINED: retained,
      AGENTMUX_FEEDBACK_PHASE_FILE: phaseFile, AGENTMUX_FEEDBACK_REPOSITORY: repositoryRoot }
    delete env.ELECTRON_RUN_AS_NODE
    const lines = []
    const result = await runProbeProcess(executable, [join(temporaryRoot, 'bundle/main.cjs')], {
      temporaryRoot, cwd: temporaryRoot, env, timeoutMs: 75_000,
      onLine: line => { lines.push(line); process.stderr.write(line + '\n') } })
    await writeFile(join(out, `${phase}-stderr.txt`), lines.join('\n') + '\n')
    const row = { phase, process: result }
    receipt.phases.push(row)
    const actualBytes = await readFile(phaseFile)
    const actual = JSON.parse(actualBytes.toString('utf8'))
    actualPhases.push(actual)
    if (nativeScope === 'motion') row.actualOriginal = { path: phaseFile, sha256: digest(actualBytes), bytes: actualBytes.length }
    else row.actual = actual
    assert.equal(result.exitCode, 0, `${phase} actual process failed`)
    assert.equal(result.timedOut, false)
    assert.ok(actual.cases.length > 0, 'Actual private process cases are nonempty')
    assert.equal(actual.phaseCompleted, true, actual.failure?.message)
    assert.equal(actual.versions.electron, '43.7.7')
    if (nativeScope === 'motion') assert.ok(await sizeOf(out) < 8 * 1024 * 1024, 'The motion increment retains original evidence within 8MiB')
    assert.ok(await sizeOf(temporaryRoot) <= 30 * 1024 * 1024, 'Private bundle and real userdata stay within 30MiB')
  }
  assert.notEqual(actualPhases[0].pid, actualPhases[1].pid, 'Ordinary recovery uses two actual processes')
  receipt.localBrowserProfileRecovery = { passed: true, firstPid: actualPhases[0].pid, secondPid: actualPhases[1].pid,
    first: actualPhases[0].retained, second: actualPhases[1].restored,
    boundary: 'This is real private profile/Browser input recovery, not Desktop Tab/Region or healthy Core Run recovery.' }
  receipt.passed = actualPhases.every(actual => actual.passed === true)
  if (!receipt.passed) receipt.failure = { message: 'Actual private process phases finished; failed/not-tested cases, OS window observation and true OOPIF input retain their explicit boundaries. Keep Native receipt RED.' }
} catch (error) { failure = error; receipt.failure = { message: error.message, stack: error.stack } }
finally {
  if (server) await new Promise(done => server.close(done))
  receipt.source.inputs ??= [...sourceInputs.values()]
  const drift = []
  for (const row of [...sourceInputs.values(), ...externalInputs.values(), ...(receipt.fixture?.inputs ?? [])]) {
    const currentSha = digest(await readFile(row.path)); if (currentSha !== row.sha256) drift.push({ path: row.path, before: row.sha256, after: currentSha })
  }
  receipt.source.drift = drift
  if (drift.length) { receipt.passed = false; receipt.failure ??= { message: 'Actual loaded Source changed during Native proof. Preserve RED and resample this result.' } }
  await writeFile(join(out, 'source-after.json'), JSON.stringify({ drift, sourceInputCount: sourceInputs.size }))
  receipt.cleanup.privateBytes = await sizeOf(temporaryRoot)
  // Retain only this probe's real durable storage for diagnosis, not caches/dependencies.
  const durable = join(temporaryRoot, 'retained-browser.json')
  try { await writeFile(join(out, 'retained-browser.json'), await readFile(durable)) } catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const rel of ['profiles.json', 'refs.json', 'journal.json']) {
    try { const bytes = await readFile(join(temporaryRoot, rel)); await mkdir(join(out, 'durable-private-storage'), { recursive: true }); await writeFile(join(out, 'durable-private-storage', rel), bytes) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (receipt.engine) {
    receipt.engine.after = { sdkEntrySha256: digest(await readFile(receipt.engine.sdkEntry)), executableSha256: digest(await readFile(receipt.engine.executable)) }
    if (receipt.engine.after.sdkEntrySha256 !== receipt.engine.sdkEntrySha256 || receipt.engine.after.executableSha256 !== receipt.engine.executableSha256) {
      receipt.passed = false; receipt.failure ??= { message: 'The actual selected Electron identity changed during this probe.' }
    }
  }
  await rm(temporaryRoot, { recursive: true, force: true })
  receipt.cleanup.privateRootRemoved = true
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt))
}
console.log(JSON.stringify({ receipt: join(out, 'receipt.json'), passed: receipt.passed, taskComplete: false }))
if (failure || !receipt.passed) process.exitCode = 1
