import { browserSourceBuild } from '../../../packages/browser/scripts/source-build.mjs'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink, copyFile } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '../../..'), require = createRequire(join(repo, 'apps/desktop/package.json'))
const { build } = browserSourceBuild(createRequire(require.resolve('vite'))('esbuild')), electron = require('electron'), work = await mkdtemp(join(tmpdir(), 'amux-browser-drag-'))
const output = join(repo, '.local/browser-drag/proof'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
await mkdir(output, { recursive: true }); await symlink(join(repo, 'apps/desktop/node_modules'), join(work, 'node_modules'), 'dir')
const owner = 'packages/browser/src/browser-page-dispatch.ts', source = await readFile(join(repo, owner), 'utf8')
const inputPaths = [owner, 'packages/core/src/browser-page-capability.ts', 'packages/core/dist/browser-page-capability.js', 'apps/desktop/src/main/browser-task-assets.ts', 'apps/desktop/src/main/browser-replay-compiler.ts', 'apps/desktop/src/main/browser-view-manager.ts', 'packages/browser/src/browser-operation-step.ts', 'packages/browser/src/browser-operation-journal.ts', 'apps/desktop/src/main/browser-own-dispatch.ts', 'packages/browser/src/browser-page-input-scripts.ts', 'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/renderer/src/components/BrowserTaskAssetEditor.tsx', 'apps/desktop/src/renderer/src/components/BrowserTaskDragEditor.tsx', 'apps/desktop/src/renderer/src/components/BrowserTaskStepFailure.tsx', 'apps/desktop/src/renderer/src/styles/browser-task-assets.css', 'apps/desktop/src/renderer/src/styles/browser-operation-surface.css', 'apps/desktop/src/shared/browser-task-assets.ts', 'packages/browser/src/model/browser-operation.ts', ...['main.ts', 'preload.ts', 'renderer.tsx'].map(name => 'apps/desktop/scripts/fixtures/browser-drag/' + name), 'apps/desktop/scripts/verify-browser-drag.mjs']
const inputs = Object.fromEntries(await Promise.all(inputPaths.map(async path => [path, hash(await readFile(join(repo, path)))])))
const receipt = { schema: 'agentmux.browser-drag.proof.v1', candidateHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim(), inputs, electron: require('electron/package.json').version, runs: [], passed: false }
const common = { absWorkingDir: repo, bundle: true, logLevel: 'silent', metafile: true, jsx: 'automatic' }
const mutations = process.argv.includes('--mutations') ? [
  { label: 'native-drop-omitted', from: "['dragEnter', 'dragOver', 'drop']", to: "['dragEnter', 'dragOver']", expected: 'HTML5 native drop must reach original destination exactly once' },
  { label: 'unknown-misreported-unsent', from: "completion is unknown. Inspect the original page before acting again.`, 'locator-changed', 'unknown')", to: "completion is unknown. Inspect the original page before acting again.`, 'locator-changed', 'not-dispatched')", expected: 'A post-press native failure must keep effects unknown' },
  { label: 'css-hover-restored', from: "return await inWorld(send, witness, 'function () { return this.read() }') === true", to: `return await inWorld(send, objectId, 'function () { return this.matches(":hover") }') === true`, expected: 'A trusted hit must keep public click available independently of CSS hover' }
] : []
try {
  for (const variant of [{ label: 'source' }, ...mutations, ...(mutations.length ? [{ label: 'restored-source' }] : [])]) {
    const root = join(work, String(receipt.runs.length)); await mkdir(root)
    const plugins = variant.from ? [{ name: 'production-native-drop-mutation', setup(build) { build.onLoad({ filter: /browser-page-dispatch\.ts$/ }, args => {
      assert.equal(args.path, join(repo, owner)); assert.equal(source.split(variant.from).length - 1, 1, 'Mutation must change one actual production block')
      return { contents: source.replace(variant.from, variant.to), loader: 'ts', resolveDir: dirname(args.path) }
    }) } }] : []
    const built = await build({ ...common, plugins, platform: 'node', format: 'esm', packages: 'external', external: ['electron'], entryPoints: ['apps/desktop/scripts/fixtures/browser-drag/main.ts'], outfile: join(root, 'main.mjs') })
    for (const path of [owner, 'apps/desktop/src/main/browser-view-manager.ts', 'apps/desktop/src/main/browser-task-assets.ts', 'apps/desktop/src/main/browser-replay-compiler.ts']) assert.ok(Object.hasOwn(built.metafile.inputs, path), 'Original native bundle consumes ' + path)
    await build({ ...common, platform: 'node', format: 'cjs', external: ['electron'], entryPoints: ['apps/desktop/scripts/fixtures/browser-drag/preload.ts'], outfile: join(root, 'preload.cjs') })
    await build({ ...common, platform: 'browser', format: 'iife', conditions: ['browser'], define: { __AGENTMUX_WEB_PREVIEW__: 'false', 'process.env.NODE_ENV': '"production"' }, entryPoints: ['apps/desktop/scripts/fixtures/browser-drag/renderer.tsx'], outfile: join(root, 'renderer.js') })
    await writeFile(join(root, 'index.html'), '<!doctype html><link rel="stylesheet" href="renderer.css"><style>body{margin:0;width:390px;padding:12px;overflow:auto}.browser-task-asset{width:100%}</style><div id="root"></div><script src="renderer.js"></script>')
    await writeFile(join(root, 'bootstrap.cjs'), `console.log('drag-proof:bootstrap');const {app}=require('electron'),fs=require('node:fs'),path=require('node:path');const root=${JSON.stringify(root)};for(const key of ['home','appData','userData','sessionData']){const p=path.join(root,key);fs.mkdirSync(p,{recursive:true});app.setPath(key,p)};app.whenReady().then(()=>{console.log('drag-proof:bootstrap-ready');return import(${JSON.stringify(join(root, 'main.mjs'))})}).catch(error=>{fs.writeFileSync(path.join(root,'receipt.json'),JSON.stringify({passed:false,failure:{message:error.message,stack:error.stack}}));app.exit(1)});`)
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('AGENTMUX_') && !key.startsWith('CTXMUX_') && key !== 'ELECTRON_RUN_AS_NODE'))
    Object.assign(env, { AGENTMUX_DRAG_ROOT: root, AGENTMUX_DRAG_SOURCE: repo, AGENTMUX_DRAG_NODE: process.execPath,
      AGENTMUX_RUNTIME_DIRECTORY: root, AGENTMUX_STATE_DIRECTORY: join(root, 'state'),
      AGENTMUX_AGENT_SESSION_STORE: join(root, 'sessions.json'), AGENTMUX_MESSAGE_QUEUE_PATH: join(root, 'messages.ndjson'),
      NODE_PATH: [join(repo, 'apps/desktop/node_modules'), join(repo, 'packages/core/node_modules'), join(repo, 'node_modules')].join(':') })
    const result = await new Promise((resolve, reject) => {
      const child = spawn(electron, [join(root, 'bootstrap.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] }); let log = '', timedOut = false
      for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log += bytes; process.stdout.write(bytes) })
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, 180000)
      child.on('error', reject); child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, timedOut, log }) })
    })
    await writeFile(join(output, variant.label + '.log'), result.log)
    assert.equal(result.timedOut, false, 'A timeout is not a meaningful red/green result')
    const native = JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8'))
    await writeFile(join(output, variant.label + '.json'), JSON.stringify({ ...native, process: result }, null, 2))
    if (variant.from) { assert.equal(result.code, 1); assert.match(native.failure?.message ?? '', new RegExp(variant.expected)); assert.equal(native.passed, false) }
    else { assert.equal(result.code, 0, result.log + '\n' + JSON.stringify(native.failure)); assert.equal(native.passed, true); assert.equal(native.cases.length, 12); for (const mode of ['dark', 'light']) for (const width of [390, 310]) await copyFile(join(root, `task-editor-${mode}-${width}.png`), join(output, `${variant.label}-task-editor-${mode}-${width}.png`)) }
    const screenshots = []
    if (!variant.from) for (const mode of ['dark', 'light']) for (const width of [390, 310]) {
      const path = `${variant.label}-task-editor-${mode}-${width}.png`, bytes = await readFile(join(output, path))
      screenshots.push({ path, sha256: hash(bytes), bytes: bytes.length })
    }
    receipt.runs.push({ screenshots, rendererSha256: hash(await readFile(join(root, 'renderer.js'))), label: variant.label, result: variant.from ? 'RED' : 'GREEN', original: variant.label + '.json', bundleSha256: hash(await readFile(join(root, 'main.mjs'))) })
    console.log(variant.label + ': ' + (variant.from ? 'expected RED' : 'GREEN'))
  }
  receipt.passed = true
} finally { receipt.diagnosticWork = receipt.passed ? null : work; await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)); if (receipt.passed) await rm(work, { recursive: true, force: true }) }
