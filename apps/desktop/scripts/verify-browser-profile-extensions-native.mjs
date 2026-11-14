import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { startExtensionHttpsFixture } from './fixtures/browser-profile-extensions/https-source.mjs'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'
import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'

// Two private Electron processes consume the first process's approved extension,
// immutable packages and original Profile partition. The user's App, Agents and Runtime are untouched.
const repo = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(repo, 'apps/desktop/package.json'))
const { build } = browserSourceBuild(createRequire(require.resolve('vite/package.json'))('esbuild'))
const electron = require('electron'), hash = value => createHash('sha256').update(value).digest('hex')
const outputRoot = process.env.EXTENSIONS_OUTPUT_ROOT || join(repo, '.tmp/browser-profile-extensions-native'); await mkdir(outputRoot, { recursive: true })
const out = await mkdtemp(join(outputRoot, 'attempt-'))
const home = await mkdtemp('/tmp/amux-profile-extensions-'), sources = new Map()
const receipt = { schema: 'agentmux.browser-profile-extensions.native.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  boundary: 'Compiled public CLI, original control socket and actual Renderer API/production preload/ProfileEditorIPC, production Profile Manager/Store/Session and native BrowserViewManager WCV. The explicit host confirmation fixture tests consent ownership, not a real person clicking a native dialog. Second process reads original durable Profile/package/extension storage. Full Desktop Tab/Region/focus and healthy Agent Run restoration are outside this fixture.',
  electron: { version: require('electron/package.json').version, executableSha256: hash(await readFile(electron)) },
  sources: {}, processes: [], out, cleanup: {} }
let server, onlineFixture
const uiOnly = process.env.EXTENSIONS_CASE === 'online-ui'
const onlineUpdate = process.env.EXTENSIONS_CASE === 'online-update'
const online = uiOnly || onlineUpdate || process.env.EXTENSIONS_CASE === 'online-install'
const mutateResultBridge = (code, path) => {
  if (process.env.EXTENSIONS_RESULT_MUTATION !== '1' || !path.endsWith('/shared/ipc-result.ts')) return code
  const target = "'listProfileExtensions', 'checkProfileExtensionUpdate', 'prepareProfileExtension', 'applyProfileExtension', 'removeProfileExtension', 'loadProfileExtension', "
  assert.equal(code.split(target).length, 2, 'Mutate the one actual production IPC result method list')
  receipt.productionMutation = { target: 'BROWSER_PROFILE_RESULT_METHODS', kind: 'omit-extension-result-unwrapping', originalSha256: hash(code) }
  return code.replace(target, '')
}
const mutateOnline = (code, path) => {
  if (process.env.EXTENSIONS_ONLINE_MUTATION === 'hide-update-candidate' && path === join(repo, 'apps/desktop/src/main/browser-profile-extensions.ts')) {
    const target = 'compareExtensionVersions(observed.candidate.version, record.version) > 0'
    assert.equal(code.split(target).length, 2, 'Mutate the original observed version comparison')
    const changed = code.replace(target, 'false')
    receipt.productionMutation = { file: relative(repo, path), kind: 'hide-newer-original-manifest-candidate', originalSha256: hash(code), effectiveSha256: hash(changed) }
    return changed
  }
  if (process.env.EXTENSIONS_ONLINE_MUTATION === 'hold-profile-lock' && path === join(repo, 'apps/desktop/src/main/browser-profile-extensions.ts')) {
    const target = "pkg = source.kind === 'local' ? await prepareExtensionPackage(source.path, staging, admitted.previous?.key) : await prepareOnlineExtension(source, staging, admitted.previous?.key)"
    assert.equal(code.split(target).length, 2, 'Restore the former configuration lock around the real acquisition only')
    const changed = code.replace(target, "pkg = await this.ports.change(profileId, async () => source.kind === 'local' ? await prepareExtensionPackage(source.path, staging, admitted.previous?.key) : await prepareOnlineExtension(source, staging, admitted.previous?.key))")
    receipt.productionMutation = { file: relative(repo, path), kind: 'restore-configuration-lock-around-acquisition', originalSha256: hash(code), effectiveSha256: hash(changed) }
    return changed
  }
  if (process.env.EXTENSIONS_ONLINE_MUTATION !== 'skip-manifest-hash' || !path.endsWith('/browser-profile-extension-online.ts')) return code
  const target = 'if (candidate?.hash && acquired[candidate.hash.algorithm] !== candidate.hash.value)'
  assert.equal(code.split(target).length, 2, 'Mutate exactly the original production package hash guard')
  receipt.productionMutation = { file: relative(repo, path), kind: 'skip-declared-manifest-package-hash', originalSha256: hash(code), effectiveSha256: hash(code.replace(target, 'if (false)')) }
  return code.replace(target, 'if (false)')
}
const loadedSource = { name: 'extensions-original-source', setup(builder) {
  builder.onResolve({ filter: /^[^./]/ }, async args => {
    if (args.pluginData?.resolvedExternal || args.path === 'electron' || args.path.startsWith('node:')) return
    const result = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { resolvedExternal: true } })
    if (result.errors.length) return { errors: result.errors }
    return { path: result.path, external: !['core', 'browser', 'native-desktop'].some(name => result.path.startsWith(join(repo, 'packages', name, 'src') + '/')) }
  })
  builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
    if (!args.path.startsWith(repo + '/') || args.path.includes('/node_modules/')) return
    const bytes = await readFile(args.path); sources.set(args.path, hash(bytes))
    // Keep each owning module's package-relative native/resource resolution.
    // Bundling must not redirect createRequire(import.meta.url) to this fixture.
    const resourceUrl = args.path.endsWith('/control-endpoint-publication.ts') ? pathToFileURL(join(out, 'core/source/control-endpoint-publication.js')).href : pathToFileURL(args.path).href
    const code = mutateOnline(mutateResultBridge(bytes.toString(), args.path), args.path).replaceAll('import.meta.url', JSON.stringify(resourceUrl))
      .replaceAll('import.meta.dirname', JSON.stringify(dirname(args.path))).replaceAll('import.meta.filename', JSON.stringify(args.path))
    return { contents: code, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' }
  })
} }
try {
  for (const path of [join(repo, 'apps/desktop/scripts/fixtures/browser-profile-extensions/index.html'), import.meta.filename, join(repo, 'apps/desktop/scripts/fixtures/browser-profile-extensions/page.html'), join(repo, 'packages/browser/scripts/source-build.mjs')]) sources.set(path, hash(await readFile(path)))
  const manifest = JSON.parse(await readFile(join(repo, 'packages/core/package.json'), 'utf8'))
  const alias = Object.fromEntries(Object.entries(manifest.exports).map(([name, value]) => [
    '@agentmux/core' + (name === '.' ? '' : name.slice(1)),
    join(repo, 'packages/core', value.types.replace('./dist/', 'src/').replace('.d.ts', '.ts'))
  ]))
  const nativeManifestPath = join(repo, 'packages/native-desktop/package.json')
  sources.set(nativeManifestPath, hash(await readFile(nativeManifestPath)))
  for (const [name, value] of Object.entries(JSON.parse(await readFile(nativeManifestPath, 'utf8')).exports)) {
    alias['@agentmux/native-desktop' + (name === '.' ? '' : name.slice(1))] = join(repo, 'packages/native-desktop', value.types.replace('./dist/', 'src/').replace('.d.ts', '.ts'))
  }
  const options = { absWorkingDir: repo, platform: 'node', format: 'esm', target: 'node24', bundle: true, external: ['electron', 'node:*'],
    banner: { js: "import{createRequire as __fixtureRequire}from'node:module';const require=__fixtureRequire(import.meta.url);" },
    plugins: [loadedSource] }
  await mkdir(join(out, 'core/dist'), { recursive: true })
  await writeFile(join(out, 'core/package.json'), JSON.stringify(manifest))
  const workerSource = join(repo, 'packages/core/src/control-endpoint-listener-worker.ts')
  await build({ platform: 'node', format: 'esm', target: 'node24', bundle: true, entryPoints: [workerSource], outfile: join(out, 'core/dist/control-endpoint-listener-worker.js') })
  sources.set(workerSource, hash(await readFile(workerSource)))
  sources.set(join(repo, 'packages/core/package.json'), hash(await readFile(join(repo, 'packages/core/package.json'))))
  receipt.runtimeAssets = { workerSourceSha256: hash(await readFile(workerSource)), workerSha256: hash(await readFile(join(out, 'core/dist/control-endpoint-listener-worker.js'))), boundary: 'Only the unchanged publication module package-resource URL is bound to the private package copy. The original worker and publication protocol execute; no shared dist is written.' }
  await build({ ...options, alias, entryPoints: [join(repo, 'apps/desktop/scripts/fixtures/browser-profile-extensions/main.ts')], outfile: join(out, 'main.mjs') })
  await build({ ...options, entryPoints: [join(repo, 'packages/core/src/agentmux.ts')], outfile: join(out, 'cli.mjs') })
  await build({ ...options, alias, format: 'cjs', banner: {}, entryPoints: [join(repo, 'apps/desktop/src/preload/index.ts')], outfile: join(out, 'preload.cjs') })
  const { build: buildRenderer } = await import('vite')
  await buildRenderer({ configFile: false, root: join(repo, 'apps/desktop/scripts/fixtures/browser-profile-extensions'), base: './', logLevel: 'error', worker: { format: 'es' }, resolve: { alias: [{ find: /^@agentmux\/browser(?=\/|$)/, replacement: join(repo, 'packages/browser/src') }, ...Object.entries(alias).map(([name, replacement]) => ({ find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement }))] }, define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, plugins: [{ name: 'extension-real-renderer-source', enforce: 'pre', async transform(code, id) {
    const path = id.split('?')[0]
    if (!path.startsWith(repo + '/') || path.includes('/node_modules/') || !/\.(?:[cm]?[jt]sx?|css)$/.test(path)) return
    sources.set(path, hash(await readFile(path)))
    const changed = mutateResultBridge(code, path)
    return changed === code ? undefined : { code: changed, map: null }
  } }], build: { outDir: join(out, 'renderer'), emptyOutDir: true, minify: false, sourcemap: false, target: 'esnext', chunkSizeWarningLimit: 20000 } })
  receipt.bundles = Object.fromEntries(await Promise.all(['main.mjs', 'cli.mjs', 'preload.cjs'].map(async name => [name, hash(await readFile(join(out, name)))])))
  await symlink(join(repo, 'apps/desktop/node_modules'), join(out, 'node_modules'))
  await writeFile(join(out, 'bootstrap.cjs'), `console.error('extensions-proof: bootstrap');const {app}=require('electron'),fs=require('node:fs'),path=require('node:path');for(const key of ['home','appData','userData','sessionData']){const value=path.join(process.env.EXTENSIONS_HOME,key==='userData'?'userdata':key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}app.whenReady().then(()=>{console.error('extensions-proof: electron ready');return import('./main.mjs')}).catch(error=>{console.error(error);fs.writeFileSync(path.join(process.env.EXTENSIONS_OUT,process.env.EXTENSIONS_PHASE+'.json'),JSON.stringify({passed:false,failure:{message:error.message,stack:error.stack}}));app.exit(1)});`)
  for (const required of ['apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/browser-profile-extensions.ts',
    'apps/desktop/src/main/browser-profile-control.ts', 'packages/core/src/browser-profile-control.ts', 'packages/core/src/agentmux.ts',
    'packages/core/src/agentmux-cli-commands.ts']) assert.ok(sources.has(join(repo, required)), `Actual source consumed: ${required}`)
  server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(await readFile(join(repo, 'apps/desktop/scripts/fixtures/browser-profile-extensions/page.html')))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  let onlineBase, fixtureCA
  if (online) {
    onlineFixture = await startExtensionHttpsFixture(home, out); fixtureCA = onlineFixture.caPath; onlineBase = onlineFixture.origin
    receipt.tlsFixture = { certificateSha256: onlineFixture.certificateSha256, scope: 'Only private child processes trust this generated local HTTPS fixture CA.' }
    const source = join(repo, 'apps/desktop/scripts/fixtures/browser-profile-extensions/https-source.mjs'); sources.set(source, hash(await readFile(source)))
  }
  const reports = []
  for (const phase of (uiOnly ? ['first'] : ['first', 'second'])) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { EXTENSIONS_HOME: home, EXTENSIONS_OUT: out, EXTENSIONS_BASE: base, EXTENSIONS_PHASE: phase, EXTENSIONS_NODE: process.execPath, ...(online ? { EXTENSIONS_CASE: uiOnly ? 'online-ui' : onlineUpdate ? 'online-update' : 'online-install', EXTENSIONS_ONLINE_BASE: onlineBase, NODE_EXTRA_CA_CERTS: fixtureCA } : {}) })
    const lines = []
    const processReport = await runProbeProcess(electron, [join(out, 'bootstrap.cjs')], {
      temporaryRoot: home, cwd: home, env, timeoutMs: 240_000,
      onLine: line => { lines.push(line); console.log(line) }
    })
    await writeFile(join(out, phase + '.log'), lines.join('\n'))
    await stopProbeProcesses(processReport.originalPid, home)
    const remaining = await listProbeProcesses(processReport.originalPid, home)
    receipt.processes.push({ phase, ...processReport, remaining })
    const nativeBytes = await readFile(join(out, phase + '.json'), 'utf8')
    assert.ok(nativeBytes.trim(), 'The private App did not finish its observation receipt; read original process timeout/exit facts')
    const actual = JSON.parse(nativeBytes); reports.push(actual)
    assert.equal(processReport.exitCode, 0, JSON.stringify(actual.failure))
    assert.equal(processReport.timedOut, false); assert.deepEqual(remaining, []); assert.equal(actual.passed, true)
    assert.ok(Number.isSafeInteger(actual.pid) && actual.pid > 0)
    assert.ok(actual.cases.length >= (uiOnly ? 2 : phase === 'first' ? 4 : 2), 'Every private process consumes nonempty business cases')
    assert.ok(actual.cli.length > 0, 'Both processes consume actual public CLI'); if (phase === 'first' && !uiOnly) assert.ok(actual.approvals.some(event => event.confirmed === false) && actual.approvals.some(event => event.kind === (online ? 'install' : 'update') && event.confirmed), 'The original host confirmation port receives exact source/permission review')
  }
  if (!uiOnly) {
  assert.notEqual(reports[0].pid, reports[1].pid, 'Actual second process has a distinct PID')
  assert.equal(reports[1].cases[0].originalProfileId, reports[0].retained.profileId, 'Second process reads the first original Profile'); assert.equal(reports[1].cases[0].extensionId, reports[0].retained.extensionId)
  }
  if (online) { assert.ok(onlineFixture.requests.length >= (uiOnly ? 1 : 5), 'Real HTTPS requests consumed'); assert.ok(onlineFixture.requests.every(request => !request.cookiePresent && !request.authorizationPresent), 'Website cookie and authorization headers never enter acquisition'); receipt.onlineRequests = onlineFixture.requests; receipt.case = uiOnly ? 'online-ui' : onlineUpdate ? 'online-update' : 'online-install' }
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  if (onlineFixture) await onlineFixture.close()
  if (server) await new Promise(done => server.close(done))
  receipt.sources = Object.fromEntries([...sources].map(([path, sha256]) => [relative(repo, path), sha256]))
  const drift = []
  for (const [path, expected] of sources) if (hash(await readFile(path)) !== expected) drift.push(relative(repo, path))
  receipt.sourceDrift = drift
  if (drift.length) { receipt.passed = false; receipt.failure ??= { message: 'Source changed during this candidate-bound probe' } }
  for (const file of ['profiles.json', 'retained.json']) {
    try { await writeFile(join(out, 'durable-' + file), await readFile(join(home, file))) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await rm(home, { recursive: true, force: true }); receipt.cleanup.privateHomeRemoved = true
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') }))
  if (!receipt.passed) process.exitCode = 1
}
