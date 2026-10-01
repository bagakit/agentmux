import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const mode = process.argv[2]
assert.ok(['--owning', '--restart'].includes(mode), 'Choose --owning or --restart.')
const output = join(repository, '.tmp/mote-topic-directories-verification', ("" + (globalThis.crypto.randomUUID()) + "-" + (mode.slice(2)) + ""))
await mkdir(output, { recursive: true })
const receipt = { mode, passed: false, inputs: {}, runs: [], callers: {}, userDataTouched: false }
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
async function run(label, args, assertion) {
  const child = spawn(process.execPath, args, { cwd: repository, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''; child.stdout.on('data', bytes => { text += bytes }); child.stderr.on('data', bytes => { text += bytes })
  const status = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
  await writeFile(join(output, label + '.log'), text)
  receipt.runs.push({ label, args, status, log: label + '.log', sha256: hash(text) })
  assert.equal(status, 0, label + ' failed: ' + text.slice(-3500))
  assertion?.(text)
}
async function sourceFiles(directory) {
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory() && entry.name !== 'node_modules') result.push(...await sourceFiles(path))
    else if (entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)) result.push(path)
  }
  return result
}
try {
  const files = await sourceFiles(join(repository, 'apps/desktop/src'))
  assert.ok(files.length > 0, 'The production caller scan must be nonempty.')
  for (const [name, definition, pattern] of [
    ['physical directory resolver', 'apps/desktop/src/main/scratch-topic-directories.ts', /resolveScratchTopicDirectory\(/],
    ['canonical launch preparation', 'apps/desktop/src/main/scratch-topics.ts', /scratchTopics\.prepareAgent\(/],
    ['durable identity projection', 'apps/desktop/src/shared/scratch-topics.ts', /scratchTopicIdentityPath\(/],
    ['Session ownership', 'apps/desktop/src/shared/scratch-topics.ts', /scratchTopicIdFromWorkspacePath\(|workspaceOwnsSessionPath\(/],
    ['original file gateway', 'apps/desktop/src/main/workspace-files.ts', /\b(?:workspaceFiles|files)\.(read|write|move|create|delete|localPathForReveal)\(/]
  ]) {
    const hits = []
    for (const file of files) {
      const path = relative(repository, file)
      if (path === definition) continue
      const lines = (await readFile(file, 'utf8')).split('\n')
      lines.forEach((line, index) => { if (!/^\s*(?:import\b|\/\/|\/\*|\*)/.test(line) && pattern.test(line)) hits.push({ path, line: index + 1 }) })
    }
    assert.ok(hits.length > 0, 'No production caller outside the definition: ' + name)
    receipt.callers[name] = hits
  }
  assert.ok(receipt.callers['original file gateway'].some(hit => hit.path === 'apps/desktop/src/main/ipc.ts'), 'The actual file IPC owner must consume the gateway.')
  const packageScript = JSON.parse(await readFile(join(repository, 'apps/desktop/package.json'), 'utf8')).scripts['migrate:topic-directories']
  assert.equal(packageScript, 'node scripts/migrate-topic-directories.mjs')
  const migration = await readFile(join(repository, 'apps/desktop/scripts/migrate-topic-directories.mjs'), 'utf8')
  assert.match(migration, /'--alias-swap'/)
  receipt.callers['native alias swap'] = ['apps/desktop/scripts/migrate-topic-directories.mjs', 'apps/desktop/package.json']
  for (const file of [...files.map(file => relative(repository, file)), 'apps/desktop/native/workspace-move.c',
    'apps/desktop/scripts/migrate-topic-directories.mjs', 'apps/desktop/test/scratch-topic-directories.test.ts',
    'apps/desktop/test/space-role-soul-session.test.ts', 'apps/desktop/test/mote-conversation-identity.test.tsx',
    'apps/desktop/test/file-explorer-open-as-project.integration.test.tsx', 'apps/desktop/test/topic-directory-migration.native.test.mjs']) {
    receipt.inputs[file] = hash(await readFile(join(repository, file)))
  }
  await run('native-build', ['apps/desktop/scripts/build-workspace-move-helper.mjs'])
  if (mode === '--restart') {
    await run('two-process-native', ['--test', '--test-reporter=tap', 'apps/desktop/test/topic-directory-migration.native.test.mjs'], text => {
      assert.match(text, /# fail 0/); assert.match(text, /# tests [1-9]/); assert.match(text, /# skipped 0/)
    })
  } else {
    await run('types', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'apps/desktop/tsconfig.json'])
    await run('main-owning', ['node_modules/vitest/vitest.mjs', 'run', '--maxWorkers=1',
      'apps/desktop/test/scratch-topic-directories.test.ts', 'apps/desktop/test/scratch-topics.test.ts',
      'apps/desktop/test/workspace-files.test.ts', 'apps/desktop/test/mote-avatar-assets.test.ts',
      'apps/desktop/test/mote-archive-service.test.ts', 'apps/desktop/test/mote-primary-directory.test.ts',
      'apps/desktop/test/mote-default-knowledge.test.ts', 'apps/desktop/test/pmo-teams-topic-role.test.ts',
      'apps/desktop/test/topic-wiki-injection.test.ts', 'apps/desktop/test/space-role-soul-session.test.ts'],
      text => assert.match(text, /Tests\s+\d+ passed/))
    await run('renderer-owning', ['node_modules/vitest/vitest.mjs', 'run', '--config',
      'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.chat.config.mts', '--maxWorkers=1',
      'test/mote-conversation-identity.test.tsx', 'test/file-explorer-open-as-project.integration.test.tsx'],
      text => assert.match(text, /Tests\s+\d+ passed/))
    await run('archive-menu-owning', ['node_modules/vitest/vitest.mjs', 'run', '--config',
      'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts', '--maxWorkers=1',
      'test/mote-archive-interaction.test.tsx', '-t', '^(?!.*Launcher recommends active objects)'],
      text => assert.match(text, /Tests\s+\d+ passed/))
  }
  receipt.passed = true
} finally { await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
console.log(JSON.stringify({ passed: receipt.passed, mode, receipt: relative(repository, join(output, 'receipt.json')) }))
