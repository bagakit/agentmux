import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire, isBuiltin } from 'node:module'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
export async function captureCraft({ root, evidence, bind, proofFiles, mode = 'capture', mutation = null }) {
  const fixture = resolve(root, 'apps/desktop/scripts/fixtures/toolkit-visual-craft'), desktop = resolve(root, 'apps/desktop')
  const sharedFixture = resolve(root, 'apps/desktop/scripts/fixtures/toolkit-custom-identity')
  const require = createRequire(resolve(desktop, 'package.json')), vitePath = require.resolve('vite')
  const { build } = await import(pathToFileURL(vitePath).href), esbuild = createRequire(vitePath)('esbuild').build
  const { runProbeProcess, listProbeProcesses } = await import(pathToFileURL(resolve(desktop, 'scripts/probe-process.mjs')).href)
  const privateRoot = await mkdtemp(resolve(tmpdir(), 'amx-visual-craft-'))
  const compiled = resolve(evidence, 'compiled'), inputs = {}, artifacts = [], phases = []
  const receipt = { schema: 'agentmux.toolkit-visual-craft-capture.v1', completed: false, privateRoot, phases, inputs, compiled: artifacts, frames: [], mode, mutation, loadedCSS: [],
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
    await esbuild({ entryPoints: [resolve(sharedFixture, 'owner-entry.ts')], outfile: resolve(compiled, 'owner.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', logLevel: 'error',
      plugins: [{ name: 'bind-config-owner-only', setup(builder) {
        builder.onResolve({ filter: /^@agentmux\// }, args => args.path === '@agentmux/core' ? { path: resolve(sharedFixture, 'core-entry.ts') } : aliases.has(args.path) ? { path: aliases.get(args.path) } : undefined)
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
      css: { postcss: { plugins: [{ postcssPlugin: 'bind-actual-custom-identity-css', async Once(rootNode) {
        const files = new Set(); rootNode.walk(node => { if (node.source?.input.file) files.add(node.source.input.file) })
        await Promise.all([...files].filter(file => file.startsWith(root + '/')).map(input))
        const path = 'apps/desktop/src/renderer/src/styles/settings-toolkit.css'
        const rules = []; rootNode.walkRules(rule => { if (relative(root, rule.source?.input.file ?? '') === path) rules.push(rule) })
        if (!rules.length) return // Other production styles, including Monaco, remain untouched.
        let changed = 0
        const originalProduct = rules.map(rule => rule.toString()).join('\n')
        for (const rule of rules) for (const declaration of rule.nodes ?? []) {
          if (declaration.type !== 'decl') continue
          const hierarchy = rule.selector === ".toolkit-workbench:is([data-creation-empty='true'], [data-starting-point='true']) .toolkit-workbench__toolbar > .toolkit-workbench__create"
          if (mutation === 'hierarchy' && hierarchy && declaration.prop === 'background') { declaration.value = 'linear-gradient(180deg, var(--green), var(--green-2))'; changed++ }
          if (mutation === 'palette' && declaration.value === 'var(--green)' && (declaration.prop === 'accent-color' || declaration.prop === 'color')) { declaration.value = 'var(--accent)'; changed++ }
          if (mutation === 'nameFocus' && rule.selector === '.toolkit-editor__name input:focus' && declaration.prop === 'outline') { declaration.value = '0px solid transparent'; changed++ }
        }
        if (mutation) assert.ok(changed > 0, 'Actual product rule mutation is nonempty: ' + mutation)
        const consumed = rootNode.toString(); await writeFile(resolve(evidence, 'consumed-cascade.css'), consumed)
        receipt.loadedCSS.push({ path, originalOwningSourceSHA256: sha(await input(resolve(root, path))), consumedCascadeSHA256: sha(consumed), originalOwningRulesSHA256: sha(originalProduct), consumedOwningRulesSHA256: sha(rules.map(rule => rule.toString()).join('\n')), mutation, changed })
      } }] } },
      plugins: [{ name: 'bind-mounted-custom-product', enforce: 'pre', async transform(_code, id) {
        const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/')) await input(file)
      } }], build: { target: 'esnext', outDir: resolve(compiled, 'renderer'), sourcemap: false, emptyOutDir: false } })
    assert.ok(receipt.loadedCSS.length > 0, 'Actual owning CSS is loaded into the full product cascade')
    for (const stage of mode === 'capture' ? ['control', 'restart'] : ['control']) {
      const lines = [], env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
      const facts = await runProbeProcess(require('electron'), [resolve(fixture, 'main.cjs'), resolve(compiled, 'renderer/index.html'), resolve(compiled, 'owner.mjs'), resolve(sharedFixture, 'preload.cjs'), privateRoot, evidence, stage, mode],
        { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 150_000, onLine: line => lines.push(line) })
      await writeFile(resolve(evidence, stage + '-process.log'), lines.join('\n') + '\n')
      phases.push({ stage, ...facts }); assert.equal(facts.exitCode, mutation ? 1 : 0); assert.equal(facts.timedOut, false); assert.equal(facts.interruption, null)
      const scene = JSON.parse(await readFile(resolve(evidence, stage + '-scene.json'))); if (mutation) {
        assert.equal(scene.completed, false); assert.equal(scene.assertionName, mutation)
        assert.equal(scene.errorName, 'AssertionError', 'SpecificAssertionRED, never setup or compile failure')
        const messages = { hierarchy: /Wide empty or starting-point toolbar New is quiet/u, palette: /checkbox\/radio consumes the defined brand green/u, nameFocus: /distinct two-pixel focus boundary/u }
        assert.match(scene.failure, messages[mutation], 'The mutated product rule fails its specific computed-style oracle')
        assert.ok(receipt.loadedCSS.some(item => item.originalOwningRulesSHA256 !== item.consumedOwningRulesSHA256))
        receipt.specificAssertionRED = true
      } else assert.equal(scene.completed, true)
      if (stage === 'control' && mode === 'capture') { assert.equal(scene.frames.length, 6); receipt.frames = scene.frames }
      else if (stage === 'restart') { assert.equal(scene.restart.sameId, true); assert.equal(scene.restart.allFields, true); assert.deepEqual(scene.restart.executionCalls, []) }
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
