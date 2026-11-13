import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '../../..'), base = join(root, '.tmp')
await mkdir(base, { recursive: true })
const directory = await mkdtemp(join(base, 'source-review-cancel-')), config = join(directory, 'vitest.config.mts')
const before = "(action.action === 'approve' || action.digest !== undefined) && action.digest !== review.digest"
const configuration = mutant => `import {defineConfig} from 'vitest/config';export default defineConfig({${mutant ? `plugins:[{name:'mandatory-cancel-digest',enforce:'pre',transform(code,id){if(id.split('?')[0]!==${JSON.stringify(join(root, 'packages/connectors/src/publication-store.ts'))})return;if(code.split(${JSON.stringify(before)}).length!==2)throw Error('Non-unique mutation');console.info('CANCEL_DIGEST_MUTANT_LOADED');return code.replace(${JSON.stringify(before)},'action.digest !== review.digest');}}],` : ''}test:{include:['packages/connectors/test/publication-native-rewrite.test.ts'],exclude:[],setupFiles:[${JSON.stringify(join(root, 'vitest.setup.ts'))}],passWithNoTests:false}})`
const run = pattern => {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', '-t', pattern], { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, output: result.stdout + result.stderr }
}
const green = (result, minimum) => {
  assert.equal(result.code, 0, result.output)
  assert.ok(Number(result.output.match(/Tests\s+(\d+) passed/u)?.[1]) >= minimum, result.output)
}
try {
  for (const project of ['packages/core/tsconfig.build.json', 'packages/connectors/tsconfig.json']) {
    const result = spawnSync(process.execPath, [join(root, 'node_modules/typescript/bin/tsc'), '-p', project], { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stdout + result.stderr)
  }
  await writeFile(config, configuration(false))
  green(run('cancels a .* immutable offer|sends nothing before exact approval|original Binding is paused|cancellation keeps the original cut'), 5)
  console.log('Five real owner consumers passed: ready/blocked cancellation, explicit wrong digest, exact approval, paused Binding and preparing cancellation.')
  await writeFile(config, configuration(true))
  const red = run('cancels a .* immutable offer')
  assert.notEqual(red.code, 0, red.output)
  assert.match(red.output, /CANCEL_DIGEST_MUTANT_LOADED/u)
  assert.match(red.output, /Tests\s+2 failed/u)
  assert.match(red.output, /Inspect the same original completed offer/u)
  await writeFile(config, configuration(false))
  green(run('cancels a .* immutable offer'), 2)
  console.log('Loaded mandatory-digest mutant rejected by both actual consumers; restored baseline passed.')
} catch (error) {
  await writeFile(join(base, 'source-review-cancel-failure.log'), String(error.stack))
  throw error
} finally { await rm(directory, { recursive: true, force: true }) }
