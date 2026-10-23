import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const test = 'apps/desktop/test/capsule-client.test.ts'
const mutations = [
  { id: 'sender-guard-lost', file: 'apps/desktop/src/main/ipc.ts', raw: true,
    from: "    requireTrustedSender('capsules:call', event)", to: '    void event',
    assertion: 'rejects untrusted App senders before any Host call' },
  { id: 'original-host-delegation-lost', file: 'apps/desktop/src/main/capsule-ipc.ts',
    from: "const result = await callOriginalCore<CapsuleMethod>('local', capsuleMethod, params, {\n    transport: 'unix', principal: { kind: 'user', id: `local-user:${process.getuid?.() ?? 'current'}` }\n  })",
    to: ("const result = {config:{revision:1,contentRoot:'" + new URL('file:///').pathname + "fixture/capsules',defaultStorageMode:'managed',defaultMode:'isolated',defaultTheme:'follow'}}"),
    assertion: 'delegates each original Capsule call to the exact original Host once' },
  { id: 'preload-failure-unwrapping-lost', file: 'apps/desktop/src/preload/index.ts',
    from: "capsules: { call: async (method, params) => unwrapSessionInputOperationResult(await ipcRenderer.invoke('capsules:call', method, params)) }",
    to: "capsules: { call: async (method, params) => await ipcRenderer.invoke('capsules:call', method, params) }",
    assertion: 'preserves unknown operation errors through copied preload envelopes without replay' }
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-client-proof-'))
await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
const receipt = { schema: 'agentmux.capsule-client-proof.v1', passed: false,
  boundary: 'Actual Renderer/preload and extracted registered Main IPC handler consume strict Capsule adapter through real Unix RPC/Node owner. Electron transport serialization is modeled by DTO cloning; Browser presentation and trusted human submission are separate tasks.',
  inputs: {}, baseline: null, preview: null, mutations: [] }

async function run(name, mutation, preview = false) {
  const report = join(directory, `${name}.json`), config = join(directory, `${name}.config.mts`)
  let plugin = '', sourceOverride
  if (mutation) {
    const source = await readFile(join(root, mutation.file), 'utf8')
    assert.equal(source.split(mutation.from).length - 1, 1, `${mutation.id}: exact source anchor must exist once`)
    const transformed = source.replace(mutation.from, mutation.to)
    receipt.inputs[mutation.file] = sha(source); mutation.loadedSha256 = sha(transformed)
    if (mutation.raw) { sourceOverride = join(directory, 'ipc-mutant.ts'); await writeFile(sourceOverride, transformed) }
    else plugin = `plugins:[{name:'capsule-client-source-mutation',enforce:'pre',transform(code,id){if(id.split('?')[0]===${JSON.stringify(resolve(root, mutation.file))}){if(code.split(${JSON.stringify(mutation.from)}).length!==2)throw new Error('Mutation anchor unavailable');return {code:code.replace(${JSON.stringify(mutation.from)},${JSON.stringify(mutation.to)}),map:null}}}}],`
  }
  const include = preview ? 'apps/desktop/test/capsule-client-preview.test.ts' : test
  await writeFile(config, `import base from ${JSON.stringify(join(root, 'vitest.config.ts'))};export default {...base,root:${JSON.stringify(root)},define:{...base.define,__AGENTMUX_WEB_PREVIEW__:${JSON.stringify(preview ? 'true' : 'false')}},${plugin}test:{...base.test,include:[${JSON.stringify(include)}],maxWorkers:1,passWithNoTests:false}};\n`)
  const result = await new Promise((resolveRun, reject) => {
    const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', report]
    if (mutation) args.push('-t', mutation.assertion)
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env,
      ...(sourceOverride ? { CAPSULE_CLIENT_IPC_SOURCE: sourceOverride } : {}), pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject); child.once('close', code => resolveRun({ code, output }))
  })
  let data
  try { data = JSON.parse(await readFile(report, 'utf8')) }
  catch { throw new Error(`${name}: preparation failure is not semantic RED. ${result.output.slice(-4000)}`) }
  const assertions = data.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(assertions.length > 0, 'Empty test coverage cannot prove this task')
  assert.equal(data.numRuntimeErrorTestSuites ?? 0, 0, result.output.slice(-4000))
  const failures = assertions.filter(item => item.status === 'failed')
  if (mutation) {
    assert.equal(result.code, 1, result.output.slice(-4000))
    assert.ok(failures.some(item => item.fullName.includes(mutation.assertion) && item.failureMessages.some(message => message.includes('AssertionError'))),
      `${name}: designated behavior assertion must fail, not collection/preparation`)
  } else { assert.equal(result.code, 0, result.output.slice(-4000)); assert.equal(data.numFailedTests, 0); assert.ok(data.numPassedTests > 0) }
  return { exitCode: result.code, passed: data.numPassedTests, failed: data.numFailedTests, reportSha256: sha(await readFile(report)),
    ...(mutation ? { id: mutation.id, source: mutation.file, loadedSha256: mutation.loadedSha256, assertion: mutation.assertion } : {}) }
}
try {
  for (const file of [test, 'apps/desktop/src/shared/contracts.ts', 'apps/desktop/src/main/capsule-ipc.ts', 'apps/desktop/src/main/ipc.ts',
    'apps/desktop/src/main/ipc-sender-trust.ts', 'apps/desktop/src/preload/index.ts', 'apps/desktop/src/renderer/src/lib/api.ts']) receipt.inputs[file] = sha(await readFile(join(root, file)))
  receipt.baseline = await run('baseline'); receipt.preview = await run('preview', undefined, true)
  if (process.argv.includes('--mutations')) for (const mutation of mutations) receipt.mutations.push(await run(mutation.id, mutation))
  receipt.passed = true
} finally {
  const at = process.argv.indexOf('--output')
  if (at >= 0) { assert.ok(process.argv[at + 1], '--output requires a file'); await writeFile(resolve(process.argv[at + 1]), JSON.stringify(receipt, null, 2) + '\n') }
  await rm(directory, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify(receipt) + '\n')
