import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve, relative } from 'node:path'
import { loadConfigFromFile } from 'vite'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
import { radixOverlayAliases } from './radix-overlay-aliases.ts'

const root = resolve(import.meta.dirname, '../../..'), desktop = join(root, 'apps/desktop'), fixture = join(desktop, 'scripts/fixtures/quick-switch-craft')
const evidence = process.env.AGENTMUX_EVIDENCE_ROOT ?? join(root, '.tmp/quick-switch-craft')
const directory = join(evidence, 'visual-' + randomUUID()), temporary = await mkdtemp(join(tmpdir(), 'amux-quick-craft-')), output = join(temporary, 'compiled')
await mkdir(directory, { recursive: true }); await mkdir(output, { recursive: true })
const require = createRequire(join(desktop, 'package.json')), { build } = createRequire(require.resolve('vite/package.json'))('esbuild')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), loaded = {}, styles = {}, transformations = [], logs = []
const config = (await loadConfigFromFile({ command: 'build', mode: 'production' }, join(desktop, 'test/vitest.ui-controls-owning.config.mts'))).config
const aliases = [{ find: 'react-dom/server', replacement: require.resolve('react-dom/server.browser') },
  ...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement })), ...config.resolve.alias.filter(alias => alias.find !== 'react' && alias.find !== 'react-dom')]
const receipt = { passed: false, loaded, styles, transformations, captureOnly: true, aestheticReview: 'not-performed', userRunTouched: false }
try {
  const source = { name: 'quick-switch-actual-source', setup(builder) {
    builder.onResolve({ filter: /monaco-editor.*\?worker$/ }, async args => {
      const resolved = await builder.resolve(args.path.replace(/\?worker$/, ''), { resolveDir: args.resolveDir, kind: args.kind })
      transformations.push({ file: resolved.path, reason: 'Unopened editor worker; construction fails this scenario' }); return { path: resolved.path, namespace: 'unopened-editor-worker' }
    })
    builder.onLoad({ filter: /.*/, namespace: 'unopened-editor-worker' }, () => ({ contents: "export default class {constructor(){throw new Error('Uncovered editor worker invoked')}}", loader: 'js' }))
    builder.onResolve({ filter: /.*/ }, async args => {
      if (args.pluginData?.originalAlias) return
      for (const alias of aliases) {
        const match = typeof alias.find === 'string' ? args.path === alias.find || args.path.startsWith(alias.find + '/') : alias.find.test(args.path)
        if (match) return builder.resolve(typeof alias.find === 'string' ? alias.replacement + args.path.slice(alias.find.length) : args.path.replace(alias.find, alias.replacement),
          { resolveDir: root, kind: args.kind, pluginData: { originalAlias: true } })
      }
    })
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, async ({ path }) => {
      if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
      const bytes = await readFile(path, 'utf8'), file = relative(root, path), name = basename(path)
      loaded[file] = hash(bytes)
      if (['TerminalView.tsx', 'EditorPane.tsx', 'GitBranchDiffPane.tsx', 'FileSourceEditor.tsx', 'PdfContent.tsx', 'ExcalidrawFilePreview.tsx', 'GitDiffCanvas.tsx', 'ToolkitScriptEditor.tsx', 'DiagramFilePreview.tsx', 'DotFilePreview.tsx', 'DrawioFilePreview.tsx'].includes(name)) {
        const symbol = name.slice(0, -4), code = `export function ${symbol}(){throw new Error('Uncovered paint leaf invoked')};export default ${symbol}`
        transformations.push({ file, original: hash(bytes), consumed: hash(code), reason: 'Unopened editor, PTY or diagram paint leaf; no switcher or file-discovery implementation replaced.' })
        return { contents: code, loader: 'js' }
      }
      return { contents: bytes, loader: path.endsWith('tsx') ? 'tsx' : path.endsWith('ts') ? 'ts' : 'js' }
    })
    builder.onLoad({ filter: /\.css$/ }, async ({ path }) => { const bytes = await readFile(path); if (path.startsWith(root + '/')) styles[relative(root, path)] = hash(bytes); return { contents: bytes.toString(), loader: 'css' } })
  } }
  await build({ entryPoints: [join(fixture, 'entry.tsx')], outfile: join(output, 'app.js'), bundle: true, platform: 'browser', conditions: ['browser', 'production'], format: 'esm', target: 'es2022', jsx: 'automatic', minify: true,
    plugins: [source], logLevel: 'silent', define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    loader: { '.png': 'file', '.gif': 'file', '.jpg': 'file', '.jpeg': 'file', '.webp': 'file', '.svg': 'file', '.woff2': 'file', '.woff': 'file', '.ttf': 'file' } })
  for (const file of ['components/QuickSwitcher.tsx', 'components/QuickOpenFiles.tsx', 'lib/quick-switch.ts', 'components/SurfaceModeSwitch.tsx']) {
    const path = 'apps/desktop/src/renderer/src/' + file; assert.equal(loaded[path], hash(await readFile(join(root, path))), 'Actual production module consumed: ' + path)
  }
  assert.equal(styles['apps/desktop/src/renderer/src/styles/overlays.css'], hash(await readFile(join(desktop, 'src/renderer/src/styles/overlays.css'))))
  receipt.compiled = { renderer: hash(await readFile(join(output, 'app.js'))), css: hash(await readFile(join(output, 'app.css'))) }
  const html = join(output, 'index.html')
  await writeFile(html, '<!doctype html><html><meta charset="utf-8"><link rel="stylesheet" href="./app.css"><div id="root"></div><script type="module" src="./app.js"></script></html>')
  await writeFile(join(directory, 'compiled-source.json'), JSON.stringify({ loaded, styles, transformations, compiled: receipt.compiled }, null, 2))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), html, temporary, directory],
    { temporaryRoot: temporary, cwd: root, env, timeoutMs: 60000, onLine: line => logs.push(line) })
  receipt.actual = JSON.parse(await readFile(join(directory, 'render.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0, receipt.actual.failure?.message); assert.equal(receipt.actual.passed, true)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await writeFile(join(directory, 'native.log'), logs.join('\n'))
  const remaining = await listProbeProcesses(-1, temporary); receipt.cleanup = { remaining, temporaryRemoved: false }
  if (!remaining.length) { await rm(temporary, { recursive: true }); receipt.cleanup.temporaryRemoved = true }
  await writeFile(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2))
  console.log(JSON.stringify({ passed: receipt.passed, directory, frames: receipt.actual?.frames?.length ?? 0, failure: receipt.failure?.message }))
}
