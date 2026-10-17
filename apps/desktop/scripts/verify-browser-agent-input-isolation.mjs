import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises'
import { join, resolve, dirname, relative } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '../../..'), require = createRequire(join(repo, 'apps/desktop/package.json'))
const { build } = createRequire(require.resolve('vite'))('esbuild'), electron = require('electron')
const output = join(repo, '.tmp/browser-agent-collaboration/input-isolation-proof')
const scratch = await mkdtemp(join(tmpdir(), 'amux-browser-input-'))
await symlink(join(repo, 'apps/desktop/node_modules'), join(scratch, 'node_modules'), 'dir')
const hash = value => createHash('sha256').update(value).digest('hex')
const main = 'apps/desktop/src/main/browser-view-manager.ts', shield = 'apps/desktop/src/main/browser-native-input-shield.ts', overlay = 'apps/desktop/src/main/native-overlay-surfaces.ts'
const inputs = [main, shield, 'apps/desktop/src/main/browser-page-dispatch.ts', 'apps/desktop/src/main/browser-cdp-session.ts',
  'apps/desktop/src/main/text-edit-context-menu.ts', 'apps/desktop/src/main/native-overlay-surfaces.ts', 'apps/desktop/src/main/browser-external-bridge.ts',
  'apps/desktop/src/shared/browser-operation.ts', 'apps/desktop/src/shared/contracts.ts', 'packages/core/src/browser-targets.ts', 'packages/core/src/control-browser-targets.ts',
  'packages/core/src/control-codec.ts', 'packages/core/src/control.ts', 'packages/core/src/agentmux-cli-browser-guide.ts', 'packages/core/src/agentmux-cli-commands.ts',
  'apps/desktop/src/renderer/src/components/BrowserOperationSurface.tsx', 'apps/desktop/src/renderer/src/store.ts',
  ...['main.ts', 'renderer.tsx', 'preload.ts', 'native-window-input.mm'].map(file => 'apps/desktop/scripts/fixtures/browser-agent-input-isolation/' + file),
  'apps/desktop/scripts/verify-browser-agent-input-isolation.mjs', 'packages/core/dist/agentmux.js', 'packages/core/dist/control-browser-targets.js']
const manifest = async () => Object.fromEntries(await Promise.all(inputs.map(async file => [file, hash(await readFile(join(repo, file)))])))
const initial = await manifest(), receipt = { schema: 'agentmux.browser-agent-input-isolation.proof.v1', passed: false,
  candidateHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), inputs: initial, runs: [],
  boundary: 'Private native Browser/Main + actual GUI component and original Renderer branches + actual public RPC client and built CLI. Mutants change private compiled production source only. No user App or Run is used.' }
await mkdir(output, { recursive: true })
const save = () => writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2))
const common = { absWorkingDir: repo, bundle: true, logLevel: 'silent', metafile: true, jsx: 'automatic' }
assert.equal(process.platform, 'darwin', 'This native-window routing proof requires macOS; it does not substitute a logical View-tree target')
execFileSync('xcrun', ['clang++', '-std=c++17', '-fobjc-arc', '-bundle', '-undefined', 'dynamic_lookup', '-framework', 'AppKit',
  '-I' + resolve(dirname(process.execPath), '../include/node'), '-DNODE_GYP_MODULE_NAME=browser_input_proof',
  join(repo, 'apps/desktop/scripts/fixtures/browser-agent-input-isolation/native-window-input.mm'), '-o', join(scratch, 'native-input.node')])
await build({ ...common, platform: 'node', format: 'cjs', external: ['electron'], entryPoints: ['apps/desktop/scripts/fixtures/browser-agent-input-isolation/preload.ts'], outfile: join(scratch, 'preload.cjs') })
await build({ ...common, platform: 'browser', format: 'iife', conditions: ['browser'], define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' },
  entryPoints: ['apps/desktop/scripts/fixtures/browser-agent-input-isolation/renderer.tsx'], outfile: join(scratch, 'renderer.js') })
await writeFile(join(scratch, 'index.html'), '<!doctype html><link rel="stylesheet" href="renderer.css"><style>body{margin:0;background:#fff;color:#162019}button{min-width:32px;min-height:28px}</style><div id="root"></div><script src="renderer.js"></script>')
await writeFile(join(scratch, 'bootstrap.cjs'), `console.log('native-proof:bootstrap');const {app}=require('electron'),fs=require('node:fs'),path=require('node:path');console.log('native-proof:required');const root=${JSON.stringify(scratch)};const fail=error=>{console.error(error);fs.writeFileSync(path.join(root,'receipt.json'),JSON.stringify({passed:false,failure:{message:error.message,stack:error.stack}}));app.exit(1)};process.on('uncaughtException',fail);for(const key of ['home','appData','userData','sessionData']){const p=path.join(root,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p);console.log('native-proof:path',key)};console.log('native-proof:await-ready',app.isReady());app.whenReady().then(()=>{console.log('native-proof:ready');return import(${JSON.stringify(join(scratch, 'main.mjs'))})}).catch(fail);`)
const originals = Object.fromEntries(await Promise.all([main, shield, overlay].map(async file => [file, await readFile(join(repo, file), 'utf8')])))
const variants = [{ name: 'source' },
  { name: 'missing-native-input-surface', path: shield, from: '      host.contentView.addChildView(this.view, index + 1)', to: '      // private mutation: no native input surface is attached', expected: 'Native input isolation: active human pointer/capture/hover/wheel' },
  { name: 'missing-native-chrome-input-pair', path: overlay, from: '        return owner ? [owner.view, ...(owner.inputShield ? [owner.inputShield] : [])] : []', to: '        return owner ? [owner.view] : []', expected: 'Native input isolation: active human pointer/capture/hover/wheel' },
  { name: 'missing-retired-surface-cleanup-reference', path: main, from: '    if (entry.inputShield) {\n      this.releaseInputShield(entry)\n      if (entry.inputShield) { this.inputIsolationFailed(entry); return }\n    }', to: '    // private mutation: overwrite the retired cleanup identity', expected: 'Retired native surface must not outlive its only cleanup reference' },
  { name: 'missing-final-first-press-check', path: main, from: '    const invalid = this.presentationFirstPressInvalid(press)', to: '    const invalid = null', expected: 'Final first-press qualification: an old control generation must never dispatch page input' },
  { name: 'missing-after-down-control-check', path: main, from: '      const afterDown = this.presentationFirstPressInvalid(press)', to: '      const afterDown = null', expected: 'Cross-generation first press must not submit its remaining up' },
  { name: 'missing-pending-action-stop-fence', path: main, pattern: /    const beforeAction = \(step = activeStep\): void => \{[\s\S]*?\n    \}\n    const dispatch = createBrowserPageDispatch/, to: '    const beforeAction = (_step = activeStep): void => {}\n    const dispatch = createBrowserPageDispatch', expected: 'Stop fence: resolved pending action must not reach the real page' },
  { name: 'restored-source' }]
async function run(variant) {
  let mutated
  if (variant.path) {
    const original = originals[variant.path], occurrences = variant.pattern ? [...original.matchAll(new RegExp(variant.pattern.source, 'g'))].length : original.split(variant.from).length - 1
    assert.equal(occurrences, 1, variant.name + ': mutation must alter exactly one actual production block')
    mutated = original.replace(variant.pattern ?? variant.from, variant.to)
    await writeFile(join(output, variant.name + '.source.txt'), mutated)
  }
  const built = await build({ ...common, platform: 'node', format: 'esm', packages: 'external', external: ['electron'],
    banner: { js: "import { createRequire as __createProofRequire } from 'node:module'; const require=__createProofRequire(import.meta.url);" },
    plugins: [{ name: 'exact-private-native-owner', setup(builder) { builder.onLoad({ filter: /browser-view-manager\.ts$|browser-native-input-shield\.ts$|native-overlay-surfaces\.ts$/ }, async args => {
      if (variant.path && args.path === join(repo, variant.path)) return { contents: mutated, loader: 'ts', resolveDir: dirname(args.path) }
    }) } }], entryPoints: ['apps/desktop/scripts/fixtures/browser-agent-input-isolation/main.ts'], outfile: join(scratch, 'main.mjs') })
  for (const file of [main, shield, 'apps/desktop/src/main/browser-page-dispatch.ts', 'apps/desktop/src/main/text-edit-context-menu.ts']) {
    assert.ok(Object.keys(built.metafile.inputs).some(input => resolve(repo, input) === join(repo, file)), 'Native bundle must consume the actual owner: ' + file)
  }
  await rm(join(scratch, 'receipt.json'), { force: true })
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
  Object.assign(env, { AGENTMUX_ISOLATION_PROOF_ROOT: scratch, AGENTMUX_ISOLATION_SOURCE: repo, AGENTMUX_ISOLATION_NODE: process.execPath,
    HOME: join(scratch, 'home'), NODE_PATH: [join(repo, 'apps/desktop/node_modules'), join(repo, 'packages/core/node_modules'), join(repo, 'node_modules')].join(':') })
  const result = await new Promise((resolve, reject) => {
    const child = spawn(electron, [join(scratch, 'bootstrap.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '', timedOut = false
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; if (process.argv.includes('--source-only')) process.stdout.write(bytes) })
    const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 180000)
    child.once('error', error => { clearTimeout(timeout); reject(error) })
    child.once('close', (code, signal) => { clearTimeout(timeout); resolve({ code, signal, timedOut, log }) })
  })
  await writeFile(join(output, variant.name + '.log'), result.log)
  assert.equal(result.timedOut, false, variant.name + ': a timeout is not a semantic RED')
  const native = JSON.parse(await readFile(join(scratch, 'receipt.json'), 'utf8'))
  await writeFile(join(output, variant.name + '.json'), JSON.stringify(native, null, 2))
  if (!variant.path) { assert.equal(result.code, 0, JSON.stringify(native.failure) + '\n' + result.log); assert.equal(native.passed, true); assert.ok(native.cases.length >= 6, 'Actual native/public consumers are nonempty') }
  else { assert.equal(result.code, 1, 'A critical production mutation must fail'); assert.match(native.failure?.message ?? '', new RegExp(variant.expected)); assert.equal(native.passed, false) }
  receipt.runs.push({ name: variant.name, code: result.code, result: variant.path ? 'expected RED' : 'GREEN', native: variant.name + '.json',
    loaded: Object.fromEntries(Object.entries(built.metafile.inputs).filter(([file]) => file.startsWith('apps/desktop/src')).map(([file]) => [file, file === variant.path ? hash(mutated) : initial[file] ?? null])),
    mutation: variant.path ? { path: variant.path, originalSha256: initial[variant.path], loadedSha256: hash(mutated) } : null })
  await save(); process.stdout.write(variant.name + ': ' + (variant.path ? 'expected RED' : 'GREEN') + '\n')
  // Only this ended private process's browser cache and stores are reusable scratch.
  for (const name of ['home', 'appData', 'userData', 'sessionData', 'operations.sqlite', 'operations.sqlite-wal', 'operations.sqlite-shm', 'refs.json', 'control.sock', 'state']) await rm(join(scratch, name), { recursive: true, force: true })
}
try {
  await save()
  for (const variant of process.argv.includes('--source-only') ? variants.slice(0, 1) : variants) await run(variant)
  assert.deepEqual(await manifest(), initial, 'The exact candidate source and built CLI must not change during verification')
  receipt.passed = !process.argv.includes('--source-only')
  await save()
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; await save(); throw error }
finally { await rm(scratch, { recursive: true, force: true }) }
