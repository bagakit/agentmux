import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { build } from 'vite'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

assert.ok(process.argv.slice(2).length <= 1 && process.argv.slice(2).every(arg => ['--mutations', '--smoke', '--behavior-only'].includes(arg)), 'Use one mode: --mutations, --smoke or --behavior-only')
const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const require = createRequire(join(desktop, 'package.json')), fixture = join(desktop, 'scripts/fixtures/mote-silhouette-layout')
const owner = 'packages/client-ui/src/styles/mote-identity.css', original = await readFile(join(repository, owner), 'utf8')
const evidence = resolve(process.env.AGENTMUX_MOTE_SILHOUETTE_EVIDENCE ?? join(repository, '.local/state/mote-silhouette-layout', randomUUID()))
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-mote-silhouette-')), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.mote-silhouette-layout-verification.v1', passed: false, owner, originalSHA256: hash(original), cases: [] }
await mkdir(evidence, { recursive: true })
const aliases = []
for (const name of ['core', 'demand', 'layout', 'identity', 'host', 'capsule']) {
  const directory = join(repository, name === 'host' ? 'apps' : 'packages', name)
  const manifest = JSON.parse(await readFile(join(directory, 'package.json')))
  for (const [subpath, target] of Object.entries(manifest.exports)) {
    const specifier = '@agentmux/' + name + (subpath === '.' ? '' : subpath.slice(1))
    aliases.push({ find: new RegExp('^' + specifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'),
      replacement: join(directory, target.import.replace('./dist/', ['core', 'identity', 'host', 'capsule'].includes(name) ? './src/' : './').replace(/\.js$/, '.ts')) })
  }
}
const protectedInputs = new Map()
async function run(mode, referenceFile) {
  const root = join(evidence, mode), renderer = join(root, 'renderer'), inputs = new Map(), transformed = new Map()
  await mkdir(root, { recursive: true })
  const compiled = await build({ configFile: false, root: fixture, base: './', worker: { format: 'es' }, logLevel: 'error', resolve: { alias: aliases }, esbuild: { jsx: 'automatic' },
    define: { __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' },
    css: { postcss: { plugins: [{ postcssPlugin: 'actual-mote-silhouette-styles', Once(root) {
      const consumed = new Map(), remember = node => { const input = node.source?.input
        if (input?.file?.startsWith(repository + '/') && !input.file.includes('/node_modules/')) consumed.set(input.file, input.css) }
      remember(root); root.walk(remember)
      for (const [file, source] of consumed) inputs.set(relative(repository, file), hash(source))
      if (consumed.has(join(repository, owner))) {
        assert.equal(hash(consumed.get(join(repository, owner))), hash(original), 'Exact original CSS owner actually consumed')
        const rules = []; root.walkRules(rule => { if (rule.source?.input?.file === join(repository, owner) && rule.selector === '.mote-identity-motion:has(svg:is(.mote-face, .mote-silhouette-art))') rules.push(rule) })
        assert.equal(rules.length, 1, 'Actual shared silhouette isolation is uniquely consumed')
        if (mode === 'inline-flex') rules[0].selector = '.mote-identity-motion:has(svg.mote-face)'
        transformed.set(owner, { original: hash(original), loaded: hash(mode === 'inline-flex' ? original.replace(':has(svg:is(.mote-face, .mote-silhouette-art))', ':has(svg.mote-face)') : original), mutation: mode === 'inline-flex' })
      }
    } }] } },
    plugins: [{ name: 'actual-mote-silhouette-owner', enforce: 'pre', async load(id) {
      if (id.startsWith(repository + '/') && !id.includes('/node_modules/') && !id.includes('?')) inputs.set(relative(repository, id), hash(await readFile(id)))
      return null
    } }],
    build: { target: 'esnext', outDir: renderer, emptyOutDir: true, minify: false } })
  for (const file of [owner, 'apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx',
    'apps/desktop/src/renderer/src/components/MoteIdentityMotion.tsx', 'apps/desktop/src/renderer/src/components/MoteSilhouetteArt.tsx',
    'apps/desktop/src/renderer/src/components/MoteAvatarCrop.tsx', 'packages/client-ui/src/lib/mote-face-motion.ts',
    'apps/desktop/src/renderer/src/styles/space-object-appearance.css', 'apps/desktop/src/renderer/src/styles/workbench.css'])
    assert.ok(inputs.has(file), 'Real owner and original consumer compiled: ' + file)
  assert.equal(transformed.size, 1)
  for (const file of ['apps/desktop/scripts/verify-mote-silhouette-layout.mjs', 'apps/desktop/scripts/fixtures/mote-silhouette-layout/main.cjs', 'apps/desktop/scripts/probe-process.mjs']) inputs.set(file, hash(await readFile(join(repository, file))))
  for (const [file, digest] of inputs) {
    if (protectedInputs.has(file)) assert.equal(protectedInputs.get(file), digest, 'Same candidate inputs throughout native comparison: ' + file)
    else protectedInputs.set(file, digest)
  }
  const outputs = (Array.isArray(compiled) ? compiled : [compiled]).flatMap(bundle => bundle.output)
  await writeFile(join(root, 'inputs.json'), JSON.stringify({ inputs: Object.fromEntries(inputs), transformed: Object.fromEntries(transformed),
    compiled: Object.fromEntries(outputs.map(output => [output.fileName, hash(output.type === 'chunk' ? output.code : output.source)])), electron: require('electron/package.json').version }, null, 2))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  let output = '', processReceipt
  try {
    processReceipt = await runProbeProcess(process.env.AGENTMUX_ELECTRON_BINARY ?? require('electron'),
      [join(fixture, 'main.cjs'), join(renderer, 'index.html'), join(privateRoot, mode), root, mode, ...(referenceFile ? [referenceFile] : [])],
      { cwd: repository, env, timeoutMs: 120000, onLine: line => output += line + '\n' })
    await stopProbeProcesses(processReceipt.originalPid, privateRoot)
    assert.deepEqual(await listProbeProcesses(processReceipt.originalPid, privateRoot), [])
    assert.equal(processReceipt.exitConfirmed, true); assert.equal(processReceipt.timedOut, false, 'Observation timeout is not a product mutation result')
    const result = JSON.parse(await readFile(join(root, 'receipt.json')))
    assert.equal(result.versions.electron, require('electron/package.json').version)
    receipt.cases.push({ mode, root, exit: processReceipt.exitCode, resultSHA256: hash(await readFile(join(root, 'receipt.json'))) })
    if (mode === 'inline-flex') {
      assert.equal(processReceipt.exitCode, 1); assert.equal(result.passed, false); assert.equal(result.cases.length, 2)
      assert.equal(result.error?.message, 'Original Mote silhouette consumers must keep part layout local and independent of unrelated workfaces')
      assert.equal(result.costOracle.local, false, 'Reverting actual silhouette isolation lets original SVG invalidation escape to the document')
      assert.ok(result.cases.every(row => row.costs.documentLayouts > 0), 'Both unrelated-workface scales reproduce document Layout')
    } else { assert.equal(processReceipt.exitCode, 0, JSON.stringify(result.error)); assert.equal(result.passed, true) }
    console.log(JSON.stringify({ mode, passed: result.passed, expected: mode === 'inline-flex' ? 'RED' : 'GREEN', costs: result.cases.map(row => ({ scale: row.scale, count: row.additional, live: row.live, documentLayouts: row.costs.documentLayouts, localLayouts: row.costs.localLayouts, taskMs: row.costs.taskUnionMs, layoutMs: row.costs.statistics.Layout.totalMs })) }))
    return root
  } finally {
    await writeFile(join(root, 'native.log'), output)
    if (processReceipt) await writeFile(join(root, 'cleanup.json'), JSON.stringify(processReceipt, null, 2))
    await rm(renderer, { recursive: true, force: true })
  }
}
try {
  const candidate = await run(process.argv.includes('--smoke') ? 'smoke' : process.argv.includes('--behavior-only') ? 'behavior' : 'candidate')
  if (process.argv.includes('--mutations') && !process.argv.includes('--smoke')) { await run('inline-flex', join(candidate, 'receipt.json')); await run('restored', join(candidate, 'receipt.json')) }
  for (const [file, digest] of protectedInputs) assert.equal(hash(await readFile(join(repository, file))), digest, 'Consumed source unchanged: ' + file)
  const review = ['# Mote silhouette layout · independent visual review', '', 'Read fixtures/mote-silhouette-layout/scenario.md and the owning Mote presentation contract. Open the complete images below; this script does not approve aesthetics.', '']
  for (const row of receipt.cases) {
    const native = JSON.parse(await readFile(join(row.root, 'receipt.json')))
    review.push('## ' + row.mode, '', '- Native receipt: ' + join(row.root, 'receipt.json'), '- Compiled/source identity: ' + join(row.root, 'inputs.json'), '')
    for (const frame of native.frames) review.push('- [' + frame.file + '](' + join(row.root, frame.file) + ')')
    review.push('')
  }
  await writeFile(join(evidence, 'review.md'), review.join('\n'))
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await rm(privateRoot, { recursive: true, force: true }); receipt.privateNamespaceRemoved = true
  await writeFile(join(evidence, 'verification.json'), JSON.stringify(receipt, null, 2)); console.log(join(evidence, 'verification.json'))
}
