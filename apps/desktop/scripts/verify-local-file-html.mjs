import { fixturePath as _hygiene_fixturePath } from './lib/fixture-values.mjs'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, lstat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { runProbeProcess } from './probe-process.mjs'

const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const require = createRequire(import.meta.url), esbuild = createRequire(require.resolve('vite'))('esbuild')
const evidence = resolve(repository, process.argv.find(value => value.startsWith('--output='))?.slice(9) ?? 'docs/reviews/evidence/local-file-preview')
const root = await mkdtemp(_hygiene_fixturePath('tmp/amx-file-html-')), sha = bytes => createHash('sha256').update(bytes).digest('hex')
const sources = ['scripts/fixtures/local-file-preview/native-html.ts', 'src/main/browser-view-manager.ts', 'src/main/browser-profile-manager.ts', 'src/main/browser-profile-store.ts', 'src/main/browser-ref-ledger-store.ts']
const identity = {}
const failure = error => ({ name: error?.name ?? 'Error', message: error?.message ?? String(error), stack: error?.stack,
  ...(error?.errors ? { errors: Array.from(error.errors, failure) } : {}), ...(error?.cause ? { cause: failure(error.cause) } : {}),
  ...(Array.isArray(error?.cleanup) ? { cleanup: error.cleanup.map(entry => ({ owner: entry.owner, released: entry.released,
    ...(entry.error === undefined ? {} : { error: failure(entry.error) }) })) } : {}) })
const receipt = { passed: false, identity, compiledInputs: {},
  boundary: 'Actual BrowserViewManager/native WebContentsView/profile/ledger in a private ordinary Electron process; no Core/Host/Runtime startup. Only this original Child exit is certified; independent background owners are outside this proof.' }
let namespace, probeAttempted = false
try {
  namespace = await lstat(root, { bigint: true })
  receipt.namespace = { path: root, dev: String(namespace.dev), ino: String(namespace.ino) }
  for (const file of sources) identity[file] = sha(await readFile(join(desktop, file)))
  await mkdir(evidence, { recursive: true }); await mkdir(join(root, 'profile'))
  await symlink(join(desktop, 'node_modules'), join(root, 'node_modules'), 'dir')
  const bundle = join(root, 'native-html.mjs')
  const built = await esbuild.build({ entryPoints: [join(desktop, sources[0])], outfile: bundle, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'error', metafile: true })
  for (const file of Object.keys(built.metafile.inputs)) receipt.compiledInputs[file] = sha(await readFile(resolve(repository, file)))
  assert.ok(Object.keys(receipt.compiledInputs).length > 0, 'Actual production Browser fixture inputs are nonempty')
  receipt.compiledSha256 = sha(await readFile(bundle))
  // Preserve the actual loaded product bundle before releasing this private namespace.
  await writeFile(join(evidence, 'html-native-bundle.mjs'), await readFile(bundle))
  const main = join(root, 'main.cjs')
  await writeFile(main, `const { app, BrowserWindow } = require('electron'); const fs = require('node:fs/promises'); const crypto = require('node:crypto');
app.setPath('userData', ${JSON.stringify(join(root, 'profile'))}); app.setPath('sessionData', ${JSON.stringify(join(root, 'profile'))});
const failure = ${failure.toString()};
app.whenReady().then(async () => { let win, result; const cleanup = []; try {
  win = new BrowserWindow({width: 860, height: 560, show: false, webPreferences: {sandbox:true, contextIsolation:true, nodeIntegration:false}});
  const native = await import(${JSON.stringify(bundle)}); result = await native.verifyNativeHtml(win, ${JSON.stringify(root)}, ${JSON.stringify(evidence)});
  result.loadedBundleSHA256 = crypto.createHash('sha256').update(await fs.readFile(${JSON.stringify(bundle)})).digest('hex');
} catch (error) { result = {passed:false,error:failure(error)}; }
try { if(win)win.destroy(); cleanup.push({owner:'private-window',released:true}); }
catch(error) { result.passed=false; cleanup.push({owner:'private-window',released:false,error:failure(error)}); }
result.mainCleanup=cleanup;
try { await fs.writeFile(${JSON.stringify(join(root, 'result.json'))}, JSON.stringify(result)); }
catch(error) { result.passed=false; console.error(JSON.stringify({originalResult:result,receiptWriteFailure:failure(error)})); }
app.exit(result.passed?0:1); });`)
  receipt.mainSha256 = sha(await readFile(main))
  await writeFile(join(evidence, 'html-native-main.cjs'), await readFile(main))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  probeAttempted = true
  try { receipt.outcome = await runProbeProcess(require('electron'), [main], { temporaryRoot: root, cwd: repository, env, timeoutMs: 45000 }) }
  catch (error) { receipt.outcome = error.probe; throw error }
  const result = JSON.parse(await readFile(join(root, 'result.json'), 'utf8'))
  receipt.result = result
  assert.equal(receipt.outcome.exitConfirmed, true, 'Original Electron exit is unconfirmed')
  assert.equal(receipt.outcome.timedOut, false, 'Original Electron attempt timed out')
  assert.equal(receipt.outcome.interruption, null, 'Original Electron attempt was interrupted')
  assert.equal(receipt.outcome.exitSignal, null, 'Original Electron ended by signal')
  assert.equal(receipt.outcome.originalExitCode, 0, result.error?.message)
  assert.equal(result.passed, true, JSON.stringify(result.error))
  assert.equal(result.loadedBundleSHA256, receipt.compiledSha256, 'The actual loaded Browser bundle must be this candidate')
  receipt.pngSha256 = sha(await readFile(join(evidence, 'html-native-browser.png')))
  for (const file of sources) assert.equal(sha(await readFile(join(desktop, file))), identity[file], 'The production HTML owner changed during proof')
  receipt.passed = true
} catch (error) { receipt.failure = failure(error) }
finally {
  receipt.cleanup = { status: 'retained', reason: 'original-exit-or-namespace-unconfirmed' }
  try {
    if (namespace && (!probeAttempted || receipt.outcome?.exitConfirmed === true)) {
      const current = await lstat(root, { bigint: true })
      if (current.isDirectory() && !current.isSymbolicLink() && current.dev === namespace.dev && current.ino === namespace.ino) {
        await rm(root, { recursive: true, force: false })
        receipt.cleanup = { status: 'removed-original-directory', dev: String(current.dev), ino: String(current.ino) }
      } else receipt.cleanup.reason = 'original-directory-identity-unconfirmed'
    }
  } catch (error) { receipt.cleanup.error = failure(error) }
  if (receipt.cleanup.status !== 'removed-original-directory') receipt.passed = false
  await mkdir(evidence, { recursive: true })
  await writeFile(join(evidence, 'html-native-receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify({ passed: receipt.passed, failure: receipt.failure ?? null, cleanup: receipt.cleanup, receipt: join(evidence, 'html-native-receipt.json') }))
process.exitCode = receipt.passed ? 0 : 1
