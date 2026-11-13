import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
const root = resolve(import.meta.dirname, '../../..'), tempRoot = join(root, '.tmp')
await mkdir(tempRoot, { recursive: true })
const directory = await mkdtemp(join(tempRoot, 'native-continuity-')), config = join(directory, 'vitest.config.mts')
const test = 'packages/core/test/native-source-snapshot.test.ts'
const run = (args, env = {}) => {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 12 * 1024 * 1024 })
  if (result.error) throw result.error
  return { code: result.status, output: result.stdout + result.stderr }
}
function configuration(mutation, interleave = false) {
  const transforms = []
  if (interleave) transforms.push({ path: 'packages/core/src/native-file-clone.ts', before: 'if (nativeDataGeneration(source) !== generation)', after: "await globalThis[Symbol.for('native-capture-interleave')]?.(source); if (nativeDataGeneration(source) !== generation)" })
  if (mutation) transforms.push(mutation)
  return `import {defineConfig} from 'vitest/config'; export default defineConfig({plugins:[{name:'native-custody-proof',enforce:'pre',transform(code,id){
    for(const t of ${JSON.stringify(transforms)}){if(id.split('?')[0]!==${JSON.stringify(root + '/')}+t.path)continue;if(code.split(t.before).length!==2)throw Error('Non-unique proof target');code=code.replace(t.before,t.after); console.info('NATIVE_CUSTODY_PROOF_LOADED');}return code;
  }}],test:{include:[${JSON.stringify(test)}],exclude:[],setupFiles:[${JSON.stringify(join(root, 'vitest.setup.ts'))}]}})`
}
const tests = (pattern, env = {}) => run([join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--maxWorkers=1', ...(pattern ? ['-t', pattern] : [])], env)
function green(result, minimum) {
  assert.equal(result.code, 0, result.output)
  const passed = result.output.match(/Tests\s+(\d+) passed/u)
  assert.ok(passed && Number(passed[1]) >= minimum, result.output)
}
try {
  const built = run([join(root, 'node_modules/typescript/bin/tsc'), '-p', 'packages/core/tsconfig.build.json'])
  assert.equal(built.code, 0, built.output)
  await writeFile(config, configuration())
  green(tests(undefined, { AGENTMUX_CONTINUITY_COMPILED: '1' }), 21)
  const mutations = [
    { path: 'packages/core/src/native-jsonl-history-reader.ts', before: "if (!expected.equals(await this.read(at, length)))", after: 'if (false)', pattern: 'rejects an interior original-scope change' },
    { path: 'packages/core/src/native-jsonl-history-reader.ts', before: 'if (previous && previous.digest !== digest)', after: 'if (false)', pattern: 'rejects a conflicting stable identity on a later source page' }
  ]
  if (process.platform === 'darwin') {
    await writeFile(config, configuration(undefined, true))
    green(tests('rejects a real ABA writer', { AGENTMUX_GENERATION_INTERLEAVE: '1' }), 1)
    mutations.push({ path: 'packages/core/src/native-file-clone.ts', before: 'if (nativeDataGeneration(source) !== generation)', after: 'if (false)', pattern: 'rejects a real ABA writer', interleave: true })
  }
  for (const mutation of mutations) {
    await writeFile(config, configuration(mutation, mutation.interleave))
    const result = tests(mutation.pattern, mutation.interleave ? { AGENTMUX_GENERATION_INTERLEAVE: '1' } : {})
    assert.notEqual(result.code, 0, `${mutation.pattern}: mutant survived`)
    assert.match(result.output, /NATIVE_CUSTODY_PROOF_LOADED/u)
    assert.match(result.output, /AssertionError/u, result.output)
    await writeFile(config, configuration(undefined, mutation.interleave))
    green(tests(mutation.pattern, mutation.interleave ? { AGENTMUX_GENERATION_INTERLEAVE: '1' } : {}), 1)
  }
  console.log(`Native continuity: 21 actual Core/Provider/SDK/RPC/compiled CLI/resource cases passed; ${mutations.length} loaded production mutations rejected; original readers restored.`)
} finally { await rm(directory, { recursive: true, force: true }) }
