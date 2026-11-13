import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), base = join(root, '.tmp')
await mkdir(base, { recursive: true }); const directory = await mkdtemp(join(base, 'publication-continuity-')), config = join(directory, 'vitest.config.mts')
const run = args => { const r = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 12 * 1024 * 1024 }); if (r.error) throw r.error; if(r.status!==0)writeFileSync(join(base,'publication-native-continuity-failure.log'),r.stdout+r.stderr); return { code: r.status, output: r.stdout + r.stderr } }
const tests = pattern => run([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', ...['-t', pattern ?? '^(?!owner.review)']])
const configuration = mutation => `import {defineConfig} from 'vitest/config';export default defineConfig({${mutation ? `plugins:[{name:'original-effect-mutant',enforce:'pre',transform(code,id){if(id.split('?')[0]!==${JSON.stringify(join(root, mutation.path))})return;if(code.split(${JSON.stringify(mutation.before)}).length!==2)throw Error('Non-unique mutation');console.info('ORIGINAL_EFFECT_MUTANT_LOADED');return code.replace(${JSON.stringify(mutation.before)},${JSON.stringify(mutation.after)});}}],` : ''}test:{include:['packages/connectors/test/publication-native-rewrite.test.ts'],exclude:[],setupFiles:[${JSON.stringify(join(root, 'vitest.setup.ts'))}]}})`
const green = (r, count) => { assert.equal(r.code, 0, r.output); const m = r.output.match(/Tests\s+(\d+) passed/u); assert.ok(m && Number(m[1]) >= count, r.output) }
try {
  for (const args of [['-p','packages/core/tsconfig.build.json'], ['--noEmit','-p','packages/connectors/tsconfig.json']]) { const r = run([join(root, 'node_modules/typescript/bin/tsc'), ...args]); assert.equal(r.code, 0, r.output) }
  await writeFile(config, configuration()); if (!process.argv.includes('--mutations-only')) green(tests(), 20)
  const mutations = [
    { path: 'packages/connectors/src/publication-store.ts', before: 'if (!row.conflict && row.identity_qualified && (!previous || previous.semantic_revision === row.semantic_revision)) continue', after: 'if (!row.conflict) continue', pattern: 'prechecks old effect versions|retains the admitted old' },
    { path: 'packages/connectors/src/publication-store.ts', before: 'return units.filter(unit => !unit.records.some(record =>', after: 'return units.filter(unit => true || !unit.records.some(record =>', pattern: 'prechecks old effect versions' },
    { path: 'packages/connectors/src/publication-host.ts', before: "if (!page.more) { this.store.finishNativeRecoveryScan", after: 'if (true) { this.store.finishNativeRecoveryScan', pattern: 'durably stages more than one' }
  ]
  for (const m of mutations) {
    await writeFile(config, configuration(m)); const red = tests(m.pattern)
    assert.notEqual(red.code, 0, `${m.pattern}: mutant survived`); assert.match(red.output, /ORIGINAL_EFFECT_MUTANT_LOADED/u); assert.match(red.output, /AssertionError/u, red.output)
    await writeFile(config, configuration()); green(tests(m.pattern), 1)
  }
  console.log(process.argv.includes('--mutations-only') ? 'Mutation-only diagnostic passed (no baseline claim).' : 'Publication continuity: 20 real Core → Publication → controlled adapter cases, bounded 18k-record source, unknown/version/reopen/input cases passed; three loaded effect mutants rejected and restored.')
} catch(error) { writeFileSync(join(base, 'publication-native-continuity-gate-error.log'), String(error.stack)); throw error } finally { await rm(directory, { recursive: true, force: true }) }
