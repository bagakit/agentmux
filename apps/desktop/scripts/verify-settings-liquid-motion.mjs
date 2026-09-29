import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { qualify } from './verify-settings-glass-prompts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
assert.equal(args.filter(arg => arg === '--settings' || arg === '--prompts').length, 1, 'Choose exactly one owning Settings or Prompts slice')
assert.ok(args.filter(arg => arg === '--mutation-only').length <= 1, 'Choose at most one bounded debug mutant')
const mutationOnlyIndex = args.indexOf('--mutation-only')
const mutationOnly = mutationOnlyIndex >= 0 ? args[mutationOnlyIndex + 1] : null
if (mutationOnlyIndex >= 0) assert.ok(args.includes('--mutations') && typeof mutationOnly === 'string' && mutationOnly.length > 0 && !mutationOnly.startsWith('--'), 'A bounded debug mutant requires --mutations and one nonempty existing id')
const task = args.includes('--settings') ? 'settings' : 'prompts'
const mode = `liquid-${task}`
const output = args.indexOf('--output')
const directory = path.resolve(root, output >= 0 ? args[output + 1] : `.bagakit/design/settings-liquid-motion/evidence/${task}`)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const relativeScript = path.relative(root, fileURLToPath(import.meta.url))
const sources = [relativeScript,
  'apps/desktop/scripts/fixtures/settings-liquid-motion/scenario.cjs',
  ...(task === 'prompts' ? ['apps/desktop/scripts/fixtures/settings-liquid-motion/scenario-prompts.cjs'] : []),
  'apps/desktop/scripts/fixtures/settings-liquid-motion/vitest.config.mts',
  'apps/desktop/scripts/fixtures/settings-liquid-motion/product-dom.tsx',
  `apps/desktop/test/${task === 'settings' ? 'settings-liquid-selection' : 'settings-prompts-liquid'}.test.tsx`]

async function reusable(at) {
  try {
    const receipt = JSON.parse(await fs.readFile(path.join(at, 'receipt.json'), 'utf8'))
    assert.equal(receipt.completed, true)
    assert.deepEqual(receipt.processes.map(p => p.mode), [mode])
    assert.ok(Object.keys(receipt.source).length > 0 && receipt.png.length > 3 && receipt.raw.length === 2, 'Nonempty owning source, actual full/intermediate PNGs and process raw')
    for (const [file, record] of Object.entries(receipt.source)) assert.equal(hash(await fs.readFile(path.join(root, file))), record.sha256, `Current source ${file}`)
    for (const record of receipt.assets) assert.equal(hash(await fs.readFile(path.join(root, record.file))), record.sha256)
    assert.equal(hash(await fs.readFile(path.join(at, receipt.compiledArchive.file))), receipt.compiledArchive.sha256)
    assert.ok(receipt.compiled.length > 0, 'The consumed compiled archive has its nonempty original manifest')
    assert.equal(hash(await fs.readFile(path.join(at, 'owner.mjs'))), receipt.ownerCompiled.sha256)
    for (const record of [...receipt.png, ...receipt.raw]) assert.equal(hash(await fs.readFile(path.join(at, record.file))), record.sha256)
    return receipt
  } catch { return null }
}

async function capture(at) {
  const receipt = await qualify(at, false, false, { modes: [mode], sources })
  if (receipt.compiled.length > 0) {
    // Keep one small immutable archive, its hash and original per-file manifest.
    // Never clone the repository, node_modules, user profile or native app.
    const archive = 'compiled.tar.gz'
    execFileSync('tar', ['-czf', path.join(at, archive), '-C', at, 'compiled'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    execFileSync('python3', ['-c', `import sys,json,tarfile,hashlib
manifest=json.load(sys.stdin)
assert len(manifest)>0
with tarfile.open(sys.argv[1], 'r:gz') as archive:
  expected={'compiled/'+record['file']:record for record in manifest}
  assert {entry.name for entry in archive.getmembers() if entry.isfile()}==set(expected)
  for name,record in expected.items():
    digest=hashlib.sha256(); count=0
    with archive.extractfile(name) as stream:
      while True:
        data=stream.read(65536)
        if not data: break
        count+=len(data); digest.update(data)
    assert count==record['bytes'] and digest.hexdigest()==record['sha256'], name
`, path.join(at, archive)], { input: JSON.stringify(receipt.compiled) })
    const bytes = await fs.readFile(path.join(at, archive))
    receipt.compiledArchive = { file: archive, bytes: bytes.length, sha256: hash(bytes) }
    receipt.compiledArchive.readBack = 'every-entry-byte-count-and-sha256'
    await fs.rm(path.join(at, 'compiled'), { recursive: true })
    await fs.writeFile(path.join(at, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  }
  return receipt
}

async function visualPass(at, receipt) {
  const review = JSON.parse(await fs.readFile(path.join(at, 'independent-visual-review.json'), 'utf8'))
  assert.equal(review.verdict, 'PASS', 'Independent Agent must actually review the images and leave no required changes')
  assert.equal(review.sourceIdentity, receipt.sourceIdentity, 'Visual PASS belongs to this exact consumed source candidate')
  assert.ok(typeof review.reviewerId === 'string' && review.reviewerId.trim(), 'Independent reviewer identity is explicit')
  assert.deepEqual(review.mustFix, [], 'Required visual changes are resolved before formal qualification')
  assert.ok(Array.isArray(review.images) && review.images.length > 0, 'Independent image review is nonempty')
  const reviewed = new Map(review.images.map(record => [record.file, record.sha256]))
  for (const image of receipt.png) assert.equal(reviewed.get(image.file), image.sha256, `Independent reviewer saw the exact full or intermediate PNG: ${image.file}`)
  return review
}

function exactly(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, 'Actual owning mutation block must occur exactly once: ' + before)
  return source.replace(before, after)
}

async function mutations() {
  const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim()
  assert.ok(branch.startsWith('feat/settings-liquid-motion-'), 'Sourcewriter mutations require the explicitly owned feature worktree, never main')
  const surface = 'apps/desktop/src/renderer/src/components/settings/LiquidSelectionSurface.tsx'
  const pane = 'apps/desktop/src/renderer/src/components/settings/ShortcutSettingsPane.tsx'
  const originals = new Map(await Promise.all((task === 'settings' ? [surface] : [pane]).map(async file => [file, await fs.readFile(path.join(root, file), 'utf8')])))
  const s = originals.get(surface)
  const variants = task === 'settings' ? [
    { id: 'no-selection-flow', file: surface, source: exactly(s, 'if (flow && from && !paused && !sameBounds(from, next))', 'if (false && from && !paused && !sameBounds(from, next))') },
    { id: 'no-finite-shape-change', file: surface, source: exactly(exactly(s, '0.93, 1.45', '1, 1'), '1.03, 0.94', '1, 1') },
    { id: 'retarget-cancelled-inline-endpoint', file: surface, source: exactly(s, 'if (animation && !lens.hidden', 'if (!lens.hidden') },
    { id: 'ignore-dynamic-reduced-motion', file: surface, source: exactly(s, '|| reduced.matches', '') },
    { id: 'ignore-real-window-hidden', file: surface, source: exactly(s, "document.addEventListener('visibilitychange', sync)", "// mutant: visibility changes no longer cancel owned animation") }
  ] : [
    { id: 'prompt-selection-disconnected', file: pane, source: exactly(originals.get(pane), 'selected={selectedId}', 'selected={null}') },
    { id: 'prompt-active-hard-true', file: pane, source: exactly(originals.get(pane), 'active={active}', 'active={true}') },
    { id: 'prompt-textarea-remounted', file: pane, source: exactly(originals.get(pane), '<ComposerTextarea ', '<ComposerTextarea key={selectedId} ') },
    { id: 'prompt-status-always-saved', file: pane, source: exactly(originals.get(pane), 'data-prompt-status={promptStatus}', 'data-prompt-status="saved"') }
  ]
  assert.ok(variants.length > 0)
  const owningFailures = {
    'no-selection-flow': 'Movement reaches at least two natural intermediate frames outside origin and destination',
    'no-finite-shape-change': 'Natural movement includes visible finite shape change',
    'retarget-cancelled-inline-endpoint': 'Rapid retarget continues from the current visible shape instead of the cancelled inline endpoint',
    'ignore-dynamic-reduced-motion': 'dynamic reduced motion: product marks its paused state',
    'ignore-real-window-hidden': 'real hidden window: product marks its paused state',
    'prompt-selection-disconnected': 'Selected surface and native target are connected',
    'prompt-active-hard-true': 'active=false releases every owned Prompt resize target including the visibility sentinel',
    'prompt-textarea-remounted': 'One actual connected ComposerTextarea survives selection, filtering and section changes',
    'prompt-status-always-saved': 'Selected authored Prompt reports Unsaved before the whole-library save'
  }
  const selectedVariants = mutationOnly === null ? variants : variants.filter(variant => variant.id === mutationOnly)
  assert.ok(selectedVariants.length > 0 && (mutationOnly === null || selectedVariants.length === 1), 'Debug selection must match exactly one existing owning mutant')
  const at = path.join(directory, 'mutations', `run-${Date.now()}-${randomUUID()}`)
  await fs.mkdir(at, { recursive: true })
  const lockPath = path.join(root, '.bagakit/design/settings-liquid-motion/sourcewriter.lock')
  await fs.mkdir(path.dirname(lockPath), { recursive: true })
  const lock = await fs.open(lockPath, 'wx')
  const receipt = { schema: 'agentmux.settings-liquid-motion-source-mutations.v1', task, root, passed: false, debugMutationOnly: mutationOnly, plannedMutants: selectedVariants.map(variant => variant.id), runs: [], original: Object.fromEntries([...originals].map(([file, text]) => [file, hash(text)])) }
  let inFlight
  try {
    const control = await capture(path.join(at, 'control'))
    assert.equal(control.completed, true, JSON.stringify(control.failure))
    receipt.control = control.sourceIdentity
    for (const variant of selectedVariants) {
      const file = path.join(root, variant.file), original = originals.get(variant.file)
      assert.equal(hash(await fs.readFile(file)), hash(original), 'Only pristine owning product source enters mutation')
      assert.notEqual(variant.source, original)
      await fs.writeFile(file, variant.source); inFlight = { file, original, source: variant.source }
      const mutant = await capture(path.join(at, variant.id))
      const raw = JSON.parse(await fs.readFile(path.join(at, variant.id, `${mode}.json`), 'utf8'))
      assert.notEqual(mutant.completed, true, 'Owning mutant must be falsified')
      assert.equal(raw.failure?.name, 'AssertionError', 'Compiler/setup/no-test errors never count as mutation RED')
      assert.equal(raw.failure.message.split('\n')[0], owningFailures[variant.id], 'The specific owning assertion must fail; sampling opportunity/reachability/setup failures never count as RED')
      receipt.runs.push({ id: variant.id, outcome: 'AssertionRED', sourceSha256: hash(variant.source), failure: raw.failure })
      assert.equal(hash(await fs.readFile(file)), hash(variant.source), 'Exact restore never overwrites an unexpected concurrent edit')
      await fs.writeFile(file, original); inFlight = undefined
    }
    const restored = await capture(path.join(at, 'restored'))
    assert.equal(restored.completed, true, JSON.stringify(restored.failure))
    assert.equal(restored.sourceIdentity, receipt.control, 'Restored GREEN consumes the exact original source bytes')
    receipt.restored = restored.sourceIdentity
    receipt.passed = true
  } finally {
    if (inFlight && hash(await fs.readFile(inFlight.file)) === hash(inFlight.source)) await fs.writeFile(inFlight.file, inFlight.original)
    receipt.exactRestore = (await Promise.all([...originals].map(async ([file, text]) => hash(await fs.readFile(path.join(root, file))) === hash(text)))).includes(false) === false
    await fs.writeFile(path.join(at, 'mutation-receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
    await lock.close(); await fs.unlink(lockPath)
    console.log(JSON.stringify({ directory: at, passed: receipt.passed, debugMutationOnly: receipt.debugMutationOnly, exactRestore: receipt.exactRestore }))
  }
}

if (args.includes('--mutations')) await mutations()
else {
  const previous = await reusable(directory)
  const receipt = previous ?? await capture(directory)
  assert.equal(receipt.completed, true, JSON.stringify(receipt.failure))
  if (args.includes('--capture-only')) console.log(JSON.stringify({ task, directory, captureOnly: true, aestheticReview: 'not-performed', sourceIdentity: receipt.sourceIdentity, png: receipt.png.length, reusedSourceBoundCapture: !!previous }))
  else {
    const review = await visualPass(directory, receipt)
    console.log(JSON.stringify({ task, directory, completed: true, independentVisualPass: review.reviewerId, sourceIdentity: receipt.sourceIdentity, reusedSourceBoundCapture: !!previous }))
  }
}
