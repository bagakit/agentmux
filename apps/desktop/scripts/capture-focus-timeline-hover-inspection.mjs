import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'
const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop'), fixture = path.join(desktop, 'scripts/fixtures/focus-timeline-hover-inspection')
const evidence = path.resolve(process.argv[2] ?? path.join(root, `.tmp/focus-timeline-hover-scene-${Date.now()}`)), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const producerFile = 'apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/public-producer.json', producerBytes = await fs.readFile(path.join(root, producerFile)), producer = JSON.parse(producerBytes)
assert.equal(producer.schema, 'agentmux.focus-author-public-producer.v1'); assert.deepEqual(producer.messages.map(item => item.author.kind), ['unknown','unknown','human','agent','unknown'])
const require = createRequire(path.join(desktop, 'package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href), electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.mkdtemp('/tmp/amux-hover-')
const sourcePaths = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx', 'apps/desktop/src/renderer/src/components/AgentAvatar.tsx', 'apps/desktop/src/renderer/src/styles/focus.css', 'apps/desktop/src/renderer/src/styles/activity-conversation.css', 'apps/desktop/src/renderer/src/lib/conversation-speaker.ts', 'apps/desktop/src/renderer/src/components/ConversationMessage.tsx', 'apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/entry.mjs', 'apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/main.mjs', 'apps/desktop/scripts/fixtures/focus-timeline-hover-inspection/index.html']
// Read-only Root T004 inputs: the same compiled scene can inspect the actual ruler UI.
sourcePaths.push('apps/desktop/src/renderer/src/lib/focus-timeline-ruler.ts', 'apps/desktop/src/renderer/src/components/FocusTimelineRulerSettings.tsx', 'apps/desktop/src/renderer/src/styles/focus-timeline-ruler.css', 'apps/desktop/src/renderer/src/store.ts')
const binding = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
const receipt = { schema: 'agentmux.focus-timeline-hover-scene.v1', passed: false, candidate: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), inputs: await binding(), publicProducer: { file: producerFile, sha256: hash(producerBytes), boundary: producer.boundary }, actual: null, images: [], actualLoadedModules: [], compiled: {}, cleanup: null, boundary: 'Current Vite compiled Focus Timeline/Avatar/Preview, public-projector counter and isolated typed I/O over sealed genuine producer facts. No full App/Core build, Runtime, writer, restart, installation or user controls.' }
await fs.mkdir(evidence, { recursive: true })
try {
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
  await fs.writeFile(path.join(evidence, 'freshness.log'), freshness.stdout + freshness.stderr); assert.equal(freshness.status, 0)
  const rulerFitMutation = process.env.AGENTMUX_FOCUS_RULER_FIT_MUTANT === 'off', fitMutations = []
  const loaded = [], binder = { name: 'actual-hover-module-binding', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0], original = code, projector = file === path.join(root, 'packages/core/dist/session-user-messages.js')
    if (projector) {
      const anchor = 'export function projectSessionUserMessages(params) {'; assert.equal(code.split(anchor).length, 2)
      code = code.replace(anchor, `${anchor}\n    window.__focusHoverProjectorCalls = (window.__focusHoverProjectorCalls ?? 0) + 1;`)
    }
    if (rulerFitMutation && file === path.join(desktop, 'src/renderer/src/components/RecentFocusTimeline.tsx')) {
      const anchor = 'const fits = row.rect.width > 0 && row.rect.left >= bounds.left && row.rect.right <= bounds.right && accepted.every(before => row.rect.right <= before.left || row.rect.left >= before.right)'
      assert.equal(code.split(anchor).length,2)
      code = code.replace(anchor,'const fits = row.rect.width > 0')
      fitMutations.push({ owner: path.relative(root,file), originalSHA256: hash(original), loadedSHA256: hash(code), anchor, code })
    }
    if (projector || file.startsWith(`${root}/apps/desktop/src/`) && /\.(?:[cm]?[jt]sx?|css)$/.test(file)) loaded.push({ path: path.relative(root, file), originalSHA256: hash(original), sha256: hash(code), bytes: Buffer.byteLength(code), ...(projector ? { instrumentation: 'public-projector-counter' } : {}) })
    if (code !== original) return { code, map: null }
  } }
  const labelMutation = process.env.AGENTMUX_FOCUS_RULER_LABEL_MUTANT === 'center-overflow'
  const cssOwner = await fs.realpath(path.join(root, 'apps/desktop/src/renderer/src/styles/focus-timeline-ruler.css'))
  const cssMutations = [], labelMutant = { postcssPlugin: 'actual-ruler-label-fit-mutant', async Once(cssRoot) {
    if (!labelMutation) return
    const declarations = []
    cssRoot.walkDecls('transform', node => { if(node.parent?.selector === '.recent-focus[data-ruler-mode] .recent-focus__tick time') declarations.push(node) })
    for (const node of declarations) {
      if (!node.source?.input.file || await fs.realpath(node.source.input.file) !== cssOwner) continue
      const original = node.value; assert.ok(original.startsWith('translateX(clamp('))
      node.value = 'translateX(-50%)'
      cssMutations.push({ owner: path.relative(root,cssOwner), selector: node.parent.selector, original, replacement: node.value })
      await fs.writeFile(path.join(evidence, 'actual-loaded-label-mutant.css'), cssRoot.toString())
    }
  } }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', plugins: [binder], css: { postcss: { plugins: [labelMutant] } }, define: { __AGENTMUX_FOCUS_HOVER_PUBLIC_PRODUCER__: JSON.stringify(producerBytes.toString('utf8')), __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true, rollupOptions: { input: path.join(fixture, 'index.html') } } })
  if (labelMutation) { assert.equal(cssMutations.length,1); receipt.labelMutation = { kind: 'center-overflow', count: cssMutations.length, entries: cssMutations, actualLoadedCSS: { path: 'actual-loaded-label-mutant.css', sha256: hash(await fs.readFile(path.join(evidence, 'actual-loaded-label-mutant.css'))) } } }
  if (rulerFitMutation) {
    assert.equal(fitMutations.length,1)
    const { code, ...binding } = fitMutations[0]
    await fs.writeFile(path.join(evidence, 'actual-loaded-filter-mutant.tsx'), code)
    receipt.filterMutation = { kind: 'actual-rectangle-fit-off', count: fitMutations.length, ...binding }
  }
  for (const file of sourcePaths.slice(0, 3)) assert.ok(loaded.some(item => item.path === file && item.originalSHA256 === receipt.inputs[file]))
  assert.ok(loaded.some(item => item.instrumentation === 'public-projector-counter')); receipt.actualLoadedModules = loaded
  await fs.copyFile(path.join(fixture, 'main.mjs'), path.join(privateRoot, 'main.mjs'))
  await fs.mkdir(path.join(privateRoot, 'node_modules'), { recursive: true }); await fs.symlink(path.join(desktop, 'node_modules/electron'), path.join(privateRoot, 'node_modules/electron'))
  const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
  receipt.compiled = Object.fromEntries(await Promise.all((await files(path.join(privateRoot, 'renderer'))).map(async file => [path.relative(privateRoot, file), hash(await fs.readFile(file))])))
  receipt.compiled['main.mjs'] = hash(await fs.readFile(path.join(privateRoot, 'main.mjs')))
  const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
  const lines = [], result = await runProbeProcess(electron, [path.join(privateRoot, 'main.mjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, evidence], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 120_000, onLine: line => lines.push(line) })
  await fs.writeFile(path.join(evidence, 'scene.log'), lines.join('\n'))
  const actual = JSON.parse(await fs.readFile(path.join(evidence, 'scene.json'), 'utf8')); receipt.actual = { result, ...actual }
  // Even a genuine failed operation keeps the painted frames and exact input binding.
  for (const frame of actual.frames) receipt.images.push({ path: frame.image, width: frame.width, sha256: hash(await fs.readFile(path.join(evidence, frame.image))) })
  receipt.after = await binding(); assert.deepEqual(receipt.after, receipt.inputs)
  assert.equal(result.timedOut, false); assert.equal(result.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true)
  assert.deepEqual(actual.controls, []); assert.deepEqual(actual.cost.start.counts, actual.cost.end.counts)
  if(actual.phase==='fold-360') assert.equal(actual.frames.length,1)
  else if(actual.phase==='label-fit') assert.equal(actual.frames.length,2)
  else { assert.equal(actual.cost.hoverPasses, 200); assert.equal(actual.cost.viewportUpdates, 200) }
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { remaining, privateRootRemoved: false }
  if (!remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message); assert.equal(receipt.cleanup.privateRootRemoved, true)
console.log(JSON.stringify({ passed: true, receipt: path.relative(root, path.join(evidence, 'receipt.json')), images: receipt.images.length }))
