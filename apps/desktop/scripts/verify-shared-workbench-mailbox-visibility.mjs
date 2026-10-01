import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

assert.equal(process.argv.length, 2, 'This verifier takes no arguments.')
const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.tmp/shared-workbench-mailbox-visibility-20261005')
const fixture = 'apps/desktop/scripts/fixtures/shared-workbench-mailbox-visibility'
const vitest = join(root, 'node_modules/vitest/vitest.mjs')
const tsc = join(root, 'node_modules/typescript/bin/tsc')
const hash = value => createHash('sha256').update(value).digest('hex')
const sourcePaths = [
  'apps/desktop/src/renderer/src/components/SessionMailbox.tsx',
  'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
  'apps/desktop/src/renderer/src/components/ObservationSurfaceGallery.tsx',
  'apps/desktop/src/renderer/src/lib/session-user-messages.ts',
  'apps/desktop/test/shared-workbench-mailbox-visibility.test.tsx',
  `${fixture}/vitest.owning.config.mts`, `${fixture}/vitest.adjacent.config.mts`,
  `${fixture}/tsconfig.owning.json`, `${fixture}/tsconfig.production.json`
]
const snapshots = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, hash(await readFile(join(root, path)))])))
await mkdir(evidence, { recursive: true })
const receipt = { schema: 'agentmux.mailbox-presentation-visibility.v1', passed: false, sourceBefore: await snapshots(), checks: [], mutations: [],
  boundary: 'Actual Composer/Mailbox/Store/public Claude reader/private FileStore and Hook. Popover toggle and Stage visibility are DOM events, not physical Native occlusion. No packaging, shared dist, user App/Run/Runtime control or complete T002 signoff.' }
const exec = promisify(execFile)
async function run(label, args, extraEnv = {}) {
  let result
  try { const output = await exec(process.execPath, args, { cwd: root, env: { ...process.env, ...extraEnv }, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 }); result = { code: 0, signal: null, output: output.stdout + output.stderr } }
  catch (error) { result = { code: error.code, signal: error.signal, output: (error.stdout ?? '') + (error.stderr ?? '') } }
  await writeFile(join(evidence, label + '.log'), result.output)
  return result
}
const tests = [vitest, 'run', '--config', `${fixture}/vitest.owning.config.mts`]
try {
  const loaded = join(evidence, 'qualification-loaded.jsonl')
  await writeFile(loaded, '')
  const baseline = await run('qualification-owning', tests, { AGENTMUX_MAILBOX_VISIBILITY_LOADED: loaded })
  assert.equal(baseline.code, 0, baseline.output); assert.match(baseline.output, /Tests\s+4 passed/)
  const modules = (await readFile(loaded, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.ok(modules.length > 0)
  for (const path of sourcePaths.slice(0, 2)) assert.ok(modules.some(module => module.path === path && module.sha256 === receipt.sourceBefore[path]), 'Actual product module loaded: ' + path)
  receipt.loadedModules = modules
  receipt.checks.push({ label: 'owning', code: 0, tests: 4 })
  for (const mutation of ['ignore-mailbox-visibility', 'ignore-composer-visibility']) {
    const log = join(evidence, mutation + '-loaded.jsonl')
    await writeFile(log, '')
    const red = await run(mutation + '-red', tests, { AGENTMUX_MAILBOX_VISIBILITY_MUTATION: mutation, AGENTMUX_MAILBOX_VISIBILITY_LOADED: log })
    assert.ok(typeof red.code === 'number' && red.code > 0 && red.signal === null, red.output)
    assert.match(red.output, /AssertionError/); assert.match(red.output, /Tests\s+[1-9]\d* failed/)
    const changes = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(module => module.mutation === mutation)
    assert.equal(changes.length, 1)
    assert.equal(changes[0].originalSHA256, receipt.sourceBefore[changes[0].path])
    assert.notEqual(changes[0].sha256, changes[0].originalSHA256)
    const restored = await run(mutation + '-restored', tests)
    assert.equal(restored.code, 0, restored.output); assert.match(restored.output, /Tests\s+4 passed/)
    receipt.mutations.push({ mutation, red: red.code, restored: restored.code, actualLoaded: changes[0] })
  }
  const adjacent = await run('qualification-adjacent', [vitest, 'run', '--config', `${fixture}/vitest.adjacent.config.mts`])
  assert.equal(adjacent.code, 0, adjacent.output); assert.match(adjacent.output, /Tests\s+[1-9]\d* passed/)
  receipt.checks.push({ label: 'adjacent', code: 0 })
  for (const kind of ['owning', 'production']) {
    const types = await run('qualification-' + kind + '-types', [tsc, '--project', `${fixture}/tsconfig.${kind}.json`, '--noEmit'])
    assert.equal(types.code, 0, types.output); receipt.checks.push({ label: kind + '-types', code: 0 })
  }
  const composer = await readFile(join(root, sourcePaths[1]), 'utf8'), gallery = await readFile(join(root, sourcePaths[2]), 'utf8')
  assert.match(composer, /<SessionMailbox visible=\{visible\}/u)
  assert.match(gallery, /<SessionMailbox visible system=/u)
  receipt.callers = sourcePaths.slice(1, 3)
  receipt.sourceAfter = await snapshots(); assert.deepEqual(receipt.sourceAfter, receipt.sourceBefore)
  receipt.passed = true
} finally {
  await writeFile(join(evidence, 'qualification.json'), JSON.stringify(receipt, null, 2) + '\n')
}
console.log(JSON.stringify({ passed: receipt.passed, owning: 4, mutations: receipt.mutations.length, callers: receipt.callers, boundary: receipt.boundary }))
