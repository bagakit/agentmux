import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
assert.ok(args.every(arg => arg === '--mutations'), 'Unsupported Viewport proof option')
const require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const fixture = resolve('apps/desktop/scripts/fixtures/browser-viewport')
const out = resolve('.local/browser-viewport/proof'), work = await mkdtemp(join(tmpdir(), 'agentmux-viewport-'))
await mkdir(out, { recursive: true }); await rm(join(out, 'receipt.json'), { force: true })
const managerPath = resolve('apps/desktop/src/main/browser-view-manager.ts'), panePath = resolve('apps/desktop/src/renderer/src/components/BrowserPane.tsx')
const originalManager = await readFile(managerPath, 'utf8'), originalPane = await readFile(panePath, 'utf8')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const inputs = [
  'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/native-overlay-surfaces.ts',
  'apps/desktop/src/main/browser-page-dispatch.ts', 'apps/desktop/src/main/browser-script-runner.ts',
  'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src/components/HoverDropdownMenu.tsx',
  'apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx', 'apps/desktop/src/renderer/src/lib/api.ts',
  'apps/desktop/src/renderer/src/hooks/useNativeOverlayChrome.ts', 'apps/desktop/src/renderer/src/lib/native-overlay-regions.ts',
  'apps/desktop/src/renderer/src/styles/browser.css', 'apps/desktop/src/renderer/src/styles/base.css',
  'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/preload/index.ts',
  'apps/desktop/test/browser-view-manager.test.ts', 'apps/desktop/scripts/verify-browser-viewport.mjs',
  ...['main.ts', 'renderer.tsx', 'store.ts', 'preload.ts', 'fixture.css'].map(name => 'apps/desktop/scripts/fixtures/browser-viewport/' + name),
  ...['public-rpc-service.ts', 'public-rpc-client.ts', 'public-rpc-server.ts', 'control-codec.ts', 'browser-page-capability.ts'].map(name => 'packages/core/src/' + name),
  ...['public-rpc-service.js', 'public-rpc-client.js', 'public-rpc-server.js', 'control-codec.js', 'agentmux.js', 'agentmux-cli-commands.js', 'spatial-state.js', 'spatial-graph.js'].map(name => 'packages/core/dist/' + name)
]
const evidence = { sourceInputs: Object.fromEntries(await Promise.all(inputs.map(async path => [path, sha(await readFile(path))]))), cases: [], passed: false }
const base = { bundle: true, logLevel: 'silent', absWorkingDir: process.cwd(), jsx: 'automatic',
  alias: { react: dirname(require.resolve('react/package.json')), 'react-dom': dirname(require.resolve('react-dom/package.json')) }, nodePaths: [resolve('apps/desktop/node_modules')] }
function replaceUnique(source, target, replacement) {
  assert.equal(source.split(target).length - 1, 1, 'Actual production mutation anchor must be unique and nonempty')
  return source.replace(target, replacement)
}
function mutatedManager(kind) {
  if (kind === 'omit-native-apply') return replaceUnique(originalManager, '    this.applyViewport(entry, entry.view, viewport)\n    entry.viewport = viewport', '    void viewport\n    entry.viewport = viewport')
  if (kind === 'omit-fit') return replaceUnique(originalManager, '      viewSize,\n      scale\n', '      viewSize,\n      scale: 1\n')
  if (kind === 'commit-before-native-apply') return replaceUnique(originalManager, '    this.applyViewport(entry, entry.view, viewport)\n    entry.viewport = viewport', '    entry.viewport = viewport\n    this.applyViewport(entry, entry.view, viewport)')
  return originalManager
}
async function childProcess(executable, argv, env, timeoutMs, input) {
  return await new Promise((done, reject) => {
    const child = spawn(executable, argv, { env, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = '', expired = false, escalation
    child.stdout.on('data', bytes => { stdout += bytes }); child.stderr.on('data', bytes => { stderr += bytes })
    const timeout = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1500) }, timeoutMs)
    child.once('error', error => { clearTimeout(timeout); clearTimeout(escalation); reject(error) })
    child.once('exit', (code, signal) => { clearTimeout(timeout); clearTimeout(escalation)
      expired ? reject(new Error('Exact Viewport proof child timed out and exited: ' + stdout + stderr)) : done({ code, signal, pid: child.pid, stdout, stderr })
    }); child.stdin.end(input)
  })
}
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:AGENTMUX_|CTXMUX_)/.test(key)))
async function native(label, mutation) {
  const compiled = join(work, label); await mkdir(compiled); await symlink(resolve('apps/desktop/node_modules'), join(compiled, 'node_modules'))
  const store = await readFile(join(fixture, 'store.ts'), 'utf8')
  const plugins = [{ name: 'original-product-consumer-and-exact-source-mutation', setup(build) {
    build.onLoad({ filter: /\/renderer\/src\/store\.ts$/ }, () => ({ contents: store, loader: 'ts', resolveDir: fixture }))
    if (mutation === 'omit-menu-call') build.onLoad({ filter: /BrowserPane\.tsx$/ }, ({ path }) => {
      assert.equal(path, panePath)
      return { contents: replaceUnique(originalPane, 'onValueChange={(viewport) => void run(() => api.browser.setViewport(tab.browserId, viewport as BrowserViewport))}', 'onValueChange={() => {}}'), loader: 'tsx', resolveDir: dirname(path) }
    })
    if (mutation && mutation !== 'omit-menu-call') build.onLoad({ filter: /browser-view-manager\.ts$/ }, ({ path }) => {
      assert.equal(path, managerPath); return { contents: mutatedManager(mutation), loader: 'ts', resolveDir: dirname(path) }
    })
  } }]
  await build({ ...base, plugins, platform: 'node', format: 'esm', packages: 'external',
    banner: { js: `import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);` }, entryPoints: [join(fixture, 'main.ts')], outfile: join(compiled, 'main.mjs') })
  await build({ ...base, platform: 'node', format: 'cjs', external: ['electron'], entryPoints: [join(fixture, 'preload.ts')], outfile: join(compiled, 'preload.cjs') })
  await build({ ...base, plugins, platform: 'browser', format: 'esm', define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
    loader: { '.png': 'file', '.svg': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, entryPoints: [join(fixture, 'renderer.tsx')], outfile: join(compiled, 'renderer.js') })
  await writeFile(join(compiled, 'index.html'), '<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="renderer.css"><div id="root"></div><script type="module" src="renderer.js"></script>')
  const env = { ...cleanEnv(), AGENTMUX_VIEWPORT_ROOT: compiled, AGENTMUX_VIEWPORT_OUT: out, AGENTMUX_VIEWPORT_LABEL: label,
    AGENTMUX_VIEWPORT_CLI: resolve('packages/core/dist/agentmux.js'), AGENTMUX_RUNTIME_DIRECTORY: join(compiled, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(compiled, 'state') }
  delete env.ELECTRON_RUN_AS_NODE
  await rm(join(out, label + '.json'), { force: true })
  const processResult = await childProcess(require('electron'), [join(compiled, 'main.mjs')], env, 120000)
  const result = JSON.parse(await readFile(join(out, label + '.json'), 'utf8'))
  await writeFile(join(out, label + '.json'), JSON.stringify({ ...result, process: processResult }, null, 2))
  if (mutation) {
    assert.equal(processResult.code, 1, processResult.stdout + processResult.stderr)
    assert.equal(result.passed, false)
    const expected = { 'omit-menu-call': /menu-call-must-apply-original-viewport/, 'omit-native-apply': /native-apply-must-change-layout-width/, 'omit-fit': /fixed-viewport-must-fit-all-four-corners/ }
    assert.match(result.failure?.message ?? '', expected[mutation], 'Mutation fails for its actual nonempty behavioral oracle')
  } else {
    assert.equal(processResult.code, 0, JSON.stringify(result.failure) + processResult.stderr)
    assert.equal(result.passed, true); assert.ok(result.cases.length >= 20); assert.ok(result.public.length >= 8)
    assert.ok(result.images.some(image => image.kind === 'complete-workface-composite-from-actual-settled-surfaces'))
    assert.deepEqual(result.warnings, [])
  }
  evidence.cases.push({ label, result: mutation ? 'RED' : 'GREEN', receipt: label + '.json' }); console.log(label + ': ' + (mutation ? 'expected RED' : 'GREEN'))
}
async function selectionMutation() {
  const test = 'apps/desktop/test/browser-view-manager.test.ts', title = 'keeps the confirmed viewport when native application fails and permits retry'
  const config = resolve('.local/browser-viewport/selection-mutation.config.mjs')
  const mutant = mutatedManager('commit-before-native-apply')
  for (const [label, source] of [['selection-source', originalManager], ['commit-before-native-apply', mutant], ['selection-restored', originalManager]]) {
    await writeFile(config, `import base from ${JSON.stringify(pathToFileURL(resolve('vitest.config.ts')).href)}; export default {...base,plugins:[...(base.plugins??[]),{name:'exact-private-viewport-selection-mutation',enforce:'pre',transform(code,id){if(id.split('?')[0]!==${JSON.stringify(managerPath)})return;return{code:${JSON.stringify(source)},map:null}}}]}`)
    const report = join(out, label + '.json')
    await rm(report, { force: true })
    const processResult = await childProcess(process.execPath, [require.resolve('vitest/vitest.mjs'), 'run', test, '--config', config, '-t', title, '--reporter=json', '--outputFile', report, '--maxWorkers=1'], { ...process.env, pnpm_config_verify_deps_before_run: 'warn' }, 30000)
    const reportJson = JSON.parse(await readFile(report, 'utf8'))
    const cases = reportJson.testResults.flatMap(suite => suite.assertionResults).filter(test => test.title === title)
    assert.equal(cases.length, 1, 'The real original owner failure test is nonempty and unique')
    const red = label === 'commit-before-native-apply'
    assert.equal(cases[0].status, red ? 'failed' : 'passed'); assert.equal(processResult.code, red ? 1 : 0)
    if (red) assert.match(cases[0].failureMessages.join('\n'), /responsive|viewport/, 'The failure concerns the unconfirmed viewport value')
    evidence.cases.push({ label, result: red ? 'RED' : 'GREEN', receipt: label + '.json' }); console.log(label + ': ' + (red ? 'expected RED' : 'GREEN'))
  }
  await rm(config, { force: true })
}
try {
  await native('source')
  if (args.includes('--mutations')) {
    for (const mutation of ['omit-menu-call', 'omit-native-apply', 'omit-fit']) await native(mutation, mutation)
    await selectionMutation(); await native('restored-source')
  }
  for (const [path, hash] of Object.entries(evidence.sourceInputs)) assert.equal(sha(await readFile(path)), hash, 'Source changed during the bounded proof: ' + path)
  evidence.passed = true; await writeFile(join(out, 'receipt.json'), JSON.stringify(evidence, null, 2))
} finally { await rm(work, { recursive: true, force: true }) }
