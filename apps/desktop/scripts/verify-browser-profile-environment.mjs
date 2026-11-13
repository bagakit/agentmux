import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm, symlink, stat } from 'node:fs/promises'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const electron = require('electron'), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const outRoot = join(root, '.tmp/browser-profile-environment'); await mkdir(outRoot, { recursive: true })
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
  boundary: 'Private Electron application, production Profile store/manager/session/BVM and compiled public CLI. No installed app, user Profile, external website, getter injection or full fingerprint claim.' }
const pageServer = createServer((request, response) => {
  if (request.url === '/headers') { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(request.headers)); return }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end('<!doctype html><title>Private environment proof</title><input value="Original draft"><script>window.originalHeaders=' + JSON.stringify(request.headers) + '</script>')
})
await new Promise(done => pageServer.listen(0, '127.0.0.1', done))
const url = `http://127.0.0.1:${pageServer.address().port}/`
try {
  for (const name of ['candidate', 'mutation', 'restored']) {
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
          if (name === 'mutation' && args.path === join(root, 'apps/desktop/src/main/browser-view-manager.ts')) {
            const anchor = "if (this.profiles.environmentApplication?.(storage.profileId)?.status !== 'unknown') return undefined"
            assert.equal(code.split(anchor).length - 1, 1, 'Exact production environment warning mutation')
            const before = sha(code); code = code.replace(anchor, 'if (true) return undefined')
            mutation = { file: relative(root, args.path), before, after: sha(code) }
          }
          return { contents: code, loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js' }
        })
      } }] })
    const isolatedHome = name === 'mutation' ? await mkdtemp('/tmp/amux-env-mutation-') : home
    try {
      for (const phase of name === 'candidate' ? ['seed', 'restart'] : ['seed']) {
        // Restored is a fresh candidate run, while candidate restart consumes the first process's
        // exact Profile file and descriptor. No new IDs or saved configuration are planted on restart.
        const runHome = name === 'restored' ? await mkdtemp('/tmp/amux-env-restored-') : isolatedHome
        const resultFile = join(compiled, phase + '.json'), bootstrap = join(compiled, phase + '.cjs')
        await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const home=${JSON.stringify(runHome)};for(const key of ['home','appData','userData','sessionData']){const p=path.join(home,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)}app.whenReady().then(()=>import(${JSON.stringify(pathToFileURL(join(compiled, 'main.mjs')).href)})).catch(e=>{console.error(e);app.exit(1)});`)
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
        Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: runHome, AGENTMUX_STATE_DIRECTORY: join(runHome, 'state'),
          AGENTMUX_AGENT_SESSION_STORE: join(runHome, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(runHome, 'messages.ndjson'),
          AGENTMUX_ENV_PROOF_HOME: runHome, AGENTMUX_ENV_PROOF_ROOT: root, AGENTMUX_ENV_PROOF_OUTPUT: resultFile,
          AGENTMUX_ENV_PROOF_PHASE: phase, AGENTMUX_ENV_PROOF_URL: url })
        // Seed now also observes a native setter failure, Profile-scoped delivery and recovery.
        // Give that added work its own observation allowance; restart's original proof is unchanged.
        const timeoutMs = phase === 'seed' ? 150_000 : 90_000
        const logs = [], processResult = await runProbeProcess(electron, [bootstrap], { cwd: runHome, env, timeoutMs,
          onLine: line => { logs.push(line); console.log(`[${name}/${phase}] ${line}`) } })
        await writeFile(join(compiled, phase + '.log'), logs.join('\n'))
        await stopProbeProcesses(processResult.originalPid, runHome)
        const remaining = await listProbeProcesses(processResult.originalPid, runHome)
        const row = { name, phase, home: runHome, process: processResult, remaining, actual: null, ...(mutation ? { mutation } : {}) }
        receipt.runs.push(row)
        await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
        const actual = JSON.parse(await readFile(resultFile, 'utf8').catch(() => { throw new Error('Native fixture result unavailable; see ' + join(compiled, phase + '.log')) }))
        row.actual = actual
        await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
        assert.equal(processResult.timedOut, false); assert.deepEqual(remaining, []); assert.deepEqual(actual.cleanup, [])
        assert.equal(actual.versions.electron, receipt.dependency.version, 'The loaded dependency matches this worktree lock')
        if (name === 'mutation') {
          assert.ok(mutation && mutation.before !== mutation.after)
          assert.equal(processResult.exitCode, 1)
          assert.match(actual.failure?.message ?? '', /Public targets retain the exact affected Profile warning/)
        } else { assert.equal(processResult.exitCode, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true) }
        if (name === 'restored') await rm(runHome, { recursive: true, force: true })
      }
    } finally { if (name === 'mutation') await rm(isolatedHome, { recursive: true, force: true }) }
  }
  for (const file of ['browser-profile-manager.ts', 'browser-profile-session.ts', 'browser-profile-environment.ts', 'browser-profile-store.ts', 'browser-view-manager.ts', 'browser-profile-control.ts']) {
    assert.ok(receipt.sources['apps/desktop/src/main/' + file], 'Actual source consumer: ' + file)
  }
  receipt.passed = true
} finally {
  await new Promise(done => pageServer.close(done))
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (receipt.passed) await rm(home, { recursive: true, force: true })
  console.log(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') }))
}
