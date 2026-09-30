import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, join, relative } from 'node:path'
const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.tmp/mote-archive-mutations', String(Date.now()))
await mkdir(join(repository, '.tmp'), { recursive: true })
const clone = await mkdtemp(join(repository, '.tmp/mote-archive-mutation-source-'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const result = { schema: 'agentmux.mote-archive-source-mutations.v1', passed: false, cases: [], callers: {}, files: {}, userAppOrRunTouched: false }
await mkdir(evidence, { recursive: true })
async function command(file, test) {
  const args = ['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', test, '--maxWorkers=1', '--reporter=verbose']
  const child = spawn(process.execPath, args, { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', bytes => { output += bytes }); child.stderr.on('data', bytes => { output += bytes })
  const exit = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
  await writeFile(join(evidence, file), output)
  return { exit, output, log: file, sha256: hash(output), command: [process.execPath, ...args] }
}
async function files(directory) {
  const rows = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) rows.push(...await files(path))
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) rows.push(path)
  }
  return rows
}
try {
  for (const dir of ['apps/desktop/src', 'apps/desktop/resources', 'packages/core/src', 'packages/demand/src', 'packages/layout/src'])
    await cp(join(repository, dir), join(clone, dir), { recursive: true })
  for (const file of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json',
    'packages/core/package.json', 'packages/demand/package.json', 'packages/layout/package.json',
    'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts',
    'apps/desktop/test/mote-archive-service.test.ts', 'apps/desktop/test/mote-archive-interaction.test.tsx',
    'apps/desktop/test/fixtures/mote-app.tsx', 'apps/desktop/test/fixtures/mote-workface.ts']) {
    await mkdir(resolve(clone, file, '..'), { recursive: true }); await cp(join(repository, file), join(clone, file))
  }
  for (const dir of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/demand/node_modules', 'packages/layout/node_modules']) {
    await mkdir(resolve(clone, dir, '..'), { recursive: true }); await symlink(join(repository, dir), join(clone, dir), 'dir')
  }
  const sourceFiles = await files(join(repository, 'apps/desktop/src'))
  assert.ok(sourceFiles.length > 0, 'Product caller scan must consume nonempty Source')
  for (const [symbol, definition, pattern] of [
    ['final setMoteArchived', 'apps/desktop/src/main/scratch-topics.ts', /args\.scratchTopics\.setMoteArchived\(/],
    ['typed archive invoke', 'apps/desktop/src/main/ipc.ts', /ipcRenderer\.invoke\('scratch:setMoteArchived'/],
    ['store archive request', 'apps/desktop/src/renderer/src/store.ts', /\.setMoteArchived\(/],
    ['local archive action', 'apps/desktop/src/renderer/src/components/MoteArchiveNotice.tsx', /useMoteArchiveAction\(/],
    ['original archive menu', 'apps/desktop/src/renderer/src/components/SpaceObjectContextMenu.tsx', /<SpaceObjectContextMenu\b/]
  ]) {
    const hits = []
    for (const file of sourceFiles) if (relative(repository, file) !== definition) {
      const lines = (await readFile(file, 'utf8')).split('\n')
      lines.forEach((line, index) => { if (!/^\s*import\b/.test(line) && pattern.test(line)) hits.push({ path: relative(repository, file), line: index + 1, text: line.trim() }) })
    }
    assert.ok(hits.length > 0, 'No external product caller for ' + symbol); result.callers[symbol] = hits
  }
  assert.deepEqual(result.callers['local archive action'].map(row => row.path).sort(), [
    'apps/desktop/src/renderer/src/components/LauncherMoteAction.tsx',
    'apps/desktop/src/renderer/src/components/PmoTeamsTopicFloatingPanel.tsx',
    'apps/desktop/src/renderer/src/components/SpaceTopicsTree.tsx'])
  for (const name of ['PmoTeamsTopicFloatingPanel.tsx', 'SpaceTopicsTree.tsx'])
    assert.ok(result.callers['original archive menu'].some(row => row.path.endsWith('/' + name)), 'Actual archive menu caller missing: ' + name)
  const service = 'apps/desktop/src/main/scratch-topics.ts', store = 'apps/desktop/src/renderer/src/store.ts'
  const fsTest = 'test/mote-archive-service.test.ts', uiTest = 'test/mote-archive-interaction.test.tsx'
  const variants = [
    { name: 'primary-final-guard', path: service, test: fsTest, mutate: source => source.replace("    if (topicId === PMO_TEAMS_TOPIC_ID) throw new Error('The primary Mote cannot be archived.')\n", '') },
    { name: 'aba-unique-generation', path: service, test: fsTest, mutate: source => source.replace('const version = randomUUID()', "const version = '00000000-0000-0000-0000-000000000000'") },
    { name: 'archive-unknown-is-not-active', path: service, test: fsTest, mutate: source => source.replace("return { state: 'unknown', issue: error instanceof Error ? error.message : String(error) }", "return { state: 'active', version: 'unwritten' }") },
    { name: 'write-confirmation-before-publication', path: store, test: uiTest, mutate: source => source.replace("      if (fact.state !== (archived ? 'archived' : 'active') || !fact.version)\n        throw new Error('The Mote archive write is not confirmed. Refresh its directory to inspect the saved state.')\n", '') },
    { name: 'old-list-revision-fence', path: store, test: uiTest, mutate: source => source.replace('const revision = bumpWorkspaceFileRevision(current.workspaceFileRevisions, workspaceId)', 'const revision = current.workspaceFileRevisions') },
    { name: 'late-ack-current-version-fence', path: store, test: uiTest, mutate: source => source.replace("const mayPublish = latestFact?.state !== 'unknown' && latestFact?.version === expectedVersion", 'const mayPublish = true') },
    { name: 'panel-thin-discovery-filter', path: 'apps/desktop/src/renderer/src/components/PmoTeamsTopicFloatingPanel.tsx', test: uiTest, mutate: source => source.replace("topics.filter(topic => topic.moteArchive?.state !== 'archived' || showArchived).map", 'topics.map') },
    { name: 'space-thin-discovery-filter', path: 'apps/desktop/src/renderer/src/components/SpaceTopicsTree.tsx', test: uiTest, mutate: source => source.replace("motes.filter(topic => topic.moteArchive?.state !== 'archived' || showArchived)", 'motes') },
    { name: 'launcher-thin-discovery-filter', path: 'apps/desktop/src/renderer/src/components/LauncherMoteAction.tsx', test: uiTest, mutate: source => source.replace("motes.filter(mote => mote.moteArchive?.state !== 'archived')", 'motes') },
    { name: 'archive-focus-original-row-commit', path: 'apps/desktop/src/renderer/src/components/SpaceObjectContextMenu.tsx', test: uiTest,
      mutate: source => source.replace('  useLayoutEffect(() => () => archiveReturnFocus.current?.(), [])\n', '') },
    { name: 'archive-focus-later-input-cancels', path: 'apps/desktop/src/renderer/src/components/SpaceObjectContextMenu.tsx', test: uiTest,
      mutate: source => source.replace("            document.addEventListener('focusin', onFocus, true)\n", '') },
    { name: 'archive-focus-exact-disabled-control', path: 'apps/desktop/src/renderer/src/components/SpaceObjectContextMenu.tsx', test: uiTest,
      mutate: source => source.replace("                      readiness.observe(next, { attributes: true, attributeFilter: ['disabled'] })", '                      void next.disabled') },
    { name: 'archive-narrow-menu-original-pin-owner', path: 'apps/desktop/src/renderer/src/components/SpaceObjectContextMenu.tsx', test: uiTest,
      mutate: source => source.replace('onSelect={moteActions.onTogglePin}', 'onSelect={() => {}}') },
    { name: 'archive-narrow-menu-original-soul-owner', path: 'apps/desktop/src/renderer/src/components/SpaceObjectContextMenu.tsx', test: uiTest,
      mutate: source => source.replace('menu.changeIcon(moteActions.onEdit)', 'menu.changeIcon(() => {})') }
  ]
  assert.ok(variants.length > 0)
  for (const variant of variants) {
    const original = await readFile(join(clone, variant.path)), changed = variant.mutate(original.toString('utf8'))
    assert.notEqual(changed, original.toString('utf8'), 'A real owning product mutation must land')
    result.files[variant.path] = hash(original)
    await writeFile(join(evidence, variant.name + '.source.txt'), changed)
    await writeFile(join(clone, variant.path), changed)
    const red = await command(variant.name + '.red.log', variant.test)
    assert.notEqual(red.exit, 0, 'Mutation must fail'); assert.match(red.output, /AssertionError:/, 'RED must be a real owning assertion')
    assert.doesNotMatch(red.output, /No test files found|Failed to load url|failed to resolve import|Transform failed|SyntaxError:/)
    await writeFile(join(clone, variant.path), original)
    const green = await command(variant.name + '.restored-green.log', variant.test)
    assert.equal(green.exit, 0, 'Restored candidate must pass'); assert.match(green.output, /Tests\s+\d+ passed/)
    result.cases.push({ name: variant.name, path: variant.path, original: hash(original), mutated: hash(changed), red: { ...red, output: undefined }, green: { ...green, output: undefined } })
  }
  for (const [file, digest] of Object.entries(result.files)) assert.equal(hash(await readFile(join(repository, file))), digest, 'Owning Source changed during proof')
  result.passed = true
} catch (error) { result.failure = { name: error.name, message: error.message, stack: error.stack } }
finally { await rm(clone, { recursive: true, force: true }); result.temporarySourceRemoved = true; await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2)) }
console.log(JSON.stringify({ passed: result.passed, receipt: join(evidence, 'receipt.json'), cases: result.cases.length, cleanup: result.temporarySourceRemoved }))
if (!result.passed) process.exitCode = 1
