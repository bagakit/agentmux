import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join, relative, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.tmp/mote-default-dialogue-mutations', String(Date.now()))
await mkdir(join(repository, '.tmp'), { recursive: true })
const clone = await mkdtemp(join(repository, '.tmp/mote-default-dialogue-source-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const owner = 'apps/desktop/src/renderer/src/lib/pmo-teams-topic-floating.ts'
const test = 'test/mote-default-dialogue.test.tsx'
const result = { schema: 'agentmux.mote-default-dialogue-source-mutations.v1', passed: false,
  cases: [], callers: {}, source: null, userAppOrRunTouched: false }
await mkdir(evidence, { recursive: true })
async function run(name) {
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config',
    'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', test, '--maxWorkers=1', '--reporter=verbose']
  const child = spawn(process.execPath, args, { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const exit = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
  const log = name + '.log'; await writeFile(join(evidence, log), output)
  return { exit, output, log, sha256: hash(output), command: [process.execPath, ...args] }
}
async function sources(directory) {
  const found = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name !== 'node_modules') found.push(...await sources(path))
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) found.push(path)
  }
  return found
}
try {
  for (const path of ['apps/desktop/src', 'apps/desktop/resources', 'packages/core/src', 'packages/demand/src', 'packages/layout/src'])
    await cp(join(repository, path), join(clone, path), { recursive: true })
  for (const path of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json',
    'packages/core/package.json', 'packages/demand/package.json', 'packages/layout/package.json',
    'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts',
    'apps/desktop/test/mote-default-dialogue.test.tsx', 'apps/desktop/test/fixtures/mote-workface.ts']) {
    await mkdir(resolve(clone, path, '..'), { recursive: true }); await cp(join(repository, path), join(clone, path))
  }
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/demand/node_modules', 'packages/layout/node_modules']) {
    await mkdir(resolve(clone, path, '..'), { recursive: true }); await symlink(join(repository, path), join(clone, path), 'dir')
  }
  const files = await sources(join(repository, 'apps/desktop/src'))
  assert.ok(files.length > 0, 'External caller scan must consume actual nonempty product Source')
  for (const [symbol, definition, pattern] of [
    ['explicit entry opening', owner, /requestPmoTeamsTopicFloatingOpen\(/],
    ['original mode writer', 'apps/desktop/src/renderer/src/store.ts', /(?:\.setViewMode\(|\bsetViewMode\(sessionId, mode\))/],
    ['original visible mode consumers', 'apps/desktop/src/renderer/src/lib/session-presentation.ts', /effectiveSessionViewMode\(/]
  ]) {
    const hits = []
    for (const file of files) if (relative(repository, file) !== definition) {
      const lines = (await readFile(file, 'utf8')).split('\n')
      lines.forEach((line, index) => {
        if (!/^\s*import\b/.test(line) && pattern.test(line)) hits.push({ path: relative(repository, file), line: index + 1, text: line.trim() })
      })
    }
    assert.ok(hits.length > 0, 'No external product caller for ' + symbol); result.callers[symbol] = hits
  }
  assert.ok(result.callers['explicit entry opening'].some(row => row.path.endsWith('/PmoTeamsTopicEntry.tsx') && row.text.includes('onClick=')), 'Original Entry actually opens the owner')
  assert.ok(result.callers['original mode writer'].some(row => row.path === owner), 'Reopening reaches the original mode writer')
  for (const file of ['SessionPane.tsx', 'AgentSessionComposer.tsx'])
    assert.ok(result.callers['original visible mode consumers'].some(row => row.path.endsWith('/' + file)), 'Original actual consumer missing: ' + file)
  const original = await readFile(join(clone, owner)), source = original.toString('utf8')
  result.source = { path: owner, sha256: hash(original) }
  const baseline = await run('original-baseline-green')
  assert.equal(baseline.exit, 0, 'The isolated original Source must first pass its real nonempty behavior suite')
  assert.match(baseline.output, /Tests\s+\d+ passed/); result.baseline = { ...baseline, output: undefined }
  const variants = [
    { name: 'explicit-reopen-activity-write', mutate: one => one.replace("current.setViewMode(session.id, 'activity', { focus: false })", 'void session.id') },
    { name: 'active-region-must-not-borrow-title', mutate: one => one.replace('const region = tab?.regions[tab.layout.activeRegionId]', 'const region = tab?.regions[tab.layout.activeRegionId] ?? tab?.regions[tab.titleRegionId]') },
    { name: 'same-open-target-is-idempotent', mutate: one => one.replace('if (isOpening) {', 'if (true) {') }
  ]
  assert.ok(variants.length > 0)
  for (const variant of variants) {
    const changed = variant.mutate(source)
    assert.notEqual(changed, source, 'A real owning Source mutant must land')
    await writeFile(join(evidence, variant.name + '.source.txt'), changed)
    await writeFile(join(clone, owner), changed)
    const red = await run(variant.name + '.red')
    assert.notEqual(red.exit, 0, 'Broken owning behavior must be RED')
    assert.match(red.output, /AssertionError:/, 'RED must come from a real behavior assertion')
    assert.doesNotMatch(red.output, /No test files found|Failed to load url|failed to resolve import|Transform failed|SyntaxError:|ReferenceError:/)
    await writeFile(join(clone, owner), original)
    const green = await run(variant.name + '.restored-green')
    assert.equal(green.exit, 0, 'Original owning bytes restore GREEN'); assert.match(green.output, /Tests\s+\d+ passed/)
    result.cases.push({ name: variant.name, path: owner, originalSha256: hash(original), mutatedSha256: hash(changed),
      red: { ...red, output: undefined }, green: { ...green, output: undefined } })
  }
  assert.equal(hash(await readFile(join(repository, owner))), hash(original), 'Shared product Source was never mutated')
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally {
  await rm(clone, { recursive: true, force: true }); result.temporarySourceRemoved = true
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2))
}
console.log(JSON.stringify({ passed: result.passed, receipt: join(evidence, 'receipt.json'), cases: result.cases.length, cleanup: result.temporarySourceRemoved }))
if (!result.passed) process.exitCode = 1
