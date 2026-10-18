import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
const fixture = join(desktop, 'scripts/fixtures/closed-agent-tabs'), evidence = join(root, '.bagakit/closed-agent-tabs/electron')
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-closed-agent-tabs-'))
const require = createRequire(join(desktop, 'package.json')), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = new Map(), transformations = [], logs = []
const receipt = { schema: 'agentmux.closed-agent-tabs.restart.v1', passed: false, phases: [],
  boundary: 'Current production Store, WorkspaceWorkbench, Renderer spatial persistence and Core file spatial owner. Real distinct Main/Renderer PIDs and original userData/spatial.json across restart; private typed Session/Run facts, controlled stop transport and isolated PTY/editor paint. Public CLI reads the same spatial owner. No physical PTY survival, native vendor, visual-quality or user-installation claim.' }
await mkdir(evidence, { recursive: true })
try {
  const observe = { name: 'closed-agent-tabs-original-source-binding', setup(builder) {
    builder.onResolve({ filter: /\?raw$/ }, args => ({ path: resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'fixture-raw-text' }))
    builder.onLoad({ filter: /.*/, namespace: 'fixture-raw-text' }, async ({ path }) => { const bytes = await readFile(path, 'utf8'); inputs.set(path, hash(bytes)); return { contents: 'export default ' + JSON.stringify(bytes), loader: 'js' } })
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const bytes = await readFile(path, 'utf8'); inputs.set(path, hash(bytes)); const component = path.slice(path.lastIndexOf('/') + 1)
      if (['SessionPane.tsx', 'EditorPane.tsx', 'GitBranchDiffPane.tsx', 'NewTabSurface.tsx', 'SourceFilePreview.tsx', 'FilePreviewPane.tsx', 'FileSourceEditor.tsx', 'ReadonlyDiffEditor.tsx', 'ToolkitScriptEditor.tsx'].includes(component)) {
        const code = component === 'SessionPane.tsx'
          ? `import{createElement as h}from'react';import{useAppStore}from ${JSON.stringify(join(desktop, 'src/renderer/src/store.ts'))};export function SessionPane({sessionId}){const draft=useAppStore(s=>s.agentComposerDrafts[sessionId]??'');return h('section',null,h('span',null,'Private typed Agent '+sessionId),h('textarea',{value:draft,readOnly:true}))}`
          : `export function ${component.slice(0, -4)}(){return null}`
        transformations.push({ file: relative(root, path), purpose: 'Isolate PTY/editor paint only; original workface, lifecycle and persistence owners are unchanged', original: hash(bytes), loaded: hash(code) })
        return { contents: code, loader: 'js' }
      }
      return { contents: bytes, loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
    })
    builder.onLoad({ filter: /\.css$/ }, async ({ path }) => { if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return; const bytes = await readFile(path, 'utf8'); inputs.set(path, hash(bytes)); return { contents: bytes, loader: 'css' } })
  } }
  for (const file of [new URL(import.meta.url).pathname, join(root, 'packages/core/bin/amux'), ...['entry.mjs', 'main.cjs', 'preload.cjs'].map(name => join(fixture, name)),
    ...['spatial-state', 'spatial-graph', 'public-rpc-server', 'public-rpc-service', 'agentmux-cli-commands'].flatMap(name => ['src/' + name + '.ts', 'dist/' + name + '.js'].map(name => join(root, 'packages/core', name)))]) inputs.set(file, hash(await readFile(file)))
  const out = join(privateRoot, 'out'); await mkdir(out)
  const compiled = await build({ entryPoints: [join(fixture, 'entry.mjs')], outfile: join(out, 'app.js'), bundle: true, platform: 'browser', format: 'esm', target: 'es2022', jsx: 'automatic', metafile: true, plugins: [observe], logLevel: 'silent',
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.png': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  for (const name of ['store.ts', 'desktop-spatial-state.ts', 'session-state.ts', 'session-events.ts', 'WorkspaceWorkbench.tsx', 'StableWorkbenchView.tsx']) assert.ok([...inputs.keys()].some(file => file.endsWith('/' + name)), 'Original production consumer loaded: ' + name)
  receipt.inputs = Object.fromEntries([...inputs].map(([file, sha]) => [relative(root, file), sha])); receipt.transformations = transformations
  receipt.compiled = { renderer: hash(await readFile(join(out, 'app.js'))), css: hash(await readFile(join(out, 'app.css'))) }; receipt.moduleCount = Object.keys(compiled.metafile.inputs).length
  const html = join(out, 'index.html'); await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_MESSAGE_QUEUE_PATH: join(privateRoot, 'messages.ndjson') }; delete env.ELECTRON_RUN_AS_NODE
  for (const phase of ['first', 'second']) {
    await rm(join(evidence, phase + '.json'), { force: true })
    const exit = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), html, privateRoot, evidence, phase, join(root, 'packages/core/dist/index.js'), process.execPath, join(root, 'packages/core/bin/amux')],
      { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
    const actual = JSON.parse(await readFile(join(evidence, phase + '.json'), 'utf8')); receipt.phases.push({ phase, exit, actual })
    assert.equal(exit.timedOut, false); assert.equal(exit.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true)
  }
  const [first, second] = receipt.phases.map(one => one.actual)
  assert.notEqual(first.pid, second.pid); assert.notEqual(first.rendererPid, second.rendererPid)
  assert.equal(second.initial.seedCount, 0); assert.deepEqual(second.graphBeforeRenderer, first.graph)
  receipt.sourceAfter = Object.fromEntries(await Promise.all([...inputs.keys()].map(async file => [relative(root, file), hash(await readFile(file))])))
  assert.deepEqual(receipt.sourceAfter, receipt.inputs, 'Source must remain stable across this compiled proof')
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { privateRoot, remaining, removed: false }
  if (remaining.length === 0) { await rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.removed = true }
  if (remaining.length) { receipt.passed = false; process.exitCode = 1 }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, evidence, failure: receipt.failure?.message, cleanup: receipt.cleanup }))
}
