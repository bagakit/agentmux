import { browserSourceBuild } from '../../../../../packages/browser/scripts/source-build.mjs'
import fs from 'node:fs/promises'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { mkdtemp } from 'node:fs/promises'
import { aliases, root, desktopRequire, installedDependency } from '../conversation-style-entry/environment.mjs'
import { workspaceSources } from '../topic-promotion/source-build.mjs'
import { radixOverlayAliases } from '../../../../../packages/client-ui/scripts/radix-overlay-aliases.ts'
import { runProbeProcess, listProbeProcesses, stopProbeProcesses } from '../../probe-process.mjs'
const fixture = import.meta.dirname, sha = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = path.join(root, '.bagakit/mote-floating-reading-continuity', 'physical-' + crypto.randomUUID())
const privateRoot = await mkdtemp('/tmp/amux-mrc-'), compiled = path.join(directory, 'compiled')
await fs.mkdir(compiled, { recursive: true }); await fs.mkdir(path.join(privateRoot, 'home'))
const receipt = { passed: false, directory: path.relative(root, directory), source: {}, loaded: [], boundary: 'Synthetic original source only. Real App/Mote/Activity/ConversationView and Core/Unix/Main/preload/strict Renderer read. Private Chromium physical geometry; no original App IPC, Run, OS input or activation.', privateRoot }
const { build: viteBuild } = await import(desktopRequire.resolve('vite'))
const { build } = browserSourceBuild(createRequire(desktopRequire.resolve('vite'))('esbuild'))
try {
  const reuse = process.env.AGENTMUX_READING_RENDERER_RECEIPT
  if (reuse) {
    const previous = JSON.parse(await fs.readFile(path.resolve(root, reuse), 'utf8'))
    receipt.reusedInputDrift = []
    for (const file of previous.loaded.filter(file => /\.[cm]?[jt]sx?$/u.test(file))) {
      if (sha(await fs.readFile(path.resolve(root, file))) === previous.source[file]) continue
      receipt.reusedInputDrift.push(file)
      assert.ok(process.env.AGENTMUX_READING_DIAGNOSTIC_REUSE === '1' && /focus-collection-lanes/u.test(file), 'Cannot reuse changed Renderer input: ' + file)
    }
    receipt.diagnosticOnly = receipt.reusedInputDrift.length > 0
    await fs.cp(path.join(path.dirname(path.resolve(root, reuse)), 'compiled'), compiled, { recursive: true })
    receipt.source = { ...previous.source }; receipt.loaded = [...previous.loaded]; receipt.rendererReusedFrom = reuse
  } else {
  await viteBuild({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' },
    resolve: { alias: [{ find: /^react-dom\/server$/, replacement: desktopRequire.resolve('react-dom/server.browser') }, { find: /^jsonc-parser$/, replacement: path.join(path.dirname(desktopRequire.resolve('jsonc-parser/package.json')), 'lib/esm/main.js') }, ...Object.entries(radixOverlayAliases).map(([find, replacement]) => ({ find, replacement })), ...aliases] },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, worker: { format: 'es' },
    plugins: [{ name: 'original-mote-reading-inputs', enforce: 'pre', resolveId(source, importer) { return installedDependency(source, importer) },
      transform(code, id) { const file = id.split('?')[0], relative = path.relative(root, file); if (file.startsWith(root + '/') && !relative.includes('node_modules/')) {
        receipt.source[relative] = sha(code); receipt.loaded.push(relative)
        if (['apps/desktop/src/renderer/src/App.tsx', 'apps/desktop/src/renderer/src/components/ActivityView.tsx', 'packages/client-ui/src/lib/use-conversation-view.ts', 'packages/client-ui/src/components/ConversationView.tsx'].includes(relative))
          return { code: code + `\n;(globalThis.__moteReadingExecuted??=[]).push(${JSON.stringify({path:relative,sha256:sha(code)})});\n`, map: null }
      } }
    }], build: { outDir: compiled, emptyOutDir: false, minify: false, rollupOptions: { input: path.join(fixture, 'index.html') } } })
  }
  for (const [entry, outfile] of [['main.ts', 'main.mjs'], ['preload.ts', 'preload.cjs']]) {
    const sourceMetadata = { name: 'preserve-original-module-source', setup(plugin) {
      plugin.onLoad({ filter: /\.(?:ts|mjs)$/ }, async args => ({ loader: args.path.endsWith('.ts') ? 'ts' : 'js', contents: (await fs.readFile(args.path, 'utf8'))
        .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href))
        .replaceAll('import.meta.dirname', JSON.stringify(path.dirname(args.path)))
        .replaceAll('import.meta.filename', JSON.stringify(args.path)) }))
    } }
    const output = await build({ absWorkingDir: root, entryPoints: [path.join(fixture, entry)], outfile: path.join(compiled, outfile), bundle: true, format: entry === 'main.ts' ? 'esm' : 'cjs', platform: 'node', target: 'node24',
      external: ['electron'], plugins: entry === 'main.ts' ? [sourceMetadata, workspaceSources()] : [], metafile: true, logLevel: 'error',
      banner: entry === 'main.ts' ? { js: "process.on('uncaughtException',error=>{console.error(error?.stack||error);process.exit(1)});" } : {},
      ...(entry === 'preload.ts' ? { alias: { '@agentmux/core/object-id': path.join(root, 'packages/core/src/object-id.ts'), '@agentmux/identity': path.join(root, 'packages/identity/src/index.ts') } } : {}) })
    for (const file of Object.keys(output.metafile.inputs)) receipt.source[file] = sha(await fs.readFile(path.resolve(root, file)))
  }
  const html = path.join(compiled, 'index.html')
  await fs.writeFile(html, (await fs.readFile(html, 'utf8')).replace('<head>', '<head><script>window.__readingStartupErrors=[];addEventListener("error",e=>window.__readingStartupErrors.push(String(e.error?.stack||e.message)));addEventListener("unhandledrejection",e=>window.__readingStartupErrors.push(String(e.reason?.stack||e.reason)));</script>'))
  for (const file of ['apps/desktop/src/renderer/src/App.tsx','apps/desktop/src/renderer/src/components/PmoTeamsTopicFloatingPanel.tsx','apps/desktop/src/renderer/src/components/ActivityView.tsx','packages/client-ui/src/components/ConversationView.tsx','packages/core/src/client.ts','packages/core/src/conversation-reader.ts','apps/desktop/src/main/conversation-read-ipc.ts','apps/desktop/src/preload/conversation-read.ts']) assert.ok(receipt.source[file], 'Actual owning input missing: ' + file)
  const env = { ...process.env, HOME: path.join(privateRoot, 'home'), AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'state'), AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'), AGENTMUX_MESSAGE_QUEUE_PATH: path.join(privateRoot, 'messages.sqlite'), XDG_RUNTIME_DIR: path.join(privateRoot, 'xdg-runtime') }
  delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  receipt.process = await runProbeProcess(desktopRequire('electron'), [path.join(compiled, 'main.mjs'), path.join(compiled, 'index.html'), privateRoot, directory], { cwd: root, env, timeoutMs: 45000, onLine: line => logs.push(line) })
  await fs.writeFile(path.join(directory, 'electron.log'), logs.join('\n'))
  receipt.physical = JSON.parse(await fs.readFile(path.join(directory, 'physical-result.json'), 'utf8'))
  assert.equal(receipt.process.exitCode, 0); assert.equal(receipt.physical.passed, true)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack } }
finally {
  const group = receipt.process?.originalPid
  if (group && (await listProbeProcesses(group, privateRoot)).length) await stopProbeProcesses(group, privateRoot)
  receipt.cleanup = { remaining: group ? await listProbeProcesses(group, privateRoot) : [] }
  await fs.writeFile(path.join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  await fs.writeFile(path.join(root, '.bagakit/mote-floating-reading-continuity/physical-latest.json'), JSON.stringify({receipt:path.relative(root,path.join(directory,'receipt.json'))})+'\n')
}
console.log(path.relative(root, path.join(directory, 'receipt.json')))
if (!receipt.passed) { console.error(receipt.failure); process.exitCode = 1 }
