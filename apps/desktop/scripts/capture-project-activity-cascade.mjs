import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
let evidenceArgument, mutation
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index], value = process.argv[index + 1]
  assert.ok(value && ['--evidence', '--mutation'].includes(flag), 'Use optional --evidence <directory> and --mutation branch-protection|narrow-reader-escape')
  if (flag === '--evidence') { assert.equal(evidenceArgument, undefined); evidenceArgument = value }
  else { assert.equal(mutation, undefined); assert.ok(['branch-protection', 'narrow-reader-escape'].includes(value)); mutation = value }
}
const evidence = evidenceArgument ? resolve(evidenceArgument) : join(root, '.bagakit/feature-tracker/activity-cascade/visual', ...(mutation ? [mutation] : []))
await mkdir(evidence, { recursive: true })
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-activity-cascade-')), fixture = join(desktop, 'scripts/fixtures/project-activity-cascade')
const require = createRequire(join(desktop, 'package.json')), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = new Map(), transformations = [], logs = []
const receipt = { schema: 'agentmux.project-activity-cascade-scene.v1', passed: false, aestheticReview: 'not-performed', userRuntimeControlled: false, mutation: mutation ?? null,
  boundary: 'Compiled production ProjectActivity/menu/shared Agent row/reader/Store/navigation/overlay/CSS with explicit typed preview Session/timeline data. Actual Core filesystem spatial owner via private IPC, original Store initialization and execution identity consumer. Unmounted PTY/editor/Launcher paint isolated. No user application, Provider process, physical OS input, Session restart or installation.' }
try {
  const observe = { name: 'actual-project-activity-cascade-source', setup(builder) {
    builder.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'fixture-raw-text' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture-raw-text' }, async ({ path }) => { const source = await readFile(path, 'utf8'); inputs.set(path, hash(source)); return { contents: 'export default ' + JSON.stringify(source), loader: 'js' } })
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const source = await readFile(path, 'utf8'); inputs.set(path, hash(source)); const component = path.slice(path.lastIndexOf('/') + 1)
      if (mutation === 'branch-protection' && component === 'HoverDropdownMenu.tsx') {
        const anchor = 'if (menu.containsBranch(event.target)) event.preventDefault()'
        const count = source.split(anchor).length - 1
        assert.equal(count, 3, 'The actual owning branch interaction/focus guards exist and are nonempty')
        const code = source.replaceAll(anchor, 'if (false) event.preventDefault()')
        transformations.push({ path: relative(root, path), mutation, occurrences: count, sourceSHA256: hash(source), loadedSHA256: hash(code) })
        return { contents: code, loader: 'tsx' }
      }
      if (mutation === 'narrow-reader-escape' && component === 'ProjectActivityMenu.tsx') {
        const anchor = 'if (event.defaultPrevented || !activeGroup) return'
        assert.equal(source.split(anchor).length - 1, 1, 'The actual narrow menu defers Escape to its original Reader branch')
        const code = source.replace(anchor, 'if (!activeGroup) return')
        transformations.push({ path: relative(root, path), mutation, occurrences: 1, sourceSHA256: hash(source), loadedSHA256: hash(code) })
        return { contents: code, loader: 'tsx' }
      }
      if (['SessionPane.tsx', 'EditorPane.tsx', 'GitBranchDiffPane.tsx', 'NewTabSurface.tsx', 'ExcalidrawFilePreview.tsx', 'PdfContent.tsx', 'monaco.ts'].includes(component)) {
        const code = component === 'monaco.ts' ? 'export {}' : `export function ${component.slice(0, -4)}(){return null}`
        transformations.push({ path: relative(root, path), isolated: 'Unmounted native/editor/Launcher paint; no product state, navigation or reading owner replaced', sourceSHA256: hash(source), loadedSHA256: hash(code) })
        return { contents: code, loader: 'js' }
      }
      return { contents: source, loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
    })
    builder.onLoad({ filter: /\.css$/ }, async ({ path }) => { if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return; const source = await readFile(path, 'utf8'); inputs.set(path, hash(source)); return { contents: source, loader: 'css' } })
  } }
  for (const path of [join(fixture, 'entry.tsx'), join(fixture, 'main.cjs'), join(fixture, 'scene.md'), new URL(import.meta.url).pathname]) inputs.set(path, hash(await readFile(path)))
  const out = join(privateRoot, 'compiled'); await mkdir(out)
  const compiled = await build({ entryPoints: [join(fixture, 'entry.tsx')], outfile: join(out, 'app.js'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', metafile: true, plugins: [observe], logLevel: 'silent',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.png': 'file', '.gif': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  receipt.metafile = compiled.metafile; receipt.transformations = transformations
  if (mutation) assert.equal(transformations.filter(item => item.mutation === mutation).length, 1, 'Exactly one original product owner is mutated in compiled bytes')
  for (const suffix of ['ProjectActivity.tsx', 'ProjectActivityMenu.tsx', 'AgentInformationPreview.tsx', 'AgentInformationReader.tsx', 'WindowOverlayHost.tsx', 'store.ts', 'desktop-spatial-state.ts'])
    assert.ok([...inputs.keys()].some(path => path.endsWith('/' + suffix)), 'Nonempty actual compiled input ' + suffix)
  const coreOwner = join(root, 'packages/core/dist/spatial-state.js')
  inputs.set(coreOwner, hash(await readFile(coreOwner)))
  receipt.inputs = Object.fromEntries([...inputs].map(([path, sha]) => [relative(root, path), sha]))
  const html = join(out, 'index.html'); await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  receipt.compiled = { renderer: hash(await readFile(join(out, 'app.js'))), css: hash(await readFile(join(out, 'app.css'))), coreOwner: hash(await readFile(coreOwner)) }
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), html, coreOwner, privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90000, onLine: line => logs.push(line) })
  receipt.actual = JSON.parse(await readFile(join(evidence, 'actual.json'), 'utf8'))
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) })))
  assert.equal(receipt.process.exitCode, 0, receipt.actual.failure?.message); assert.equal(receipt.actual.passed, true)
  assert.ok(receipt.frames.length >= 3, 'Wide cascade, shared reader and narrow cascade are captured')
  receipt.after = Object.fromEntries(await Promise.all([...inputs.keys()].map(async path => [relative(root, path), hash(await readFile(path))])))
  assert.deepEqual(receipt.after, receipt.inputs, 'The loaded product sources stay stable throughout capture')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { remaining, removed: false, evidencePreserved: true, compiledBytesPreserved: false }
  if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, evidence: relative(root, evidence), failure: receipt.failure?.message, pendingIndependentVisualReview: true }))
}
