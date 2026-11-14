import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

// Two private Electron processes consume the first process's original parallel TaskAssets,
// journal and Profile partition. The user's App, Agents and Runtime are untouched.
const orchestration = process.argv.includes('--orchestration')
const repo = resolve(import.meta.dirname, '../../..')
const require = createRequire(join(repo, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const electron = require('electron'), hash = value => createHash('sha256').update(value).digest('hex')
const outputRoot = join(repo, orchestration ? '.tmp/browser-task-orchestration-native' : '.tmp/browser-task-parallel-native'); await mkdir(outputRoot, { recursive: true })
const out = await mkdtemp(join(outputRoot, 'attempt-'))
const home = await mkdtemp('/tmp/amux-task-parallel-'), sources = new Map()
const receipt = { schema: orchestration ? 'agentmux.browser-task-orchestration.native.v1' : 'agentmux.browser-task-parallel.native.v1', passed: false, mode: process.argv.includes('--compile-only') ? 'compile-only' : 'native',
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(),
  boundary: orchestration ? 'Actual production component pointer input/API/full preload/shared Main parallel IPC, compiled public stop/continue/inspect CLI and original Manager/TaskAssets/native WCV. Original public follow Gap/sequence and reader cancellation; real different PID retains original Run/cursor/operation IDs/cost, stopped result, continuation receipt, queue and persistent Profile cookie/storage. Synthetic Agent association is not an authenticated Agent Session; full Desktop layout and healthy Agent Run restoration are outside this fixture.' : 'Compiled public parallel CLI, original control socket, production Main Manager/TaskAssets and four native WCVs across three explicit Profiles. Second process reads the original target/run records and partitions without replay. Full Desktop Tab/Region/focus and healthy Agent Run restoration are outside this fixture.',
  electron: { version: require('electron/package.json').version, executableSha256: hash(await readFile(electron)) },
  sources: {}, processes: [], out, cleanup: {} }
let server
const loadedSource = { name: 'parallel-original-source', setup(builder) {
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
    const code = bytes.toString().replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href))
      .replaceAll('import.meta.dirname', JSON.stringify(dirname(args.path))).replaceAll('import.meta.filename', JSON.stringify(args.path))
    return { contents: code, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' }
  })
} }
try {
  for (const path of [import.meta.filename, join(repo, 'apps/desktop/scripts/fixtures/browser-task-parallel/page.html')]) sources.set(path, hash(await readFile(path)))
  const manifest = JSON.parse(await readFile(join(repo, 'packages/core/package.json'), 'utf8'))
  const alias = Object.fromEntries(Object.entries(manifest.exports).map(([name, value]) => [
    '@agentmux/core' + (name === '.' ? '' : name.slice(1)),
    join(repo, 'packages/core', value.types.replace('./dist/', 'src/').replace('.d.ts', '.ts'))
  ]))
  const options = { platform: 'node', format: 'esm', target: 'node24', bundle: true, external: ['electron', 'node:*'],
    banner: { js: "import{createRequire as __fixtureRequire}from'node:module';const require=__fixtureRequire(import.meta.url);" },
    plugins: [loadedSource] }
  await build({ ...options, alias, entryPoints: [join(repo, 'apps/desktop/scripts/fixtures', orchestration ? 'browser-task-orchestration-native/main.ts' : 'browser-task-parallel/main.ts')], outfile: join(out, 'main.mjs') })
  await build({ ...options, entryPoints: [join(repo, 'packages/core/src/agentmux.ts')], outfile: join(out, 'cli.mjs') })
  if (orchestration) {
    await build({ ...options, alias, format: 'cjs', banner: {}, entryPoints: [join(repo, 'apps/desktop/src/preload/index.ts')], outfile: join(out, 'preload.cjs') })
    const { build: buildRenderer } = await import('vite')
    await buildRenderer({ configFile: false, root: join(repo, 'apps/desktop/scripts/fixtures/browser-task-orchestration-native'), base: './', logLevel: 'error',
      resolve: { alias: [{ find: /^@agentmux\/host\/(.+)$/, replacement: join(repo, 'apps/host/src/$1.ts') }] }, define: { __AGENTMUX_WEB_PREVIEW__: 'false' },
      plugins: [{ name: 'orchestration-original-renderer', enforce: 'pre', async transform(code, id) { const path = id.split('?')[0]; if (path.startsWith(repo + '/') && !path.includes('/node_modules/') && /\.(?:[cm]?[jt]sx?|css)$/.test(path)) sources.set(path, hash(await readFile(path))) } }],
      build: { outDir: join(out, 'renderer'), emptyOutDir: true, minify: false, sourcemap: false, target: 'esnext', chunkSizeWarningLimit: 20000 } })
  }
  receipt.bundles = Object.fromEntries(await Promise.all(['main.mjs', 'cli.mjs'].map(async name => [name, hash(await readFile(join(out, name)))])))
  await symlink(join(repo, 'apps/desktop/node_modules'), join(out, 'node_modules'))
  await writeFile(join(out, 'bootstrap.cjs'), `console.error('parallel-proof: bootstrap');const {app}=require('electron'),fs=require('node:fs'),path=require('node:path');for(const key of ['home','appData','userData','sessionData']){const value=path.join(process.env.TASK_PARALLEL_HOME,key==='userData'?'userdata':key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}app.whenReady().then(()=>{console.error('parallel-proof: electron ready');return import('./main.mjs')}).catch(error=>{console.error(error);fs.writeFileSync(path.join(process.env.TASK_PARALLEL_OUT,process.env.TASK_PARALLEL_PHASE+'.json'),JSON.stringify({passed:false,failure:{message:error.message,stack:error.stack}}));app.exit(1)});`)
  for (const required of ['apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/browser-task-assets.ts',
    'apps/desktop/src/main/browser-task-control.ts', 'apps/desktop/src/main/browser-task-parallel.ts', 'packages/core/src/browser-task-parallel.ts', 'packages/core/src/browser-task-control.ts', 'packages/core/src/agentmux.ts',
    'packages/core/src/agentmux-cli-commands.ts']) assert.ok(sources.has(join(repo, required)), `Actual source consumed: ${required}`)
  receipt.compiled = true
  if (receipt.mode === 'native') {
  server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(await readFile(join(repo, 'apps/desktop/scripts/fixtures/browser-task-parallel/page.html')))
  })
  await new Promise(done => server.listen(0, '127.0.0.1', done))
  const base = `http://127.0.0.1:${server.address().port}`
  const reports = []
  for (const phase of ['first', 'second']) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { TASK_PARALLEL_HOME: home, TASK_PARALLEL_OUT: out, TASK_PARALLEL_BASE: base, TASK_PARALLEL_PHASE: phase, TASK_PARALLEL_NODE: process.execPath })
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
    assert.ok(actual.cases.length >= (phase === 'first' ? 3 : 2), 'Every private process consumes nonempty business cases')
    assert.ok(actual.cli.some(call => call.command === 'parallel') && actual.cli.some(call => call.command === 'parallel-inspect'), 'Both processes consume actual compiled parallel CLI and paged inspections')
    if (!orchestration && phase === 'first') assert.ok(new Set(actual.dialogs.filter(event => event.method === 'Page.javascriptDialogOpening' && event.type === 'confirm').map(event => event.browserId)).size >= 3, 'Real native confirm protocols execute on three exact target pages')
    else if (!orchestration) assert.deepEqual(actual.dialogs, [], 'Second process never replays native confirmations')
  }
  assert.notEqual(reports[0].pid, reports[1].pid, 'Actual second process has a distinct PID')
  assert.deepEqual(reports[0].retained, reports[1].original, 'Second process reads the first process original retained data')
  receipt.passed = true
  }
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  if (server) await new Promise(done => server.close(done))
  receipt.sources = Object.fromEntries([...sources].map(([path, sha256]) => [relative(repo, path), sha256]))
  const drift = []
  for (const [path, expected] of sources) if (hash(await readFile(path)) !== expected) drift.push(relative(repo, path))
  receipt.sourceDrift = drift
  if (drift.length) { receipt.passed = false; receipt.failure ??= { message: 'Source changed during this candidate-bound probe' } }
  for (const file of ['assets.json', 'profiles.json', 'retained.json']) {
    try { await writeFile(join(out, 'durable-' + file), await readFile(join(home, file))) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await rm(home, { recursive: true, force: true }); receipt.cleanup.privateHomeRemoved = true
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, compiled: receipt.compiled ?? false, mode: receipt.mode, receipt: join(out, 'receipt.json') }))
  if (!receipt.passed && !(receipt.mode === 'compile-only' && receipt.compiled && !receipt.failure)) process.exitCode = 1
}
