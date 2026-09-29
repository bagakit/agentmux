import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runProbeProcess } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve('vite'))('esbuild')
const evidence = resolve(repository, process.argv.find(value => value.startsWith('--output='))?.slice(9) ?? 'docs/reviews/evidence/local-file-preview-2026-10-04')
const root = await mkdtemp('/tmp/amx-file-html-'), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = ['scripts/fixtures/local-file-preview/native-html.ts', 'src/main/browser-view-manager.ts', 'src/main/browser-profile-manager.ts', 'src/main/browser-profile-store.ts', 'src/main/browser-ref-ledger-store.ts']
const identity = {}
for (const file of sources) identity[file] = sha(await readFile(join(desktop, file)))
let receipt = { passed: false, identity, boundary: 'Real production BrowserViewManager/native WebContentsView/profile/ledger in a private ordinary Electron process. Local relative resources and absence of App preload/Node/bridge are observed. Renderer Save & Preview and project binding are covered by the mounted product tests; this proof does not touch the installed App or claim workspace confinement for file:// pages.' }
try {
  await mkdir(evidence, { recursive: true }); await mkdir(join(root, 'profile'))
  await symlink(join(desktop, 'node_modules'), join(root, 'node_modules'), 'dir')
  const bundle = join(root, 'native-html.mjs')
  await esbuild.build({ entryPoints: [join(desktop, sources[0])], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'error' })
  const main = join(root, 'main.cjs')
  await writeFile(main, `const { app, BrowserWindow } = require('electron'); const fs = require('node:fs/promises');
app.setPath('userData', ${JSON.stringify(join(root, 'profile'))}); app.setPath('sessionData', ${JSON.stringify(join(root, 'profile'))});
app.whenReady().then(async () => { let win; let result; try {
  win = new BrowserWindow({width: 860, height: 560, show: false, webPreferences: {sandbox:true, contextIsolation:true, nodeIntegration:false}});
  const native = await import(${JSON.stringify(bundle)}); result = await native.verifyNativeHtml(win, ${JSON.stringify(root)}, ${JSON.stringify(evidence)});
} catch (error) { result = {passed:false,error:{name:error.name,message:error.message,stack:error.stack}}; }
await fs.writeFile(${JSON.stringify(join(root, 'result.json'))}, JSON.stringify(result)); if(win)win.destroy(); app.exit(result.passed?0:1); });`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const outcome = await runProbeProcess(require('electron'), [main], { temporaryRoot: root, cwd: repository, env, timeoutMs: 45000 })
  const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
  receipt = { ...receipt, result, outcome, compiledSha256: sha(await readFile(bundle)), pngSha256: result.passed ? sha(await readFile(join(evidence, 'html-native-browser.png'))) : null }
  assert.equal(outcome.exitCode, 0, result.error?.message); assert.equal(result.passed, true)
  for (const file of sources) assert.equal(sha(await readFile(join(desktop, file))), identity[file], 'The production HTML owner did not change during the proof')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally { await rm(root, { recursive: true, force: true }); await writeFile(join(evidence, 'html-native-receipt.json'), JSON.stringify(receipt, null, 2)); }
console.log(JSON.stringify({ passed: receipt.passed, failure: receipt.failure ?? null })); process.exitCode = receipt.passed ? 0 : 1
