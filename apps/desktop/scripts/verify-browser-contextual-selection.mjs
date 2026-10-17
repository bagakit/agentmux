import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
const baseline = args.includes('--baseline'), handoff = args.includes('--capture-handoff'), foreground = args.includes('--foreground')
let output = join(root, '.tmp/browser-agent-collaboration/contextual-selection-proof'), coreBuildReceipt
const qualifiedEnvironment = process.env.AGENTMUX_BROWSER_SELECTION_QUALIFIED_INPUT
assert.ok(qualifiedEnvironment === undefined || qualifiedEnvironment.trim(), 'Qualified selection input cannot be empty')
let qualifiedInput = qualifiedEnvironment && resolve(qualifiedEnvironment)
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output') { assert.ok(args[i + 1] && !args[i + 1].startsWith('--')); output = resolve(args[++i]) }
  else if (args[i] === '--core-build-receipt') { assert.ok(args[i + 1] && !args[i + 1].startsWith('--')); coreBuildReceipt = resolve(args[++i]) }
  else if (args[i] === '--qualified-input') {
    assert.ok(args[i + 1] && !args[i + 1].startsWith('--'))
    const file = resolve(args[++i]); assert.ok(!qualifiedInput || qualifiedInput === file, 'CLI and environment must select the same original evidence')
    qualifiedInput = file
  }
  else assert.ok(['--baseline', '--capture-handoff', '--foreground'].includes(args[i]), 'Unsupported selection proof argument')
}
assert.ok(!foreground || handoff, 'Foreground selection uses the exact private capture handoff')
assert.ok(!qualifiedInput || !baseline && !handoff && !foreground && !coreBuildReceipt, 'Qualified input only reads original evidence; observation options cannot be combined')
assert.ok(qualifiedInput || coreBuildReceipt, 'A new observation identifies its exact source-qualified Core build receipt')
await mkdir(output, { recursive: true })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.browser-contextual-selection.proof.v1', passed: false, baselineOnly: baseline,
  candidate: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), sources: {},
  physicalInputQualified: false, independentVisualReview: 'not-performed',
  boundary: 'One private actual BrowserPane/editor workflow through original Main, Hosted/Core, Provider and reader. Separate Renderer and native document images never stand in for an OS whole-window visual review.' }
receipt.sources[relative(root, fileURLToPath(import.meta.url))] = hash(await readFile(fileURLToPath(import.meta.url)))
async function run(file, parameters, name) {
  const log = []
  const status = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [file, ...parameters], { cwd: root, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] })
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { log.push(bytes); process.stdout.write(bytes) })
    child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal }))
  })
  await writeFile(join(output, name + '.log'), Buffer.concat(log))
  assert.equal(status.code, 0, name + ' must complete its actual product assertions'); assert.equal(status.signal, null)
}
async function consume(path) {
  const value = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(value.candidate, receipt.candidate)
  assert.ok(Object.keys(value.sources).length > 0, 'A qualified selection slice binds real nonempty source inputs')
  for (const [file, digest] of Object.entries(value.sources)) {
    assert.equal(hash(await readFile(join(root, file))), digest, 'Changed selection source: ' + file)
    if (receipt.sources[file]) assert.equal(receipt.sources[file], digest)
    receipt.sources[file] = digest
  }
  return value
}
async function reuseQualified() {
  const bytes = await readFile(qualifiedInput), input = JSON.parse(bytes)
  assert.equal(input.schema, 'agentmux.browser-contextual-selection.qualified-input.v1')
  const artifacts = {}
  async function load(name) {
    const entry = input[name], file = resolve(dirname(qualifiedInput), entry.file), bytes = await readFile(file)
    assert.match(entry.sha256, /^[a-f0-9]{64}$/u); assert.equal(hash(bytes), entry.sha256, 'Original artifact: ' + name)
    artifacts[name] = { file: relative(root, file), sha256: entry.sha256 }
    return JSON.parse(bytes)
  }
  const proof = await load('behavior'), native = await load('native'), unit = await load('opinion')
  const sourceJoin = await load('sourceJoin'), visual = await load('visualReview'), resolution = await load('preloadResolution')
  assert.equal(proof.schema, receipt.schema); assert.equal(proof.passed, true); assert.equal(proof.baselineOnly, false)
  assert.equal(native.candidate, proof.candidate); assert.equal(native.selectionBaselineComplete, true); assert.equal(native.runs.length, 1)
  const actual = native.runs[0].actual
  assert.equal(actual.passed, true); assert.equal(actual.cases.length, 1); assert.deepEqual(actual.cleanupFailures, [])
  assert.equal(actual.ipc.filter(call => call.channel === 'sessions:submitPrompt').length, 1)
  assert.equal(actual.selection.publicInspect.passed, true); assert.equal(actual.selection.preview.exactSender, true)
  assert.equal(proof.native.sha256, input.native.sha256); assert.equal(proof.opinion.sha256, input.opinion.sha256)
  assert.equal(unit.schema, 'agentmux.browser-opinion-selection.proof.v1'); assert.equal(unit.candidate, proof.candidate); assert.equal(unit.passed, true)
  assert.equal(unit.runs.length, 9); assert.ok(unit.runs.every(run => run.assertions === 14 && !run.timedOut && run.signal === null))
  for (const run of [unit.runs[0], unit.runs.at(-1)]) { assert.equal(run.code, 0); assert.equal(run.failures, 0) }
  assert.equal(new Set(unit.runs.slice(1, -1).map(run => run.label)).size, 7)
  assert.ok(unit.runs.slice(1, -1).every(run => run.code !== 0 && run.failures > 0 && run.owningAssertion))
  assert.equal(sourceJoin.behavior.sha256, input.behavior.sha256); assert.equal(sourceJoin.behaviorCandidate, proof.candidate)
  assert.equal(sourceJoin.independentVisual.sha256, input.visualReview.sha256); assert.equal(sourceJoin.withinScope, true)
  assert.equal(sourceJoin.qaRepair.resolutionSha256, input.preloadResolution.sha256)
  assert.equal(resolution.passed, true); assert.equal(resolution.candidate, sourceJoin.candidate)
  assert.equal(resolution.records.find(record => record.sourceAliases)?.foreignCompiledCount, 0)
  assert.equal(visual.candidate, proof.candidate); assert.equal(visual.reviewed, true); assert.equal(visual.approved, true)
  assert.deepEqual(visual.blockingFindings, []); assert.equal(visual.files.length, 2); assert.equal(input.images.length, 2)
  assert.deepEqual(visual.files.map(file => file.shape).sort(), ['narrow', 'normal'])
  assert.equal(new Set(input.images.map(image => image.sha256)).size, 2)
  const frames = actual.frames.filter(frame => frame.surface === 'os-native-window')
  assert.equal(frames.length, 2)
  for (const image of input.images) {
    const bytes = await readFile(resolve(dirname(qualifiedInput), image.file)); assert.equal(hash(bytes), image.sha256)
    assert.ok(visual.files.some(file => file.sha256 === image.sha256 && file.approved && file.actuallyViewedOriginal))
    assert.ok(frames.some(frame => frame.sha256 === image.sha256 && frame.native.pid === visual.pid && frame.native.windowId === visual.windowId))
  }
  // Own the image/input result, not unrelated metrics, Session observation or the entire bundle.
  const owners = [
    'apps/desktop/src/main/browser-input-context-capture.ts', 'apps/desktop/src/main/browser-input-context-ipc.ts',
    'apps/desktop/src/main/browser-input-selection-image.ts', 'apps/desktop/src/main/browser-view-manager.ts',
    'apps/desktop/src/main/pasted-image-write.ts', 'apps/desktop/src/main/pasted-image-read.ts', 'apps/desktop/src/preload/index.ts',
    'apps/desktop/src/renderer/src/components/BrowserContextualComposer.tsx', 'apps/desktop/src/renderer/src/components/BrowserOpinionSelection.tsx',
    'apps/desktop/src/renderer/src/lib/browser-opinion-draft.ts', 'apps/desktop/src/renderer/src/components/image-annotation/ImageAnnotationEditor.tsx',
    'apps/desktop/src/renderer/src/components/image-annotation/document.ts', 'apps/desktop/src/renderer/src/components/image-annotation/image-annotation.css',
    'apps/desktop/src/renderer/src/styles/browser-contextual-composer.css', 'apps/desktop/src/renderer/src/components/DesktopClientUiProvider.tsx',
    'apps/desktop/src/renderer/src/components/BrowserSelectionImage.tsx', 'apps/host/src/input-context-capture-reader.ts',
    'packages/core/src/browser-input-context.ts', 'packages/core/src/agent-input-context-capture.ts',
    'packages/core/src/agent-input-context-capture-resolve.ts', 'packages/core/src/agent-outbound-message.ts', 'packages/core/src/providers/codex.ts',
    'packages/client-ui/src/components/ConversationInputText.tsx', 'packages/client-ui/src/components/ConversationBrowserContext.tsx',
    'packages/client-ui/src/components/CapturedConversationMessage.tsx'
  ]
  for (const file of owners) {
    assert.match(input.productSources[file], /^[a-f0-9]{64}$/u)
    assert.equal(input.productSources[file], proof.sources[file], 'Original owning source: ' + file)
    assert.equal(hash(await readFile(join(root, file))), input.productSources[file], 'Changed selection owner: ' + file)
    receipt.sources[file] = input.productSources[file]
  }
  receipt.qualifiedInput = { file: relative(root, qualifiedInput), sha256: hash(bytes) }
  receipt.reused = { originalCandidate: proof.candidate, artifacts, images: input.images, productSourceCount: owners.length,
    nonOwningDifference: sourceJoin.qaRepair, ordinaryRestartQualified: false }
  receipt.independentVisualReview = 'approved-original-captures'
  receipt.boundary = 'Read existing exact product, mutation and independent OS visual evidence only. No product process, Agent input, capture, replay, current-page read or ordinary restart is performed.'
  receipt.passed = true
}
try {
  if (qualifiedInput) await reuseQualified()
  else {
  const nativeDirectory = join(output, 'native')
  await run('apps/desktop/scripts/verify-browser-contextual-composer.mjs', ['--selection-only', '--output', nativeDirectory,
    '--core-build-receipt', coreBuildReceipt,
    ...(handoff ? ['--capture-handoff'] : []), ...(foreground ? ['--foreground'] : [])], 'selection-native')
  const native = await consume(join(nativeDirectory, 'receipt.json'))
  assert.equal(native.selectionBaselineComplete, true)
  assert.equal(native.runs.length, 1)
  assert.equal(native.runs[0].actual.selection.passed, true)
  assert.equal(native.runs[0].actual.selection.publicInspect.passed, true)
  assert.ok(native.coreBuild?.sourceCount > 0 && native.coreBuild?.outputCount > 0)
  receipt.coreBuild = native.coreBuild
  receipt.native = { file: relative(root, join(nativeDirectory, 'receipt.json')), sha256: hash(await readFile(join(nativeDirectory, 'receipt.json'))), wholeWindowCaptures: native.runs[0].actual.frames?.filter(frame => frame.surface === 'os-native-window').length ?? 0 }
  if (handoff) assert.equal(receipt.native.wholeWindowCaptures, 2, 'Selection handoff retains its exact normal and narrow native window images')
  if (!baseline) {
    const path = join(output, 'opinion.json')
    await run('apps/desktop/scripts/verify-browser-opinion-selection.mjs', ['--receipt', path], 'opinion-owner')
    const unit = await consume(path)
    assert.equal(unit.schema, 'agentmux.browser-opinion-selection.proof.v1'); assert.equal(unit.passed, true)
    assert.equal(unit.runs.length, 9)
    assert.ok(unit.runs.every(run => run.assertions === 14))
    receipt.opinion = { file: relative(root, path), sha256: hash(await readFile(path)) }
  }
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), receipt.candidate)
  for (const [file, digest] of Object.entries(receipt.sources)) assert.equal(hash(await readFile(join(root, file))), digest, 'Changed final selection source: ' + file)
  receipt.passed = true
  }
} catch (error) { receipt.failure = { message: error.message, stack: error.stack }; throw error }
finally { await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
