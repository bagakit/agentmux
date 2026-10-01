import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export async function captureIdentity({ root, evidence, bind, proofFiles }) {
  const fixture = resolve(root, 'apps/desktop/scripts/fixtures/toolkit-custom-identity'), desktop = resolve(root, 'apps/desktop')
  const require = createRequire(resolve(desktop, 'package.json')), vitePath = require.resolve('vite')
  const { build } = await import(pathToFileURL(vitePath).href), esbuild = createRequire(vitePath)('esbuild').build
  const { runProbeProcess, listProbeProcesses } = await import(pathToFileURL(resolve(desktop, 'scripts/probe-process.mjs')).href)
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'amx-custom-identity-'))
  const compiled = resolve(evidence, 'compiled'), inputs = {}, artifacts = [], phases = []
  const receipt = { schema: 'agentmux.toolkit-custom-identity-capture.v1', completed: false, privateRoot, phases, inputs, compiled: artifacts, frames: [],
    boundary: 'Actual selected product components and configuration owner only; no App/Run/Runtime, built CLI, real account query or installation. Controlled result DTO is synthetic.' }
  async function input(file) {
    const key = relative(root, file), bytes = await bind(key)
    if (Object.hasOwn(inputs, key)) assert.equal(inputs[key].sha256, sha(bytes), 'Capture input stayed exact: ' + key)
    else inputs[key] = { sha256: sha(bytes), bytes: bytes.length }
    return bytes
  }
  try {
    await mkdir(compiled, { recursive: true }); for (const key of ['home', 'userData', 'sessionData']) await mkdir(resolve(privateRoot, key))
    for (const file of proofFiles) await input(resolve(root, file))
    for (const file of ['package.json', 'pnpm-lock.yaml', 'apps/desktop/package.json', 'apps/desktop/scripts/probe-process.mjs']) await input(resolve(root, file))
    const aliases = new Map()
    for (const name of ['core', 'demand', 'layout']) {
      const dir = resolve(root, 'packages', name), pkg = JSON.parse(await input(resolve(dir, 'package.json')))
      for (const [key, value] of Object.entries(pkg.exports)) {
        const target = typeof value === 'string' ? value : value.import
        aliases.set('@agentmux/' + name + (key === '.' ? '' : key.slice(1)), resolve(dir, target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/u, '.ts')))
      }
    }
    for (const entry of await readdir(fixture, { withFileTypes: true })) if (entry.isFile()) await input(resolve(fixture, entry.name))
    // Node bundle narrows only exports, not their implementations, to avoid importing Runtime.
    await esbuild({ entryPoints: [resolve(fixture, 'owner-entry.ts')], outfile: resolve(compiled, 'owner.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', logLevel: 'error',
      plugins: [{ name: 'bind-config-owner-only', setup(builder) {
        builder.onResolve({ filter: /^@agentmux\// }, args => args.path === '@agentmux/core' ? { path: resolve(fixture, 'core-entry.ts') } : aliases.has(args.path) ? { path: aliases.get(args.path) } : undefined)
        builder.onResolve({ filter: /^[^./]/ }, args => {
          assert.notEqual(args.path, '@ctxmux/sdk', 'Configuration proof never loads a Runtime SDK')
          if (args.path === 'electron' || isBuiltin(args.path) || aliases.has(args.path)) return
          return { path: require.resolve(args.path, { paths: [dirname(args.importer), desktop] }), external: true }
        })
        builder.onLoad({ filter: /\.[cm]?tsx?$/ }, async args => {
          if (!args.path.startsWith(root + '/') || args.path.includes('/node_modules/')) return
          return { contents: (await input(args.path)).toString(), loader: args.path.endsWith('tsx') ? 'tsx' : 'ts' }
        })
      } }] })
    const alias = [...aliases.entries()].map(([name, replacement]) => ({ find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') + '$'), replacement }))
    for (const name of ['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client']) alias.push({ find: new RegExp('^' + name + '$'), replacement: require.resolve(name) })
    await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias }, esbuild: { jsx: 'automatic' },
      define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
      css: { postcss: { plugins: [{ postcssPlugin: 'bind-actual-custom-identity-css', Once(rootNode) {
        const files = new Set(); rootNode.walk(node => { if (node.source?.input.file) files.add(node.source.input.file) })
        return Promise.all([...files].filter(file => file.startsWith(root + '/')).map(input))
      } }] } },
      plugins: [{ name: 'bind-mounted-custom-product', enforce: 'pre', async transform(_code, id) {
        const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/')) await input(file)
      } }], build: { target: 'esnext', outDir: resolve(compiled, 'renderer'), sourcemap: false, emptyOutDir: false } })
    for (const stage of ['control', 'restart']) {
      const lines = [], env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const facts = await runProbeProcess(require('electron'), [resolve(fixture, 'main.cjs'), resolve(compiled, 'renderer/index.html'), resolve(compiled, 'owner.mjs'), resolve(fixture, 'preload.cjs'), privateRoot, evidence, stage],
        { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 150_000, onLine: line => lines.push(line) })
      await writeFile(resolve(evidence, stage + '-process.log'), lines.join('\n') + '\n')
      phases.push({ stage, ...facts }); assert.equal(facts.exitCode, 0); assert.equal(facts.timedOut, false); assert.equal(facts.interruption, null)
      const scene = JSON.parse(await readFile(resolve(evidence, stage + '-scene.json'))); assert.equal(scene.completed, true)
      if (stage === 'control') { assert.equal(scene.frames.length, 6); receipt.frames = scene.frames }
      else { assert.equal(scene.restart.sameId, true); assert.equal(scene.restart.allFields, true); assert.deepEqual(scene.restart.executionCalls, []) }
    }
    assert.ok(Object.keys(inputs).length > 0); assert.ok(Object.keys(inputs).some(file => file.endsWith('settings-toolkit.css')))
    receipt.sourceIdentity = sha(JSON.stringify(Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)))))
    receipt.completed = true
  } catch (error) { receipt.failure = String(error?.stack ?? error) }
  finally {
    receipt.drift = []
    for (const [file, identity] of Object.entries(inputs)) if (sha(await readFile(resolve(root, file))) !== identity.sha256) receipt.drift.push(file)
    if (receipt.drift.length) receipt.completed = false
    async function collect(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = resolve(directory, entry.name); if (entry.isSymbolicLink()) continue
        if (entry.isDirectory()) await collect(file)
        else { const bytes = await readFile(file); artifacts.push({ file: relative(evidence, file), sha256: sha(bytes), bytes: bytes.length }) }
      }
    }
    await collect(compiled); assert.ok(artifacts.length > 0, 'Actual compiled artifacts are nonempty')
    receipt.remainingPrivateProcesses = await listProbeProcesses(-1, privateRoot)
    if (!receipt.remainingPrivateProcesses.length) { await rm(privateRoot, { recursive: true }); receipt.privateRootRemoved = true }
    else { receipt.privateRootRemoved = false; receipt.completed = false }
    await writeFile(resolve(evidence, 'capture.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  assert.equal(receipt.completed, true, receipt.failure); return receipt
}
