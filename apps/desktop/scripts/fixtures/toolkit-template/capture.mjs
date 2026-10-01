import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, relative, dirname } from 'node:path'
import { capturePerformancePanel } from '../performance-panel/capture.mjs'

const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const proofFiles = [
  'apps/desktop/scripts/verify-toolkit-template.mjs',
  ...['capture.mjs', 'entry.tsx', 'main.cjs', 'preload.cjs', 'owner-entry.ts', 'index.html', 'data.ts', 'health-entry.ts', 'coordinator.cjs', 'qualification.cjs', 'query.mjs', 'vitest.config.mts', 'tsconfig.owning.json'].map(file => 'apps/desktop/scripts/fixtures/toolkit-template/' + file),
  ...['entry.tsx', 'main.cjs', 'preload.cjs', 'owner-entry.ts', 'data.ts', 'health-entry.ts', 'coordinator.cjs', 'tsconfig.owning.json'].map(file => 'apps/desktop/scripts/fixtures/toolkit-custom-ui/' + file),
  'apps/desktop/scripts/fixtures/toolkit-custom/tsconfig.owning.json',
  'apps/desktop/scripts/fixtures/toolkit-preferences/vitest.config.mts',
  'tsconfig.base.json', 'vitest.setup.ts',
  'apps/desktop/scripts/fixtures/performance-panel/capture.mjs',
  'apps/desktop/scripts/probe-process.mjs',
  'apps/desktop/test/toolkit-template-script.test.ts',
  'apps/desktop/test/toolkit-template-ui.test.tsx',
  'apps/desktop/test/helpers/composer-dom-fixture.tsx'
]
const expectedFrames = [
  '1480-dark-template.png', '320-light-template.png', '320-light-editable.png', '1480-dark-result.png',
  '320-light-unknown-result.png', '320-light-failed-result.png', 'restart-1480-dark-result.png'
]

function actualFacts(native, raw) {
  assert.equal(native.completed, true, 'Actual template native assertions and cleanup complete')
  assert.equal(native.sourceCurrentReadbackExact, true)
  assert.deepEqual(native.changedAfterCapture, []); assert.deepEqual(native.remainingPrivateProcesses, []); assert.equal(native.privateRootRemoved, true)
  assert.ok(native.sdkClosure); assert.equal(native.sdkClosure.actualProtocol, native.sdkClosure.manifestProtocol)
  assert.equal(native.inputs[native.sdkClosure.archive].sha256, native.sdkClosure.archiveSHA256)
  assert.ok(native.compiled.some(item => item.file === native.sdkClosure.entry && item.sha256 === native.sdkClosure.entrySHA256), 'Executed private SDK belongs to the sealed archive and compiled collection')
  assert.equal(raw.qualificationScope, 'toolkit-template'); assert.equal(raw.qualified, true)
  assert.ok(raw.templateToolId); assert.equal(raw.externalCalls.length, 4)
  assert.equal(raw.authoritativeFailure.latestConfirmed.state, 'failed'); assert.ok(raw.authoritativeFailure.latestConfirmed.text.includes('Account query failed: exit 2'))
  assert.equal(raw.secondOutputAdapter.latestConfirmed.state, 'succeeded')
  assert.equal(raw.secondOutputAdapter.latestConfirmed.definition.script, raw.savedDefinition.script)
  assert.ok(raw.saveProofs.length > 0); for (const save of raw.saveProofs) assert.equal(save.committed.script, save.expectedScript)
  assert.equal(raw.cost.definitions, 128); assert.equal(raw.cost.inputCounts.unrelated, 128); assert.equal(raw.cost.models.length, 1); assert.equal(raw.cost.externalCalls, 4)
  assert.equal(raw.restart.ordinaryGuiProcesses, 2); assert.equal(raw.restart.exactSurface, true); assert.equal(raw.restart.confirmedResultRetained, true)
  assert.equal(raw.restart.healthyRunSamePid, true); assert.equal(raw.restart.realInputAckReplay, true); assert.equal(raw.restart.actualTerminalAutomaticAttach, true)
  assert.equal(raw.afterDisposalLeases, 0); assert.deepEqual(raw.frames, native.frames)
  assert.deepEqual(raw.frames.map(frame => frame.file).sort(), expectedFrames.slice().sort(), 'All finite original images are present exactly once')
}

export async function verifyToolkitTemplateNative({ root, evidence, bind, captureOnly = false }) {
  if (!captureOnly) {
    const packetPath = ".bagakit/design/toolkit-template-fixture/qualification/current.json"
    const packet = JSON.parse(await bind(packetPath, { copy: false }))
    assert.equal(packet.schema, 'agentmux.toolkit-template-qualification.v1')
    const readReceipt = async ref => {
      assert.ok(ref && typeof ref.path === 'string' && /^[a-f0-9]{64}$/u.test(ref.sha256))
      const bytes = await bind(ref.path, { copy: false }); assert.equal(hash(bytes), ref.sha256); return JSON.parse(bytes)
    }
    const native = await readReceipt(packet.native), raw = await readReceipt(packet.raw), wrapper = await readReceipt(packet.wrapper), visual = await readReceipt(packet.visual)
    actualFacts(native, raw)
    const nativeDirectory = dirname(resolve(root, packet.native.path)), rawInput = native.rawInputs.find(item => item.phase === 'toolkit')
    assert.ok(rawInput); assert.equal(rawInput.file, 'toolkit-render.json'); assert.equal(rawInput.sha256, packet.raw.sha256)
    assert.equal(resolve(root, packet.raw.path), resolve(nativeDirectory, rawInput.file), 'Raw belongs to this original native capture')
    assert.equal(wrapper.schema, 'agentmux.toolkit-template-native.v1'); assert.equal(wrapper.completed, true)
    assert.equal(wrapper.sourceIdentity, native.sourceIdentity); assert.deepEqual(wrapper.native, packet.native); assert.deepEqual(wrapper.raw, packet.raw)
    assert.equal(wrapper.proofIdentity, hash(JSON.stringify(wrapper.proofInputs)))
    assert.deepEqual(Object.keys(wrapper.proofInputs).sort(), proofFiles.slice().sort(), 'Every fixed wrapper proof Source is bound')
    for (const [file, identity] of Object.entries(wrapper.proofInputs)) assert.equal(hash(await bind(file, { copy: false })), identity.sha256, 'Current wrapper proof Source matches capture: ' + file)
    assert.equal(visual.sourceIdentity, native.sourceIdentity); assert.equal(visual.verdict, 'pass'); assert.deepEqual(visual.mustFix, [])
    assert.equal(visual.images.length, native.frames.length); assert.equal(new Set(visual.images.map(image => image.file)).size, native.frames.length)
    assert.deepEqual(wrapper.images.map(image => ({ file: image.file, sha256: image.sha256 })), native.frames.map(frame => ({ file: frame.file, sha256: frame.sha256 })))
    for (const frame of native.frames) {
      const image = visual.images.find(image => image.file === frame.file)
      assert.ok(image?.personallyViewedOriginal); assert.equal(image.sha256, frame.sha256)
      const bytes = await bind(relative(root, resolve(nativeDirectory, frame.file)), { copy: false }); assert.ok(bytes.length); assert.equal(hash(bytes), frame.sha256)
    }
    assert.ok(Object.keys(native.inputs).length > 0); assert.ok(native.compiled.length > 0)
    for (const [file, identity] of Object.entries(native.inputs)) assert.equal(hash(await bind(file, { copy: false })), identity.sha256, 'Current Source matches original native capture: ' + file)
    for (const artifact of native.compiled) assert.equal(hash(await bind(relative(root, resolve(nativeDirectory, artifact.file)), { copy: false })), artifact.sha256)
    return { sealed: true, native: packet.native, raw: packet.raw, wrapper: packet.wrapper, visual: packet.visual }
  }

  const proofInputs = {}
  for (const file of proofFiles) { const bytes = await bind(file); proofInputs[file] = { sha256: hash(bytes), bytes: bytes.length } }
  const before = process.env.AGENTMUX_TOOLKIT_UI_PREPARATION_SCOPE
  let native
  try { process.env.AGENTMUX_TOOLKIT_UI_PREPARATION_SCOPE = 'qualification'; native = await capturePerformancePanel({ root, evidence: resolve(evidence, 'native'), captureScope: 'toolkit', fixtureName: 'toolkit-template' }) }
  finally { if (before === undefined) delete process.env.AGENTMUX_TOOLKIT_UI_PREPARATION_SCOPE; else process.env.AGENTMUX_TOOLKIT_UI_PREPARATION_SCOPE = before }
  const directory = resolve(evidence, 'native'), file = resolve(directory, 'toolkit-render.json'), raw = JSON.parse(await readFile(file))
  actualFacts(native, raw)
  for (const [file, identity] of Object.entries(proofInputs)) assert.equal(hash(await bind(file)), identity.sha256, 'Capture wrapper proof Source stays exact: ' + file)
  const images = []
  for (const frame of raw.frames) { const bytes = await readFile(resolve(directory, frame.file)); assert.ok(bytes.length > 0); assert.equal(hash(bytes), frame.sha256); images.push({ file: frame.file, sha256: frame.sha256, bounds: frame.bounds, scene: frame.before }) }
  const result = { schema: 'agentmux.toolkit-template-native.v1', completed: true, aestheticReview: 'not-performed', sourceIdentity: native.sourceIdentity,
    proofInputs, proofIdentity: hash(JSON.stringify(proofInputs)),
    native: { path: relative(root, resolve(directory, 'receipt.json')), sha256: hash(await readFile(resolve(directory, 'receipt.json'))) },
    raw: { path: relative(root, file), sha256: hash(await readFile(file)) }, images, boundary: raw.boundary }
  await writeFile(resolve(directory, 'template-receipt.json'), JSON.stringify(result, null, 2) + '\n')
  await writeFile(resolve(directory, 'review.md'), '# T010 实际模板场景待独立看图\n\n本轮只新增模板预览、普通编辑与实际非空结果；沿原私有 App/Runtime owner 和普通 GUI 恢复，不复跑 T008 全矩阵。capture 成功不代表审美通过。\n\n请逐张打开以下完整 PNG，结合 toolkit-render.json 的原生点击与场景，检查主次、密度、对齐、窄窗可达性、低密度和结果可读性。给出明确 mustFix 与是否可交付，不用几何分数代替亲看。\n\n' + images.map(image => `- [${image.file}](${image.file}) — ${image.sha256}`).join('\n') + '\n')
  return result
}
