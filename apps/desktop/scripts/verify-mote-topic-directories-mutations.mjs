import { fixturePath as _hygiene_fixturePath } from "./lib/fixture-values.mjs"
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, relative, resolve } from 'node:path'
import { runTopicDirectoryMigrationMutations } from './verify-topic-directory-migration-mutations.mjs'

const repository = resolve(import.meta.dirname, '../../..')
await mkdir(join(repository, '.tmp'), { recursive: true })
const output = await mkdtemp(join(repository, '.tmp/mote-directory-source-mutations-'))
const clone = join(output, 'source')
const receipt = { passed: false, source: {}, mutations: [], native: null, userDataTouched: false }
const hash = value => createHash('sha256').update(value).digest('hex')
async function run(label, config, test) {
  const args = [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1',
    ...(config ? ['--config', config] : []), test, '--reporter=verbose']
  const child = spawn(process.execPath, args, { cwd: clone, stdio: ['ignore', 'pipe', 'pipe'] })
  let text = ''; child.stdout.on('data', value => { text += value }); child.stderr.on('data', value => { text += value })
  const status = await new Promise((accept, reject) => { child.once('error', reject); child.once('close', accept) })
  await writeFile(join(output, label + '.log'), text)
  return { status, text, args, log: label + '.log', sha256: hash(text) }
}
try {
  for (const path of ['apps/desktop/src', 'apps/desktop/test', 'apps/desktop/scripts', 'apps/desktop/resources',
    'packages/core/src', 'packages/core/vendor', 'packages/demand/src', 'packages/demand/bin', 'packages/layout/src', 'packages/client-ui/src'])
    await cp(join(repository, path), join(clone, path), { recursive: true, preserveTimestamps: true })
  for (const path of ['package.json', 'tsconfig.base.json', 'vitest.config.ts', 'vitest.dist-freshness.ts', 'vitest.setup.ts',
    'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'packages/core/package.json',
    'packages/demand/package.json', 'packages/layout/package.json', 'packages/client-ui/package.json']) {
    await mkdir(dirname(join(clone, path)), { recursive: true }); await cp(join(repository, path), join(clone, path), { preserveTimestamps: true })
  }
  for (const path of ['node_modules', 'apps/desktop/node_modules', 'packages/core/node_modules', 'packages/core/dist',
    'packages/demand/node_modules', 'packages/demand/dist', 'packages/layout/node_modules', 'packages/client-ui/node_modules', 'packages/client-ui/dist']) {
    await mkdir(dirname(join(clone, path)), { recursive: true }); await symlink(join(repository, path), join(clone, path), 'dir')
  }
  const ordinary = 'apps/desktop/test/scratch-topic-directories.test.ts'
  const ui = 'apps/desktop/scripts/fixtures/mote-navigation-footer/vitest.chat.config.mts'
  const variants = [
    { name: 'new-mote-wrong-root', path: 'apps/desktop/src/main/scratch-topics.ts', test: ordinary,
      changes: [['const root = mote ? roots.motes : roots.topics', 'const root = roots.topics']] },
    { name: 'relocated-identity-reissued', path: 'apps/desktop/src/main/scratch-topic-directories.ts', test: ordinary,
      changes: [['return value.identityDirectoryPath', 'return physical']] },
    { name: 'write-escape-opened', path: 'apps/desktop/src/main/workspace-files.ts', test: ordinary,
      changes: [['return { root: dirname(directory), requested: [basename(directory), ...parts.slice(1)].join(sep) }',
        'return { root: dirname(dirname(directory)), requested: [basename(dirname(directory)), basename(directory), ...parts.slice(1)].join(sep) }']] },
    { name: 'old-provider-cwd-retargeted', path: 'packages/core/src/client.ts', config: 'apps/desktop/scripts/fixtures/mote-default-context/vitest.owning.config.mts', test: 'test/space-role-soul-session.test.ts',
      changes: [['        cwd: current.workspacePath,', ("        cwd: current.workspacePath.replace('" + _hygiene_fixturePath("scratch/") + ("', '" + _hygiene_fixturePath("motes/") + "'),"))]] },
    { name: 'canonical-avatar-key-lost', path: 'apps/desktop/src/renderer/src/lib/space-object-appearance.ts', config: ui, test: 'test/mote-conversation-identity.test.tsx',
      changes: [['scratchTopicIdentityPath(workspace, topic)', "workspace.path + '/' + topic.directoryPath"]] }
  ]
  for (const variant of variants) {
    const original = await readFile(join(clone, variant.path), 'utf8')
    receipt.source[variant.path] = hash(original)
    let changed = original
    for (const [from, to] of variant.changes) {
      assert.equal(changed.split(from).length, 2, 'Exactly one current owning Source anchor must change: ' + variant.name)
      changed = changed.replace(from, to)
    }
    const baseline = await run(variant.name + '.baseline', variant.config, variant.test)
    assert.equal(baseline.status, 0, baseline.text.slice(-3500)); assert.match(baseline.text, /Tests\s+\d+ passed/)
    let red
    try {
      await writeFile(join(clone, variant.path), changed)
      red = await run(variant.name + '.red', variant.config, variant.test)
      assert.notEqual(red.status, 0, 'The owning assertion must reject the mutant: ' + variant.name)
      assert.match(red.text, /AssertionError:/, 'Load/compilation errors are not behavioral RED.')
      assert.doesNotMatch(red.text, /No test files found|Cannot find module|Failed to resolve import|SyntaxError:/)
    } finally { await writeFile(join(clone, variant.path), original) }
    const restored = await run(variant.name + '.restored', variant.config, variant.test)
    assert.equal(restored.status, 0, restored.text.slice(-3500))
    receipt.mutations.push({ name: variant.name, path: variant.path, original: hash(original), changed: hash(changed),
      red: { ...red, text: undefined }, restored: { ...restored, text: undefined } })
  }
  receipt.native = await runTopicDirectoryMigrationMutations({ repository, outputDirectory: output })
  for (const [path, expected] of Object.entries(receipt.source)) assert.equal(hash(await readFile(join(repository, path))), expected, 'The shared Source must be unchanged by isolated mutations.')
  receipt.passed = true
} finally { await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2)) }
console.log(JSON.stringify({ passed: receipt.passed, mutations: receipt.mutations.length + receipt.native.mutations.length, receipt: relative(repository, join(output, 'receipt.json')) }))
