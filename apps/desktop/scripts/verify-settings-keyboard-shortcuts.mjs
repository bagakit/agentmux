import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { qualify } from './verify-settings-glass-prompts.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const args = process.argv.slice(2)
assert.equal(args.filter(arg => ['--product', '--mutations', '--callers'].includes(arg)).length, 1, 'Choose one declared verification mode')
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const output = args.indexOf('--output')
const base = path.resolve(root, output < 0 ? '.bagakit/design/settings-followups-20261004/implementation/evidence' : args[output + 1])
const sources = [fileURLToPath(import.meta.url), 'apps/desktop/scripts/fixtures/settings-keyboard-shortcuts/scenario.cjs', 'apps/desktop/scripts/fixtures/settings-keyboard-shortcuts/callers.mjs', 'apps/desktop/scripts/fixtures/settings-keyboard-shortcuts/vitest.config.mts', 'apps/desktop/test/settings-keyboard-shortcuts.test.tsx', 'apps/desktop/test/shortcut-help-affordance.test.tsx']

async function capture(at, sourceOverrides = {}) {
  assert.equal(await fs.stat(at).then(() => true, () => false), false, 'Fresh proof directories never overwrite earlier evidence')
  const receipt = await qualify(at, false, false, { modes: ['keyboard-shortcuts'], sources, sourceOverrides, preserveAllSources: true })
  for (const [file, record] of Object.entries(receipt.source)) {
    const bytes = await fs.readFile(path.join(at, 'source', file))
    assert.equal(hash(bytes), record.sha256, 'Snapshot matches compiled Source: ' + file)
  }
  if (receipt.compiled.length) {
    execFileSync('tar', ['-czf', path.join(at, 'compiled.tar.gz'), '-C', at, 'compiled'], { env: { ...process.env, COPYFILE_DISABLE: '1' } })
    execFileSync('python3', ['-c', `import sys,json,tarfile,hashlib
manifest=json.load(sys.stdin)
assert len(manifest)>0
with tarfile.open(sys.argv[1],'r:gz') as archive:
  expected={'compiled/'+record['file']:record for record in manifest}
  assert {entry.name for entry in archive.getmembers() if entry.isfile()}==set(expected)
  for name,record in expected.items():
    with archive.extractfile(name) as stream: data=stream.read()
    assert len(data)==record['bytes'] and hashlib.sha256(data).hexdigest()==record['sha256'],name
`, path.join(at, 'compiled.tar.gz')], { input: JSON.stringify(receipt.compiled) })
    const archive = await fs.readFile(path.join(at, 'compiled.tar.gz'))
    receipt.compiledArchive = { file: 'compiled.tar.gz', bytes: archive.length, sha256: hash(archive), readBack: 'every-entry-byte-count-and-sha256' }
    await fs.rm(path.join(at, 'compiled'), { recursive: true })
  }
  await fs.writeFile(path.join(at, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
  return receipt
}

async function visual(at, receipt) {
  const review = JSON.parse(await fs.readFile(path.join(at, 'independent-visual-review.json'), 'utf8'))
  assert.equal(review.verdict, 'PASS')
  assert.equal(review.sourceIdentity, receipt.sourceIdentity)
  assert.ok(typeof review.reviewerId === 'string' && review.reviewerId.trim())
  assert.deepEqual(review.mustFix, [])
  assert.ok(review.images.length > 0 && receipt.png.length > 0)
  const images = new Map(review.images.map(image => [image.file, image.sha256]))
  for (const image of receipt.png) assert.equal(images.get(image.file), image.sha256, 'Peer reviewed this actual full PNG: ' + image.file)
  return review
}

async function currentCapture(at) {
  const receipt = JSON.parse(await fs.readFile(path.join(at, 'receipt.json'), 'utf8'))
  assert.equal(receipt.completed, true, JSON.stringify(receipt.failure))
  assert.ok(Object.keys(receipt.source).length > 0 && receipt.png.length > 0 && receipt.raw.length === 2)
  for (const [file, record] of Object.entries(receipt.source)) assert.equal(hash(await fs.readFile(path.join(root, file))), record.sha256, 'Accepted source remains exact: ' + file)
  for (const asset of receipt.assets) assert.equal(hash(await fs.readFile(path.join(root, asset.file))), asset.sha256)
  for (const item of [...receipt.png, ...receipt.raw]) assert.equal(hash(await fs.readFile(path.join(at, item.file))), item.sha256)
  assert.equal(hash(await fs.readFile(path.join(at, receipt.compiledArchive.file))), receipt.compiledArchive.sha256)
  assert.equal(hash(await fs.readFile(path.join(at, 'owner.mjs'))), receipt.ownerCompiled.sha256)
  return receipt
}

async function units(at) {
  await fs.mkdir(at, { recursive: true })
  const logs = []
  for (const [name, tail] of [
    ['owning-and-input-contracts', ['--exclude', 'apps/desktop/test/overlay-native-adoption.test.tsx']],
    ['adjacent-native-lease', ['apps/desktop/test/overlay-native-adoption.test.tsx', '-t', '^(?!.*(?:source-derived AST|derives retained layout)).*$']]
  ]) {
    let bytes
    try { bytes = execFileSync('pnpm', ['exec', 'vitest', 'run', '--config', 'apps/desktop/scripts/fixtures/settings-keyboard-shortcuts/vitest.config.mts', ...tail], { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 }) }
    catch (error) { await fs.writeFile(path.join(at, `${name}.log`), String(error.stdout ?? '') + String(error.stderr ?? '')); throw error }
    assert.match(bytes, /Tests\s+\d+ passed/, 'The finite test set ran and is nonempty')
    await fs.writeFile(path.join(at, `${name}.log`), bytes)
    logs.push({ name, file: `${name}.log`, sha256: hash(bytes) })
  }
  await fs.writeFile(path.join(at, 'unit-receipt.json'), JSON.stringify({ passed: true, logs, boundary: 'Existing two full-tree retained-portal inventory assertions fail on unrelated StableWorkbenchView Source. Those exact failing inventory assertions are unchanged and their original failures are preserved in unit-initial.log; this bounded run covers the nine actual remaining overlay/native lease cases without claiming that broad scan GREEN.' }, null, 2) + '\n')
}

function replace(source, before, after) {
  assert.equal(source.split(before).length - 1, 1, 'Owning Source anchor occurs once: ' + before)
  return source.replace(before, after)
}

async function mutations() {
  const at = path.join(base, 'mutations', `run-${Date.now()}-${randomUUID()}`)
  await fs.mkdir(at, { recursive: true })
  const renderer = 'apps/desktop/src/renderer/src/'
  const variants = [
    ['module-pane-empty', 'components/settings/modules/keyboard-shortcuts.tsx', 'Pane: KeyboardShortcutsPane', 'Pane: () => null', 'Actual shortcut row collection is nonempty'],
    ['help-route-empty', 'App.tsx', "openShortcuts: () => openSettings('keyboard-shortcuts')", 'openShortcuts: () => {}', 'Keyboard help opens the same Settings section'],
    ['button-route-empty', 'components/WindowUtilityBar.tsx', "onClick={() => settings.open('keyboard-shortcuts')}", 'onClick={() => {}}', 'The original visible button opens the same Settings section'],
    ['chord-projection-detached', 'components/settings/KeyboardShortcutsPane.tsx', 'row.keys.map((token, index)', "['Unbound'].map((token, index)", 'Settings displays the actual registry platform chord'],
    ['title-query-empty-page', 'components/settings/KeyboardShortcutsPane.tsx', 'const terms = query.trim()', 'const terms = (document.querySelector<HTMLInputElement>(\'[aria-label="Search settings"]\')?.value || query).trim()', 'Settings title search keeps the full registry row set']
  ]
  const originals = new Map()
  for (const [, relative] of variants) {
    const file = renderer + relative
    if (!originals.has(file)) originals.set(file, await fs.readFile(path.join(root, file), 'utf8'))
  }
  const result = { boundary: 'Private Source files are substituted as actual compilation input; main Source is never mutated.', passed: false, runs: [], original: Object.fromEntries([...originals].map(([file, bytes]) => [file, hash(bytes)])) }
  try {
    const control = await capture(path.join(at, 'control'))
    assert.equal(control.completed, true, JSON.stringify(control.failure))
    result.control = control.sourceIdentity
    for (const [id, relative, before, after, owningMessage] of variants) {
      const file = renderer + relative, original = originals.get(file)
      assert.equal(hash(await fs.readFile(path.join(root, file))), hash(original), 'No concurrent main Source edit is overwritten')
      const changed = replace(original, before, after), privateFile = path.join(at, 'private-source', id, file)
      await fs.mkdir(path.dirname(privateFile), { recursive: true })
      await fs.writeFile(privateFile, changed, { flag: 'wx' })
      const receipt = await capture(path.join(at, id), { [file]: { file: privateFile, originalSha256: hash(original), sha256: hash(changed) } })
      const raw = JSON.parse(await fs.readFile(path.join(at, id, 'keyboard-shortcuts.json'), 'utf8'))
      assert.notEqual(receipt.completed, true, 'The owning Source mutation must be falsified')
      assert.equal(raw.failure?.name, 'AssertionError', 'Compiler/setup/reachability errors never count as RED')
      assert.equal(raw.failure.message.split('\n')[0], owningMessage, 'Only the specific owning failure is RED')
      result.runs.push({ id, source: file, privateFile, sha256: hash(changed), failure: raw.failure, result: 'AssertionRED' })
    }
    const restored = await capture(path.join(at, 'restored'))
    assert.equal(restored.completed, true, JSON.stringify(restored.failure))
    assert.equal(restored.sourceIdentity, result.control, 'Restored GREEN is the exact original compilation input')
    result.restored = restored.sourceIdentity
    result.passed = true
  } finally {
    result.mainExact = [...await Promise.all([...originals].map(async ([file, bytes]) => hash(await fs.readFile(path.join(root, file))) === hash(bytes)))].every(Boolean)
    result.exactRestore = result.mainExact
    await fs.writeFile(path.join(at, 'mutation-receipt.json'), JSON.stringify(result, null, 2) + '\n')
    console.log(JSON.stringify({ at, passed: result.passed, mainExact: result.mainExact }))
  }
}

if (args.includes('--callers')) {
  const { verifyCallers } = await import('./fixtures/settings-keyboard-shortcuts/callers.mjs')
  console.log(JSON.stringify(await verifyCallers(root, base)))
} else if (args.includes('--mutations')) await mutations()
else {
  const at = path.join(base, 'product')
  if (!args.includes('--capture-only')) await units(path.join(base, 'tests'))
  const exists = await fs.stat(at).then(() => true, () => false)
  const receipt = exists ? await currentCapture(at) : await capture(at)
  assert.equal(receipt.completed, true, JSON.stringify(receipt.failure))
  if (!args.includes('--capture-only')) await visual(at, receipt)
  console.log(JSON.stringify({ at, completed: true, captureOnly: args.includes('--capture-only'), aestheticReview: args.includes('--capture-only') ? 'not-performed' : 'independent-PASS-consumed', sourceIdentity: receipt.sourceIdentity, png: receipt.png.length }))
}
