import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'
import { runProbeProcess, listProbeProcesses } from '../../probe-process.mjs'

const root = resolve(import.meta.dirname, '../../../../..'), desktop = join(root, 'apps/desktop'), fixture = import.meta.dirname
const require = createRequire(join(desktop, 'package.json'))
const { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const evidence = resolve(process.env.AGENTMUX_PRESENTATION_RESOURCE_EVIDENCE || join(root, '.tmp', 'browser-presentation-resource-native-' + Date.now()))
await mkdir(evidence, { recursive: true })
const receipt = { schema: 'agentmux.browser-presentation-resource-native.v1', evidence, passed: false,
  T004Qualified: false, userAppRunRuntimeControls: 0, inputs: {},
  boundary: 'First resource slice only; registered production Main/preload/BVM with private two-video media holder. No product BrowserPane/shared surface caller, Native first press, IME, clipboard, Runtime/Run, restart or installation qualification.' }
const inputs = new Map(), logs = []
let privateRoot
try {
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
    `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(join(root,'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
  await writeFile(join(evidence, 'freshness.log'), freshness.stdout + freshness.stderr)
  receipt.freshness = { exitCode: freshness.status, rebuilt: false }
  assert.equal(freshness.status, 0, 'Unmodified production Core/Demand freshness guard')
  receipt.main = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim()
  privateRoot = await mkdtemp(join(tmpdir(), 'amux-native-resource-'))
  const out = join(privateRoot, 'out'); await mkdir(out)
  await symlink(join(desktop, 'node_modules'), join(privateRoot, 'node_modules'))
  const plugin = { name: 'literal-production-source-binding', setup(builder) {
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const bytes = await readFile(path); inputs.set(path, digest(bytes))
      return { contents: bytes.toString(), loader: path.endsWith('.ts') ? 'ts' : 'js' }
    })
  } }
  const main = join(out, 'main.mjs'), preload = join(out, 'preload.cjs'), entry = join(out, 'entry.js')
  const settings = { bundle: true, packages: 'external', platform: 'node', target: 'node22', format: 'cjs', external: ['electron'], plugins: [plugin], metafile: true, logLevel: 'silent' }
  const mainBuild = await build({ ...settings, format: 'esm', entryPoints: [join(fixture, 'resource-main.ts')], outfile: main,
    banner: { js: "import {createRequire as createNativeRequire} from 'node:module';const require=createNativeRequire(import.meta.url);" } })
  // Sandboxed preload bundles local pure dependencies; only Electron is a native external.
  const preloadBuild = await build({ ...settings, packages: 'bundle', entryPoints: [join(desktop, 'src/preload/index.ts')], outfile: preload })
  const entryBuild = await build({ entryPoints: [join(fixture, 'resource-entry.mjs')], outfile: entry, bundle: true,
    platform: 'browser', format: 'esm', target: 'es2022', plugins: [plugin], metafile: true, logLevel: 'silent' })
  const sourcePage = join(out, 'source.html'), html = join(out, 'index.html')
  await writeFile(sourcePage, '<!doctype html><html><body style="margin:0"><input id="original-input"><script>const count=Number(sessionStorage.loads||0)+1;sessionStorage.loads=count;document.body.style.background=count===1?"rgb(238,45,64)":"rgb(25,190,75)";document.body.style.minHeight="800px";</script></body></html>')
  await writeFile(html, '<!doctype html><html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src \'self\'; script-src \'self\'; style-src \'self\' \'unsafe-inline\'; media-src blob:"><body style="margin:0;background:#151b22;color:white"><p>Private original Browser resource proof</p><div style="display:flex;gap:24px;margin:24px"><video muted autoplay style="width:480px;height:240px;object-fit:contain"></video><video muted autoplay style="width:480px;height:240px;object-fit:contain"></video></div><script type="module" src="entry.js"></script></body></html>')
  await mkdir(join(evidence, 'compiled'))
  receipt.compiled = {}
  for (const file of ['main.mjs','preload.cjs','entry.js','source.html','index.html']) {
    const bytes = await readFile(join(out, file)); receipt.compiled[file] = { sha256: digest(bytes), bytes: bytes.length }
    await copyFile(join(out, file), join(evidence, 'compiled', file))
  }
  for (const file of ['resource-proof.mjs','vitest.resource.config.mts','tsconfig.resource.json']) {
    const path = join(fixture, file); inputs.set(path, digest(await readFile(path)))
  }
  const packageEntries = []
  for (const name of ['core', 'demand']) {
    const directory = join(root, 'packages', name)
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    assert.equal(typeof manifest.exports['.'].import, 'string', 'Actual public ESM export')
    packageEntries.push(resolve(directory, manifest.exports['.'].import))
  }
  for (const file of ['pnpm-lock.yaml','packages/core/package.json','packages/demand/package.json',...packageEntries]) {
    const path = resolve(root, file); inputs.set(path, digest(await readFile(path)))
  }
  receipt.inputs = Object.fromEntries([...inputs].map(([path, sha]) => [relative(root, path), sha]))
  await writeFile(join(evidence, 'metafiles.json'), JSON.stringify({ main: mainBuild.metafile, preload: preloadBuild.metafile, entry: entryBuild.metafile }, null, 2) + '\n')
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'),
    AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.ndjson'),
    AGENTMUX_AGENT_SESSION_STORE: join(privateRoot, 'sessions.json') }
  delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [main, html, privateRoot, preload, evidence, sourcePage],
    { cwd: root, temporaryRoot: privateRoot, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  receipt.native = JSON.parse(await readFile(join(evidence, 'native-receipt.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0, 'Original private resource fixture exit')
  assert.equal(receipt.native.passed, true, 'Actual resource facts')
  assert.equal(receipt.native.phases.length, 4, 'Four nonempty actual phases')
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs].map(async ([path]) => [relative(root, path), digest(await readFile(path))])))
  assert.deepEqual(receipt.sourceAfter, receipt.inputs, 'Actual Source/compiled dependency inputs before/after')
  receipt.frames = await Promise.all(receipt.native.frames.map(async frame => {
    const bytes = await readFile(join(evidence, frame.file)); return { ...frame, sha256: digest(bytes), bytes: bytes.length }
  }))
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n') + '\n')
  if (privateRoot) {
    const remaining = await listProbeProcesses(-1, privateRoot)
    receipt.cleanup = { privateRoot, remaining, removed: false, borrowedLinksChanged: false }
    if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ evidence: relative(root, evidence), resourcePassed: receipt.passed,
    phases: receipt.native?.phases.length, failure: receipt.failure?.message, cleanup: receipt.cleanup }))
  if (!receipt.passed) process.exitCode = 1
}
