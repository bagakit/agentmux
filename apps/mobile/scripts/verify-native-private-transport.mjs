import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'

if (!process.argv.includes('--preparation')) {
  throw new Error('Native OS TLS/trust, Keychain/Keystore, native build and actual device proof are absent. Module preparation cannot sign T002/T006.')
}
const repository = resolve(import.meta.dirname, '../../..'), mobile = join(repository, 'apps/mobile')
const evidence = join(repository, '.tmp/agentmux-private-mobile-client/native-secure-transport')
await mkdir(evidence, { recursive: true })
const files = [
  'apps/mobile/src/platform/native/private-transport.ts', 'apps/mobile/src/platform/native/workface-file.ts',
  'apps/mobile/test/native-private-transport.test.ts', 'apps/mobile/scripts/verify-native-private-transport.mjs',
  'apps/mobile/ios/App/App/PrivateCredentialVault.swift', 'apps/mobile/ios/App/App/PrivateHttpBytes.swift',
  'apps/mobile/ios/App/App/AgentMuxPrivateTransportPlugin.swift', 'apps/mobile/ios/App/App/AgentMuxBridgeViewController.swift',
  'apps/mobile/ios/App/App/AgentMuxWorkfaceFilePlugin.swift', 'apps/mobile/ios/App/App/SceneDelegate.swift',
  'apps/mobile/ios/App/App.xcodeproj/project.pbxproj',
  'apps/mobile/android/app/src/main/java/dev/bagakit/agentmux/mobile/PrivateCredentialVault.java',
  'apps/mobile/android/app/src/main/java/dev/bagakit/agentmux/mobile/AgentMuxPrivateTransportPlugin.java',
  'apps/mobile/android/app/src/main/java/dev/bagakit/agentmux/mobile/AgentMuxWorkfaceFilePlugin.java',
  'apps/mobile/android/app/src/main/java/dev/bagakit/agentmux/mobile/MainActivity.java',
  'apps/mobile/android/app/src/main/res/xml/network_security_config.xml', 'apps/mobile/android/app/src/main/AndroidManifest.xml'
]
const hashes = async () => Object.fromEntries(await Promise.all(files.map(async file => [file,
  createHash('sha256').update(await readFile(join(repository, file))).digest('hex')])))
const source = await hashes()
const originalConfig = join(mobile, 'vitest.config.ts')
function run(config, report, pattern) {
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    'test/native-private-transport.test.ts', ...(pattern ? ['--testNamePattern', pattern] : []),
    '--reporter=json', `--outputFile=${join(evidence, report + '.json')}`], { cwd: mobile, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.error) throw result.error
  return { exit: result.status, log: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
async function green(name) {
  const result = run(originalConfig, name)
  const json = JSON.parse(await readFile(join(evidence, name + '.json'), 'utf8'))
  assert.equal(result.exit, 0, result.log)
  assert.equal(json.success, true); assert.equal(json.numTotalTests, 10); assert.equal(json.numPassedTests, 10)
  assert.ok(json.testResults.some(suite => suite.assertionResults?.length === 10), 'A missing/empty owning suite cannot pass')
}
await green('baseline')
const mutations = [
  { id: 'cross-origin-request-submitted', file: files[0],
    from: 'url.origin !== boundOrigin || url.username || url.password || url.hash', to: 'false', pattern: 'refuses cross-origin' },
  { id: 'abort-keeps-native-stream', file: files[0],
    from: 'finish(); controller?.error(aborted(signal))\n        void plugin.cancel({ requestId }).catch(() => {})',
    to: 'finish(); controller?.error(aborted(signal))', pattern: 'fences a late stream chunk' },
  { id: 'unbounded-native-chunk', file: files[0], from: 'const MAX_CHUNK = 64 * 1024', to: 'const MAX_CHUNK = Number.POSITIVE_INFINITY', pattern: 'fails only the malformed' },
  { id: 'private-data-exported', file: files[1], from: 'getDeviceWorkface().parseBackup(bytes)', to: 'void bytes', pattern: 'passes only a validated public schema' },
  { id: 'unsaved-picker-accepted', file: files[1], from: 'await plugin.save({ filename, bytes })', to: 'void plugin', pattern: 'retains an unsuccessful system picker' }
]
const results = []
for (const mutation of mutations) {
  const path = join(repository, mutation.file), original = await readFile(path, 'utf8')
  assert.equal(original.split(mutation.from).length, 2, `${mutation.id}: actual nonempty Source block must be unique`)
  const config = join(evidence, mutation.id + '.config.mts')
  await writeFile(config, `import base from ${JSON.stringify(originalConfig)};\nexport default {...base,plugins:[{name:'native-transport-source-mutant',enforce:'pre',transform(code,id){if(id.split('?')[0]!==${JSON.stringify(path)})return;const from=${JSON.stringify(mutation.from)};if(code.split(from).length!==2)throw new Error('Source block absent');console.info('AMX_NATIVE_SOURCE_MUTANT:${mutation.id}');return code.replace(from,${JSON.stringify(mutation.to)});}},...(base.plugins??[])]};\n`)
  try {
    const red = run(config, mutation.id + '-red', mutation.pattern)
    await writeFile(join(evidence, mutation.id + '-red.log'), red.log)
    const json = JSON.parse(await readFile(join(evidence, mutation.id + '-red.json'), 'utf8'))
    assert.notEqual(red.exit, 0)
    assert.match(red.log, new RegExp(`AMX_NATIVE_SOURCE_MUTANT:${mutation.id}`, 'u'))
    const assertions = json.testResults.flatMap(suite => suite.assertionResults ?? []).filter(test => test.status === 'failed')
    assert.equal(assertions.length, 1); assert.ok(assertions[0].failureMessages.some(message => message.includes('AssertionError')),
      'Collection/import/type errors are not behavior detection')
    results.push({ id: mutation.id, actualAssertionRed: true, cases: assertions.length, exit: red.exit })
  } finally { await rm(config) }
}
await green('restored')
assert.deepEqual(await hashes(), source)
await writeFile(join(evidence, 'preparation.json'), JSON.stringify({ schema: 'agentmux.native-private-transport-preparation.v1',
  at: new Date().toISOString(), source, actualAdapterCases: 10, sourceMutations: results, restoredGreen: 10,
  scope: 'Actual TS native port/Response/ReadableStream and public workface schema consumer with controlled plugin. Native Source/registration prepared.',
  nativeCompiled: false, osSecretStorageVerified: false, osTlsTrustVerified: false, actualDeviceVerified: false,
  formalGatePassed: false, taskDone: false
}, null, 2) + '\n')
console.log('Native module preparation: 10 cases GREEN, 5 Source mutants Assertion RED, restored GREEN. Actual native/device gates remain absent.')
