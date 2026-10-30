import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

assert.equal(process.argv[2], '--evidence'); assert.ok(process.argv[3])
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop'), evidence = resolve(process.argv[3])
const fixture = join(desktop, 'scripts/fixtures/focus-disconnected-recovery')
const require = createRequire(join(desktop, 'package.json')), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = new Map(), isolated = [], logs = []
if (process.env.AGENTMUX_FOCUS_RECOVERY_SCENE_RECEIPT) {
  const path = resolve(process.env.AGENTMUX_FOCUS_RECOVERY_SCENE_RECEIPT), saved = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(saved.capturedPass, true); assert.equal(saved.captureOnly, true); assert.equal(saved.userAppControlled, false)
  assert.equal(saved.actual?.passed, true); assert.equal(saved.cleanup?.removed, true); assert.deepEqual(saved.cleanup.remaining, [])
  assert.deepEqual(saved.parallelInputChanges, []); assert.deepEqual(saved.sourceAfter, saved.inputs)
  assert.ok(Object.keys(saved.inputs).length > 0); assert.equal(saved.frames.length, 4)
  const expected = ['exited-placeless-wide.png','exited-close-wide.png','exited-stop-unconfirmed-narrow.png','unknown-stop-unconfirmed-narrow.png']
  assert.deepEqual(saved.frames.map(frame => frame.file), expected)
  assert.match(saved.compiled.renderer, /^[a-f0-9]{64}$/); assert.match(saved.compiled.css, /^[a-f0-9]{64}$/)
  for (const [file, sha] of Object.entries(saved.inputs)) assert.equal(hash(await readFile(join(root,file))), sha, 'Original scene input: '+file)
  for (const frame of saved.frames) assert.equal(hash(await readFile(resolve(path,'../'+frame.file))), frame.sha256, frame.file)
  const actual = JSON.parse(await readFile(resolve(path,'../actual.json'),'utf8')); assert.deepEqual(actual,saved.actual)
  const log = await readFile(resolve(path,'../process.log'),'utf8'); assert.equal(hash(log),saved.processLogSHA256)
  assert.equal(saved.process.exitCode,0)
  console.log(JSON.stringify({ capturedPass: true, exactEvidenceReused: path, aestheticReview: saved.aestheticReview }))
  process.exit(0)
}
const privateRoot = await mkdtemp(join(tmpdir(), 'amx-focus-recovery-')); await mkdir(evidence, { recursive: true })
const receipt = { capturedPass: false, captureOnly: true, aestheticReview: 'not-performed', userAppControlled: false, inputs: {}, isolated,
  boundary: 'Private Electron and maintained preview transport exercise original Renderer consumers only. Core Stop/reopen qualification has its separate private fixture evidence; these pixels do not prove Runtime, original user operation, native history recovery, restart or installation.' }
try {
  const sources = { name: 'current-public-source-entries', setup(builder) {
    builder.onResolve({ filter: /^@agentmux\// }, async ({ path: specifier }) => {
      const [, name, ...parts] = specifier.split('/'), directory = join(root, name === 'host' ? 'apps' : 'packages', name)
      const manifest = join(directory, 'package.json'), bytes = await readFile(manifest); inputs.set(manifest, hash(bytes))
      const exports = JSON.parse(bytes).exports, entry = parts.length ? './'+parts.join('/') : '.'
      const key = Object.keys(exports).sort((a,b) => Number(a.includes('*')) - Number(b.includes('*')) || b.length-a.length)
        .find(key => key === entry || key.includes('*') && entry.startsWith(key.split('*')[0]) && entry.endsWith(key.split('*')[1]))
      assert.ok(key, specifier); const declared = exports[key], target = typeof declared === 'string' ? declared : declared.browser ?? declared.import
      const wildcard = key.includes('*') ? entry.slice(key.split('*')[0].length, entry.length-key.split('*')[1].length) : ''
      let source = target.replace('*', wildcard).replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts')
      if (name === 'identity' && key === './runtime-source') source = target
      if (name === 'identity' && key === './runtime') source = './src/runtime-entry.ts'
      const path = [join(directory, source), join(directory, source.replace(/\.ts$/, '.tsx'))].find(existsSync)
      assert.ok(path, specifier); return { path }
    })
    builder.onResolve({ filter: /\?worker$/ }, () => ({ path: 'unused-editor-worker', namespace: 'unused-worker' }))
    builder.onLoad({ filter: /.*/, namespace: 'unused-worker' }, () => ({ contents: 'export default class UnusedWorker { constructor(){ throw Error("No editor worker is used in this Focus scene") } }', loader: 'js' }))
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$|\.css$/ }, async ({ path }) => {
      const bytes = await readFile(path); inputs.set(path, hash(bytes))
      // Retain every actual dependency byte for explicit receipt reuse; esbuild
      // keeps its own installed-package loader and resolution behavior.
      if (!path.startsWith(root+'/') || path.includes('/node_modules/')) return
      const name = path.slice(path.lastIndexOf('/')+1)
      if (['SessionPane.tsx','EditorPane.tsx','GitBranchDiffPane.tsx','FileSurfaceView.tsx'].includes(name)) {
        isolated.push({ path: relative(root, path), source: hash(bytes), reason: 'PTY/editor painting only; original Store/navigation/projection is compiled and used.' })
        return { contents: `export function ${name.slice(0,-4)}(){return null}`, loader: 'tsx' }
      }
      return { contents: bytes.toString(), loader: path.endsWith('.css') ? 'css' : path.endsWith('.tsx') ? 'tsx' : 'ts' }
    })
  } }
  const out = join(privateRoot, 'out'); await mkdir(out)
  for (const path of [new URL(import.meta.url).pathname, join(fixture,'entry.mjs'), join(fixture,'main.cjs'), join(root,'pnpm-lock.yaml')]) inputs.set(path, hash(await readFile(path)))
  await build({ entryPoints: [join(fixture, 'entry.mjs')], outfile: join(out, 'app.js'), bundle: true, platform: 'browser', format: 'esm',
    target: 'es2022', jsx: 'automatic', plugins: [sources], logLevel: 'silent',
    alias: { react: join(desktop,'node_modules/react'), 'react-dom': join(desktop,'node_modules/react-dom'), 'react-dom/server': join(desktop,'node_modules/react-dom/server.browser.js') },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.png':'file','.svg':'file','.woff2':'file','.woff':'file','.ttf':'file' } })
  const html = join(out, 'index.html'); await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="app.css"><style>html,body,#root{height:100%;margin:0}body{background:var(--bg-1)}</style><div id="root"></div><script type="module" src="app.js"></script></html>')
  receipt.inputs = Object.fromEntries([...inputs].map(([path, sha]) => [relative(root,path),sha]))
  for (const file of ['GlobalFocusSurface.tsx','SessionStop.tsx','FocusContextMenu.tsx','AgentMenuContent.tsx','ConfirmationDialog.tsx','store.ts']) assert.ok([...inputs.keys()].some(path => path.endsWith('/'+file)), file)
  receipt.compiled = { renderer: hash(await readFile(join(out,'app.js'))), css: hash(await readFile(join(out,'app.css'))) }
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot,'user-data'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot,'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot,'state') }; delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [join(fixture,'main.cjs'),html,privateRoot,evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  receipt.actual = JSON.parse(await readFile(join(evidence,'actual.json'),'utf8'))
  assert.equal(receipt.process.exitCode, 0, receipt.actual.failure?.message); assert.equal(receipt.actual.passed, true); assert.equal(receipt.actual.frames.length, 4)
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence,frame.file))) })))
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs].map(async ([path]) => [relative(root,path),hash(await readFile(path))])))
  receipt.parallelInputChanges = Object.keys(receipt.inputs).filter(path => receipt.sourceAfter[path] !== receipt.inputs[path])
  for (const suffix of ['SessionStop.tsx','GlobalFocusSurface.tsx']) { const path = Object.keys(receipt.inputs).find(path => path.endsWith('/'+suffix)); assert.equal(receipt.sourceAfter[path], receipt.inputs[path]) }
  receipt.capturedPass = true
} catch(error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await writeFile(join(evidence,'process.log'),logs.join('\n')); receipt.processLogSHA256 = hash(logs.join('\n'))
  receipt.cleanup = { privateRoot, remaining: await listProbeProcesses(-1, privateRoot), removed: false }
  if (!receipt.cleanup.remaining.length) { await rm(privateRoot,{recursive:true,force:true}); receipt.cleanup.removed = true }
  else { receipt.capturedPass = false; process.exitCode = 1 }
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
  console.log(JSON.stringify({ capturedPass: receipt.capturedPass, evidence, failure: receipt.failure?.message, aestheticReview: receipt.aestheticReview }))
}
