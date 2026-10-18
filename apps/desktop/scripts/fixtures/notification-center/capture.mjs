import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
export async function captureNotificationCenter({ root, evidence }) {
  const desktop = resolve(root, 'apps/desktop'), fixture = resolve(desktop, 'scripts/fixtures/notification-center')
  const require = createRequire(resolve(desktop, 'package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href)
  const { runProbeProcess, listProbeProcesses } = await import(pathToFileURL(resolve(desktop, 'scripts/probe-process.mjs')).href)
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'amx-notification-center-')), compiled = resolve(privateRoot, 'compiled')
  const inputs = {}, artifacts = [], receipt = { schema: 'agentmux.notification-center-capture.v1', completed: false,
    captureOnly: true, aestheticReview: 'not-performed', privateRoot, inputs, artifacts, userRunTouched: false }
  async function bind(file) {
    const bytes = await readFile(file), key = relative(root, file)
    assert.ok(bytes.length > 0, 'Nonempty consumed source: ' + key)
    if (inputs[key]) assert.equal(inputs[key].sha256, hash(bytes), 'Consumed source remains fixed: ' + key)
    else inputs[key] = { sha256: hash(bytes), bytes: bytes.length }
    return bytes
  }
  try {
    await mkdir(evidence, { recursive: true })
    for (const file of ['package.json', 'pnpm-lock.yaml', 'apps/desktop/package.json', 'apps/desktop/scripts/probe-process.mjs']) await bind(resolve(root, file))
    for (const entry of await readdir(fixture, { withFileTypes: true })) if (entry.isFile()) await bind(resolve(fixture, entry.name))
    const alias = []
    for (const pkg of ['core', 'relay', 'demand', 'layout', 'client-ui', 'identity', 'diagnostic-evidence']) {
      const manifest = JSON.parse(await bind(resolve(root, `packages/${pkg}/package.json`)))
      for (const [key, value] of Object.entries(manifest.exports)) {
        const target = typeof value === 'string' ? value : value.types ?? value.import
        if (!target) continue
        const file = resolve(root, `packages/${pkg}/` + target.replace(/^\.\/dist\/(src\/)?/u, 'src/').replace(/\.d\.ts$/u, '.ts').replace(/\.js$/u, '.ts'))
        if (!existsSync(file.includes('*') ? file.slice(0, file.indexOf('*')) : file)) continue
        const name = '@agentmux/' + pkg + (key === '.' ? '' : key.slice(1))
        alias.push({ find: new RegExp('^' + name.replace(/[.+?^${}()|[\]\\]/gu, '\\$&').replace('*', '(.+)') + '$'), replacement: file.replace('*', '$1') })
      }
    }
    alias.sort((a, b) => String(b.find).length - String(a.find).length)
    for (const name of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client']) alias.push({ find: new RegExp('^' + name + '$'), replacement: require.resolve(name) })
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias, dedupe: ['react', 'react-dom'] }, esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
      plugins: [{ name: 'bind-actual-notification-renderer', enforce: 'pre', async transform(code, id) {
        const file = id.split('?')[0]
        if (file.startsWith(root + '/') && !file.includes('/node_modules/')) await bind(file)
      } }],
      css: { postcss: { plugins: [{ postcssPlugin: 'bind-actual-notification-css', async Once(styles) {
        const files = new Set(); styles.walk(node => { if (node.source?.input.file) files.add(node.source.input.file.split('?')[0]) })
        await Promise.all([...files].filter(file => file.startsWith(root + '/') && !file.includes('/node_modules/')).map(bind))
      } }] } },
      build: { target: 'esnext', outDir: compiled, sourcemap: false, minify: false, emptyOutDir: true } })
    for (const target of ['App.tsx', 'components/GlobalSystemNotices.tsx', 'components/NotificationItem.tsx', 'store.ts', 'styles/base.css', 'styles/service-notice.css'])
      assert.ok(inputs['apps/desktop/src/renderer/src/' + target], 'Actual product consumer is compiled: ' + target)
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const lines = []
    receipt.process = await runProbeProcess(require('electron'), [resolve(fixture, 'main.cjs'), resolve(compiled, 'index.html'), privateRoot, evidence],
      { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 120000, onLine: line => lines.push(line) })
    await writeFile(resolve(evidence, 'process.log'), lines.join('\n') + '\n')
    receipt.render = JSON.parse(await readFile(resolve(evidence, 'render.json')))
    assert.equal(receipt.process.exitCode, 0, JSON.stringify(receipt.render.failure)); assert.equal(receipt.process.timedOut, false)
    assert.equal(receipt.render.passed, true); assert.ok(receipt.render.frames.length >= 7)
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
    receipt.remainingPrivateProcesses = await listProbeProcesses(-1, privateRoot)
    if (!receipt.remainingPrivateProcesses.length) { await rm(privateRoot, { recursive: true }); receipt.privateRootRemoved = true }
    else { receipt.privateRootRemoved = false; receipt.completed = false }
    await writeFile(resolve(evidence, 'capture.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  assert.equal(receipt.completed, true, receipt.failure ?? receipt.drift.join(', ')); return receipt
}
