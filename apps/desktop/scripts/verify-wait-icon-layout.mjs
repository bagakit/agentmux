import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative } from 'node:path'
import { build } from 'vite'
import { runProbeProcess, stopProbeProcesses, listProbeProcesses } from './probe-process.mjs'

assert.ok(process.argv.slice(2).every(arg => arg === '--mutations'), 'Use --mutations to prove the actual isolation mechanism')
const desktop = resolve(import.meta.dirname, '..'), repository = resolve(desktop, '../..')
const require = createRequire(join(desktop, 'package.json')), fixture = join(desktop, 'scripts/fixtures/wait-icon-layout')
const owner = 'packages/client-ui/src/styles/semantic-icons.css', original = await readFile(join(repository, owner), 'utf8')
const evidence = resolve(process.env.AGENTMUX_WAIT_ICON_EVIDENCE ?? join(repository, '.local/state/wait-icon-layout', randomUUID()))
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-wait-icon-')), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.wait-icon-layout-verification.v1', passed: false, owner, originalSHA256: hash(original), cases: [] }
await mkdir(evidence, { recursive: true })
const aliases = [
  { find: '@agentmux/client-ui/icons', replacement: join(repository, 'packages/client-ui/src/theme/icons.tsx') },
  { find: '@agentmux/client-ui/styles', replacement: join(repository, 'packages/client-ui/src/styles') },
  { find: '@agentmux/client-ui/input/styles.css', replacement: join(repository, 'packages/client-ui/src/input/input.css') }
]
const protectedInputs = new Map()
async function run(mode, referenceFile) {
  const root = join(evidence, mode), renderer = join(root, 'renderer'), inputs = new Map(), transformed = new Map()
  await mkdir(root, { recursive: true })
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', resolve: { alias: aliases }, esbuild: { jsx: 'automatic' },
    define: { 'process.env.NODE_ENV': '"production"' },
    css: { postcss: { plugins: [{ postcssPlugin: 'actual-wait-icon-styles', Once(root) {
      const consumed = new Map(), remember = node => { const input = node.source?.input
        if (input?.file?.startsWith(repository + '/') && !input.file.includes('/node_modules/')) consumed.set(input.file, input.css) }
      remember(root); root.walk(remember)
      for (const [file, source] of consumed) inputs.set(relative(repository, file), hash(source))
      const declarations = []
      root.walkDecls('display', node => { if (node.source?.input?.file === join(repository, owner) && node.value === 'inline-block') declarations.push(node) })
      if (declarations.length) {
        assert.equal(declarations.length, 1, 'Actual carrier mutation is nonempty and unique')
        assert.equal(hash(consumed.get(join(repository, owner))), hash(original), 'Exact original CSS owner actually consumed')
        if (mode === 'inline-flex') declarations[0].value = 'inline-flex'
        transformed.set(owner, { original: hash(original), loaded: hash(mode === 'inline-flex' ? original.replace('  display: inline-block;', '  display: inline-flex;') : original), mutation: mode === 'inline-flex' })
      }
    } }] } },
    plugins: [{ name: 'actual-wait-icon-owner', enforce: 'pre', async load(id) {
      if (id.startsWith(repository + '/') && !id.includes('/node_modules/') && !id.includes('?')) inputs.set(relative(repository, id), hash(await readFile(id)))
      return null
    } }],
    build: { target: 'esnext', outDir: renderer, emptyOutDir: true, minify: false } })
  for (const file of [owner, 'packages/client-ui/src/theme/icons.tsx', 'packages/client-ui/src/theme/icon-sprite.ts',
    'packages/client-ui/src/theme/runtime.ts', 'apps/desktop/src/renderer/src/components/FullPageLoadingSurface.tsx',
    'apps/desktop/src/renderer/src/components/SurfaceState.tsx', 'apps/desktop/src/renderer/src/styles/full-page-loading.css',
    'apps/desktop/src/renderer/src/styles/workbench.css']) assert.ok(inputs.has(file), 'Real owner and original consumer compiled: ' + file)
  assert.equal(transformed.size, 1)
  for (const file of ['apps/desktop/scripts/verify-wait-icon-layout.mjs', 'apps/desktop/scripts/fixtures/wait-icon-layout/main.cjs', 'apps/desktop/scripts/probe-process.mjs']) inputs.set(file, hash(await readFile(join(repository, file))))
  for (const [file, digest] of inputs) {
    if (protectedInputs.has(file)) assert.equal(protectedInputs.get(file), digest, 'Same candidate inputs throughout native comparison: ' + file)
    else protectedInputs.set(file, digest)
  }
  await writeFile(join(root, 'inputs.json'), JSON.stringify({ inputs: Object.fromEntries(inputs), transformed: Object.fromEntries(transformed), electron: require('electron/package.json').version }, null, 2))
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  let output = '', processReceipt
  try {
    processReceipt = await runProbeProcess(process.env.AGENTMUX_ELECTRON_BINARY ?? require('electron'),
      [join(fixture, 'main.cjs'), join(renderer, 'index.html'), join(privateRoot, mode), root, mode, ...(referenceFile ? [referenceFile] : [])],
      { cwd: repository, env, timeoutMs: 100000, onLine: line => output += line + '\n' })
    await stopProbeProcesses(processReceipt.originalPid, privateRoot)
    assert.deepEqual(await listProbeProcesses(processReceipt.originalPid, privateRoot), [])
    assert.equal(processReceipt.exitConfirmed, true); assert.equal(processReceipt.timedOut, false, 'Observation timeout is not a product mutation result')
    const result = JSON.parse(await readFile(join(root, 'receipt.json')))
    assert.equal(result.versions.electron, require('electron/package.json').version)
    receipt.cases.push({ mode, root, exit: processReceipt.exitCode, resultSHA256: hash(await readFile(join(root, 'receipt.json'))) })
    if (mode === 'inline-flex') {
      assert.equal(processReceipt.exitCode, 1); assert.equal(result.passed, false); assert.equal(result.cases.length, 2)
      assert.equal(result.error?.message, 'Waiting animation must stay local and independent of unrelated retained workfaces')
      assert.equal(result.costOracle.local, false, 'Reverting actual isolation lets original SVG invalidation escape to the document')
    } else { assert.equal(processReceipt.exitCode, 0, JSON.stringify(result.error)); assert.equal(result.passed, true) }
    console.log(JSON.stringify({ mode, passed: result.passed, expected: mode === 'inline-flex' ? 'RED' : 'GREEN', costs: result.cases.map(row => ({ scale: row.scale, count: row.count, live: row.live, documentLayouts: row.costs.documentLayouts, localLayouts: row.costs.localLayouts, taskMs: row.costs.taskUnionMs, layoutMs: row.costs.statistics.Layout.totalMs })) }))
    return root
  } finally {
    await writeFile(join(root, 'native.log'), output)
    if (processReceipt) await writeFile(join(root, 'cleanup.json'), JSON.stringify(processReceipt, null, 2))
    await rm(renderer, { recursive: true, force: true })
  }
}
try {
  const candidate = await run('candidate')
  if (process.argv.includes('--mutations')) { await run('inline-flex', join(candidate, 'receipt.json')); await run('restored', join(candidate, 'receipt.json')) }
  for (const [file, digest] of protectedInputs) assert.equal(hash(await readFile(join(repository, file))), digest, 'Consumed source unchanged: ' + file)
  receipt.passed = true
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; process.exitCode = 1 }
finally {
  await rm(privateRoot, { recursive: true, force: true }); receipt.privateNamespaceRemoved = true
  await writeFile(join(evidence, 'verification.json'), JSON.stringify(receipt, null, 2)); console.log(join(evidence, 'verification.json'))
}
