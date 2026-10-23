import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mutateMessageSlotScope } from './layout-mutations.mjs'
import { candidateAlias, candidateModule } from '../../candidate-package-resolve.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function captureA2aOriginalReading({ root, evidence, layout = false, styleMutation = null }) {
  assert.ok(!styleMutation || layout, 'Slot mutations belong to the layout proof')
  const desktop = resolve(root, 'apps/desktop'), fixture = resolve(desktop, 'scripts/fixtures/a2a-original-reading')
  const require = createRequire(resolve(desktop, 'package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const { runProbeProcess, listProbeProcesses, stopProbeProcesses } = await import(pathToFileURL(resolve(desktop, 'scripts/probe-process.mjs')).href)
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'amx-a2a-original-reading-')), compiled = resolve(privateRoot, 'compiled')
  const inputs = {}, artifacts = [], receipt = { schema: 'agentmux.a2a-original-reading-capture.v1', completed: false,
    captureOnly: true, aestheticReview: 'not-performed', privateRoot, inputs, artifacts, transforms: [], userRunTouched: false }
  function bindBytes(file, bytes) {
    const key = relative(root, file)
    assert.ok(bytes.length > 0, 'Nonempty consumed source: ' + key)
    if (inputs[key]) assert.equal(inputs[key].sha256, hash(bytes), 'Consumed source remains fixed: ' + key)
    else inputs[key] = { sha256: hash(bytes), bytes: bytes.length }
    return bytes
  }
  async function bind(file) { return bindBytes(file, await readFile(file)) }
  try {
    await mkdir(evidence, { recursive: true })
    for (const file of ['package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'apps/desktop/package.json', 'apps/desktop/scripts/probe-process.mjs', 'apps/desktop/scripts/candidate-package-resolve.mjs']) await bind(resolve(root, file))
    for (const entry of await readdir(fixture, { withFileTypes: true })) if (entry.isFile()) await bind(resolve(fixture, entry.name))
    const alias = [candidateAlias(root, { browser: true, source: true, onManifest: bindBytes })]
    for (const name of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client']) alias.push({ find: new RegExp('^' + name + '$'), replacement: require.resolve(name) })
    const candidate = { name: 'bind-actual-a2a-original-renderer', enforce: 'pre', async transform(code, id) {
        const file = id.split('?')[0]
        if (resolve(file) === file) {
          const actual = candidateModule(root, file)
          if (actual.startsWith(root + '/') && !actual.includes('/node_modules/')) await bind(actual)
        }
      } }
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias, dedupe: ['react', 'react-dom'] }, esbuild: { jsx: 'automatic' }, worker: { format: 'es', plugins: () => [candidate] },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, plugins: [candidate],
      css: { postcss: { plugins: [{ postcssPlugin: 'bind-actual-a2a-original-css', async Once(styles) {
        const files = new Set(); styles.walk(node => { if (node.source?.input.file) files.add(node.source.input.file.split('?')[0]) })
        for (const file of files) {
          const actual = candidateModule(root, file)
          if (actual.startsWith(root + '/') && !actual.includes('/node_modules/')) await bind(actual)
        }
        const owner = resolve(root, 'packages/client-ui/src/styles/conversation-message.css')
        if (styleMutation && files.has(owner)) {
          const original = styles.toString(), changes = mutateMessageSlotScope(styles, styleMutation, owner)
          receipt.transforms.push({ file: relative(root, owner), stage: 'postcss-imported-styles', original: hash(original),
            changed: hash(styles.toString()), changes, mutation: styleMutation })
        }
      } }] } },
      build: { target: 'esnext', outDir: compiled, sourcemap: false, minify: false, emptyOutDir: true,
        rollupOptions: { input: resolve(fixture, layout ? 'layout.html' : 'index.html') } } })
    if (styleMutation) assert.equal(receipt.transforms.length, 1, 'The loaded product stylesheet received exactly one mutation')
    for (const target of [
      'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx', 'apps/desktop/src/renderer/src/lib/api.ts',
      'packages/client-ui/src/components/ConversationMessage.tsx', 'packages/client-ui/src/components/ConversationInputText.tsx',
      'packages/client-ui/src/components/ConversationA2AReferences.tsx', 'packages/client-ui/src/components/AgentMarkdown.tsx',
      'packages/client-ui/src/styles/conversation-message.css', 'packages/client-ui/src/styles/conversation-protocol.css',
      'packages/client-ui/src/styles/markdown.css'
    ]) assert.ok(inputs[target], 'Actual product consumer is compiled: ' + target)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const lines = []
    receipt.process = await runProbeProcess(require('electron'), [resolve(fixture, layout ? 'layout-main.cjs' : 'main.cjs'), resolve(compiled, layout ? 'layout.html' : 'index.html'), privateRoot, evidence],
      { cwd: root, env, timeoutMs: 60000, onLine: line => lines.push(line) })
    await writeFile(resolve(evidence, 'process.log'), lines.join('\n') + '\n')
    receipt.render = JSON.parse(await readFile(resolve(evidence, 'render.json')))
    assert.equal(receipt.process.exitCode, 0, JSON.stringify(receipt.render.failure)); assert.equal(receipt.process.timedOut, false)
    assert.equal(receipt.render.passed, true); assert.equal(receipt.render.frames.length, layout ? 13 : 8)
    receipt.frames = receipt.render.frames.map(frame => ({ ...frame, path: resolve(evidence, frame.file) }))
    receipt.sourceIdentity = hash(JSON.stringify(Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)))))
    receipt.completed = true
  } catch (error) { receipt.failure = String(error.stack ?? error) }
  finally {
    receipt.drift = []
    for (const [file, identity] of Object.entries(inputs)) if (hash(await readFile(resolve(root, file))) !== identity.sha256) receipt.drift.push(file)
    if (receipt.drift.length) receipt.completed = false
    async function collect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = resolve(directory, entry.name)
        if (entry.isDirectory()) await collect(file)
        else { const bytes = await readFile(file); artifacts.push({ file: relative(compiled, file), sha256: hash(bytes), bytes: bytes.length }) }
      }
    }
    if (existsSync(compiled)) await collect(compiled)
    try { await stopProbeProcesses(-1, privateRoot) }
    catch (error) { receipt.cleanupFailure = String(error.stack ?? error); receipt.completed = false }
    receipt.remainingPrivateProcesses = await listProbeProcesses(-1, privateRoot)
    if (!receipt.remainingPrivateProcesses.length) { await rm(privateRoot, { recursive: true }); receipt.privateRootRemoved = true }
    else { receipt.privateRootRemoved = false; receipt.completed = false }
    await writeFile(resolve(evidence, 'capture.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  assert.equal(receipt.completed, true, receipt.failure ?? receipt.cleanupFailure ?? receipt.drift.join(', ')); return receipt
}
