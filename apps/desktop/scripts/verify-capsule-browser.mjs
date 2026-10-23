import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const sourceMode = process.argv.includes('--source')
const manager = 'apps/desktop/src/main/browser-view-manager.ts', preload = 'apps/desktop/src/preload/capsule.ts'
const tests = ['apps/desktop/test/capsule-browser.test.ts', 'apps/desktop/test/capsule-page-preload.test.ts',
  'packages/core/test/capsule-browser-open.test.ts', 'apps/desktop/test/capsule-browser-open-consumer.test.ts',
  'apps/desktop/test/capsule-browser-recovery.test.tsx', 'apps/desktop/test/spatial-link-ingress.test.ts']
const mutations = [
  { id: 'container-isolation-lost', file: manager,
    from: 'partition: `persist:agentmux-capsule:${saved.capsule.record.capsuleId}`', to: "partition: 'persist:default-profile'",
    assertion: 'keeps Capsule storage independent from user Profiles' },
  { id: 'isolated-sdk-exposed', file: manager,
    from: "capsule?.mode === 'injected' ? { preload:",
    to: "capsule ? { preload:", assertion: 'keeps Capsule storage independent from user Profiles' },
  { id: 'exact-main-frame-guard-lost', file: manager,
    from: 'frame !== entry.view.webContents.mainFrame || entry.committedNavigationId !== entry.navigationId ||',
    to: 'entry.committedNavigationId !== entry.navigationId ||', assertion: 'admits only the exact live committed' },
  { id: 'sdk-unrelated-pages-scan', file: manager,
    from: '    const entry = this.entriesByContents.get(sender)\n    if (!entry',
    to: '    const entry = [...this.entries.values()].find(candidate => candidate.view.webContents === sender)\n    if (!entry',
    assertion: 'admits only the exact live committed' },
  { id: 'native-commit-guard-lost', file: manager,
    from: 'frame !== entry.view.webContents.mainFrame || entry.committedNavigationId !== entry.navigationId ||',
    to: 'frame !== entry.view.webContents.mainFrame ||', assertion: 'admits only the exact live committed' },
  { id: 'durable-container-provenance-lost', file: 'apps/desktop/src/renderer/src/lib/workbench-persistence.ts',
    from: '...(surface.capsuleId ? { capsuleId: surface.capsuleId, capsuleOrigin: surface.capsuleOrigin } : {}),',
    to: '...{},', assertion: 'retains the original container through external navigation' },
  { id: 'original-open-binding-lost', file: manager,
    from: 'capsuleOpenOperationIds: [...entry.storage.capsuleOpenOperationIds],',
    to: 'capsuleOpenOperationIds: [],', assertion: 'retains the original container through external navigation' },
  { id: 'response-request-identity-lost', file: manager,
    from: 'request.id !== details.id || request.navigationId !== entry.navigationId ||',
    to: 'request.navigationId !== entry.navigationId ||', assertion: 'requires the exact main-document response' },
  { id: 'loaded-instance-provenance-lost', file: manager,
    from: 'instanceId: values[0], navigationId: entry.navigationId, frame: details.frame!',
    to: "instanceId: entry.storage.capsule.endpoint.instanceId, navigationId: entry.navigationId, frame: details.frame!",
    assertion: 'requires the exact main-document response' },
  { id: 'same-document-provenance-lost', file: manager,
    from: 'if (details.isSameDocument && entry.capsuleResponse?.navigationId === previousNavigationId)',
    to: 'if (false && entry.capsuleResponse?.navigationId === previousNavigationId)', assertion: 'requires the exact main-document response' },
  { id: 'mode-policy-refresh-lost', file: manager,
    from: 'if (storage.capsule.record.mode === inspection.record.mode)',
    to: 'if (true)', assertion: 'refreshes Capsule mode in the same Browser and partition' },
  { id: 'active-operation-reload-protection-lost', file: manager,
    from: "!['visible', 'presentation', 'document-used'].includes(reason)",
    to: "!['visible', 'presentation', 'document-used', 'operation'].includes(reason)",
    assertion: 'does not repeat an unknown native close' },
  { id: 'capsule-retry-container-lost', file: 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
    from: 'if (tab.capsuleId) return api.browser.reload(tab.browserId)', to: 'if (false) return api.browser.reload(tab.browserId)',
    assertion: 'retries the exact Capsule Browser through restore-aware reload' },
  { id: 'link-original-receipt-validation-lost', file: 'apps/desktop/src/main/spatial-link-ingress.ts',
    from: "if (result.capsuleId !== target.capsuleId || result.operationId !== operationId) throw new Error('The Capsule owner returned another object or operation.')",
    to: '', assertion: 'rejects another Capsule owner' },
  { id: 'link-original-operation-notice-lost', file: 'apps/desktop/src/main/spatial-link-ingress.ts',
    from: "if (result.rendering.status === 'unavailable') this.report?.(`Capsule opening is unconfirmed. ${result.rendering.reason} Inspect original operation ${operationId}; the page and current workface are kept.`)",
    to: '', assertion: 'reports the original Capsule operation when its actual rendering receipt is unavailable without reopening' },
  { id: 'child-frame-sdk-exposed', file: preload,
    from: 'if (process.isMainFrame) {', to: 'if (true) {', assertion: 'keeps child frames outside the SDK exposure boundary' },
  { id: 'explicit-operation-identity-lost', file: preload,
    from: 'return await call<T>(action, { ...params, operationId })',
    to: 'return await call<T>(action, { ...params, operationId: mintObjectId() })',
    assertion: 'exposes only the narrow Capsule facade and preserves explicit operation identity' },
  { id: 'implicit-request-identity-restored', file: preload,
    from: 'request: (question, draft, operationId) =>',
    to: 'request: (question, draft, operationId = mintObjectId()) =>',
    assertion: 'requires a page-owned mutation ID before IPC' },
  { id: 'implicit-draft-identity-restored', file: preload,
    from: 'saveDraft: (interactionId, expectedRevision, draft, operationId) =>',
    to: 'saveDraft: (interactionId, expectedRevision, draft, operationId = mintObjectId()) =>',
    assertion: 'requires a page-owned mutation ID before IPC' },
  { id: 'missing-operation-identity-admitted', file: preload,
    from: "if (typeof operationId !== 'string' || !operationId.trim())",
    to: 'if (false)', assertion: 'requires a page-owned mutation ID before IPC' },
  { id: 'public-capsule-identity-validation-lost', file: 'packages/core/src/control-codec.ts',
    from: '!isObjectId(source.capsuleId) || source.mode', to: 'false || source.mode',
    assertion: 'rejects malformed Capsule IDs and incompatible private creation' },
  { id: 'public-cli-capsule-field-lost', file: 'packages/core/src/agentmux-cli-commands.ts',
    from: "url: id(f, '--url'), ...fields(f, { '--capsule': 'capsuleId' }),", to: "url: id(f, '--url'),",
    assertion: 'retains the exact Capsule identity and original operation through public Browser CLI' },
  { id: 'store-capsule-container-lost', file: 'apps/desktop/src/renderer/src/store.ts',
    from: 'request.mode, undefined, request.capsuleId, request.requestId)', to: 'request.mode, undefined, undefined, request.requestId)',
    assertion: 'carries the original Capsule and open operation through the actual public Browser request' },
  { id: 'store-original-open-operation-lost', file: 'apps/desktop/src/renderer/src/store.ts',
    from: 'request.mode, undefined, request.capsuleId, request.requestId)', to: 'request.mode, undefined, request.capsuleId, mintObjectId())',
    assertion: 'carries the original Capsule and open operation through the actual public Browser request' }
]
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const directory = await mkdtemp(join(tmpdir(), 'amux-capsule-browser-proof-'))
await symlink(join(root, 'node_modules'), join(directory, 'node_modules'), 'dir')
const receipt = { schema: 'agentmux.capsule-browser-proof.v1', passed: false,
  dependencyMode: sourceMode ? 'actual-source-exports' : 'fresh-built-exports',
  boundary: 'Real Node Capsule HTTP/records feed the original BrowserViewManager and durable Workbench projection through controlled native ports. Actual page preload is loaded with a copied IPC facade; native Electron, OS restart, Host presentation, HITL and pixels require the integrated Browser gate.',
  inputs: {}, baseline: null, mutations: [] }

async function run(name, mutation) {
  const consumerTests = mutation?.file === preload ? [tests[1]] : tests
  const report = join(directory, `${name}.json`), config = join(directory, `${name}.config.mts`)
  let plugin = ''
  if (mutation) {
    const source = await readFile(join(root, mutation.file), 'utf8')
    assert.equal(source.split(mutation.from).length - 1, 1, `${mutation.id}: exact source anchor must exist once`)
    const transformed = source.replace(mutation.from, mutation.to)
    mutation.loadedSha256 = sha(transformed)
    plugin = `plugins:[{name:'capsule-browser-source-mutation',enforce:'pre',transform(code,id){if(id.split('?')[0]===${JSON.stringify(resolve(root, mutation.file))}){if(code.split(${JSON.stringify(mutation.from)}).length!==2)throw new Error('Mutation anchor unavailable');return {code:code.replace(${JSON.stringify(mutation.from)},${JSON.stringify(mutation.to)}),map:null}}}}],`
  }
  const base = sourceMode ? 'apps/desktop/test/vitest.performance-reading.config.mts' : 'vitest.config.ts'
  const capsuleAlias = sourceMode ? `resolve:{...base.resolve,alias:[{find:/^@agentmux\\/capsule$/,replacement:${JSON.stringify(join(root, 'packages/capsule/src/index.ts'))}},{find:/^@agentmux\\/host\\/(.+)$/,replacement:${JSON.stringify(join(root, 'apps/host/src/$1.ts'))}},...(base.resolve.alias??[])]},` : ''
  await writeFile(config, `import base from ${JSON.stringify(join(root, base))};export default {...base,root:${JSON.stringify(root)},${capsuleAlias}${plugin}test:{...base.test,include:${JSON.stringify(consumerTests)},maxWorkers:1,passWithNoTests:false}};\n`)
  const result = await new Promise((resolveRun, reject) => {
    const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile', report]
    if (mutation) args.push('-t', mutation.assertion)
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
    child.once('error', reject); child.once('close', code => resolveRun({ code, output }))
  })
  let data
  try { data = JSON.parse(await readFile(report, 'utf8')) }
  catch { throw new Error(`${name}: preparation failure is not semantic RED. ${result.output.slice(-4000)}`) }
  const assertions = data.testResults.flatMap(suite => suite.assertionResults)
  assert.ok(assertions.length > 0, 'Empty test coverage cannot prove this task. ' + result.output.slice(-4000))
  for (const file of consumerTests) assert.ok(data.testResults.some(suite => suite.name.endsWith(file) && suite.assertionResults.length > 0),
    'Every declared consumer suite must be collected: ' + file)
  assert.equal(data.numRuntimeErrorTestSuites ?? 0, 0, result.output.slice(-4000))
  const failures = assertions.filter(item => item.status === 'failed')
  if (mutation) {
    assert.equal(result.code, 1, result.output.slice(-4000))
    assert.ok(failures.some(item => item.fullName.includes(mutation.assertion) && item.failureMessages.some(message => message.includes('AssertionError'))),
      `${name}: designated behavior assertion must fail, not collection/preparation. ${failures.map(item => item.failureMessages.join('\n')).join('\n').slice(-3000)}`)
  } else { assert.equal(result.code, 0, result.output.slice(-4000)); assert.equal(data.numFailedTests, 0); assert.ok(data.numPassedTests > 0) }
  return { exitCode: result.code, passed: data.numPassedTests, failed: data.numFailedTests, reportSha256: sha(await readFile(report)),
    ...(mutation ? { id: mutation.id, source: mutation.file, loadedSha256: mutation.loadedSha256, assertion: mutation.assertion } : {}) }
}
try {
  for (const file of [...tests, manager, preload, 'apps/desktop/src/main/browser-cold-descriptor.ts',
    'apps/desktop/src/shared/capsule-document.ts', 'apps/desktop/src/shared/contracts.ts',
    'apps/desktop/src/renderer/src/lib/workbench-persistence.ts', 'apps/desktop/src/preload/index.ts',
    'apps/desktop/electron.vite.config.ts', 'packages/core/src/control.ts', 'packages/core/src/control-codec.ts',
    'packages/core/src/agentmux-cli-commands.ts', 'apps/desktop/src/renderer/src/store.ts',
    'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/main/spatial-link-ingress.ts',
    'apps/desktop/src/renderer/src/components/InlineObjectLink.tsx']) receipt.inputs[file] = sha(await readFile(join(root, file)))
  receipt.baseline = await run('baseline')
  const atMutation = process.argv.indexOf('--mutation')
  const documentIds = new Set(['isolated-sdk-exposed', 'exact-main-frame-guard-lost', 'native-commit-guard-lost', 'sdk-unrelated-pages-scan', 'response-request-identity-lost', 'loaded-instance-provenance-lost', 'same-document-provenance-lost', 'mode-policy-refresh-lost', 'active-operation-reload-protection-lost'])
  const entryIds = new Set(['capsule-retry-container-lost', 'link-original-receipt-validation-lost', 'link-original-operation-notice-lost'])
  const sdkIdentityIds = new Set(['explicit-operation-identity-lost', 'implicit-request-identity-restored', 'implicit-draft-identity-restored', 'missing-operation-identity-admitted'])
  const selected = mutations.filter(item => (atMutation < 0 || item.id === process.argv[atMutation + 1]) &&
    (!process.argv.includes('--document-only') || documentIds.has(item.id)) && (!process.argv.includes('--entry-only') || entryIds.has(item.id)) &&
    (!process.argv.includes('--sdk-identity-only') || sdkIdentityIds.has(item.id)))
  if (atMutation >= 0) assert.equal(selected.length, 1, 'A requested source mutation must exist exactly once')
  if (process.argv.includes('--mutations') || atMutation >= 0) for (const mutation of selected) receipt.mutations.push(await run(mutation.id, mutation))
  for (const [file, identity] of Object.entries(receipt.inputs)) assert.equal(sha(await readFile(join(root, file))), identity, 'Source changed during proof: ' + file)
  receipt.passed = true
} catch (error) {
  receipt.error = { name: error.name, message: error.message }
  throw error
} finally {
  const at = process.argv.indexOf('--output')
  if (at >= 0) assert.ok(process.argv[at + 1], '--output requires a file')
  const resultPath = at >= 0 ? resolve(process.argv[at + 1]) : join(root, '.bagakit/capsule/browser-proof.json')
  await mkdir(dirname(resultPath), { recursive: true })
  await writeFile(resultPath, JSON.stringify(receipt, null, 2) + '\n')
  await rm(directory, { recursive: true, force: true })
}
process.stdout.write(JSON.stringify(receipt) + '\n')
