import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const run = promisify(execFile)
const root = resolve(import.meta.dirname, '../../..')
const mode = process.argv[2]
assert.ok(mode === '--settings' || mode === '--composer', 'Choose one accepted mutation surface')
const cases = mode === '--settings' ? [
  { name: 'schema-rejects-real-state-bindings', file: 'apps/desktop/src/main/config-store.ts',
    from: 'states: z.array(z.enum(COMPOSER_PROMPT_STATES)).optional()', to: "states: z.array(z.enum(['running'])).optional()" },
  { name: 'state-editor-drops-selections', file: 'apps/desktop/src/renderer/src/components/settings/ShortcutSettingsPane.tsx',
    from: 'states: event.target.checked', to: 'states: false' }
] : [
  { name: 'dispatch-drops-configured-body', file: 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
    from: 'send(sessionId, prompt.body, feedback.report)', to: "send(sessionId, 'wrong body', feedback.report)" },
  { name: 'dispatch-clears-unrelated-draft', file: 'apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx',
    from: '// State actions leave the independently authored Composer draft intact.',
    to: "setAgentComposerDraft(sessionId, '')" }
]
const tests = mode === '--settings' ? ['apps/desktop/test/status-prompt-settings.test.tsx'] : ['apps/desktop/test/agent-status-prompt-actions.test.tsx']
const privateRoot = await mkdtemp(join(tmpdir(), 'agentmux-status-prompts-mutations-'))
const evidence = join(root, '.tmp/status-prompt-actions', `mutations-${mode.slice(2)}-${Date.now()}`)
const originals = new Map()
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
const receipt = { schema: 'agentmux.status-prompt-actions-mutations.v1', passed: false, mode, sharedSourceMutated: false, cases: [] }
await mkdir(evidence, { recursive: true })
try {
  for (const dir of ['apps/desktop/src', 'apps/desktop/test', 'apps/desktop/resources', 'packages/core/src', 'packages/demand/src']) {
    await cp(join(root, dir), join(privateRoot, dir), { recursive: true, preserveTimestamps: true })
  }
  for (const file of ['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'vitest.config.ts', 'vitest.setup.ts', 'vitest.dist-freshness.ts',
    'apps/desktop/package.json', 'apps/desktop/tsconfig.json', 'apps/desktop/tsconfig.test.json']) {
    await cp(join(root, file), join(privateRoot, file), { preserveTimestamps: true })
  }
  const configPath = join(privateRoot, 'vitest.config.ts'), configSource = await readFile(configPath, 'utf8')
  assert.equal(configSource.split('  define: {').length, 2, 'The private test config retains its original globalSetup and checks')
  // Existing Core assets resolve through the isolated worktree dependency links. Admit only these
  // two exact roots; the entire production test setup and dist freshness guard are retained.
  await writeFile(configPath, configSource.replace('  define: {', `  server: { fs: { allow: ${JSON.stringify([privateRoot, root])} } },\n  define: {`))
  await symlink(join(root, 'node_modules'), join(privateRoot, 'node_modules'), 'dir')
  await symlink(join(root, 'apps/desktop/node_modules'), join(privateRoot, 'apps/desktop/node_modules'), 'dir')
  for (const name of ['core', 'demand']) await symlink(join(root, `packages/${name}/dist`), join(privateRoot, `packages/${name}/dist`), 'dir')
  for (const item of cases) originals.set(item.file, await readFile(join(root, item.file), 'utf8'))
  async function test(label, expectRed) {
    let output = '', code = 0
    try { const value = await run(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...tests, '--maxWorkers=1'], { cwd: privateRoot, timeout: 60000, maxBuffer: 4 * 1024 * 1024 }); output = value.stdout + value.stderr }
    catch (error) { code = error.code; output = (error.stdout ?? '') + (error.stderr ?? '') }
    await writeFile(join(evidence, `${label}.log`), output)
    if (expectRed) {
      assert.equal(typeof code, 'number', `${label}: a process failure is not an Assertion RED`)
      assert.notEqual(code, 0, `${label}: mutation survived`)
      assert.match(output, /AssertionError:/, `${label}: source must load and fail an actual assertion`)
    } else assert.equal(code, 0, `${label}: restored candidate must be GREEN; see log`)
    return { code, assertionRed: expectRed }
  }
  receipt.baseline = await test('baseline', false)
  for (const item of cases) {
    const original = originals.get(item.file)
    assert.equal(original.split(item.from).length, 2, `${item.name}: source anchor must occur exactly once`)
    await writeFile(join(privateRoot, item.file), original.replace(item.from, item.to))
    const red = await test(item.name, true)
    await writeFile(join(privateRoot, item.file), original)
    const restored = await test(`${item.name}-restored`, false)
    receipt.cases.push({ name: item.name, file: item.file, originalSha256: hash(original), red, restored })
  }
  for (const [file, original] of originals) assert.equal(hash(await readFile(join(root, file))), hash(original), `${file}: shared candidate stayed untouched`)
  receipt.passed = true
} catch (error) { receipt.failure = { name: error.name, message: error.message } }
finally {
  await rm(privateRoot, { recursive: true, force: true })
  await writeFile(join(evidence, 'receipt.json'), JSON.stringify(receipt, null, 2))
}
console.log(JSON.stringify({ passed: receipt.passed, receipt: join(evidence, 'receipt.json'), failure: receipt.failure }))
assert.equal(receipt.passed, true, receipt.failure?.message)
