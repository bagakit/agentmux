import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { qualify } from './verify-settings-glass-prompts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const output = args.indexOf('--output')
const base = path.resolve(root, output < 0 ? '.bagakit/design/settings-all-pane-completion-20261004/appearance-preview/evidence' : args[output + 1])
const pane = 'apps/desktop/src/renderer/src/components/settings/AppearanceSettingsPane.tsx'
const sources = [
  path.relative(root, fileURLToPath(import.meta.url)),
  'apps/desktop/scripts/fixtures/settings-appearance-preview/scenario.cjs',
  'apps/desktop/scripts/fixtures/settings-appearance-preview/vitest.config.mts',
  'apps/desktop/scripts/fixtures/settings-prompts/entry.mjs',
  'apps/desktop/test/settings-radio-keyboard.test.tsx',
  'apps/desktop/test/settings-draft-conflict.test.tsx'
]

async function capture(at, glyphsOnly = false, sourceOverrides = {}) {
  assert.equal(await fs.stat(at).then(() => true, () => false), false, 'Fresh proof never overwrites earlier evidence')
  const receipt = await qualify(at, false, false, { modes: [glyphsOnly ? 'appearance-preview-glyphs' : 'appearance-preview'], sources, sourceOverrides })
  // Preserve bounded scenario/catalog inputs as well as the existing owning UI snapshots.
  for (const file of [...sources, 'apps/desktop/src/renderer/src/lib/terminal-theme.ts']) {
    const record = receipt.source[file]
    assert.ok(record && record.bytes > 0, 'Actual proof Source binding is nonempty: ' + file)
    const bytes = await fs.readFile(path.join(root, file))
    assert.equal(hash(bytes), record.sha256, 'No concurrent proof Source drift: ' + file)
    const target = path.join(at, 'source', file)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, bytes)
  }
  await fs.writeFile(path.join(at, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  return receipt
}

async function current(at) {
  const receipt = JSON.parse(await fs.readFile(path.join(at, 'receipt.json'), 'utf8'))
  assert.equal(receipt.completed, true, JSON.stringify(receipt.failure))
  assert.equal(receipt.processes.length, 1)
  assert.equal(receipt.processes[0].mode, 'appearance-preview')
  assert.equal(receipt.png.length, 3, 'Exactly the three actual representative Appearance windows')
  assert.ok(Object.keys(receipt.source).length > 0 && receipt.compiled.length > 0 && receipt.raw.length === 2)
  assert.deepEqual(receipt.remainingPrivateProcesses, [])
  assert.equal(receipt.privateRootRemoved, true)
  for (const [file, record] of Object.entries(receipt.source)) assert.equal(hash(await fs.readFile(path.join(root, file))), record.sha256, 'Accepted Source remains exact: ' + file)
  for (const asset of receipt.assets) assert.equal(hash(await fs.readFile(path.join(root, asset.file))), asset.sha256)
  for (const item of [...receipt.png, ...receipt.raw]) assert.equal(hash(await fs.readFile(path.join(at, item.file))), item.sha256)
  for (const item of receipt.compiled) assert.equal(hash(await fs.readFile(path.join(at, 'compiled', item.file))), item.sha256)
  assert.equal(hash(await fs.readFile(path.join(at, 'owner.mjs'))), receipt.ownerCompiled.sha256)
  return receipt
}

async function visual(at, receipt) {
  const review = JSON.parse(await fs.readFile(path.join(at, 'independent-visual-review.json'), 'utf8'))
  assert.equal(review.verdict, 'PASS')
  assert.equal(review.sourceIdentity, receipt.sourceIdentity)
  assert.ok(typeof review.reviewerId === 'string' && review.reviewerId.trim())
  assert.deepEqual(review.mustFix, [])
  assert.equal(review.images.length, receipt.png.length)
  const images = new Map(review.images.map(item => [item.file, item.sha256]))
  assert.equal(images.size, receipt.png.length, 'Every peer image entry is unique')
  for (const image of receipt.png) assert.equal(images.get(image.file), image.sha256, 'Peer actually reviewed this exact PNG: ' + image.file)
}

function replace(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, 'Actual owning Source anchor occurs exactly once: ' + before)
  return source.replace(before, after)
}

async function mutations() {
  const at = path.join(base, 'mutations', `run-${Date.now()}-${randomUUID()}`)
  await fs.mkdir(at, { recursive: true })
  const original = await fs.readFile(path.join(root, pane), 'utf8')
  const variants = [
    { id: 'old-long-samples', source: replace(replace(original, '›</b> project/', '›</b> Working in project'), '›</b> Ask agent…', '›</b> Ask or steer the agent…'), message: 'Appearance sample glyphs fit one fully visible line' },
    { id: 'multiline-sample', source: replace(original, '›</b> Ask agent…</span>', "›</b> <span style={{ whiteSpace: 'pre' }}>Ask agent…{'\\n'}Ask agent…{'\\n'}Ask agent…</span></span>"), message: 'Appearance sample glyphs fit one fully visible line' },
    { id: 'empty-palette-map', source: replace(original, '{TERMINAL_THEME_CATALOG.map((definition) => {', '{TERMINAL_THEME_CATALOG.slice(0, 0).map((definition) => {'), message: 'Actual palette radio collection is nonempty' }
  ]
  const result = { passed: false, exactRestore: false, source: pane, originalSha256: hash(original), runs: [], boundary: 'Private owning Source overrides are actual compiler inputs; shared Main is never mutated. These runs qualify only the static sample glyph consumer.' }
  try {
    const control = await capture(path.join(at, 'control'), true)
    assert.equal(control.completed, true, JSON.stringify(control.failure))
    result.control = control.sourceIdentity
    for (const variant of variants) {
      assert.equal(hash(await fs.readFile(path.join(root, pane))), hash(original), 'Concurrent Main Source changes are never overwritten')
      assert.notEqual(hash(variant.source), hash(original))
      const file = path.join(at, 'private-source', variant.id, pane)
      await fs.mkdir(path.dirname(file), { recursive: true })
      await fs.writeFile(file, variant.source, { flag: 'wx' })
      const receipt = await capture(path.join(at, variant.id), true, { [pane]: { file, originalSha256: hash(original), sha256: hash(variant.source) } })
      const raw = JSON.parse(await fs.readFile(path.join(at, variant.id, 'appearance-preview-glyphs.json'), 'utf8'))
      assert.notEqual(receipt.completed, true, 'Owning Source mutation must be falsified')
      assert.equal(raw.failure?.name, 'AssertionError', 'Compiler/setup/no-tests errors do not count as RED')
      assert.equal(raw.failure.message.split('\n')[0], variant.message, 'Only the specific owning glyph/collection assertion is RED')
      assert.equal(receipt.source[pane].sha256, hash(variant.source), 'The mutant reached the actual loaded Renderer Source')
      assert.equal(receipt.originalInputs[pane].sha256, hash(original))
      result.runs.push({ id: variant.id, result: 'AssertionRED', sourceIdentity: receipt.sourceIdentity, sha256: hash(variant.source), failure: raw.failure })
    }
    const restored = await capture(path.join(at, 'restored'), true)
    assert.equal(restored.completed, true, JSON.stringify(restored.failure))
    assert.equal(restored.sourceIdentity, result.control, 'Restored GREEN consumes exact original Source inputs')
    result.restored = restored.sourceIdentity
    result.passed = true
  } finally {
    result.exactRestore = hash(await fs.readFile(path.join(root, pane))) === hash(original)
    if (!result.exactRestore) result.passed = false
    await fs.writeFile(path.join(at, 'mutation-receipt.json'), JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify({ at, passed: result.passed, exactRestore: result.exactRestore }))
  }
  assert.equal(result.exactRestore, true, 'Unexpected concurrent bytes remain untouched and cannot be signed GREEN')
}

if (args.includes('--mutations')) await mutations()
else {
  const pointer = path.join(base, 'product-current.json')
  const chosen = await fs.readFile(pointer, 'utf8').then(JSON.parse, () => null)
  const at = args.includes('--capture-only') ? path.join(base, `product-${Date.now()}-${randomUUID()}`) : path.resolve(base, chosen?.directory ?? 'product')
  assert.ok(at.startsWith(base + path.sep), 'The current candidate is confined to this evidence directory')
  const exists = await fs.stat(at).then(() => true, () => false)
  const receipt = exists ? await current(at) : await capture(at)
  assert.equal(receipt.completed, true, JSON.stringify(receipt.failure))
  if (args.includes('--capture-only')) await fs.writeFile(pointer, JSON.stringify({ directory: path.relative(base, at), sourceIdentity: receipt.sourceIdentity }, null, 2) + '\n')
  if (!args.includes('--capture-only')) await visual(at, receipt)
  console.log(JSON.stringify({ at, completed: true, captureOnly: args.includes('--capture-only'), aestheticReview: args.includes('--capture-only') ? 'not-performed' : 'independent-PASS-consumed', sourceIdentity: receipt.sourceIdentity, png: receipt.png.length }))
}
