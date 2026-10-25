import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export async function captureStartupProduct({ root, evidence, rendererMutation, connectionProgress = false }) {
  const fixture = resolve(root, 'apps/desktop/scripts/fixtures/startup-agent-availability')
  const desktop = resolve(root, 'apps/desktop'), compiled = resolve(evidence, 'compiled')
  const require = createRequire(resolve(desktop, 'package.json')), vitePath = require.resolve('vite')
  const { build } = await import(pathToFileURL(vitePath).href), esbuild = createRequire(vitePath)('esbuild').build
  const { runProbeProcess, listProbeProcesses } = await import(pathToFileURL(resolve(desktop, 'scripts/probe-process.mjs')).href)
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'amx-startup-agents-'))
  const inputs = {}, artifacts = [], phases = [], frames = []
  const receipt = { schema: 'agentmux.startup-agent-product-capture.v1', completed: false, privateRoot, inputs, artifacts, phases, frames,
    boundary: 'Actual complete App and Renderer initialize, startup stage, Workbench, General settings and System notifications; actual ConfigStore/ConfigOwner writes and Core spatial disk owner; persistent Chromium localStorage. Three independently launched private Electron processes read the same original disk state. Executor availability/check failures and empty Runtime snapshot are controlled API boundary inputs, no live Agent or user Runtime.' }
  async function bind(file) {
    const key = relative(root, file), bytes = await readFile(file)
    assert.ok(bytes.length > 0, 'Nonempty actual source: ' + key)
    if (Object.hasOwn(inputs, key)) assert.equal(inputs[key].sha256, sha(bytes), 'Source remains fixed during capture: ' + key)
    else inputs[key] = { sha256: sha(bytes), bytes: bytes.length }
    return bytes
  }
  try {
    await mkdir(compiled, { recursive: true })
    for (const key of ['user-data', 'session-data']) await mkdir(resolve(privateRoot, key))
    for (const file of ['package.json', 'pnpm-lock.yaml', 'apps/desktop/package.json', 'apps/desktop/scripts/probe-process.mjs']) await bind(resolve(root, file))
    for (const entry of await readdir(fixture, { withFileTypes: true })) if (entry.isFile()) await bind(resolve(fixture, entry.name))
    const aliases = new Map()
    for (const name of ['core', 'demand', 'layout', 'identity', 'host', 'client-ui']) {
      const directory = resolve(root, name === 'host' ? 'apps' : 'packages', name), pkg = JSON.parse(await bind(resolve(directory, 'package.json')))
      for (const [key, value] of Object.entries(pkg.exports)) {
        const target = typeof value === 'string' ? value : value.browser ?? value.import
        if (!target) continue
        aliases.set('@agentmux/' + name + (key === '.' ? '' : key.slice(1)), resolve(directory, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts')))
      }
    }
    aliases.set('@agentmux/identity/runtime', resolve(root, 'packages/identity/src/runtime-entry.ts'))
    aliases.set('@agentmux/identity/runtime-source', resolve(root, 'packages/identity/dist/runtime-source.js'))
    function resolveAlias(name) {
      if (aliases.has(name)) return aliases.get(name)
      for (const [pattern, replacement] of [...aliases].sort(([a], [b]) => b.length - a.length)) {
        if (!pattern.includes('*')) continue
        const [prefix, suffix] = pattern.split('*')
        if (name.startsWith(prefix) && name.endsWith(suffix)) return replacement.replace('*', name.slice(prefix.length, name.length - suffix.length))
      }
    }
    aliases.set('@agentmux/client-ui/theme', resolve(root, 'packages/client-ui/src/theme/index.ts'))
    aliases.set('@agentmux/client-ui/composer-input-config', resolve(root, 'packages/client-ui/src/lib/composer-input-config.ts'))
    await bind(resolve(root, 'packages/client-ui/package.json'))
    await esbuild({ entryPoints: [resolve(fixture, 'owner-entry.ts')], outfile: resolve(compiled, 'owner.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', logLevel: 'error',
      plugins: [{ name: 'bind-actual-startup-durable-owners', setup(builder) {
        builder.onResolve({ filter: /^@agentmux\// }, args => args.path === '@agentmux/core' ? { path: resolve(fixture, 'core-entry.ts') } : resolveAlias(args.path) ? { path: resolveAlias(args.path) } : undefined)
        builder.onResolve({ filter: /^[^./]/ }, args => {
          assert.notEqual(args.path, '@ctxmux/sdk', 'A startup UI proof never loads a Runtime SDK')
          if (args.path === 'electron' || isBuiltin(args.path) || aliases.has(args.path)) return
          return { path: require.resolve(args.path, { paths: [dirname(args.importer), desktop] }), external: true }
        })
        builder.onLoad({ filter: /\.[cm]?tsx?$/ }, async args => {
          if (!args.path.startsWith(root + '/') || args.path.includes('/node_modules/')) return
          return { contents: (await bind(args.path)).toString(), loader: args.path.endsWith('tsx') ? 'tsx' : 'ts' }
        })
      } }] })
    // The actual spatial owner uses createRequire(import.meta.url) for its N-API lock.
    // Bind that existing installed dependency beside this isolated compiled owner.
    const coreRequire = createRequire(resolve(root, 'packages/core/package.json'))
    const nativeRoot = dirname(coreRequire.resolve('fs-native-extensions/package.json'))
    await bind(resolve(nativeRoot, 'package.json'))
    await mkdir(resolve(compiled, 'node_modules')); await symlink(nativeRoot, resolve(compiled, 'node_modules/fs-native-extensions'), 'dir')
    const alias = [...aliases.entries()].sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
      .map(([name, replacement]) => ({ find: new RegExp('^' + name.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('(.*)') + '$'), replacement: replacement.replace('*', '$1') }))
    for (const name of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client']) alias.push({ find: new RegExp('^' + name + '$'), replacement: require.resolve(name) })
    const dialog = createRequire(createRequire(resolve(root, 'packages/client-ui/package.json')).resolve('@radix-ui/react-dialog'))
    for (const name of ['@radix-ui/react-dismissable-layer', '@radix-ui/react-focus-scope']) alias.push({ find: name, replacement: dialog.resolve(name) })
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias, dedupe: ['react', 'react-dom'] }, esbuild: { jsx: 'automatic' }, worker: { format: 'es' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
      css: { postcss: { plugins: [{ postcssPlugin: 'bind-actual-startup-product-css', async Once(styles) {
        const files = new Set(); styles.walk(node => { if (node.source?.input.file) files.add(node.source.input.file.split('?')[0]) })
        await Promise.all([...files].filter(file => file.startsWith(root + '/') && !file.includes('/node_modules/')).map(bind))
      } }] } },
      plugins: [{ name: 'bind-actual-startup-renderer', enforce: 'pre', async transform(code, id) {
        const file = id.split('?')[0]
        if (file.startsWith(root + '/') && !file.includes('/node_modules/')) await bind(file)
        if (rendererMutation && file === resolve(root, rendererMutation.file)) {
          assert.equal(code.split(rendererMutation.from).length, 2, 'One actual production Renderer mutation seam')
          const loaded = code.replace(rendererMutation.from, rendererMutation.to)
          receipt.rendererMutation = { ...rendererMutation, original: sha(code), loaded: sha(loaded) }
          return { code: loaded, map: null }
        }
      } }],
      build: { target: 'esnext', outDir: resolve(compiled, 'renderer'), sourcemap: false, emptyOutDir: false } })
    const stages = connectionProgress ? ['control', 'restart'] : ['control', 'failure-restart', 'restart']
    for (const stage of stages) {
      const lines = [], env = { ...process.env, AGENTMUX_STATE_DIRECTORY: resolve(privateRoot, 'agentmux-state'), AGENTMUX_RUNTIME_DIRECTORY: resolve(privateRoot, 'runtime') }
      if (connectionProgress) env.AGENTMUX_CONNECTION_PROGRESS_PROOF = '1'
      delete env.ELECTRON_RUN_AS_NODE
      const facts = await runProbeProcess(require('electron'), [resolve(fixture, 'main.cjs'), resolve(compiled, 'renderer/index.html'), resolve(compiled, 'owner.mjs'), privateRoot, evidence, stage],
        { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 120_000, onLine: line => lines.push(line) })
      await writeFile(resolve(evidence, stage + '-process.log'), lines.join('\n') + '\n')
      phases.push({ stage, ...facts })
      const scene = JSON.parse(await readFile(resolve(evidence, stage + '-scene.json')))
      assert.equal(facts.exitCode, 0, JSON.stringify(scene.failure)); assert.equal(facts.timedOut, false); assert.equal(facts.interruption, null)
      assert.equal(scene.completed, true); frames.push(...scene.frames)
    }
    const scenes = await Promise.all(phases.map(phase => readFile(resolve(evidence, phase.stage + '-scene.json')).then(JSON.parse)))
    assert.equal(new Set(scenes.map(scene => scene.pid)).size, stages.length, 'Independent Electron main processes')
    for (const scene of scenes.slice(1)) assert.deepEqual(scenes[0].checkpoint.surface, scene.checkpoint.surface)
    if (!connectionProgress) {
      assert.equal(scenes[1].failureRecovery.pendingCauseRetained, true); assert.equal(scenes[1].failureRecovery.clearedAfterSuccessfulChecks, true)
    }
    assert.equal(scenes.at(-1).restart.noReseed, true)
    if (!connectionProgress) assert.equal(scenes.at(-1).actualSettingsSaveReadback, true)
    assert.equal(frames.length, 5, 'Normal/narrow restored workface and loading/settings plus observation details captures are nonempty')
    if (connectionProgress) assert.deepEqual(scenes.at(-1).connectionProgress, { loadingVisible: true, workfaceVisible: true, readKeptVisible: true, resolvedCleared: true })
    assert.ok(Object.keys(inputs).some(file => file.endsWith('/App.tsx')))
    assert.ok(Object.keys(inputs).some(file => file.endsWith('/StartupLoadingSurface.tsx')))
    assert.ok(Object.keys(inputs).some(file => file.endsWith('/GeneralSettingsPane.tsx')))
    assert.ok(Object.keys(inputs).some(file => file.endsWith('/GlobalSystemNotices.tsx')))
    receipt.sourceIdentity = sha(JSON.stringify(Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)))))
    receipt.completed = true
  } catch (error) { receipt.failure = String(error?.stack ?? error); console.error(receipt.failure) }
  finally {
    receipt.drift = []
    for (const [file, identity] of Object.entries(inputs)) if (sha(await readFile(resolve(root, file))) !== identity.sha256) receipt.drift.push(file)
    if (receipt.drift.length) receipt.completed = false
    async function collect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = resolve(directory, entry.name)
        if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) await collect(file)
        else { const bytes = await readFile(file); artifacts.push({ file: relative(evidence, file), sha256: sha(bytes), bytes: bytes.length }) }
      }
    }
    await collect(compiled)
    receipt.remainingPrivateProcesses = await listProbeProcesses(-1, privateRoot)
    if (!receipt.remainingPrivateProcesses.length) { await rm(privateRoot, { recursive: true }); receipt.privateRootRemoved = true }
    else { receipt.privateRootRemoved = false; receipt.completed = false }
    await writeFile(resolve(evidence, 'capture.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  assert.equal(receipt.completed, true, receipt.failure); return receipt
}
