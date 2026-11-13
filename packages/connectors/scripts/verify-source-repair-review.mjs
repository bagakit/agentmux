import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), base = join(root, '.tmp')
await mkdir(base, { recursive: true })
const directory = await mkdtemp(join(base, 'source-repair-review-')), config = join(directory, 'vitest.config.mts')
const run = args => {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...process.env, AGENTMUX_SOURCE_REVIEW_COMPILED: '1' }, maxBuffer: 12 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, output: result.stdout + result.stderr }
}
const tests = pattern => run([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', '-t', pattern])
const configuration = mutation => `import {defineConfig} from 'vitest/config'; export default defineConfig({${mutation ? `plugins:[{name:'source-repair-review-mutant',enforce:'pre',transform(code,id){if(id.split('?')[0]!==${JSON.stringify(join(root, mutation.path))})return;if(code.split(${JSON.stringify(mutation.before)}).length!==2)throw Error('Non-unique mutation');console.info('SOURCE_REVIEW_MUTANT_LOADED');return code.replace(${JSON.stringify(mutation.before)},${JSON.stringify(mutation.after)});}}],` : ''}test:{include:['packages/connectors/test/publication-native-rewrite.test.ts'],exclude:[],setupFiles:[${JSON.stringify(join(root, 'vitest.setup.ts'))}]}})`
const green = (result, minimum) => {
  assert.equal(result.code, 0, result.output)
  const passed = result.output.match(/Tests\s+(\d+) passed/u)
  assert.ok(passed && Number(passed[1]) >= minimum, result.output)
}
const mutations = [
  { path: 'packages/connectors/src/publication-host.ts', before: "if (input.review && (context.actor.kind === 'agent'", after: "if (false && input.review && (context.actor.kind === 'agent'", pattern: 'refuses another actor' },
  { path: 'packages/connectors/src/publication-store.ts', before: 'if (action.digest !== review.digest ||', after: 'if (false ||', pattern: 'sends nothing before exact approval' },
  { path: 'packages/core/dist/native-jsonl-history-reader.js', before: 'scopeStart: this.snapshotCursor.recovery?.start ?? this.snapshotLease.manifest.end', after: 'scopeStart: 0', pattern: 'new future cut rather than a zero' },
  { path: 'packages/connectors/src/publication-store.ts', before: 'unmappedEffects: review.unmappedEffects + 1', after: 'unmappedEffects: review.unmappedEffects', pattern: 'never treats an unmapped legacy unknown' },
  { path: 'packages/connectors/src/publication-store.ts', before: 'this.acceptReplyFacts(boundary, units, recovering)', after: 'this.acceptReplyFacts(boundary, units, false)', pattern: 'older nonpublic activity' },
  { path: 'packages/connectors/src/publication-store.ts', before: "const original = this.database.prepare('SELECT operation_json,state FROM connector_publication_operation WHERE ordinal IN (SELECT MAX(ordinal) FROM connector_publication_operation WHERE projection_id=? GROUP BY fragment_ordinal) ORDER BY fragment_ordinal DESC')\n        .all(projectionId).map(row => this.read(row)!).find(operation => operation.effect === 'upsert' && operation.payload.kind === 'speech')", after: 'const original = this.latestProjection(projectionId)', pattern: 'final original fragment is media' },
  { path: 'packages/connectors/src/publication-store.ts', before: 'const sourceProofs = admissionProofs(unit, originalProofs)', after: 'const sourceProofs = admissionProofs(unit)', pattern: 'response metadata across frozen large-resource' }
]
try {
  for (const args of [['-p', 'packages/core/tsconfig.build.json'], ['--noEmit', '-p', 'packages/connectors/tsconfig.json']]) {
    const built = run([join(root, 'node_modules/typescript/bin/tsc'), ...args]); assert.equal(built.code, 0, built.output)
  }
  await writeFile(config, configuration())
  if (!process.argv.includes('--mutations-only')) { green(tests('^owner.review'), 13); console.log('13 real owner review consumers passed, including compiled CLI/RPC/Hosted, resources, media, pause, unknown effects and durable reopen.') }
  for (const mutation of mutations) {
    console.log('Checking loaded mutation: ' + mutation.pattern)
    await writeFile(config, configuration(mutation)); const red = tests(mutation.pattern)
    await writeFile(join(base, 'source-repair-review-last-mutant.log'), red.output)
    assert.notEqual(red.code, 0, mutation.pattern + ': mutation survived')
    assert.match(red.output, /SOURCE_REVIEW_MUTANT_LOADED/u)
    assert.match(red.output, /AssertionError/u, red.output)
    await writeFile(config, configuration()); green(tests(mutation.pattern), 1)
    console.log('Rejected and restored: ' + mutation.pattern)
  }
  console.log(process.argv.includes('--mutations-only') ? 'Mutation diagnostic only: no baseline claim.' : 'Source repair review passed: 13 real consumers and seven loaded production mutations rejected; original consumers restored.')
} catch (error) { await writeFile(join(base, 'source-repair-review-failure.log'), String(error.stack)); throw error }
finally { await rm(directory, { recursive: true, force: true }) }
