import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { build } from 'esbuild'

const repository = resolve(import.meta.dirname, '../../..')
const evidence = join(repository, '.tmp/private-mobile-host/private-host')
await mkdir(evidence, { recursive: true })
const own = ['apps/host/src/host.ts', 'apps/host/src/index.ts', 'apps/host/src/private-access-configuration.ts',
  'apps/host/test/private-host.test.ts', 'apps/host/scripts/verify-private-host.mjs']
const dependencies = ['apps/host/src/device-authority.ts', 'apps/host/src/private-access.ts',
  'apps/host/src/private-access-assets.ts', 'apps/host/src/private-tls.ts', 'apps/host/src/private-certificates.ts',
  'packages/core/src/public-rpc-server.ts', 'packages/core/src/public-rpc-service.ts',
  'packages/core/src/public-rpc-wire.ts', 'packages/core/src/public-rpc-http.ts',
  'packages/core/src/hosted-client.ts', 'packages/core/src/hosted-client-contract.ts', 'packages/core/src/hosted-output-observer.ts']
const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async file =>
  [file, createHash('sha256').update(await readFile(join(repository, file))).digest('hex')])))
const source = await hashes(own), consumedSource = await hashes(dependencies)
const resume = process.argv.includes('--resume-before-startup')
let previousVerifier
if (resume) {
  const previous = JSON.parse(await readFile(join(evidence, 'source-inputs.json'), 'utf8'))
  for (const file of own.filter(file => file !== 'apps/host/scripts/verify-private-host.mjs')) {
    assert.equal(source[file], previous.source[file], 'Resume requires the exact already-tested product and test Source')
  }
  assert.deepEqual(consumedSource, previous.consumedSource, 'Resume requires the exact consumed business Source')
  previousVerifier = previous.source['apps/host/scripts/verify-private-host.mjs']
} else await writeFile(join(evidence, 'source-inputs.json'), JSON.stringify({ source, consumedSource }, null, 2) + '\n')
const run = (config, pattern, entry) => {
  const result = spawnSync(process.execPath, [join(repository, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config,
    'apps/host/test/private-host.test.ts', ...(pattern ? ['--testNamePattern', pattern] : [])],
  { cwd: repository, env: { ...process.env, ...(entry ? { AGENTMUX_TEST_HOST_ENTRY: entry } : {}) },
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  if (result.error) throw result.error
  return { exitCode: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}
const buildResult = spawnSync(process.execPath, [join(repository, 'apps/host/scripts/build.mjs')], {
  cwd: repository, encoding: 'utf8', maxBuffer: 1024 * 1024 })
assert.equal(buildResult.status, 0, `${buildResult.stdout}${buildResult.stderr}`)
const config = join(repository, 'vitest.config.ts'), host = 'apps/host/src/host.ts', configuration = 'apps/host/src/private-access-configuration.ts'
if (resume) assert.match(await readFile(join(evidence, 'green.log'), 'utf8'), /7 passed/u)
else {
  const green = run(config)
  await writeFile(join(evidence, 'green.log'), green.output)
  assert.equal(green.exitCode, 0, green.output); assert.match(green.output, /7 passed/u)
}
const configurationSource = await readFile(join(repository, configuration), 'utf8')
const validationStart = configurationSource.indexOf('  if (!required.every('), validationEnd = configurationSource.indexOf('  requirePrivateHostAddress(input.host)')
assert.ok(validationStart >= 0 && validationEnd > validationStart)
const validation = configurationSource.slice(validationStart, validationEnd)
assert.ok(validation.includes('mobileBuildDirectory') && validation.includes('throw invalid()'), 'The actual manifest validation body must be nonempty')
const failedAuthority = `      } catch (error) {
        privateIssue = 'The original device authority cannot be read. Its bytes are retained; restore that identity to recover mobile access. Unix and Agent Sessions remain available.'
        rejectAuthority(error)
      }`
const mutations = [
  { id: 'manifest-field-admission-removed', target: configuration, from: validation, to: '', pattern: 'reads one exact non-secret startup manifest' },
  { id: 'private-workflow-retires-healthy-session', target: host,
    from: '    resolveOwner(client)\n    if (tls && authority && !privateIssue && !server.httpUnavailable) {',
    to: '    resolveOwner(client)\n    if (privateIssue) { for (const session of client.agentSessions()) await client.stopAgent(session.agentSessionId, session.run) }\n    if (tls && authority && !privateIssue && !server.httpUnavailable) {',
    pattern: 'explicit mobile configuration cannot be read' },
  { id: 'private-failure-notice-concealed', target: host,
    from: "    if (failure) return { state: 'unavailable', message: failure }",
    to: "    if (failure) return { state: 'unconfigured', message: 'Mobile access is ready.' }",
    pattern: 'explicit mobile configuration cannot be read' },
  { id: 'bad-device-identity-replaced', target: host, from: failedAuthority,
    to: `      } catch (error) {
        authority = await DeviceAuthority.open(join(dirname(options.store.path), 'agentmux-replacement-devices.json'))
        resolveAuthority(authority)
      }`, pattern: 'bad durable device identity bytes' },
  { id: 'mobile-assets-not-routed', target: host,
    from: 'return access ? await access.route(request) ?? assets?.route(request) ?? null : mobileUnavailable()',
    to: 'return access ? await access.route(request) ?? null : mobileUnavailable()',
    pattern: 'serves actual mobile assets' },
  { id: 'device-admission-bypassed', target: host,
    from: 'authorize: async request => { await privateReady; return access?.authorize(request) ?? null }',
    to: "authorize: async request => { await privateReady; return { principal: { kind: 'user', id: 'unapproved-device' } } }",
    pattern: 'serves actual mobile assets' },
  { id: 'device-revocation-signal-dropped', target: host,
    from: 'authorize: async request => { await privateReady; return access?.authorize(request) ?? null }',
    to: 'authorize: async request => { await privateReady; const authorization = access?.authorize(request); return authorization ? { principal: authorization.principal } : null }',
    pattern: 'serves actual mobile assets' }
]
const proofs = []
for (const mutation of mutations) {
  const target = join(repository, mutation.target), original = await readFile(target, 'utf8')
  assert.equal(original.split(mutation.from).length, 2, `${mutation.id}: one actual Source block`)
  if (resume) {
    const log = await readFile(join(evidence, `${mutation.id}-red.log`), 'utf8')
    assert.ok(log.includes(`AMX_PRIVATE_HOST_MUTANT:${mutation.id}`))
    assert.match(log, /AssertionError/u); assert.match(log, /1 failed/u)
    proofs.push({ id: mutation.id, assertionRed: true, sourceApplied: true,
      reusedExactSource: true, previousVerifier, logSha256: createHash('sha256').update(log).digest('hex') })
    continue
  }
  const mutantConfig = join(evidence, `${mutation.id}.config.mts`)
  await writeFile(mutantConfig, `import base from ${JSON.stringify(config)};const target=${JSON.stringify(target)},from=${JSON.stringify(mutation.from)},to=${JSON.stringify(mutation.to)};export default {...base,plugins:[{name:'private-host-source-mutant',enforce:'pre',transform(code,id){if(id.split('?')[0]!==target)return;if(code.split(from).length!==2)throw new Error('Actual Source block missing');console.info('AMX_PRIVATE_HOST_MUTANT:${mutation.id}');return code.replace(from,to)}},...(base.plugins??[])]};\n`)
  try {
    const red = run(mutantConfig, mutation.pattern)
    await writeFile(join(evidence, `${mutation.id}-red.log`), red.output)
    assert.notEqual(red.exitCode, 0, `${mutation.id} must fail behavior`)
    assert.ok(red.output.includes(`AMX_PRIVATE_HOST_MUTANT:${mutation.id}`), 'Actual owning Source was transformed')
    assert.match(red.output, /AssertionError/u, 'Collection or tool failure does not prove the behavior')
    proofs.push({ id: mutation.id, exitCode: red.exitCode, assertionRed: true, sourceApplied: true })
  } finally { await rm(mutantConfig) }
}
const startupId = 'startup-default-manifest-ignored', startup = 'apps/host/src/index.ts'
const from = 'privateArgument === -1 ? defaultPrivateAccessConfigurationPath(storePath) : process.argv[privateArgument + 1]'
const to = "privateArgument === -1 ? `${storePath}.unconfigured` : process.argv[privateArgument + 1]"
assert.equal((await readFile(join(repository, startup), 'utf8')).split(from).length, 2)
const entry = join(evidence, `${startupId}.js`)
try {
  await build({ entryPoints: [join(repository, startup)], outfile: entry, bundle: true, packages: 'external',
    platform: 'node', format: 'esm', target: 'node24', plugins: [{ name: startupId, setup(builder) {
      builder.onLoad({ filter: /\/src\/index\.ts$/ }, async args => {
        if (args.path !== join(repository, startup)) return
        const code = await readFile(args.path, 'utf8'); assert.equal(code.split(from).length, 2)
        return { contents: code.replace(from, to), loader: 'ts' }
      })
    } }] })
  const red = run(config, 'actual Host startup entry', entry)
  await writeFile(join(evidence, `${startupId}-red.log`), red.output)
  assert.notEqual(red.exitCode, 0); assert.match(red.output, /AssertionError/u)
  proofs.push({ id: startupId, exitCode: red.exitCode, assertionRed: true, sourceApplied: true,
    scope: 'Original Host entry bundled with one isolated Source replacement, invoked by the actual startup child' })
} finally { await rm(entry, { force: true }) }
const restored = run(config)
await writeFile(join(evidence, 'restored-green.log'), restored.output)
assert.equal(restored.exitCode, 0, restored.output); assert.match(restored.output, /7 passed/u)
assert.deepEqual(await hashes(own), source)
assert.deepEqual(await hashes(dependencies), consumedSource)
const callerSource = await readFile(join(repository, 'apps/host/src/index.ts'), 'utf8')
assert.ok(callerSource.includes('readPrivateAccessConfiguration(privatePath)') && callerSource.includes('startAgentMuxHost({'), 'The actual startup consumes configuration outside its definition')
await writeFile(join(evidence, 'receipt.json'), JSON.stringify({ schema: 'agentmux.private-host-assembly.v1',
  checkedAt: new Date().toISOString(), source, consumedSource, behaviorCases: 7, sourceMutations: proofs,
  restoredGreen: { exitCode: restored.exitCode, behaviorCases: 7 },
  callers: ['Host index → readPrivateAccessConfiguration → startAgentMuxHost',
    'Host → original ControlServer.http route/authorize/TLS', 'Desktop ensureHost → actual Host entry with original Store namespace'],
  limitations: ['Actual private ctxmux Run, Unix owner, TLS/assets/public dispatcher and device stream; local approval uses original DeviceAuthority directly.',
    'No actual Mac confirmation dialog, phone system trust, iOS/Android build or physical device input acceptance.'],
  actualDeviceAccepted: false, fullT002Passed: false
}, null, 2) + '\n')
console.log('Private Host: 7 actual startup/TLS/healthy Run cases, 8 Source block mutants RED, restored GREEN.')
