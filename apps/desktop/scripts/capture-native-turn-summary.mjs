import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop')
assert.equal(process.argv[2], '--evidence'); assert.ok(process.argv[3]); assert.equal(process.argv.length, 4)
const evidence = resolve(process.argv[3]); await mkdir(evidence, { recursive: true })
const privateRoot = await mkdtemp(join(tmpdir(), 'amux-turn-summary-')), fixture = join(desktop, 'scripts/fixtures/native-turn-summary')
const require = createRequire(join(desktop, 'package.json')), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const hash = value => createHash('sha256').update(value).digest('hex'), inputs = new Map(), logs = []
const receipt = { capturedPass: false, aestheticReview: 'not-performed', userAppRunRuntimeControlled: false, transformations: [], inputs: {} }
try {
  const sourceBinding = { name: 'actual-turn-summary-source', setup(builder) { builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
    if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
    const source = await readFile(path, 'utf8'); inputs.set(path, hash(source)); const name = path.slice(path.lastIndexOf('/') + 1)
    if (['TerminalView.tsx', 'EditorPane.tsx', 'GitBranchDiffPane.tsx', 'FileSourceEditor.tsx', 'PdfContent.tsx', 'ExcalidrawFilePreview.tsx', 'GitDiffCanvas.tsx', 'ToolkitScriptEditor.tsx'].includes(name)) {
      const code = `export function ${name.slice(0, -4)}(){return null}`; receipt.transformations.push({ file: relative(root, path), sourceSHA256: hash(source), loadedSHA256: hash(code), reason: 'Unused PTY/file/Monaco paint leaf; this preview only reads Activity.' }); return { contents: code, loader: 'js' }
    }
    return { contents: source, loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
  }); builder.onLoad({ filter: /\.css$/ }, async ({ path }) => { if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return; const source = await readFile(path); inputs.set(path, hash(source)); return { contents: source.toString(), loader: 'css' } }) } }
  const out = join(privateRoot, 'out'); await mkdir(out)
  await build({ entryPoints: [join(fixture, 'entry.tsx')], outfile: join(out, 'app.js'), bundle: true, platform: 'browser', conditions: ['browser', 'production'], format: 'esm', target: 'es2022', jsx: 'automatic', plugins: [sourceBinding], logLevel: 'silent', define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, loader: { '.png': 'file', '.gif': 'file', '.jpg': 'file', '.jpeg': 'file', '.webp': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  for (const suffix of ['App.tsx', 'WorkspaceWorkbench.tsx', 'SessionPane.tsx', 'ActivityView.tsx', 'ConversationRecordSequence.tsx', 'NativeProcessObservation.tsx', 'ConversationMetrics.tsx', 'conversation-metrics.css']) assert.ok([...inputs.keys()].some(file => file.endsWith('/' + suffix)), 'Actual loaded source: ' + suffix)
  inputs.set(join(fixture, 'main.cjs'), hash(await readFile(join(fixture, 'main.cjs')))); inputs.set(new URL(import.meta.url).pathname, hash(await readFile(new URL(import.meta.url))))
  receipt.inputs = Object.fromEntries([...inputs].map(([file, digest]) => [relative(root, file), digest]))
  receipt.compiled = { renderer: hash(await readFile(join(out, 'app.js'))), css: hash(await readFile(join(out, 'app.css'))) }
  const html = join(out, 'index.html'); await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  const env = { ...process.env, AGENTMUX_DESKTOP_USER_DATA: join(privateRoot, 'user-data'), AGENTMUX_RUNTIME_DIRECTORY: join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), html, privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  receipt.actual = JSON.parse(await readFile(join(evidence, 'actual.json'), 'utf8')); assert.equal(receipt.process.exitCode, 0, receipt.actual.failure?.message); assert.equal(receipt.actual.passed, true)
  receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) }))); assert.equal(receipt.frames.length, 7)
  const after = Object.fromEntries(await Promise.all([...inputs.keys()].map(async file => [relative(root, file), hash(await readFile(file))]))); assert.deepEqual(after, receipt.inputs, 'Candidate source stable during capture'); receipt.capturedPass = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1
} finally { await writeFile(join(evidence, 'process.log'), logs.join('\n')); const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { privateRoot, remaining, removed: false }; if (!remaining.length) { await rm(privateRoot, { recursive: true }); receipt.cleanup.removed = true }; await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n'); console.log(JSON.stringify({ capturedPass: receipt.capturedPass, failure: receipt.failure?.message, evidence })) }
