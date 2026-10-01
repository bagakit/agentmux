import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, rm, cp } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'

if (!process.argv.includes('--preparation')) throw new Error('Actual Desktop/public dispatcher/Host caller and Mac native dialog/iPhone proof are required. Module preparation cannot sign T002.')
const root = resolve(import.meta.dirname, '../../..')
const evidence = join(root, '.tmp/agentmux-private-mobile-client/device-management')
const temporary = join(evidence, 'tmp'), sandbox = join(evidence, 'mutation-sandbox')
await mkdir(temporary, { recursive: true })
const files = ['apps/host/src/device-management.ts', 'apps/host/src/mac-device-confirmation.ts',
  'apps/host/test/device-management.test.ts', 'apps/host/test/mac-device-confirmation.test.ts',
  'apps/host/vitest.device-management.config.ts', 'apps/host/scripts/verify-device-management.mjs']
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file, hash(await readFile(join(root, file)))])))
const source = await hashes()
function run(config, name, pattern) {
  const result = spawnSync(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    ...(pattern ? ['--testNamePattern', pattern] : []), '--reporter=json', `--outputFile=${join(evidence, name + '.json')}`],
    { cwd: root, env: { ...process.env, TMPDIR: temporary }, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
  if (result.error) throw result.error
  return { exit: result.status, log: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
async function green(config, name) {
  const result = run(config, name), report = JSON.parse(await readFile(join(evidence, name + '.json'), 'utf8'))
  await writeFile(join(evidence, name + '.log'), result.log)
  assert.equal(result.exit, 0, result.log); assert.equal(report.numTotalTests, 11); assert.equal(report.numPassedTests, 11)
  assert.equal(report.testResults.flatMap(suite => suite.assertionResults ?? []).length, 11)
}
await green(join(root, 'apps/host/vitest.device-management.config.ts'), 'module-baseline')
const mutations = [
  { id: 'mac-approve-permission-scope', file: 'mac-device-confirmation.ts', from: '批准后，这台设备可操作本 Mac 的 Agent：读取、发送、启动和停止。', to: '此设备只能读取。', pattern: 'uses an absolute OS command' },
  { id: 'unicode-line-name-in-argv', file: 'mac-device-confirmation.ts', from: String.raw`[\u0000-\u001f\u007f\u0085\u2028\u2029\u202a-\u202e\u2066-\u2069]`, to: String.raw`[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]`, pattern: 'uses an absolute OS command' },
  { id: 'http-as-local', file: 'device-management.ts', from: "context.transport !== 'unix'", to: 'false', pattern: 'refuses managed' },
  { id: 'managed-as-user', file: 'device-management.ts', from: 'context.caller !== undefined', to: 'false', pattern: 'refuses managed' },
  { id: 'device-as-user', file: 'device-management.ts', from: "context.principal?.kind !== 'user'", to: 'false', pattern: 'refuses managed' },
  { id: 'client-confirmed-params', file: 'device-management.ts', from: 'Object.keys(value).length !== keys.length', to: 'false', pattern: 'refuses managed' },
  { id: 'native-cancel-approved', file: 'device-management.ts', from: "if (outcome !== 'confirmed')", to: 'if (false)', pattern: 'preserves pending' },
  { id: 'wrong-code-approved', file: 'device-management.ts', from: 'const initial = this.waiting(deviceId, p.confirmationCode)', to: 'const initial = this.waiting(deviceId)', pattern: 'requires the original exact code' },
  { id: 'unbound-native-receipt', file: 'mac-device-confirmation.ts', from: 'result.stdout === `${nonce}:confirmed\\n`', to: 'result.stdout.length > 0', pattern: 'does not promote cancelled' },
  { id: 'failed-native-child-approved', file: 'mac-device-confirmation.ts', from: 'if (result.exitCode !== 0)', to: 'if (false)', pattern: 'does not promote cancelled' }
]
const red = []
const selection = process.argv.find(value => value.startsWith('--mutation-only='))?.slice('--mutation-only='.length)
const selectedMutations = selection ? mutations.filter(value => value.id === selection) : mutations
assert.ok(selectedMutations.length, 'Actual Source mutation selection is empty')
if (process.argv.includes('--mutation')) {
  await rm(sandbox, { recursive: true, force: true }); await mkdir(join(sandbox, 'src'), { recursive: true }); await mkdir(join(sandbox, 'test'))
  for (const file of ['device-management.ts', 'mac-device-confirmation.ts', 'device-authority.ts']) await cp(join(root, 'apps/host/src', file), join(sandbox, 'src', file))
  for (const file of ['device-management.test.ts', 'mac-device-confirmation.test.ts']) await cp(join(root, 'apps/host/test', file), join(sandbox, 'test', file))
  const config = join(sandbox, 'vitest.config.mts')
  await writeFile(config, `import {defineConfig} from 'vitest/config'; export default defineConfig({resolve:{alias:[{find:/^@agentmux\\/core$/,replacement:${JSON.stringify(join(root, 'packages/core/src/index.ts'))}}]},test:{environment:'node',include:[${JSON.stringify(join(sandbox, 'test/*.test.ts'))}],restoreMocks:true}});\n`)
  try {
    for (const mutation of selectedMutations) {
      const original = await readFile(join(root, 'apps/host/src', mutation.file), 'utf8'), path = join(sandbox, 'src', mutation.file)
      assert.equal(original.split(mutation.from).length, 2, `${mutation.id}: actual unique Source block absent`)
      await writeFile(path, original.replace(mutation.from, mutation.to))
      const result = run(config, mutation.id, mutation.pattern)
      await writeFile(join(evidence, mutation.id + '.log'), result.log)
      const report = JSON.parse(await readFile(join(evidence, mutation.id + '.json'), 'utf8'))
      const failed = report.testResults.flatMap(suite => suite.assertionResults ?? []).filter(test => test.status === 'failed')
      assert.notEqual(result.exit, 0, mutation.id); assert.equal(failed.length, 1)
      assert.ok(failed[0].failureMessages.some(message => message.includes('AssertionError')), `${mutation.id}: import/collection failures are not behavior proof`)
      red.push({ id: mutation.id, actualSourceAssertionRed: true, cases: 1, exit: result.exit })
      await writeFile(path, original)
    }
    await green(config, 'module-restored')
  } finally { await rm(sandbox, { recursive: true, force: true }) }
}
const nativeSource = await readFile(join(root, files[1]), 'utf8'), script = /const SCRIPT = `(.*?)`/su.exec(nativeSource)?.[1]
assert.ok(script)
const compile = spawnSync('/usr/bin/osacompile', ['-o', join(temporary, 'native-confirmation.scpt'), '-'], { input: script, encoding: 'utf8' })
await writeFile(join(evidence, 'applescript-syntax.log'), `${compile.stdout ?? ''}${compile.stderr ?? ''}`)
assert.equal(compile.status, 0, 'Fixed AppleScript OS syntax compile failed; it was not executed')
assert.deepEqual(await hashes(), source)
const caller = await readFile(join(root, 'apps/host/src/host.ts'), 'utf8')
await writeFile(join(evidence, selection ? `module-proof-${selection}.json` : process.argv.includes('--mutation') ? 'module-proof.json' : 'module-baseline-proof.json'), JSON.stringify({
  schema: 'agentmux.device-management-preparation.v1', at: new Date().toISOString(), source,
  actualCases: 11, actualSourceMutations: red, restoredCases: red.length ? 11 : null,
  actualOsFixedScriptSyntaxCompileExit: compile.status,
  actualHostSourceCallerPresent: /\bnew DeviceManagement\(/u.test(caller), hostSourceSha256: hash(caller),
  nativeDialogVerified: false, publicDispatcherJoined: false, actualDeviceVerified: false, formalGatePassed: false, taskDone: false,
  scope: 'Original Authority plus actual Mac port Source with controlled ProcessRunner; no fake public dispatcher/caller/native dialog or iPhone proof'
}, null, 2) + '\n')
await rm(temporary, { recursive: true, force: true }) // own exited-process cache/compiler product only
console.log(`Device management preparation: 11 actual cases GREEN, ${red.length} Source mutants Assertion RED, fixed script OS syntax compile. Native/product/device final proof remains absent.`)
