import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink, stat } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = browserSourceBuild(createRequire(require.resolve('vite/package.json'))('esbuild'))
const electron = require('electron'), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const scopeMode = process.argv.includes('--scope')
const releaseProof = process.argv.includes('--screen-and-release-proof')
const fingerprintProof = process.argv.includes('--fingerprint')
const hardwareProof=process.argv.includes('--hardware-baseline-proof')
const bindingProof=process.argv.includes('--binding-proof')
assert.ok(!releaseProof || scopeMode, 'The screen/release proof uses --scope')
assert.ok(!hardwareProof || scopeMode, 'The isolated hardware baseline proof uses --scope')
assert.ok(!bindingProof || scopeMode, 'The native binding proof uses --scope')
assert.ok(!process.argv.includes('--cold-target') || scopeMode, 'The bounded cold-target scene requires --scope')
assert.ok(!process.argv.includes('--cold-target') || !process.argv.includes('--mutations'), 'Native mutations use the full scope scene')
const outRoot = join(root, scopeMode ? '.local/browser-profile-scope/native' : '.tmp/browser-profile-environment'); await mkdir(outRoot, { recursive: true })
const out = await mkdtemp(join(outRoot, 'attempt-')), home = await mkdtemp('/tmp/amux-env-')
// Compile the selected Main consumer from this worktree. These packages' source exports are used
// instead of asking for an unrelated complete Host/Renderer build or borrowing another tree's dist.
const alias = {}
for (const folder of ['apps/host', 'packages/client-ui']) {
  const directory = join(root, folder), pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(pkg.exports)) {
    const target = typeof value === 'string' ? value : value.import
    if (typeof target !== 'string' || key.includes('*')) continue
    let source = resolve(directory, target.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    try { await stat(source) } catch { source = source.replace(/\.ts$/u, '.tsx'); try { await stat(source) } catch { continue } }
    alias[pkg.name + (key === '.' ? '' : key.slice(1))] = source
  }
}
const receipt = { schema: 'agentmux.browser-profile-environment.native.v1', passed: false, sources: {}, runs: [], out,
  dependency: { electron: await realpath(electron), sha256: sha(await readFile(electron)), version: require('electron/package.json').version },
  caller: { executable: await realpath(process.execPath), node: process.versions.node, sha256: sha(await readFile(process.execPath)) },
  boundary: 'Private Electron application, production Profile store/manager/session/BVM and compiled public CLI. No installed app, user Profile, external website, getter injection or full fingerprint claim.' }
for(const file of ['packages/core/src/browser-profile-control.ts','packages/core/src/agentmux-cli-commands.ts','packages/core/dist/browser-profile-control.js','packages/core/dist/agentmux.js'])receipt.sources[file]=sha(await readFile(join(root,file)))
const pageServer = createServer((request, response) => {
  if(scopeMode)console.log('Native scope HTTP request: '+request.url)
  if(scopeMode && request.url === '/worker.js'){response.setHeader('Content-Type','application/javascript');response.end('postMessage({locale:Intl.DateTimeFormat().resolvedOptions().locale,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,hardware:navigator.hardwareConcurrency,userAgent:navigator.userAgent})');return}
  if(scopeMode && (request.url === '/same'||request.url === '/cross')){response.setHeader('Content-Type','text/html');response.end('<script>parent.postMessage({scopeKind:'+JSON.stringify(request.url.slice(1))+',locale:Intl.DateTimeFormat().resolvedOptions().locale,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone,hardware:navigator.hardwareConcurrency},"*")</script>');return}
  if (request.url === '/headers') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(request.headers)); return }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Private environment proof</title><input value="Original draft"><script>window.firstEnvironment={locale:Intl.DateTimeFormat().resolvedOptions().locale,timeZone:Intl.DateTimeFormat().resolvedOptions().timeZone};window.originalHeaders=' + JSON.stringify(request.headers) + '</script>' + (scopeMode ? '<script>window.childEnvironments={};window.addEventListener("message",e=>{if(e.data&&e.data.scopeKind)window.childEnvironments[e.data.scopeKind]=e.data});new Worker("/worker.js").onmessage=e=>window.workerEnvironment=e.data</script><iframe src="/same"></iframe><iframe src="http://localhost:' + pageServer.address().port + '/cross"></iframe>' : ''))
})
await new Promise(done => pageServer.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${pageServer.address().port}/`
try {
  for (const name of fingerprintProof ? (process.argv.includes('--mutations') ? ['candidate', 'fingerprint-mutant', 'restored'] : ['candidate']) : scopeMode ? bindingProof&&process.argv.includes('--mutations') ? ['scope-binding-mutant','scope-switch-screen-mutant','restored'] : hardwareProof ? ['scope-hardware-baseline-mutant','restored'] : releaseProof ? ['scope-screen-mutant','restored'] : process.argv.includes('--mutations') ? ['candidate','scope-locale-mutant','scope-screen-mutant','restored'] : ['candidate'] : ['candidate','mutation','restored']) {
    const compiled = join(out, name); await mkdir(compiled)
    await symlink(join(root, 'apps/desktop/node_modules'), join(compiled, 'node_modules'))
    let mutation
    await build({ entryPoints: [join(root, 'apps/desktop/scripts/fixtures/browser-profile-environment/main.ts')],
      outfile: join(compiled, 'main.mjs'), platform: 'node', format: 'esm', target: 'node24', bundle: true, alias, external: ['electron', '@agentmux/core', '@agentmux/core/*'],
      banner: { js: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);" },
      plugins: [{ name: 'owning-source-proof', setup(bundler) {
        bundler.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async args => {
          if (!args.path.startsWith(root + '/') || args.path.includes('/node_modules/')) return
          let code = await readFile(args.path, 'utf8'); receipt.sources[relative(root, args.path)] = sha(code)
          if (name === 'fingerprint-mutant' && args.path === join(root, 'apps/desktop/src/main/browser-profile-fingerprint.ts')) {
            const anchor = "if (enabled.has('canvas')) {"
            assert.equal(code.split(anchor).length, 2, 'Exact original canvas override')
            const before = sha(code)
            code = code.replace(anchor, 'if (false) {')
            mutation = { file: relative(root, args.path), before, after: sha(code) }
          }
          if(scopeMode && name.startsWith('scope-') && name!=='scope-switch-screen-mutant' && args.path===join(root,'apps/desktop/src/main/browser-profile-page-environment.ts')){
            const anchor=name==='scope-binding-mutant'?'page.port.isCurrent()':name==='scope-hardware-baseline-mutant'?'contextId: realm.executionContextId,':name==='scope-locale-mutant'?"await one(['locale'], 'Emulation.setLocaleOverride', { locale: settings?.locale ?? '' })":"page.port.applyScreen()"
            assert.equal(code.split(anchor).length-1,1,'Exact original native environment mutation')
            const before=sha(code);code=code.replace(anchor,name==='scope-binding-mutant'?'true':name==='scope-hardware-baseline-mutant'?'':name==='scope-locale-mutant'?"void settings?.locale":"void page.port")
            mutation={file:relative(root,args.path),before,after:sha(code)}
          }
          if(scopeMode&&name==='scope-switch-screen-mutant'&&args.path===join(root,'apps/desktop/src/main/browser-view-manager.ts')){
            const anchor='this.applyViewport(entry, candidate, entry.viewport, this.profiles.environmentSettings?.(profileId)?.screen ?? null)'
            assert.equal(code.split(anchor).length-1,1,'Exact original Profile switch screen binding')
            const before=sha(code);code=code.replace(anchor,'this.applyViewport(entry, candidate)');mutation={file:relative(root,args.path),before,after:sha(code)}
          }
          if (name === 'mutation' && args.path === join(root, 'apps/desktop/src/main/browser-view-manager.ts')) {
            const anchor = "if (this.profiles.environmentApplication?.(storage.profileId)?.status !== 'unknown') return undefined"
            assert.equal(code.split(anchor).length - 1, 1, 'Exact production environment warning mutation')
            const before = sha(code); code = code.replace(anchor, 'if (true) return undefined')
            mutation = { file: relative(root, args.path), before, after: sha(code) }
          }
          return { contents: code, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' }
        })
      } }] })
    const isMutation = name === 'mutation' || name.startsWith('scope-') || name === 'fingerprint-mutant'
    const isolatedHome = isMutation ? await mkdtemp('/tmp/amux-env-mutation-') : home
    try {
      for (const phase of name === 'candidate' && !process.argv.includes('--cold-target') && !bindingProof ? ['seed', 'restart'] : ['seed']) {
        // Restored is a fresh candidate run, while candidate restart consumes the first process's
        // exact Profile file and descriptor. No new IDs or saved configuration are planted on restart.
        const runHome = name === 'restored' ? await mkdtemp('/tmp/amux-env-restored-') : isolatedHome
        const resultFile = join(compiled, phase + '.json'), bootstrap = join(compiled, phase + '.cjs')
        await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const home=${JSON.stringify(runHome)};for(const key of ['appData','userData','sessionData']){const p=path.join(home,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(join(compiled, 'main.mjs')).href)})).catch(e=>{console.error(e);app.exit(1)});`)
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
        Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: runHome, AGENTMUX_STATE_DIRECTORY: join(runHome, 'state'),
          AGENTMUX_AGENT_SESSION_STORE: join(runHome, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(runHome, 'messages.ndjson'),
          AGENTMUX_ENV_PROOF_HOME: runHome, AGENTMUX_ENV_PROOF_ROOT: root, AGENTMUX_ENV_PROOF_OUTPUT: resultFile,
          AGENTMUX_ENV_PROOF_PHASE: phase, AGENTMUX_ENV_PROOF_URL: url, AGENTMUX_ENV_PROOF_SCOPE: scopeMode?'1':'0', AGENTMUX_ENV_PROOF_NODE: process.execPath,
          AGENTMUX_ENV_PROOF_FINGERPRINT: fingerprintProof ? '1' : '0',
          AGENTMUX_ENV_PROOF_COLD_TARGET: process.argv.includes('--cold-target')?'1':'0', AGENTMUX_ENV_PROOF_RELEASE: releaseProof?'1':'0', AGENTMUX_ENV_PROOF_HARDWARE_BASELINE: hardwareProof?'1':'0', AGENTMUX_ENV_PROOF_BINDING:bindingProof?'1':'0' })
        // Seed now also observes a native setter failure, Profile-scoped delivery and recovery.
        // Give that added work its own observation allowance; restart's original proof is unchanged.
        const timeoutMs = scopeMode ? 180_000 : phase === 'seed' ? 150_000 : 90_000
        const logs = [], processResult = await runProbeProcess(electron, [bootstrap], { cwd: runHome, env, timeoutMs,
          onLine: line => { logs.push(line); console.log(`[${name}/${phase}] ${line}`) } })
        await writeFile(join(compiled, phase + '.log'), logs.join('\n'))
        await stopProbeProcesses(processResult.originalPid, runHome)
        const remaining = await listProbeProcesses(processResult.originalPid, runHome)
        const row = { name, phase, home: runHome, bundleSha256: sha(await readFile(join(compiled,'main.mjs'))), process: processResult, remaining, actual: null, ...(mutation ? { mutation } : {}) }
        receipt.runs.push(row)
        await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
        const actual = JSON.parse(await readFile(resultFile, 'utf8').catch(() => { throw new Error('Native fixture result unavailable; see ' + join(compiled, phase + '.log')) }))
        row.actual = actual
        await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
        assert.equal(processResult.timedOut, false); assert.deepEqual(remaining, []); assert.deepEqual(actual.cleanup, [])
        assert.equal(actual.versions.electron, receipt.dependency.version, 'The loaded dependency matches this worktree lock')
        if (isMutation) {
          assert.ok(mutation && mutation.before !== mutation.after)
          assert.equal(processResult.exitCode, 1)
          assert.match(actual.failure?.message ?? '', fingerprintProof ? /Native canvas readback must change/ : scopeMode ? name==='scope-binding-mutant'?/A prepared candidate must not claim/:name==='scope-switch-screen-mutant'?/committed native view must keep/:name==='scope-hardware-baseline-mutant'?/Native hardware clear must restore/:name==='scope-locale-mutant'?/Native locale command/:/Original native screen application/ : /Public targets retain the exact affected Profile warning/)
        } else { assert.equal(processResult.exitCode, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true) }
        if (name === 'restored') await rm(runHome, { recursive: true, force: true })
      }
    } finally { if (isMutation) await rm(isolatedHome, { recursive: true, force: true }) }
  }
  for (const file of ['browser-profile-manager.ts', 'browser-profile-session.ts', 'browser-profile-environment.ts', 'browser-profile-page-environment.ts', 'browser-cdp-session.ts', 'browser-profile-store.ts', 'browser-view-manager.ts', 'browser-profile-control.ts']) {
    assert.ok(receipt.sources['apps/desktop/src/main/' + file], 'Actual source consumer: ' + file)
  }
  receipt.sourcesUnchanged=(await Promise.all(Object.entries(receipt.sources).map(async([file,original])=>sha(await readFile(join(root,file)))===original))).every(Boolean)
  assert.equal(receipt.sourcesUnchanged,true,'The native application and caller must retain the exact reviewed candidate inputs')
  receipt.passed = true
} finally {
  await new Promise(done => pageServer.close(done))
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (receipt.passed) await rm(home, { recursive: true, force: true })
  console.log(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') }))
}
