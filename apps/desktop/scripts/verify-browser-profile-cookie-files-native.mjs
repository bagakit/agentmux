import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

// Two private Electron processes consume the first process's exact Profile cookies,
// durable operation bindings and original Profile partition. The user's App, Agents and Runtime are untouched.
const repo = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(repo, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const electron = require('electron'), hash = value => createHash('sha256').update(value).digest('hex')
const outputRoot = join(repo, '.tmp/browser-profile-cookie-files-native'); await mkdir(outputRoot, { recursive: true })
const out = await mkdtemp(join(outputRoot, 'attempt-'))
const home = await mkdtemp('/tmp/amux-profile-cookie-files-'), sources = new Map()
const receipt = { schema: 'agentmux.browser-profile-cookie-files.native.v1', passed: false,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  boundary: 'Native confirmation dialog selection is an explicit private person-input fixture; production Main builds the dialog and checks response, not an Agent approval. Compiled public CLI, original control socket and actual Renderer API/production preload/ProfileEditorIPC, production Profile Manager/Store/Session and native BrowserViewManager WCV. The private file-dialog input fixture proves exact host paths, not a person clicking an OS dialog. Second process reads original durable Profile/Cookie safe operation metadata and native sign-in storage. Full Desktop Tab/Region/focus and healthy Agent Run restoration are outside this fixture.',
  electron: { version: require('electron/package.json').version, executableSha256: hash(await readFile(electron)) },
  sources: {}, processes: [], out, cleanup: {} }
let server
const mutateResultBridge = (code, path) => {
  if(process.env.COOKIE_FILES_CONFIRM_MUTATION==='1'&&path.endsWith('/main/browser-profile-cookie-files.ts')){
    const target='return await confirm(request,controller.signal)===true';assert.equal(code.split(target).length,2);receipt.productionMutation={target:'original-person-confirmation',originalSha256:hash(code)};return code.replace(target,'await confirm(request,controller.signal);return true')
  }
  if(process.env.COOKIE_FILES_RESULT_MUTATION==='1'&&path.endsWith('/shared/ipc-result.ts')){
    const target="'prepareProfileCookieImport', 'importProfileCookies', 'exportProfileCookies', 'inspectProfileCookieFiles', 'discardProfileCookieImport', 'revealProfileCookieFile',";assert.equal(code.split(target).length,2);receipt.productionMutation={target:'original-GUI-result-consumer',originalSha256:hash(code)};return code.replace(target,'')
  }
  return code
}
const loadedSource = { name: 'cookie-files-original-source', setup(builder) {
  builder.onResolve({ filter: /^[^./]/ }, async args => {
    if (args.pluginData?.resolvedExternal || args.path === 'electron' || args.path.startsWith('node:')) return
    const result = await builder.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { resolvedExternal: true } })
    if (result.errors.length) return { errors: result.errors }
    if (result.path.startsWith(repo + '/') && !result.path.includes('/node_modules/')) sources.set(result.path, hash(await readFile(result.path)))
    return { path: result.path, external: !result.path.startsWith(join(repo, 'packages/core/src') + '/') }
  })
  builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
    if (!args.path.startsWith(repo + '/') || args.path.includes('/node_modules/')) return
    const bytes = await readFile(args.path); sources.set(args.path, hash(bytes))
    // Keep each owning module's package-relative native/resource resolution.
    // Bundling must not redirect createRequire(import.meta.url) to this fixture.
    const code = mutateResultBridge(bytes.toString(), args.path).replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href))
      .replaceAll('import.meta.dirname', JSON.stringify(dirname(args.path))).replaceAll('import.meta.filename', JSON.stringify(args.path))
    return { contents: code, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' }
  })
} }
try {
  for(const path of ['apps/host/native/workspace-move.c','apps/desktop/resources/bin/agentmux-workspace-move'])sources.set(join(repo,path),hash(await readFile(join(repo,path))))
  for (const path of [join(repo, 'apps/desktop/scripts/fixtures/browser-profile-cookie-files/index.html'), import.meta.filename, join(repo, 'apps/desktop/scripts/fixtures/browser-profile-cookie-files/page.html')]) sources.set(path, hash(await readFile(path)))
  const manifest = JSON.parse(await readFile(join(repo, 'packages/core/package.json'), 'utf8'))
  const alias = Object.fromEntries(Object.entries(manifest.exports).map(([name, value]) => [
    '@agentmux/core' + (name === '.' ? '' : name.slice(1)),
    join(repo, 'packages/core', value.types.replace('./dist/', 'src/').replace('.d.ts', '.ts'))
  ]))
  const options = { platform: 'node', format: 'esm', target: 'node24', bundle: true, external: ['electron', 'node:*'],
    banner: { js: "import{createRequire as __fixtureRequire}from'node:module';const require=__fixtureRequire(import.meta.url);" },
    plugins: [loadedSource] }
  await build({ ...options, alias, entryPoints: [join(repo, 'apps/desktop/scripts/fixtures/browser-profile-cookie-files/main.ts')], outfile: join(out, 'main.mjs') })
  await build({ ...options, entryPoints: [join(repo, 'packages/core/src/agentmux.ts')], outfile: join(out, 'cli.mjs') })
  await build({ ...options, alias, format: 'cjs', banner: {}, entryPoints: [join(repo, 'apps/desktop/src/preload/index.ts')], outfile: join(out, 'preload.cjs') })
  const { build: buildRenderer } = await import('vite')
  await buildRenderer({ configFile: false, worker: { format: 'es' }, resolve: { alias: [{ find: /^@agentmux\/host\/(.+)$/, replacement: join(repo, 'apps/host/src/$1.ts') }] }, root: join(repo, 'apps/desktop/scripts/fixtures/browser-profile-cookie-files'), base: './', logLevel: 'error', define: { __AGENTMUX_WEB_PREVIEW__: 'false' }, plugins: [{ name: 'bookmark-real-renderer-source', enforce: 'pre', async transform(code, id) {
    const path = id.split('?')[0]
    if (!path.startsWith(repo + '/') || path.includes('/node_modules/') || !/\.(?:[cm]?[jt]sx?|css)$/.test(path)) return
    sources.set(path, hash(await readFile(path)))
    const changed = mutateResultBridge(code, path)
    return changed === code ? undefined : { code: changed, map: null }
  } }], build: { outDir: join(out, 'renderer'), emptyOutDir: true, minify: false, sourcemap: false, target: 'esnext', chunkSizeWarningLimit: 20000 } })
  receipt.bundles = Object.fromEntries(await Promise.all(['main.mjs', 'cli.mjs', 'preload.cjs'].map(async name => [name, hash(await readFile(join(out, name)))])))
  await symlink(join(repo, 'apps/desktop/node_modules'), join(out, 'node_modules'))
  await writeFile(join(out, 'bootstrap.cjs'), `console.error('cookie-files-proof: bootstrap');const {app}=require('electron'),fs=require('node:fs'),path=require('node:path');for(const key of ['home','appData','userData','sessionData']){const value=path.join(process.env.COOKIE_FILES_HOME,key==='userData'?'userdata':key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}app.whenReady().then(()=>{console.error('cookie-files-proof: electron ready');return import('./main.mjs')}).catch(error=>{console.error(error);fs.writeFileSync(path.join(process.env.COOKIE_FILES_OUT,process.env.COOKIE_FILES_PHASE+'.json'),JSON.stringify({passed:false,failure:{message:error.message,stack:error.stack}}));app.exit(1)});`)
  for (const required of ['apps/desktop/src/main/browser-profile-cookie-file-native.ts', 'apps/desktop/src/main/browser-profile-cookie-files.ts',
    'apps/desktop/src/main/browser-profile-control.ts', 'packages/core/src/browser-profile-control.ts', 'packages/core/src/agentmux.ts',
    'packages/core/src/agentmux-cli-commands.ts']) assert.ok(sources.has(join(repo, required)), `Actual source consumed: ${required}`)
  server = createServer(async (request, response) => {
    if(request.url==='/auth'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({authenticated:(request.headers.cookie??'').includes('signed-in-name=FIXTURE-COOKIE-SECRET-auth')}));return}
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(await readFile(join(repo, 'apps/desktop/scripts/fixtures/browser-profile-cookie-files/page.html')))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  const reports = []
  for (const phase of ['first', 'second']) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { COOKIE_FILES_HOME: home, COOKIE_FILES_OUT: out, COOKIE_FILES_BASE: base, COOKIE_FILES_PHASE: phase, COOKIE_FILES_NODE: process.execPath })
    const lines = []
    const processReport = await runProbeProcess(electron, [join(out, 'bootstrap.cjs')], {
      temporaryRoot: home, cwd: home, env, timeoutMs: 240_000,
      onLine: line => { lines.push(line); console.log(line) }
    })
    await writeFile(join(out, phase + '.log'), lines.join('\n'))
    await stopProbeProcesses(processReport.originalPid, home)
    const remaining = await listProbeProcesses(processReport.originalPid, home)
    const actual = JSON.parse(await readFile(join(out, phase + '.json'), 'utf8'))
    receipt.processes.push({ phase, ...processReport, remaining }); reports.push(actual)
    assert.equal(processReport.exitCode, 0, JSON.stringify(actual.failure))
    assert.equal(processReport.timedOut, false); assert.deepEqual(remaining, []); assert.equal(actual.passed, true)
    assert.ok(Number.isSafeInteger(actual.pid) && actual.pid > 0)
    assert.ok(actual.cases.length >= (phase === 'first' ? 5 : 2), 'Every private process consumes nonempty business cases')
    assert.ok(actual.cli.length > 0, 'Both processes consume actual public CLI')
  }
  assert.notEqual(reports[0].pid, reports[1].pid, 'Actual second process has a distinct PID')
  assert.equal(reports[1].cases[0].originalProfileId, reports[0].retained.profileId, 'Second process reads the first original Profile'); assert.equal(reports[1].cases[0].operationId, reports[0].retained.operationId)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
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
