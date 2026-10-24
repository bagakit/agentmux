import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { candidateAlias, candidateModule } from '../../candidate-package-resolve.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function capturePrimaryReading({ root, evidence, scene }) {
  const desktop = resolve(root, 'apps/desktop'), fixture = resolve(desktop, 'scripts/fixtures/a2a-primary-reading')
  const require = createRequire(resolve(desktop, 'package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const { runProbeProcess, listProbeProcesses, stopProbeProcesses } = await import(pathToFileURL(resolve(desktop, 'scripts/probe-process.mjs')).href)
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'amx-primary-reading-')), compiled = resolve(privateRoot, 'compiled')
  const receipt = { schema: 'agentmux.a2a-primary-reading-capture.v1', completed: false, captureOnly: true,
    aestheticReview: 'not-performed', userRunTouched: false, inputs: {}, sceneSha256: hash(await readFile(scene)) }
  const bind = (file, bytes) => {
    const path = relative(root, file), digest = hash(bytes)
    assert.ok(bytes.length > 0, 'Nonempty actual Renderer input: ' + path)
    if (receipt.inputs[path]) assert.equal(receipt.inputs[path], digest, 'One consumed Renderer candidate: ' + path)
    else receipt.inputs[path] = digest
  }
  try {
    await mkdir(evidence, { recursive: true })
    for (const name of await readdir(fixture)) { const file = resolve(fixture, name); bind(file, await readFile(file)) }
    const alias = [candidateAlias(root, { browser: true, source: true, onManifest: bind })]
    for (const name of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client']) alias.push({ find: new RegExp('^' + name + '$'), replacement: require.resolve(name) })
    const candidate = { name: 'actual-primary-reading-input', enforce: 'pre', async transform(_code, id) {
      const file = id.split('?')[0]
      if (resolve(file) !== file) return
      const actual = candidateModule(root, file)
      if (actual.startsWith(root + '/') && !actual.includes('/node_modules/')) bind(actual, await readFile(actual))
    } }
    const sceneBytes = await readFile(scene, 'utf8')
    const scenePlugin = { name: 'actual-public-reader-scene', resolveId: id => id === 'virtual:a2a-primary-scene' ? '\0a2a-primary-scene' : undefined,
      load: id => id === '\0a2a-primary-scene' ? 'export default ' + sceneBytes : undefined }
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias, dedupe: ['react', 'react-dom'] },
      esbuild: { jsx: 'automatic' }, worker: { format: 'es', plugins: () => [candidate] },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, plugins: [scenePlugin, candidate],
      css: { postcss: { plugins: [{ postcssPlugin: 'actual-primary-reading-css', async Once(styles) {
        const files = new Set(); styles.walk(node => { if (node.source?.input.file) files.add(node.source.input.file.split('?')[0]) })
        for (const file of files) { const actual = candidateModule(root, file); if (actual.startsWith(root + '/') && !actual.includes('/node_modules/')) bind(actual, await readFile(actual)) }
      } }] } },
      build: { target: 'esnext', outDir: compiled, sourcemap: false, minify: false, emptyOutDir: true, rollupOptions: { input: resolve(fixture, 'index.html') } } })
    for (const file of ['apps/desktop/src/renderer/src/components/ActivityView.tsx', 'apps/mobile/src/conversation/MobileConversationSurface.tsx',
      'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx', 'packages/client-ui/src/components/ConversationMessage.tsx',
      'packages/client-ui/src/components/ConversationA2AReferences.tsx', 'packages/client-ui/src/components/ConversationNotificationDetails.tsx',
      'packages/client-ui/src/styles/conversation-message.css']) assert.ok(receipt.inputs[file], 'Actual product consumer compiled: ' + file)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const lines = []
    receipt.process = await runProbeProcess(require('electron'), [resolve(fixture, 'main.cjs'), resolve(compiled, 'index.html'), privateRoot, evidence],
      { cwd: root, env, timeoutMs: 60000, onLine: line => lines.push(line) })
    await writeFile(resolve(evidence, 'process.log'), lines.join('\n') + '\n')
    receipt.render = JSON.parse(await readFile(resolve(evidence, 'render.json'), 'utf8'))
    assert.equal(receipt.process.exitCode, 0, JSON.stringify(receipt.render.failure)); assert.equal(receipt.process.timedOut, false)
    assert.equal(receipt.render.passed, true); assert.equal(receipt.render.frames.length, 18)
    receipt.sourceIdentity = hash(JSON.stringify(Object.fromEntries(Object.entries(receipt.inputs).sort(([a], [b]) => a.localeCompare(b)))))
    receipt.completed = true
  } catch (error) { receipt.failure = String(error.stack ?? error) }
  finally {
    receipt.drift = []
    for (const [file, digest] of Object.entries(receipt.inputs)) if (hash(await readFile(resolve(root, file))) !== digest) receipt.drift.push(file)
    if (receipt.drift.length) receipt.completed = false
    await stopProbeProcesses(-1, privateRoot)
    receipt.remainingPrivateProcesses = await listProbeProcesses(-1, privateRoot)
    if (!receipt.remainingPrivateProcesses.length) { await rm(privateRoot, { recursive: true }); receipt.privateRootRemoved = true }
    else { receipt.privateRootRemoved = false; receipt.completed = false }
    await writeFile(resolve(evidence, 'capture.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  assert.equal(receipt.completed, true, receipt.failure ?? receipt.drift.join(', ')); return receipt
}
