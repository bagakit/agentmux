import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, dirname } from 'node:path'
import { execFileSync } from 'node:child_process'
import { runProbeProcess, listProbeProcesses } from '../../probe-process.mjs'
import { radixOverlayAliases } from '../../radix-overlay-aliases.ts'

const fixture = import.meta.dirname, root = resolve(fixture, '../../../../..')
const mainRoot = dirname(resolve(root, execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim()))
const require = createRequire(join(mainRoot, 'apps/desktop/package.json'))
const { build } = await import(require.resolve('vite'))
const motion = process.argv.includes('--motion')
const mutant = process.argv.includes('--mutant=motion') ? 'motion' : process.argv.includes('--mutant=consumer') ? 'consumer' : null
assert.ok(process.argv.slice(2).every(value => ['--motion', '--mutant=consumer', '--mutant=motion'].includes(value)), 'Use --motion and optionally --mutant=motion, or --mutant=consumer')
assert.ok(mutant !== 'motion' || motion, 'Motion mutation needs the motion scenario')
assert.ok(mutant !== 'consumer' || !motion, 'Consumer mutation uses the original scenario')
const evidenceRoot = join(root, motion ? '.tmp/topic-promotion-motion' : '.tmp/topic-promotion')
const evidence = join(evidenceRoot, (mutant ? mutant + '-' : 'visual-') + randomUUID())
const temporary = await mkdtemp(join(tmpdir(), 'amux-topic-promotion-')), compiled = join(temporary, 'renderer')
const hash = bytes => createHash('sha256').update(bytes).digest('hex'), inputs = {}, mutations = []
const record = async id => { const file = id.split('?')[0]; if (file.startsWith(root + '/') && !file.includes('/node_modules/') && existsSync(file)) inputs[relative(root, file)] = hash(await readFile(file)) }
const files = async directory => (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat()
const receipt = { schema: 'agentmux.topic-promotion-renderer.v1', passed: false, captureOnly: !mutant, aestheticReview: 'not-performed', mutant,
  boundary: 'Production App, WorkspaceTopicsPanel, shared Topic menu, TopicPromotionDialog, Store and styles in a private Electron Renderer. Controlled content/spatial/RPC transport facts; native Chromium pointer interaction. No user profile, live Session/Run, backend persistence, package or installation claim.', inputs, mutations, frames: [] }
await mkdir(evidence, { recursive: true })
try {
  const packages = new Map()
  const sourceResolver = { name: 'topic-promotion-current-public-sources', enforce: 'pre',
    async resolveId(specifier) {
      if (!specifier.startsWith('@agentmux/')) return
      const [, name, ...parts] = specifier.split('/')
      let pkg = packages.get(name)
      if (!pkg) {
        const directory = [join(root, 'packages', name), join(root, 'apps', name)].find(path => existsSync(join(path, 'package.json')))
        assert.ok(directory, 'Current workspace package exists: ' + name)
        const manifestPath = join(directory, 'package.json'); await record(manifestPath)
        pkg = { directory, manifest: JSON.parse(await readFile(manifestPath, 'utf8')) }; packages.set(name, pkg)
      }
      const entry = parts.length ? './' + parts.join('/') : '.'
      const declarations = Object.entries(pkg.manifest.exports ?? {}).sort(([a], [b]) => Number(a.includes('*')) - Number(b.includes('*')) || b.length - a.length)
      for (const [pattern, value] of declarations) {
        const [prefix, suffix = ''] = pattern.split('*')
        if (pattern.includes('*') ? !entry.startsWith(prefix) || !entry.endsWith(suffix) : entry !== pattern) continue
        const match = pattern.includes('*') ? entry.slice(prefix.length, suffix ? -suffix.length : undefined) : ''
        const target = typeof value === 'string' ? value : value.browser ?? value.import ?? value.default
        assert.equal(typeof target, 'string', 'Public browser/import export ' + specifier)
        let source = target.replace('./dist/src/', './src/').replace('./dist/', './src/').replace(/\.js$/, '.ts').replace('*', match)
        if (name === 'identity' && entry === './runtime') source = './src/runtime-entry.ts'
        if (name === 'identity' && entry === './runtime-source') source = target
        const file = [resolve(pkg.directory, source), resolve(pkg.directory, source.replace(/\.ts$/, '.tsx'))].find(existsSync)
        assert.ok(file, 'Current public source exists: ' + specifier + ' → ' + source)
        return file
      }
      throw Error('No current public export for ' + specifier)
    },
    async transform(source, id) {
      await record(id)
      if (mutant === 'motion' && id.endsWith('/styles/topic-promotion.css')) {
        assert.ok(source.includes('.topic-promotion__particle') && source.includes('.topic-promotion__halo'), 'The production waiting motion is loaded')
        const changed = source + '\n.topic-promotion-dialog[data-phase="writing"] .topic-promotion__energy * { animation: none !important; }\n'
        mutations.push({ file: relative(root, id), mutant, count: 1, sourceSHA256: hash(source), loadedSHA256: hash(changed) })
        return { code: changed, map: null }
      }
      if (mutant !== 'consumer' || !id.endsWith('/components/WorkspaceTopicsPanel.tsx')) return
      const before = 'onPromote: () => setPromotionTarget({ topicId: topic.id, title: topic.title, categorySpaceId }),'
      assert.equal(source.split(before).length - 1, 1, 'Unique actual consumer mutation anchor')
      const changed = source.replace(before, 'onPromote: undefined,')
      mutations.push({ file: relative(root, id), mutant, count: 1, sourceSHA256: hash(source), loadedSHA256: hash(changed) })
      return { code: changed, map: null }
    },
    async generateBundle() { await Promise.all(this.getWatchFiles().map(record)) }
  }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', esbuild: { jsx: 'automatic' }, worker: { format: 'es', plugins: () => [sourceResolver] },
    resolve: { alias: radixOverlayAliases }, define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    plugins: [sourceResolver], build: { target: 'esnext', outDir: compiled, emptyOutDir: true } })
  await Promise.all([import.meta.filename, join(fixture, 'main.cjs'), join(fixture, 'scenario.md')].map(record))
  receipt.compiled = Object.fromEntries(await Promise.all((await files(compiled)).map(async file => [relative(compiled, file), hash(await readFile(file))])))
  for (const suffix of ['App.tsx', 'WorkspaceTopicsPanel.tsx', 'TopicContextMenu.tsx', 'TopicPromotionDialog.tsx', 'topic-promotion.css', 'store.ts']) assert.ok(Object.keys(inputs).some(file => file.endsWith('/' + suffix)), 'Production consumer loaded: ' + suffix)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const logs = []
  receipt.process = await runProbeProcess(require('electron'), [join(fixture, 'main.cjs'), join(compiled, 'index.html'), temporary, evidence, ...(motion ? ['motion'] : [])],
    { temporaryRoot: temporary, cwd: root, env, timeoutMs: 90000, onLine: line => logs.push(line) })
  await writeFile(join(evidence, 'process.log'), logs.join('\n'))
  receipt.actual = JSON.parse(await readFile(join(evidence, 'actual.json'), 'utf8'))
  assert.equal(receipt.process.timedOut, false, 'A timeout does not prove a behavioral mutation failure')
  if (mutant) {
    assert.equal(mutations.length, 1); assert.notEqual(receipt.process.exitCode, 0)
    assert.equal(receipt.actual.failure?.name, 'AssertionError')
    assert.match(receipt.actual.failure?.message ?? '', mutant === 'motion' ? /Waiting motion changes visible geometry or opacity after the initial transition/ : /Production Topic menu exposes the promotion action/)
    receipt.assertionRed = true
  } else {
    assert.equal(receipt.process.exitCode, 0, receipt.actual.failure?.message); assert.equal(receipt.actual.passed, true)
    receipt.frames = await Promise.all(receipt.actual.frames.map(async frame => ({ ...frame, sha256: hash(await readFile(join(evidence, frame.file))) })))
    assert.ok(receipt.frames.length >= (motion ? 9 : 8))
  }
  receipt.sourceDrift = []
  for (const [file, digest] of Object.entries(inputs)) if (hash(await readFile(join(root, file))) !== digest) receipt.sourceDrift.push(file)
  const affected = ['apps/desktop/src/renderer/src/components/WorkspaceTopicsPanel.tsx', 'apps/desktop/src/renderer/src/components/TopicContextMenu.tsx',
    'apps/desktop/src/renderer/src/components/TopicPromotionDialog.tsx', 'apps/desktop/src/renderer/src/styles/topic-promotion.css']
  assert.deepEqual(receipt.sourceDrift.filter(file => affected.includes(file)), [], 'Affected product source is stable during capture')
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  receipt.cleanup = { remaining: await listProbeProcesses(-1, temporary) }
  if (!receipt.cleanup.remaining.length) { await rm(temporary, { recursive: true, force: true }); receipt.cleanup.removed = true }
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  if (receipt.passed) await writeFile(join(evidenceRoot, mutant ? 'latest-' + mutant + '.json' : 'latest-visual.json'), JSON.stringify({ evidence }, null, 2) + '\n')
  console.log(JSON.stringify({ passed: receipt.passed, evidence, failure: receipt.failure?.message, pendingIndependentVisualReview: !mutant }))
}
