import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..')
await mkdir(join(root, '.tmp'), { recursive: true })
const temporary = await mkdtemp(join(root, '.tmp/rewrite-boundary-'))
const config = join(temporary, 'vitest.config.mts')
const file = 'packages/connectors/test/publication-native-rewrite.test.ts'
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 24 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const makeConfig = mutation => `import {defineConfig} from 'vitest/config';export default defineConfig({
${mutation ? `plugins:[{name:'rewrite-boundary-mutant',enforce:'pre',transform(code,id){
if(id.split('?')[0]!==${JSON.stringify(join(root, mutation.path))})return;
const before=${JSON.stringify(mutation.before)};
if(code.split(before).length!==2)throw Error('Mutation target is not unique');
console.info('REWRITE_BOUNDARY_MUTANT_LOADED');return code.replace(before,${JSON.stringify(mutation.after)});
}}],` : ''}
test:{testTimeout:30000,include:[${JSON.stringify(file)}],exclude:[],setupFiles:[${JSON.stringify(join(root, 'vitest.setup.ts'))}]}})`
const tests = pattern => run([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', ...(pattern ? ['-t', pattern] : [])])
const green = result => {
  assert.equal(result.code, 0, result.output)
  const passed = result.output.match(/Tests\s+(\d+) passed/u)
  assert.ok(passed && Number(passed[1]) >= 11, `Expected nonempty original consumer proofs:\n${result.output}`)
  const cost = result.output.match(/REWRITE_OBSERVATION_COST (\{[^\n]+\})/u)
  assert.ok(cost, 'The original large-file observation must be measured')
  const measured = JSON.parse(cost[1])
  assert.ok(measured.sourceBytes > 8 * 1024 * 1024 && measured.ordinary.length === 3 && measured.rewritten.length === 3)
  return measured
}
const mutations = [
  { name: 'advance-unproven-cut', path: 'packages/core/dist/native-jsonl-history-reader.js',
    before: "if (saved.offset > this.cut || saved.tail !== fingerprints.tail)\n                return failure('REWRITTEN', 'The original conversation was rewritten before the saved reading position.');",
    after: 'if (saved.offset > this.cut || saved.tail !== fingerprints.tail) { this.forwardPosition = this.cut; return; }',
    pattern: 'identical anchor cannot exclude' },
  { name: 'block-independent-source', path: 'packages/connectors/src/publication-host.ts',
    before: '      const consumed = consumeConversationWindowPage(page, state.pending)',
    after: "      if (nativeFailure) { this.sourceUnavailable(lane, 'source-gap', new AgentMuxError('Controlled native gap', nativeFailure.code!), state.after); return }\n      const consumed = consumeConversationWindowPage(page, state.pending)",
    pattern: 'keeps independent captured publication' }
]
try {
  for (const project of ['packages/core/tsconfig.build.json', 'packages/connectors/tsconfig.json']) {
    const build = run([join(root, 'node_modules/typescript/bin/tsc'), '-p', project]); assert.equal(build.code, 0, build.output)
  }
  await writeFile(config, makeConfig())
  green(tests())
  for (const mutation of mutations) {
    await writeFile(config, makeConfig(mutation))
    const red = tests(mutation.pattern)
    assert.notEqual(red.code, 0, `${mutation.name} survived`)
    assert.match(red.output, /REWRITE_BOUNDARY_MUTANT_LOADED/u, 'The production mutant must be loaded')
    assert.match(red.output, /AssertionError/u, `The mutant must reach its business assertion:\n${red.output}`)
  }
  await writeFile(config, makeConfig())
  const cost = green(tests())
  console.log('Rewrite boundary: original Core → Publication → controlled transport passed; both loaded production mutants failed; restored consumers passed.')
  console.log(JSON.stringify({ cost, livePlatform: 'unconfirmed', automaticBackfill: 'unimplemented-without-source-proof' }))
} finally { await rm(temporary, { recursive: true, force: true }) }
