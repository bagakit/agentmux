import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm, readdir, lstat, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { runProbeProcess } from './probe-process.mjs'

// This is a private original Main/WCV probe, never a Desktop build or user lifecycle action.
const root = resolve(import.meta.dirname, '../../..'), fixture = join(import.meta.dirname, 'fixtures/browser-task-bounded')
const argument = name => { const index = process.argv.indexOf(name); return index < 0 ? undefined : process.argv[index + 1] }
const out = resolve(argument('--out') ?? join(root, '.tmp', ("browser-task-bounded-native-" + (globalThis.crypto.randomUUID()) + "")))
const require = createRequire(join(root, 'apps/desktop/package.json')), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const temporary = await realpath(await mkdtemp(join(tmpdir(), 'amx-task-bounded-'))), projection = join(temporary, 'projection')
const receipt = { schema: 'agentmux.browser-task-bounded-native.v1', author: '/root/browser_source_closeout', taskComplete: false,
  scope: 'actual private Main task owner, public typed control socket, original native WCV and ordinary private profile recovery',
  privateProofPassed: false, fullDesktopPassed: false, desktopTabRegionFocusRestore: 'not-tested', healthyCoreRunRestore: 'not-tested',
  userAuthentication: 'not-tested', physicalHumanInput: 'not-tested', source: {}, phases: [], cleanup: {}, visualReview: 'not-performed', osWindows: [] }
let server
const inputs = new Map(), externals = new Map()
async function directoryBytes(path) {
  let bytes = 0
  for (const name of await readdir(path)) {
    const item = join(path, name), state = await lstat(item)
    if (state.isSymbolicLink()) continue
    bytes += state.isDirectory() ? await directoryBytes(item) : state.size
  }
  return bytes
}
await mkdir(out, { recursive: true })
try {
  const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })
  const commit = argument('--candidate') ?? git(['rev-parse', 'refs/heads/main']).toString().trim()
  git(['merge-base', '--is-ancestor', commit, 'refs/heads/main'])
  const tree = git(['rev-parse', commit + '^{tree}']).toString().trim()
  const projectedPaths = ['apps/desktop/src/main', 'apps/desktop/src/shared', 'packages/core/src', 'packages/core/bin', 'package.json', 'apps/desktop/package.json', 'packages/core/package.json', 'tsconfig.base.json', 'apps/desktop/tsconfig.json']
  await mkdir(projection); execFileSync('tar', ['-x', '-C', projection], { input: git(['archive', commit, ...projectedPaths]) })
  const sourceMain = join(projection, 'apps/desktop/src/main')
  for (const name of ['browser-task-batch.ts', 'browser-task-branch.ts']) {
    const bytes = await readFile(join(sourceMain, name)); assert.ok(bytes.length > 0, `Actual published Main contains ${name}`)
  }
  const fixtureTarget = join(projection, 'apps/desktop/scripts/fixtures/browser-task-bounded')
  await mkdir(fixtureTarget, { recursive: true })
  for (const name of ['main.ts', 'page.html', 'page.js', 'page.css']) await writeFile(join(fixtureTarget, name), await readFile(join(fixture, name)))
  for (const rel of ['', 'apps/desktop']) await symlink(join(root, rel, 'node_modules'), join(projection, rel, 'node_modules'))
  const coreDependencyView = join(projection, 'packages/core/node_modules')
  await mkdir(coreDependencyView)
  for (const name of await readdir(join(root, 'packages/core/node_modules'))) {
    await symlink(join(root, 'packages/core/node_modules', name), join(coreDependencyView, name))
  }
  const coreManifest = JSON.parse(await readFile(join(projection, 'packages/core/package.json'), 'utf8'))
  const rpcVersion = coreManifest.dependencies['json-rpc-2.0']
  assert.ok(typeof rpcVersion === 'string' && /^\d+\.\d+\.\d+$/.test(rpcVersion), 'The candidate pins its actual JSON-RPC package')
  const rpcPackage = join(root, 'node_modules/.pnpm', `json-rpc-2.0@${rpcVersion}`, 'node_modules/json-rpc-2.0')
  const rpcManifest = await readFile(join(rpcPackage, 'package.json'))
  assert.equal(JSON.parse(rpcManifest.toString()).version, rpcVersion)
  try { await lstat(join(coreDependencyView, 'json-rpc-2.0')) }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    await symlink(rpcPackage, join(coreDependencyView, 'json-rpc-2.0'))
  }
  receipt.dependencyView = { kind: 'owned-shallow-links', installedPackage: 'json-rpc-2.0', version: rpcVersion,
    packageManifestSha256: sha(rpcManifest), packageManifestBytes: rpcManifest.length, installedDependenciesChanged: false }
  receipt.source.candidate = { kind: 'published-main-source-projection', commit, tree, projectedPaths, uncommittedPeerSourceConsumed: false }
  const executable = require('electron'), sdkEntry = require.resolve('electron')
  receipt.engine = { executable, executableSha256: sha(await readFile(executable)), sdkEntry, sdkEntrySha256: sha(await readFile(sdkEntry)), packageVersion: require('electron/package.json').version }
  assert.equal(receipt.engine.packageVersion, '43.7.7')
  const manifest = JSON.parse(await readFile(join(projection, 'packages/core/package.json'), 'utf8'))
  const coreAliases = Object.entries(manifest.exports).map(([key, value]) => ({ find: '@agentmux/core' + (key === '.' ? '' : key.slice(1)), replacement: join(projection, 'packages/core', value.types.replace('./dist/', 'src/').replace('.d.ts', '.ts')) })).sort((a, b) => b.find.length - a.find.length)
  assert.ok(coreAliases.length > 0, 'Core aliases consume actual owning Source')
  const { build } = await import(pathToFileURL(require.resolve('vite')))
  await build({ configFile: false, root: projection, logLevel: 'warn', ssr: { noExternal: true }, resolve: { alias: coreAliases },
    plugins: [{ name: 'bounded-task-actual-source', enforce: 'pre', async resolveId(id, importer) {
      if (!importer || id.startsWith('\0') || id === 'electron' || id.startsWith('node:') || id.startsWith('.') || isAbsolute(id) || id.startsWith('@agentmux/core')) return
      const resolved = await this.resolve(id, importer, { skipSelf: true }); assert.ok(resolved && isAbsolute(resolved.id), `Actual owning package resolves ${id}`)
      const bytes = await readFile(resolved.id); externals.set(resolved.id, { path: resolved.id, specifier: id, sha256: sha(bytes), bytes: bytes.length })
      return { id: resolved.id, external: true }
    }, resolveImportMeta(property, { moduleId }) {
      if (!isAbsolute(moduleId)) return
      if (property === 'url') return JSON.stringify(pathToFileURL(moduleId).href)
      if (property === 'filename') return JSON.stringify(moduleId)
      if (property === 'dirname') return JSON.stringify(dirname(moduleId))
    }, async transform(code, id) {
      const path = id.split('?')[0]; if (!isAbsolute(path) || !path.startsWith(projection + '/') || path.includes('/node_modules/')) return
      const bytes = await readFile(path), relativePath = path.slice(projection.length + 1), snapshot = join(out, 'source-inputs', relativePath)
      await mkdir(dirname(snapshot), { recursive: true }); await writeFile(snapshot, bytes)
      inputs.set(path, { path, relativePath, snapshot, bytes: bytes.length, sha256: sha(bytes), loadedTextSha256: sha(Buffer.from(code)), origin: path.startsWith(fixtureTarget + '/') ? 'owned-fixture' : 'published-main-git-blob' })
      if (!id.endsWith('?url')) assert.equal(sha(Buffer.from(code)), sha(bytes), 'Actual loaded raw Source is unchanged')
    } }], build: { ssr: true, outDir: join(temporary, 'bundle'), emptyOutDir: true, minify: false,
      rollupOptions: { input: join(fixtureTarget, 'main.ts'), external: id => id === 'electron' || id.startsWith('node:'), output: { format: 'cjs', entryFileNames: 'main.cjs' } } } })
  assert.ok(inputs.size > 0)
  for (const name of ['browser-task-assets.ts', 'browser-task-branch.ts', 'browser-task-batch.ts', 'browser-task-control.ts', 'browser-view-manager.ts']) assert.ok([...inputs.values()].some(row => row.relativePath === 'apps/desktop/src/main/' + name), `Actual production consumer ${name} was loaded`)
  const bundle = await readFile(join(temporary, 'bundle/main.cjs'))
  receipt.source.bundle = { path: join(out, 'probe-main.cjs'), sha256: sha(bundle), bytes: bundle.length }; await writeFile(receipt.source.bundle.path, bundle)
  for (const path of [import.meta.filename, join(import.meta.dirname, 'probe-process.mjs'), ...['main.ts', 'page.html', 'page.js', 'page.css'].map(name => join(fixture, name))]) {
    const bytes = await readFile(path), relativePath = path.slice(root.length + 1), snapshot = join(out, 'source-inputs', relativePath)
    await mkdir(dirname(snapshot), { recursive: true }); await writeFile(snapshot, bytes)
    inputs.set(path, { path, relativePath, snapshot, bytes: bytes.length, sha256: sha(bytes), origin: 'owned-producer-fixture' })
  }
  receipt.source.inputs = [...inputs.values()]; receipt.source.externalEntries = [...externals.values()]
  await writeFile(join(out, 'source-before.json'), JSON.stringify(receipt.source, null, 2))
  const requests = []
  server = createServer(async (request, response) => {
    requests.push({ path: request.url, at: Date.now() })
    const path = new URL(request.url, 'http://localhost').pathname
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; require-trusted-types-for 'script'; trusted-types 'none'")
    try {
      if (['/form', '/panel'].includes(path)) {
        let html = (await readFile(join(fixture, 'page.html'), 'utf8')).replace('__SHAPE__', path === '/form' ? 'Labelled form input' : 'Named toolbar input')
        if (path === '/panel') html = html.replace('<label for="entry">Item value</label><input id="entry" autocomplete="off">', '<input id="entry" aria-label="Item value" autocomplete="off">')
        response.setHeader('Content-Type', 'text/html'); response.end(html)
      } else if (['/page.js', '/page.css'].includes(path)) { response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/css'); response.end(await readFile(join(fixture, path.slice(1)))) }
      else { response.statusCode = 404; response.end('Not found') }
    } catch (error) { response.statusCode = 500; response.end(String(error)) }
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`; receipt.fixture = { base, requests, strictCsp: true, trustedTypesRequired: true }
  const actual = []
  for (const phase of ['first', 'second']) {
    const lines = [], env = { ...process.env, AMX_TASK_NATIVE_ROOT: temporary, AMX_TASK_NATIVE_OUT: out, AMX_TASK_NATIVE_PHASE: phase, AMX_TASK_NATIVE_BASE: base }
    delete env.ELECTRON_RUN_AS_NODE
    const processReport = await runProbeProcess(executable, [join(temporary, 'bundle/main.cjs')], { temporaryRoot: temporary, cwd: temporary, env, timeoutMs: 90_000, onLine: line => lines.push(line) })
    await writeFile(join(out, phase + '-stderr.txt'), lines.join('\n'))
    const path = join(out, phase + '-receipt.json'), bytes = await readFile(path)
    receipt.phases.push({ phase, process: processReport, actualOriginal: { path, sha256: sha(bytes), bytes: bytes.length } })
    const report = JSON.parse(bytes.toString()); actual.push(report)
    assert.equal(processReport.exitCode, 0, report.failure?.message); assert.equal(processReport.timedOut, false); assert.equal(report.phaseCompleted, true)
    assert.equal(report.versions.electron, '43.7.7'); assert.ok(report.cases.length > 0 && report.nativePages.length > 0)
    assert.ok(await directoryBytes(temporary) <= 30 * 1024 * 1024, 'The actual private Source closure/bundle/userdata stays within 30MiB')
  }
  assert.notEqual(actual[0].pid, actual[1].pid)
  assert.deepEqual(actual[0].retained, actual[1].cases[0].expected)
  receipt.privateProofPassed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  if (server) await new Promise(done => server.close(done))
  const drift = []
  for (const row of [...inputs.values(), ...externals.values()]) {
    const current = sha(await readFile(row.path)); if (current !== row.sha256) drift.push({ path: row.path, before: row.sha256, after: current })
  }
  receipt.source.inputs ??= [...inputs.values()]; receipt.source.drift = drift
  if (drift.length) { receipt.privateProofPassed = false; receipt.failure ??= { message: 'Actual Native Source changed; preserve this RED original' } }
  for (const name of ['assets.json', 'journal.json', 'refs.json', 'profiles.json', 'retained.json']) {
    try { const bytes = await readFile(join(temporary, name)); await mkdir(join(out, 'durable-originals'), { recursive: true }); await writeFile(join(out, 'durable-originals', name), bytes) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await writeFile(join(out, 'source-after.json'), JSON.stringify({ actualInputs: inputs.size, drift }, null, 2))
  receipt.cleanup.privateBytesBeforeRemoval = await directoryBytes(temporary)
  await rm(temporary, { recursive: true, force: true }); receipt.cleanup.ownedPrivateRootRemoved = true
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ receipt: join(out, 'receipt.json'), privateProofPassed: receipt.privateProofPassed, taskComplete: false }))
if (!receipt.privateProofPassed) process.exitCode = 1
