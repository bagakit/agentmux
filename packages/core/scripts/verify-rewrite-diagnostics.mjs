import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

// Run in an isolated checkout: compiled output is owned by this verification.
const root = resolve(import.meta.dirname, '../../..')
const tmpRoot = join(root, '.tmp')
await import('node:fs/promises').then(fs => fs.mkdir(tmpRoot, { recursive: true }))
const temporary = await mkdtemp(join(tmpRoot, 'rewrite-diagnostics-'))
const vitest = join(root, 'node_modules/vitest/vitest.mjs')
const tsc = join(root, 'node_modules/typescript/bin/tsc')
const config = join(temporary, 'vitest.config.mts')
const tests = ['packages/core/test/native-rewrite-anchor.test.ts', 'packages/core/test/pi-native-changes.test.ts', 'packages/core/test/providers/grok-session-analysis.test.ts']
const cliTest = 'packages/core/test/conversation-unified-public.test.ts'
const setup = join(root, 'vitest.setup.ts')
const result = (args, env = {}) => {
  const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 24 * 1024 * 1024 })
  if (r.error) throw r.error
  return { code: r.status, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const requireGreen = (run, minimum) => {
  assert.equal(run.code, 0, run.output)
  const match = run.output.match(/Tests\s+(\d+) passed/u)
  assert.ok(match && Number(match[1]) >= minimum, `Expected nonempty passed tests, got:\n${run.output}`)
}
const runTests = (file, pattern, env = {}) => result([vitest, 'run', '--config', file, ...(pattern ? ['-t', pattern] : []), '--maxWorkers=1'], env)
const makeConfig = (includes, mutation) => {
  const plugin = mutation ? `plugins: [{name:'rewrite-diagnostics-mutant', enforce:'pre', transform(code,id) {
    if (id.split('?')[0] !== ${JSON.stringify(join(root, mutation.path))}) return;
    const before = ${JSON.stringify(mutation.before)}, after = ${JSON.stringify(mutation.after)};
    if (code.split(before).length !== 2) throw new Error('Mutation target is not unique');
    console.info('REWRITE_DIAGNOSTIC_MUTANT_LOADED'); return code.replace(before, after);
  }}],` : ''
  return `import { defineConfig } from 'vitest/config';\nexport default defineConfig({${plugin}test:{include:${JSON.stringify(includes)},exclude:[],setupFiles:[${JSON.stringify(setup)}]}});\n`
}
const mutations = [
  { name: 'same-file-rewrite', path: 'packages/core/src/native-jsonl-history-reader.ts',
    before: "failure('REWRITTEN', 'The original conversation was rewritten before the saved reading position.')",
    after: "failure('SOURCE_CHANGED', 'The original conversation was rewritten before the saved reading position.')",
    includes: tests.slice(1), pattern: 'reports a same-file' },
  { name: 'changed-continuation', path: 'packages/core/src/conversation-reader.ts',
    before: "fail('The continuation changed its original upper frontier or rewrite anchor.', 'AGENT_SESSION_HISTORY_INVALID_CURSOR')",
    after: "fail('The continuation changed its original upper frontier or rewrite anchor.', 'AGENT_SESSION_HISTORY_SOURCE_CHANGED')",
    includes: tests.slice(0, 1), pattern: 'reports a changed rewrite continuation' }
]
try {
  const build = result([tsc, '-p', 'packages/core/tsconfig.build.json'])
  assert.equal(build.code, 0, build.output)
  await writeFile(config, makeConfig(tests))
  const baseline = runTests(config); requireGreen(baseline, 1)
  await writeFile(config, makeConfig([cliTest]))
  const cliBaseline = runTests(config, 'compiled CLI reports invalid rewrite input', { AGENTMUX_UNIFIED_COMPILED: '1' }); requireGreen(cliBaseline, 1)
  for (const mutation of mutations) {
    await writeFile(config, makeConfig(mutation.includes, mutation))
    const red = runTests(config, mutation.pattern)
    assert.notEqual(red.code, 0, `${mutation.name} survived`)
    assert.match(red.output, /REWRITE_DIAGNOSTIC_MUTANT_LOADED/u, `${mutation.name} was not loaded`)
    assert.match(red.output, /AssertionError/u, `${mutation.name} failed without its business assertion`)
  }
  // Mutate only a private copy of the compiled CLI, keeping source and actual dist intact.
  const privateCore = join(temporary, 'private-core')
  await cp(join(root, 'packages/core/dist'), join(privateCore, 'dist'), { recursive: true })
  await cp(join(root, 'packages/core/bin'), join(privateCore, 'bin'), { recursive: true })
  await cp(join(root, 'packages/core/package.json'), join(privateCore, 'package.json'))
  await symlink(join(root, 'packages/core/node_modules'), join(privateCore, 'node_modules'), 'dir')
  const privateCodec = join(privateCore, 'dist/conversation-changes.js'), original = await readFile(privateCodec, 'utf8')
  const before = "A rewrite anchor requires the original record ID and digest from its changes read.', 'INVALID_CONTROL_REQUEST'"
  const after = "A rewrite anchor requires the original record ID and digest from its changes read.', 'CONTROL_PROTOCOL_ERROR'"
  assert.equal(original.split(before).length, 2, 'Compiled CLI mutation target must be unique')
  await writeFile(privateCodec, original.replace(before, after))
  await writeFile(config, makeConfig([cliTest]))
  const cliRed = runTests(config, 'compiled CLI reports invalid rewrite input', { AGENTMUX_UNIFIED_COMPILED: '1', AGENTMUX_TEST_OBJECT_CLI: join(privateCore, 'bin/amux') })
  assert.notEqual(cliRed.code, 0, 'Compiled CLI error mutant survived')
  assert.match(cliRed.output, /AssertionError/u, 'Compiled CLI mutant did not reach the business assertion')
  assert.match(cliRed.output, /CONTROL_PROTOCOL_ERROR/u, 'Compiled CLI did not load the mutated code')
  await writeFile(config, makeConfig(tests))
  const restored = runTests(config); requireGreen(restored, 1)
  await writeFile(config, makeConfig([cliTest]))
  const cliRestored = runTests(config, 'compiled CLI reports invalid rewrite input', { AGENTMUX_UNIFIED_COMPILED: '1' }); requireGreen(cliRestored, 1)
  console.log('Rewrite diagnostics: actual Provider/Core suites and compiled CLI passed; three loaded mutations failed their business assertions; restored consumers passed.')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
