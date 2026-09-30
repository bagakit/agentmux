import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { resolve, join, relative } from 'node:path'
const repository = resolve(import.meta.dirname, '../../..'), args = process.argv.slice(2)
assert.deepEqual(args.slice(0, 1), ['--scope']); assert.ok(['avatar', 'primary'].includes(args[1]) && args.length === 2)
const scope = args[1], evidence = join(repository, '.tmp/mote-identity-mutations', `${scope}-${Date.now()}`)
const clone = await mkdtemp(join(repository, '.tmp/mote-identity-mutation-source-').replace(/\/\.tmp\//, '/'))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const result = { schema: 'agentmux.mote-identity-source-mutations.v1', scope, passed: false, cases: [], callers: {}, files: {}, userAppOrRunTouched: false }
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
  for (const dir of ['apps/desktop/src', 'apps/desktop/test', 'apps/desktop/resources', 'packages/core/src', 'packages/demand', 'packages/layout/src']) {
    await cp(join(repository, dir), join(clone, dir), { recursive: true, filter: path => !path.includes('/node_modules') && !path.includes('/dist') && !path.includes('/.tmp') })
  }
  for (const file of ['package.json', 'tsconfig.base.json', 'vitest.setup.ts', 'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json', 'packages/core/package.json', 'packages/layout/package.json', 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts']) {
    await mkdir(resolve(clone, file, '..'), { recursive: true }); await cp(join(repository, file), join(clone, file))
  }
  for (const dir of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/demand/node_modules', 'packages/layout/node_modules']) {
    await mkdir(resolve(clone, dir, '..'), { recursive: true }); await symlink(join(repository, dir), join(clone, dir), 'dir').catch(error => { if (error.code !== 'EEXIST') throw error })
  }
  const sourceFiles = await files(join(repository, 'apps/desktop/src'))
  assert.ok(sourceFiles.length > 0)
  const callers = scope === 'avatar' ? [
    ['setSpaceObjectIcon', 'apps/desktop/src/renderer/src/store.ts', /\.setSpaceObjectIcon\(/],
    ['SpaceObjectIcon', 'apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx', /<SpaceObjectIcon\s/],
    ['readMoteAvatar', 'apps/desktop/src/preload/index.ts', /api\.scratch\.readMoteAvatar\(/],
    ['saveAvatar', 'apps/desktop/src/main/scratch-topics.ts', /args\.scratchTopics\.saveAvatar\(/]
  ] : [
    ['ordinary ensureMote', 'apps/desktop/src/main/scratch-topics.ts', /api\.scratch\.ensureMote\(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID\)/],
    ['delete final service', 'apps/desktop/src/main/workspace-files.ts', /(?:await )?files\.delete\(/],
    ['Renderer deletePath', 'apps/desktop/src/renderer/src/store.ts', /(?:await |void )?deletePath\(/]
  ]
  for (const [symbol, definition, pattern] of callers) {
    const hits = []
    for (const file of sourceFiles) if (relative(repository, file) !== definition) {
      const lines = (await readFile(file, 'utf8')).split('\n')
      lines.forEach((line, index) => { if (!/^\s*import\b/.test(line) && pattern.test(line)) hits.push({ path: relative(repository, file), line: index + 1, text: line.trim() }) })
    }
    assert.ok(hits.length > 0, `No external product caller for ${symbol}`); result.callers[symbol] = hits
  }
  const variants = scope === 'avatar' ? [
    { name: 'state-first-confirmation', path: 'apps/desktop/src/renderer/src/store.ts', test: 'test/mote-avatar-identity.test.tsx',
      mutate: source => source.replace('      writeChoice(choice(get().spaceObjectIcons))\n      await requestWorkbenchStorageFlush()', '      set(state => ({ spaceObjectIcons: choice(state.spaceObjectIcons) }))\n      writeChoice(choice(get().spaceObjectIcons))\n      await requestWorkbenchStorageFlush()') },
    { name: 'footer-borrows-primary', path: 'apps/desktop/src/renderer/src/components/PmoTeamsTopicEntry.tsx', test: 'test/mote-avatar-identity.test.tsx',
      mutate: source => source.replace('topics?.find(item => item.id === target.topicId)', "topics?.find(item => item.id === 'launcher:leader')") },
    { name: 'image-consumer-disconnected', path: 'apps/desktop/src/renderer/src/components/SpaceObjectIcon.tsx', test: 'test/mote-avatar-identity.test.tsx',
      mutate: source => source.replace('return <MoteAvatar workspaceId={avatarWorkspaceId} topicId={avatarTopicId} choice={manualIcon} objectKey={avatarObjectKey} />', 'return <span data-space-icon-source="image"><MoteIcon size={14} /></span>') },
    { name: 'avatar-reads-unrelated-topic-snapshot', path: 'apps/desktop/src/main/scratch-topics.ts', test: 'test/mote-avatar-assets.test.ts',
      mutate: source => source.replace('  private async avatarMoteDirectory(workspace: WorkspaceRecord, topicId: string): Promise<string> {\n    requireScratchWorkspace(workspace)', '  private async avatarMoteDirectory(workspace: WorkspaceRecord, topicId: string): Promise<string> {\n    requireScratchWorkspace(workspace)\n    await this.read(workspace, topicId)') },
    { name: 'same-image-preview-not-remounted', path: 'apps/desktop/src/renderer/src/components/SpaceIconPicker.tsx', test: 'test/mote-avatar-identity.test.tsx',
      mutate: source => source.replace('key={preview.revision}', 'key={preview.dataUrl}') }
  ] : [
    { name: 'final-service-primary-guard-removed', path: 'apps/desktop/src/main/workspace-files.ts', test: 'test/mote-primary-directory.test.ts',
      mutate: source => source.replace(/        await this\.assertPrimaryMoteRetained[^\n]+\n/g, '').replace(/      await this\.assertPrimaryMoteRetained[^\n]+\n/g, '') },
    { name: 'ordinary-initialize-ensure-removed', path: 'apps/desktop/src/renderer/src/store.ts', test: 'test/mote-primary-identity.test.tsx',
      mutate: source => source.replace('api.scratch.ensureMote(SCRATCH_WORKSPACE_ID, PMO_TEAMS_TOPIC_ID)', 'Promise.resolve(null)') }
  ]
  for (const variant of variants) {
    const original = await readFile(join(clone, variant.path)), changed = variant.mutate(original.toString('utf8'))
    assert.notEqual(changed, original.toString('utf8'), 'A real product Source mutation must land')
    result.files[variant.path] = hash(original)
    await writeFile(join(evidence, variant.name + '.source.txt'), changed)
    await writeFile(join(clone, variant.path), changed)
    const red = await command(variant.name + '.red.log', variant.test)
    assert.notEqual(red.exit, 0, 'Mutation must fail'); assert.match(red.output, /AssertionError:/, 'Failure must be a real Assertion RED')
    assert.doesNotMatch(red.output, /No test files found|Failed to load url|failed to resolve import|Transform failed|SyntaxError:/)
    await writeFile(join(clone, variant.path), original)
    const green = await command(variant.name + '.restored-green.log', variant.test)
    assert.equal(green.exit, 0, 'Same candidate restored Source must pass'); assert.match(green.output, /Tests\s+\d+ passed/)
    result.cases.push({ name: variant.name, path: variant.path, original: hash(original), mutated: hash(changed), red: { ...red, output: undefined }, green: { ...green, output: undefined } })
  }
  for (const [file, digest] of Object.entries(result.files)) assert.equal(hash(await readFile(join(repository, file))), digest, 'Owning product Source remained unchanged')
  result.passed = true
} catch (cause) { result.failure = { name: cause.name, message: cause.message, stack: cause.stack } }
finally { await rm(clone, { recursive: true, force: true }); await writeFile(join(evidence, 'receipt.json'), JSON.stringify(result, null, 2)) }
console.log(JSON.stringify({ passed: result.passed, scope, receipt: join(evidence, 'receipt.json'), cases: result.cases.length }))
if (!result.passed) process.exitCode = 1
