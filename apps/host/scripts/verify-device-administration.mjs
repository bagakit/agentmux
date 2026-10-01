import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'

const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.tmp/private-mobile-host/device-administration')
await mkdir(evidence, { recursive: true })
const own = ['apps/host/src/device-administration.ts', 'apps/host/src/host.ts',
  'apps/host/src/device-authority.ts', 'apps/host/src/private-access.ts', 'apps/host/src/device-management.ts',
  'apps/host/test/device-administration.test.ts', 'apps/host/scripts/verify-device-administration.mjs']
const consumed = ['apps/host/src/mac-device-confirmation.ts', 'packages/core/src/public-rpc-device.ts',
  'packages/core/src/public-rpc-service.ts', 'packages/core/src/public-rpc-server.ts',
  'packages/core/src/public-rpc-client.ts', 'packages/core/src/public-rpc-wire.ts',
  'packages/core/src/hosted-runtime-service.ts']
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path,
  createHash('sha256').update(await readFile(join(repository, path))).digest('hex')])))
const source = await hashes(own), consumedSource = await hashes(consumed)
const run = config => {
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run',
    '--config', config, 'apps/host/test/device-administration.test.ts'], {
    cwd: repository, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024
  })
  if (result.error) throw result.error
  return { exitCode: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const config = join(repository, 'vitest.config.ts')
const green = run(config)
await writeFile(join(evidence, 'green.log'), green.output)
assert.equal(green.exitCode, 0, green.output); assert.match(green.output, /2 passed/u)
const mutations = [
  { id: 'host-device-port-disconnected', target: 'apps/host/src/host.ts',
    from: '    deviceAdministration: createDeviceAdministration(authorityReady, options.deviceConfirmation),', to: '' },
  { id: 'host-device-context-lost', target: 'apps/host/src/device-administration.ts',
    from: '    return await invoke(params, context)', to: '    return await invoke(params, {})' }
]
const proofs = []
for (const mutation of mutations) {
  const target = join(repository, mutation.target), body = await readFile(target, 'utf8')
  assert.equal(body.split(mutation.from).length, 2, 'Exactly one nonempty actual Source block')
  const candidate = join(evidence, `${mutation.id}.config.mts`)
  await writeFile(candidate, `import base from ${JSON.stringify(config)};const target=${JSON.stringify(target)},from=${JSON.stringify(mutation.from)},to=${JSON.stringify(mutation.to)};export default {...base,plugins:[{name:'host-device-port-mutant',enforce:'pre',transform(code,id){if(id.split('?')[0]!==target)return;if(code.split(from).length!==2)throw new Error('Source block missing');console.info('AMX_DEVICE_PORT_MUTANT:${mutation.id}');return code.replace(from,to)}},...(base.plugins??[])]};\n`)
  try {
    const red = run(candidate)
    await writeFile(join(evidence, `${mutation.id}-red.log`), red.output)
    assert.notEqual(red.exitCode, 0, 'Disconnected finite port must fail real requests')
    assert.ok(red.output.includes(`AMX_DEVICE_PORT_MUTANT:${mutation.id}`))
    assert.match(red.output, /AssertionError/u, 'Collection failure is not a behavior proof')
    proofs.push({ id: mutation.id, sourceBlockApplied: true, assertionRed: true, exitCode: red.exitCode,
      logSha256: createHash('sha256').update(red.output).digest('hex') })
  } finally { await rm(candidate) }
}
const restored = run(config)
await writeFile(join(evidence, 'restored-green.log'), restored.output)
assert.equal(restored.exitCode, 0, restored.output); assert.match(restored.output, /2 passed/u)
const strictConfig = join(evidence, 'tsconfig.json')
await writeFile(strictConfig, JSON.stringify({ extends: '../../../tsconfig.base.json', compilerOptions: {
  types: ['node', 'vitest/globals'], noEmit: true }, include: ['../../../apps/host/src/**/*.ts',
  '../../../apps/host/test/device-administration.test.ts'] }, null, 2) + '\n')
const typed = spawnSync(process.execPath, [join(repository, 'node_modules/typescript/bin/tsc'), '-p', strictConfig], {
  cwd: repository, encoding: 'utf8', maxBuffer: 1024 * 1024 })
await writeFile(join(evidence, 'typecheck.log'), `${typed.stdout ?? ''}${typed.stderr ?? ''}`)
assert.equal(typed.status, 0, `${typed.stdout}${typed.stderr}`)
const host = await readFile(join(repository, 'apps/host/src/host.ts'), 'utf8')
assert.ok(host.includes('deviceAdministration: createDeviceAdministration(authorityReady, options.deviceConfirmation)'),
  'The actual Host consumes the adapter outside its defining file')
const startup = await readFile(join(repository, 'apps/host/src/index.ts'), 'utf8')
assert.ok(startup.includes('startAgentMuxHost({'), 'The actual executable consumes the sole Host')
assert.deepEqual(await hashes(own), source); assert.deepEqual(await hashes(consumed), consumedSource)
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.host-device-administration.v1',
  checkedAt: new Date().toISOString(), source, consumedSource, behaviorCases: 2, mutations: proofs,
  restoredGreen: { exitCode: restored.exitCode, cases: 2 }, typecheckExitCode: typed.status,
  callers: ['Host index → sole Host → finite public deviceAdministration → original DeviceManagement → original DeviceAuthority/Mac runner'],
  limitations: ['The actual Unix/HTTPS public dispatcher and original fixed native runner are exercised with a controlled process result.',
    'No actual OS dialog, GUI interaction or physical phone/native acceptance is claimed.'], actualOsDialog: false,
  fullT002Passed: false }, null, 2) + '\n')
console.log('Host device port: 2 actual Unix/HTTPS cases, 2 Source block mutants RED, restored GREEN, strict types GREEN.')
