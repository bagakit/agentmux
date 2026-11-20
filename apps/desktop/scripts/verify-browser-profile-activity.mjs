import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, stat, readdir, symlink, rm, realpath } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), require = createRequire(join(root, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const recoveryOnly = process.argv.includes('--recovery-only'), visualOnly = process.argv.includes('--visual-only')
if (process.argv.slice(2).some(value => !['--recovery-only', '--visual-only'].includes(value)) || recoveryOnly && visualOnly) throw new Error('Choose one proof mode: default full, --recovery-only, or --visual-only')
const proof = join(root, '.tmp/browser-profile-activity'); await mkdir(proof, { recursive: true })
const out = await mkdtemp(join(proof, 'attempt-')), fixture = join(root, 'apps/desktop/scripts/fixtures/browser-profile-activity')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.browser-profile-activity.native.v1', passed: false, out,
  mode: visualOnly ? 'visual-only' : recoveryOnly ? 'core-workface-crash-recovery' : 'full', notRunStages: visualOnly || recoveryOnly ? ['seed business cases and production mutations (separate receipts)'] : [], requestedStages: [], sources: {}, runs: [],
  dependency: { electron: await realpath(require('electron')), sha256: sha(await readFile(require('electron'))), version: require('electron/package.json').version },
  boundary: 'Private App; production preload/trusted IPC/Profile metadata owner/public CLI/Settings UI and native pages. No Native Run, Provider/hook connection, installed app, user Profile, HOME override or external website. Screenshots prove App Renderer geometry, not OS child-view composition. Production mutations are separate owner-test receipts, not claimed as native stages.' }
const aliases = [], mainModules = []
for (const directory of [...(await readdir(join(root, 'packages'))).map(name => join(root, 'packages', name)), join(root, 'apps/host')]) {
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
  for (const [key, value] of Object.entries(pkg.exports ?? {})) {
    const id = pkg.name + (key === '.' ? '' : key.slice(1)), wildcard = id.includes('*')
    const pattern = new RegExp('^' + id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&').replace('\\*', '(.+)') + '$')
    const browserTarget = typeof value === 'string' ? value : value.browser ?? value.import
    if (typeof browserTarget === 'string') {
      let source = resolve(directory, browserTarget.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
      if (!wildcard) { try { await stat(source) } catch { source = source.replace(/\.ts$/u, '.tsx'); try { await stat(source) } catch { source = undefined } } }
      if (source) aliases.push({ find: pattern, replacement: source.replace('*', '$1'), wildcard, id })
    }
    const mainTarget = typeof value === 'string' ? value : value.import
    if (typeof mainTarget !== 'string') continue
    const artifact = resolve(directory, mainTarget)
    let source = resolve(directory, mainTarget.replace(/^\.\/dist\/(?:src\/)?/u, './src/').replace(/\.js$/u, '.ts'))
    let external = !wildcard && await stat(artifact).then(value => value.isFile(), () => false)
    if (!external && !wildcard) { try { await stat(source) } catch { source = source.replace(/\.ts$/u, '.tsx'); try { await stat(source) } catch { continue } } }
    mainModules.push({ find: pattern, replacement: (external ? artifact : source).replace('*', '$1'), wildcard, id, external })
  }
}
for (const list of [aliases, mainModules]) list.sort((a, b) => Number(a.wildcard) - Number(b.wildcard) || b.id.length - a.id.length)
const server = createServer((request, response) => {
  if (request.headers['user-agent'] === 'ActivityCandidateFailure/1.0') { request.socket.destroy(); return }
  response.setHeader('Content-Type', 'text/html; charset=utf-8')
  response.end('<!doctype html><title>Private Profile activity</title><input id="draft" value="Original page draft">')
})
await new Promise(done => server.listen(0, '127.0.0.1', done)); const urls = { page: `http://127.0.0.1:${server.address().port}/page` }
function sourcePlugin() {
  return { name: 'exact-profile-activity-source', setup(bundler) {
    bundler.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      let code = await readFile(path, 'utf8'); receipt.sources[relative(root, path)] = sha(code)
      return { contents: code, loader: path.endsWith('.tsx') ? 'tsx' : path.endsWith('.ts') ? 'ts' : 'js' }
    })
  } }
}

try {
  const preload = join(out, 'preload.cjs')
  await build({ entryPoints: [join(root, 'apps/desktop/src/preload/index.ts')], outfile: preload, bundle: true, platform: 'browser', format: 'cjs', target: 'es2022',
    conditions: ['browser', 'production'], external: ['electron'], plugins: [{ name: 'source-preload', setup(bundler) {
      bundler.onResolve({ filter: /^@agentmux\// }, args => { for (const alias of aliases) if (alias.find.test(args.path)) return { path: args.path.replace(alias.find, alias.replacement) } })
    } }, sourcePlugin()] })
  const renderer = join(out, 'renderer')
  await build({ entryPoints: [join(fixture, 'renderer.tsx')], outdir: renderer, bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic',
    conditions: ['browser', 'production'], define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
    loader: Object.fromEntries(['.woff2', '.woff', '.ttf', '.svg', '.png', '.jpg', '.gif', '.avif'].map(value => [value, 'file'])),
    plugins: [{ name: 'actual-browser-pane', setup(bundler) {
      bundler.onResolve({ filter: /^@agentmux\// }, args => { for (const alias of aliases) if (alias.find.test(args.path)) return { path: args.path.replace(alias.find, alias.replacement) } })
      bundler.onResolve({ filter: /\?(?:worker|url)$/ }, async args => {
        const suffix = args.path.slice(args.path.lastIndexOf('?') + 1), resolved = await bundler.resolve(args.path.slice(0, args.path.lastIndexOf('?')), { resolveDir: args.resolveDir, kind: 'import-statement' })
        return resolved.errors.length ? { errors: resolved.errors } : { path: resolved.path, namespace: 'activity-' + suffix }
      })
      bundler.onLoad({ filter: /.*/, namespace: 'activity-url' }, async ({ path }) => ({ contents: await readFile(path), loader: 'file' }))
      bundler.onLoad({ filter: /.*/, namespace: 'activity-worker' }, async ({ path }) => {
        const name = sha(path).slice(0, 16) + '.js'; await build({ entryPoints: [path], outfile: join(renderer, 'workers', name), bundle: true, platform: 'browser', format: 'esm', target: 'es2022' })
        return { contents: `export default class extends Worker { constructor(options={}) { super(new URL('./workers/${name}',import.meta.url), {...options,type:'module'}) } }`, loader: 'js' }
      })
      bundler.onLoad({ filter: /\.css$/ }, async ({ path }) => { if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
        const contents = await readFile(path, 'utf8'); receipt.sources[relative(root, path)] = sha(contents); return { contents, loader: 'css', resolveDir: dirname(path) } })
    } }, sourcePlugin()] })
  await writeFile(join(renderer, 'index.html'), '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>')
  const home = await mkdtemp(join(process.env.AGENTMUX_ACTIVITY_TMPDIR ?? '/tmp', 'amux-profile-activity-'))
  const variants = [{ name: visualOnly ? 'visual' : recoveryOnly ? 'recovery' : 'candidate', phases: visualOnly ? ['visual'] : recoveryOnly ? ['recovery-seed', 'recovery-restart'] : ['seed', 'crash', 'restart'], home }]
  receipt.requestedStages = variants.flatMap(candidate => candidate.phases.map(phase => candidate.name + '/' + phase))
  assert.ok(receipt.requestedStages.length > 0)
  for (const candidate of variants) {
    const compiled = join(out, candidate.name); await mkdir(compiled)
    await symlink(join(root, 'apps/desktop/node_modules'), join(compiled, 'node_modules')); await symlink(renderer, join(compiled, 'renderer')); await symlink(preload, join(compiled, 'preload.cjs'))
    const main = join(compiled, 'main.mjs')
    await build({ entryPoints: [join(fixture, 'main.ts')], outfile: main, bundle: true, external: ['electron'], platform: 'node', format: 'esm', target: 'node24',
      banner: { js: "import{createRequire as __proofRequire}from'node:module';const require=__proofRequire(import.meta.url);" },
      plugins: [{ name: 'owning-workspace-modules', setup(bundler) { bundler.onResolve({ filter: /^@agentmux\// }, args => {
        for (const entry of mainModules) if (entry.find.test(args.path)) return { path: args.path.replace(entry.find, entry.replacement), external: entry.external }
      })
      // Source-bundled Host modules retain their own dependency resolution, rather than looking
      // for a transitive package in Desktop's node_modules beside this selected fixture output.
      bundler.onResolve({ filter: /^[^./]/ }, async args => {
        if (args.path.startsWith('@agentmux/') || isBuiltin(args.path) || args.pluginData?.absoluteExternal) return
        const selected = await bundler.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: { absoluteExternal: true } })
        return selected.errors.length ? { errors: selected.errors } : { path: selected.path, external: true }
      }) } }, sourcePlugin()] })
    for (const phase of candidate.phases) {
      const phaseOut = join(compiled, phase); await mkdir(phaseOut)
      const bootstrap = join(phaseOut, 'bootstrap.cjs')
      await writeFile(bootstrap, `const{app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(candidate.home)};for(const key of ['home','appData','userData','sessionData']){const value=path.join(root,key);fs.mkdirSync(value,{recursive:true});app.setPath(key,value)}app.commandLine.appendSwitch('no-proxy-server');app.whenReady().then(()=>{console.error('Profile activity bootstrap ready; importing exact Main');return import(${JSON.stringify(pathToFileURL(main).href)});}).catch(e=>{console.error(e);app.exit(1)});`)
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(AGENTMUX_|CTXMUX_)/u.test(key) && key !== 'ELECTRON_RUN_AS_NODE'))
      Object.assign(env, { AGENTMUX_RUNTIME_DIRECTORY: join(candidate.home, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(candidate.home, 'state'),
        AGENTMUX_ACTIVITY_HOME: candidate.home, AGENTMUX_ACTIVITY_OUT: phaseOut, AGENTMUX_ACTIVITY_ASSETS: compiled, AGENTMUX_ACTIVITY_URLS: JSON.stringify(urls),
        AGENTMUX_ACTIVITY_PHASE: phase, AGENTMUX_ACTIVITY_CAPTURE: phase === 'visual' || phase === 'seed' || phase === 'recovery-restart' ? '1' : '0',
        AGENTMUX_ACTIVITY_NODE: process.execPath, AGENTMUX_ACTIVITY_CLI: join(root, 'packages/core/bin/amux') })
      const logs = [], processResult = await runProbeProcess(require('electron'), [bootstrap], { cwd: candidate.home, env, timeoutMs: 180000,
        onLine: line => { logs.push(line); console.log(`[${candidate.name}/${phase}] ${line}`) } })
      await writeFile(join(phaseOut, 'process.log'), logs.join('\n')); await stopProbeProcesses(processResult.originalPid, candidate.home)
      const remaining = await listProbeProcesses(processResult.originalPid, candidate.home)
      const row = { name: candidate.name, phase, home: candidate.home, process: processResult, remaining, actual: null }
      receipt.runs.push(row); await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
      const actual = JSON.parse(await readFile(join(phaseOut, 'native.json'), 'utf8')); row.actual = actual
      assert.equal(processResult.timedOut, false); assert.deepEqual(remaining, []); assert.deepEqual(actual.cleanup, []); assert.equal(actual.runtimeConnections, 0)
      if (phase === 'crash' || phase === 'recovery-seed') { assert.equal(processResult.exitSignal, 'SIGKILL'); assert.equal(actual.crashPrepared, true); assert.equal(actual.cleanupComplete, false) }
      else { assert.equal(actual.cleanupComplete, true); assert.equal(processResult.exitCode, 0, JSON.stringify(actual.failure)); assert.equal(actual.passed, true) }

    }
    await rm(candidate.home, { recursive: true, force: true })
  }
  for (const file of ['apps/desktop/src/main/ipc.ts', 'apps/desktop/src/main/browser-profile-store.ts', 'apps/desktop/src/main/browser-profile-manager.ts',
    'apps/desktop/src/main/browser-profile-control.ts', 'apps/desktop/src/renderer/src/components/settings/BrowserProfilesSettingsPane.tsx',
    'apps/desktop/src/shared/ipc-result.ts', 'apps/desktop/src/preload/index.ts',
    'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/browser-profile-observation.ts', 'apps/desktop/src/renderer/src/components/settings/BrowserProfileNetwork.tsx',
    'apps/desktop/src/renderer/src/lib/desktop-spatial-state.ts', 'apps/desktop/src/renderer/src/lib/workbench-persistence.ts']) assert.ok(receipt.sources[file], 'Actual source consumer: ' + file)
  assert.deepEqual(receipt.runs.map(row => row.name + '/' + row.phase), receipt.requestedStages, 'Every requested native stage actually ran')
  receipt.passed = true
} finally {
  server.closeAllConnections(); await new Promise(done => server.close(done))
  await writeFile(join(out, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ passed: receipt.passed, receipt: join(out, 'receipt.json') }))
}
