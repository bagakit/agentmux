import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

const root = process.cwd(), require = createRequire(resolve('apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild')
const sourcePath = resolve('apps/desktop/src/main/native-overlay-surfaces.ts'), source = await readFile(sourcePath, 'utf8')
const out = resolve('.tmp/native-overlay-focus'), work = await mkdtemp(join(tmpdir(), 'agentmux-overlay-focus-'))
await mkdir(out, { recursive: true })
for (const name of ['receipt.json', 'source.json', 'navigation-autofocus-mutant.json', 'restored-source.json']) await rm(join(out, name), { force: true })
const core = JSON.parse(await readFile('packages/core/package.json', 'utf8'))
const alias = Object.fromEntries(Object.entries(core.exports).filter(([, value]) => value.import).map(([key, value]) => [
  key === '.' ? '@agentmux/core' : '@agentmux/core/' + key.slice(2), resolve('packages/core', value.import.replace('./dist/', './src/'))
]))
const base = { bundle: true, logLevel: 'silent', alias, absWorkingDir: root }
const proofInputs = ['apps/desktop/scripts/verify-native-overlay-focus.mjs', 'apps/desktop/scripts/fixtures/native-overlay-focus/main.ts', 'apps/desktop/scripts/fixtures/native-overlay-focus/renderer.tsx', 'apps/desktop/scripts/fixtures/browser-input-history-native/renderer.tsx', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/styles/agent.css', 'apps/desktop/src/renderer/src/components/BrowserAddressInput.tsx', 'apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx', 'apps/desktop/src/renderer/src/hooks/useNativeOverlayChrome.ts', 'apps/desktop/src/renderer/src/lib/native-overlay-regions.ts']
const evidence = { sourceSha256: createHash('sha256').update(source).digest('hex'), proofInputs: Object.fromEntries(await Promise.all(proofInputs.map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')]))), mutations: [], privateProcesses: [], userAppOperations: [] }
async function run(label, mutant = false) {
  const compiled = join(work, label); await mkdir(compiled, { recursive: true })
  const plugins = mutant ? [{ name: 'restore-navigation-autofocus', setup(build) {
    build.onLoad({ filter: /native-overlay-surfaces\.ts$/ }, async args => {
      assert.equal(args.path, sourcePath)
      assert.equal(source.match(/focusOnNavigation: false/g)?.length, 1, 'Mutation target must be nonempty and unique')
      return { contents: source.replace('focusOnNavigation: false', 'focusOnNavigation: true'), loader: 'ts', resolveDir: resolve('apps/desktop/src/main') }
    })
  } }] : []
  await build({ ...base, plugins, platform: 'node', format: 'esm', external: ['electron'], entryPoints: ['apps/desktop/scripts/fixtures/native-overlay-focus/main.ts'], outfile: join(compiled, 'main.mjs') })
  await build({ ...base, platform: 'node', format: 'cjs', external: ['electron'], entryPoints: ['apps/desktop/src/preload/index.ts'], outfile: join(compiled, 'preload.cjs') })
  await build({ ...base, platform: 'browser', format: 'iife', define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
    entryPoints: ['apps/desktop/scripts/fixtures/native-overlay-focus/renderer.tsx'], outfile: join(compiled, 'renderer.js') })
  await writeFile(join(compiled, 'index.html'), '<!doctype html><link rel="stylesheet" href="renderer.css"><div id="root"></div><script src="renderer.js"></script>')
  const env = { ...process.env, AGENTMUX_OVERLAY_FOCUS_ROOT: compiled }; delete env.ELECTRON_RUN_AS_NODE
  const result = await new Promise((done, reject) => {
    const child = spawn(require('electron'), [join(compiled, 'main.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let output = ''
    evidence.privateProcesses.push({ label, pid: child.pid })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { output += bytes })
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Private Electron focus proof timed out: ' + label)) }, 30000)
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', (code, signal) => { clearTimeout(timer); done({ code, signal, output }) })
  })
  await writeFile(join(out, label + '.log'), result.output)
  const receipt = JSON.parse(await readFile(join(compiled, 'receipt.json'), 'utf8'))
  await writeFile(join(out, label + '.json'), JSON.stringify(receipt, null, 2))
  if (mutant) {
    assert.equal(result.code, 1, 'Old navigation autofocus must fail the focus proof')
    assert.match(receipt.failure?.message ?? '', /History projection must preserve native Renderer focus/)
    assert.equal(receipt.passed, false); evidence.mutations.push({ label, assertion: receipt.failure.message, result: 'RED' })
  } else {
    assert.equal(result.code, 0, result.output + '\n' + JSON.stringify(receipt.failure)); assert.equal(receipt.passed, true)
    assert.ok(receipt.cases.length >= 3, 'All native cases must execute')
  }
  console.log(label + ': ' + (mutant ? 'expected RED' : 'GREEN'))
}
try {
  await run('source')
  if (process.argv.includes('--mutations')) { await run('navigation-autofocus-mutant', true); await run('restored-source') }
  await writeFile(join(out, 'receipt.json'), JSON.stringify({ ...evidence, passed: true }, null, 2))
} finally { await rm(work, { recursive: true, force: true }) }
