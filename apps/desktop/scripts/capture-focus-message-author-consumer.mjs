import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { runProbeProcess, listProbeProcesses } from './probe-process.mjs'

const root = path.resolve(import.meta.dirname, '../../..'), desktop = path.join(root, 'apps/desktop'), fixture = path.join(desktop, 'scripts/fixtures/focus-message-author-consumer')
const evidence = path.resolve(process.argv[2] ?? path.join(root, `.tmp/focus-message-author-consumer-scene-${Date.now()}`)), variants = process.argv.slice(3)
if (!variants.length) variants.push('authors', 'authors-crowded', 'known', 'conflict')
assert.ok(variants.every(value => ['authors', 'authors-closeout', 'authors-crowded', 'authors-addendum', 'known', 'conflict'].includes(value)))
const producerPath = process.env.AGENTMUX_FOCUS_AUTHOR_PUBLIC_PRODUCER
assert.ok(producerPath, 'Actual manual receipt/FileStore/public projector producer required, never a hand-made human DTO')
const producerBytes = await fs.readFile(path.resolve(root, producerPath)), producer = JSON.parse(producerBytes)
assert.equal(producer.schema, 'agentmux.focus-author-public-producer.v1'); assert.equal(producer.messages.length, 5)
assert.deepEqual(producer.messages.map(item => item.author.kind), ['unknown', 'unknown', 'human', 'agent', 'unknown'])
assert.equal(new Set(producer.messages.map(item => item.id)).size, 5); assert.equal(producer.captured.items[0].authorHuman, true)
const crowdedPath = `${producerPath}.crowded.json`, crowdedBytes = await fs.readFile(path.resolve(root, crowdedPath)), crowded = JSON.parse(crowdedBytes)
assert.equal(crowded.schema, producer.schema); assert.deepEqual(crowded.messages.map(item => item.author.kind), ['unknown', 'unknown', 'human', 'agent', 'unknown']); assert.equal(new Set(crowded.messages.filter(item => item.recordedAt !== undefined).map(item => Math.floor(item.recordedAt / 60000))).size, 1)
const require = createRequire(path.join(desktop, 'package.json')), { build } = await import(pathToFileURL(require.resolve('vite')).href), electron = process.env.AGENTMUX_PROOF_ELECTRON_PATH ?? require('electron')
const privateRoot = await fs.mkdtemp('/tmp/amux-focus-nav-'), hash = bytes => createHash('sha256').update(bytes).digest('hex')
const sourcePaths = ['apps/desktop/src/renderer/src/components/RecentFocusTimeline.tsx', 'apps/desktop/src/renderer/src/lib/focus-time-window.ts', 'apps/desktop/src/renderer/src/styles/focus.css', 'apps/desktop/src/renderer/src/styles/activity-conversation.css', 'apps/desktop/src/renderer/src/styles/conversation-avatar.css', 'apps/desktop/src/renderer/src/styles/index.css', 'apps/desktop/src/renderer/src/lib/focus-history-timeline.ts', 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx', 'apps/desktop/src/renderer/src/lib/conversation-speaker.ts', 'apps/desktop/scripts/fixtures/focus-message-author-consumer/entry.mjs', 'apps/desktop/scripts/fixtures/focus-message-author-consumer/main.mjs', 'apps/desktop/scripts/fixtures/focus-message-author-consumer/index.html', 'apps/desktop/scripts/fixtures/focus-timeline-navigation/entry.mjs']
const binding = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
const receipt = { schema: 'agentmux.focus-timeline-navigation-scene-delivery.v1', passed: false, candidate: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(), sourceRoot: root, publicProducer: { file: producerPath, sha256: hash(producerBytes), boundary: producer.boundary, crowded: { file:crowdedPath, sha256:hash(crowdedBytes) } }, inputs: await binding(), actual: { controls: [], scenes: [] }, compiled: {}, images: [], cleanup: null, boundary: 'Normal Vite compiled production Timeline/API/Store, typed isolated I/O and trusted CDP presentation operations. Not public Reader/native Writer, whole App build, Runtime, restart, installation or healthy-user Run qualification.', independentVisualReview: 'pending' }
const geometryMutation = process.env.AGENTMUX_FOCUS_AUTHOR_GEOMETRY_MUTATION
if (geometryMutation) assert.ok(['marker-top', 'controls-scrollbar'].includes(geometryMutation))
receipt.geometryMutation = geometryMutation ?? null
await fs.mkdir(evidence, { recursive: true })
try {
  const freshness = spawnSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e', `const {assertWorkspaceDistBuiltFromCurrentSource}=await import(${JSON.stringify(pathToFileURL(path.join(root, 'vitest.dist-freshness.ts')).href)});await assertWorkspaceDistBuiltFromCurrentSource(${JSON.stringify(root)});`], { cwd: root, encoding: 'utf8' })
  await fs.writeFile(path.join(evidence, 'freshness.log'), freshness.stdout + freshness.stderr); assert.equal(freshness.status, 0)
  const loaded = [], binder = { name: 'actual-timeline-navigation-module-binding', enforce: 'pre', transform(code, id) {
    const file = id.split('?')[0], original = code
    const projector = file === path.join(root, 'packages/core/dist/session-user-messages.js')
    if (projector) {
      const anchor = 'export function projectSessionUserMessages(params) {'
      assert.equal(code.split(anchor).length, 2, 'Unique actual public projector counter anchor')
      code = code.replace(anchor, `${anchor}\n    window.__focusAuthorProjectorCalls = (window.__focusAuthorProjectorCalls ?? 0) + 1;`)
    }
    if (geometryMutation === 'marker-top' && file === path.join(root, 'apps/desktop/src/renderer/src/components/FocusMessagePreview.tsx')) {
      const anchor = 'header.getBoundingClientRect().top'
      assert.equal(code.split(anchor).length, 2, 'Unique actual virtual-reference mutation anchor')
      code = code.replace(anchor, 'markerBounds.top')
    }
    if (projector || file.startsWith(`${root}/apps/desktop/src/`) && /\.(?:[cm]?[jt]sx?|css)$/.test(file)) loaded.push({ path: path.relative(root, file), originalSHA256: hash(original), sha256: hash(code), bytes: Buffer.byteLength(code), ...(projector ? { instrumentation: 'public-projector-counter' } : code !== original ? { mutation: geometryMutation } : {}) })
    if (code !== original) return { code, map: null }
  } }
  let scrollbarDeclarations = 0
  const cssBinding = { postcssPlugin: 'actual-focus-controls-source-declaration', Declaration(declaration) {
    if (declaration.prop !== 'scrollbar-width' || declaration.parent.selector !== '.recent-focus__controls') return
    assert.equal(declaration.source.input.file, path.join(root, 'apps/desktop/src/renderer/src/styles/focus.css'))
    assert.equal(declaration.value, 'none'); scrollbarDeclarations++
    const original = declaration.source.input.css, anchor = 'overflow-x: auto; scrollbar-width: none;'
    assert.equal(original.split(anchor).length, 2, 'Nonempty unique actual imported CSS declaration')
    const code = geometryMutation === 'controls-scrollbar' ? original.replace(anchor, 'overflow-x: auto;') : original
    loaded.push({ path: 'apps/desktop/src/renderer/src/styles/focus.css', originalSHA256: hash(original), sha256: hash(code), bytes: Buffer.byteLength(code), loadedPhase: 'postcss-import-source-declaration', selector: declaration.parent.selector, ...(geometryMutation === 'controls-scrollbar' ? { mutation: geometryMutation } : {}) })
    if (geometryMutation === 'controls-scrollbar') declaration.remove()
  } }
  await build({ configFile: false, root: fixture, base: './', logLevel: 'error', plugins: [binder], css: { postcss: { plugins: [cssBinding] } }, define: { __AGENTMUX_FOCUS_AUTHOR_PUBLIC_PRODUCER__: JSON.stringify(producerBytes.toString('utf8')), __AGENTMUX_FOCUS_AUTHOR_CROWDED_PRODUCER__: JSON.stringify(crowdedBytes.toString('utf8')), __AGENTMUX_WEB_PREVIEW__: 'true', 'process.env.NODE_ENV': '"production"' }, build: { target: 'esnext', outDir: path.join(privateRoot, 'renderer'), emptyOutDir: true, rollupOptions: { input: path.join(fixture, 'index.html') } } })
  assert.equal(scrollbarDeclarations, 1, 'Actual imported Focus controls declaration is loaded exactly once')
  assert.ok(loaded.some(module => module.path.endsWith('/RecentFocusTimeline.tsx'))); receipt.actualLoadedModules = loaded
  assert.ok(loaded.some(module => module.instrumentation === 'public-projector-counter'))
  await fs.copyFile(path.join(fixture, 'main.mjs'), path.join(privateRoot, 'main.mjs'))
  await fs.mkdir(path.join(privateRoot, 'node_modules'), { recursive: true }); await fs.symlink(path.join(desktop, 'node_modules/electron'), path.join(privateRoot, 'node_modules/electron'))
  const files = async directory => (await Promise.all((await fs.readdir(directory, { withFileTypes: true })).map(entry => entry.isDirectory() ? files(path.join(directory, entry.name)) : [path.join(directory, entry.name)]))).flat()
  receipt.compiled = Object.fromEntries(await Promise.all((await files(path.join(privateRoot, 'renderer'))).map(async file => [path.relative(privateRoot, file), hash(await fs.readFile(file))])))
  const compiledStyles = (await files(path.join(privateRoot, 'renderer'))).filter(file => file.endsWith('.css'))
  assert.equal(compiledStyles.length, 1, 'One actual compiled stylesheet, not an injected override')
  const cssBytes = await fs.readFile(compiledStyles[0]); await fs.writeFile(path.join(evidence, 'actual-compiled.css'), cssBytes)
  receipt.compiledStylesheet = { path: 'actual-compiled.css', sha256: hash(cssBytes), bytes: cssBytes.length }
  receipt.compiled['main.mjs'] = hash(await fs.readFile(path.join(privateRoot, 'main.mjs')))
  for (const variant of variants) {
    const env = { ...process.env, AGENTMUX_RUNTIME_DIRECTORY: path.join(privateRoot, 'runtime'), AGENTMUX_STATE_DIRECTORY: path.join(privateRoot, 'state') }; delete env.ELECTRON_RUN_AS_NODE
    const lines = [], result = await runProbeProcess(electron, [path.join(privateRoot, 'main.mjs'), path.join(privateRoot, 'renderer/index.html'), privateRoot, evidence, variant, variant.startsWith('authors') ? 'authors' : 'supplement'], { temporaryRoot: privateRoot, cwd: root, env, timeoutMs: 90_000, onLine: line => lines.push(line) })
    await fs.writeFile(path.join(evidence, `${variant}.log`), lines.join('\n'))
    const actual = JSON.parse(await fs.readFile(path.join(evidence, `${variant}-scene.json`), 'utf8'))
    receipt.actual.scenes.push({ variant, result, ...actual }); receipt.actual.controls.push(...actual.controls)
    assert.equal(result.timedOut, false); assert.equal(result.exitCode, 0, actual.failure?.message); assert.equal(actual.passed, true)
    for (const frame of actual.frames) receipt.images.push({ path: frame.image, width: frame.width, variant, sha256: hash(await fs.readFile(path.join(evidence, frame.image))) })
  }
  assert.deepEqual(await binding(), receipt.inputs, 'Actual source is unchanged during compiled capture'); assert.deepEqual(receipt.actual.controls, variants.some(variant => ['authors', 'authors-closeout'].includes(variant)) ? ['focus-author-sender'] : [])
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  const remaining = await listProbeProcesses(-1, privateRoot); receipt.cleanup = { remaining, privateRootRemoved: false }
  if (!remaining.length) { await fs.rm(privateRoot, { recursive: true, force: true }); receipt.cleanup.privateRootRemoved = true }
  await fs.writeFile(path.join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
}
assert.equal(receipt.passed, true, receipt.failure?.message); assert.equal(receipt.cleanup.privateRootRemoved, true)
const parentBytes = await fs.readFile(path.join(evidence, 'receipt.json'))
const writePhase = async (name, scenes, images, controls, boundary) => {
  const phase = { ...receipt, phase: name, parent: { path: 'receipt.json', sha256: hash(parentBytes), completeControls: receipt.actual.controls }, actual: { controls, scenes }, images, boundary }
  await fs.writeFile(path.join(evidence, `${name}-receipt.json`), JSON.stringify(phase, null, 2) + '\n')
}
const authorScene = receipt.actual.scenes.find(scene => ['authors', 'authors-closeout'].includes(scene.variant))
if (authorScene) {
  const phase = authorScene.mousePhase
  assert.equal(phase.viewportUpdates, 200); assert.deepEqual(phase.controls, []); assert.deepEqual(phase.start.counts, phase.end.counts)
  const addendum = receipt.actual.scenes.find(scene => scene.variant === 'authors-addendum')
  await writePhase('navigation-phase', [{ variant: 'author-pinned-navigation', result: authorScene.result, passed: true, pid: authorScene.pid, ...phase, attempts: authorScene.viewportAttempts, pinnedGeometry: authorScene.pinnedGeometry, preservation: authorScene.preservation, narrowPreview: authorScene.narrowPreview }, ...(addendum ? [addendum] : [])], receipt.images.filter(image => [`${authorScene.variant}-wide.png`, `${authorScene.variant}-human-preview.png`, 'authors-human-320-preview.png', 'authors-addendum-narrow-next-now.png', 'authors-addendum-detached-body.png'].includes(image.path)), phase.controls, 'Only the explicit 200-action mouse phase plus the separate private PID addendum for detached-marker reading and 320px native control scroll. Full parent trace contains one earlier verified sender navigation; phase start/end retain that trace, phase delta is zero. No Runtime/App restart/installation qualification.')
  await writePhase('authors-phase', receipt.actual.scenes.filter(scene => scene.variant.startsWith('authors')), receipt.images.filter(image => image.variant.startsWith('authors')), authorScene.controls, receipt.boundary)
}
const projects = receipt.actual.scenes.filter(scene => ['known', 'conflict'].includes(scene.variant))
if (projects.length) await writePhase('projects-phase', projects, receipt.images.filter(image => ['known', 'conflict'].includes(image.variant)), projects.flatMap(scene => scene.final.controls), 'Only the separate known/conflict project presentation phases. Typed isolated I/O, compiled current Timeline/Preview; not a public Reader/native Writer or App/Runtime qualification. Full parent author trace retains its one explicit sender navigation.')
console.log(JSON.stringify({ passed: true, receipt: path.relative(root, path.join(evidence, 'receipt.json')), images: receipt.images }))
