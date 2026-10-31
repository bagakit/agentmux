import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { copyFile, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(root, 'packages/core/package.json'))
const { build } = require('esbuild')
const sha = value => createHash('sha256').update(value).digest('hex')
const tests = ['apps/desktop/test/capsule-browser.test.ts', 'apps/desktop/test/capsule-address-consumer.test.tsx',
  'apps/desktop/test/capsule-bookmark-open-consumer.test.ts', 'apps/desktop/test/bookmark-owner-ipc.test.ts',
  'apps/desktop/test/capsule-bookmark-placement-consumer.test.ts']
const owner = 'apps/desktop/src/main/browser-view-manager.ts'
const helper = 'apps/desktop/src/shared/browser-object-link.ts'
const codec = 'packages/core/src/control-browser-targets.ts'
const mutations = [
  { id: 'original-object-reference-lost', file: helper, suite: tests[0],
    from: "return formatAmuxObjectLink({ kind: 'capsule', capsuleId: page.capsuleId })", to: 'return undefined',
    assertion: 'derives stable object addresses from the original container' },
  { id: 'external-document-mislabelled', file: helper, suite: tests[0],
    from: 'if (new URL(page.url).origin !== page.capsuleOrigin) return undefined', to: 'if (false) return undefined',
    assertion: 'derives stable object addresses from the original container' },
  { id: 'real-document-url-replaced', file: owner, suite: tests[0],
    from: '      url,\n      ...(objectLink ? { objectLink } : {}),',
    to: '      url: objectLink ?? url,\n      ...(objectLink ? { objectLink } : {}),',
    assertion: 'derives stable object addresses from the original container' },
  { id: 'public-object-reference-dropped', file: codec, suite: tests[0],
    from: '    ...(objectLink === undefined ? {} : { objectLink }),', to: '',
    assertion: 'retains the original stable object address through actual Browser target RPC' },
  { id: 'address-bar-object-reference-lost', file: 'apps/desktop/src/renderer/src/components/BrowserPane.tsx', suite: tests[1],
    from: '      const pageAddress = tab.objectLink ?? tab.url', to: '      const pageAddress = tab.url',
    assertion: 'shows the original object address without requiring a handshake' },
  { id: 'object-address-handed-to-generic-browser', file: 'apps/desktop/src/renderer/src/components/BrowserPane.tsx', suite: tests[1],
    from: 'if (/^amux:/iu.test(target)) {', to: 'if (false) {',
    assertion: 'opens a different Capsule reference through the global object owner' },
  { id: 'bookmark-saves-internal-endpoint', file: 'apps/desktop/src/renderer/src/components/BrowserPane.tsx', suite: tests[1],
    from: 'source.objectLink ?? source.url', to: 'source.url',
    assertion: 'saves the stable object address and retains the original bookmark result' },
  { id: 'old-object-address-retained-after-navigation', file: 'apps/desktop/src/renderer/src/lib/browser-state.ts', suite: tests[1],
    from: 'objectLink: _objectLink, privateSessionEnded, ...availableSurface',
    to: 'privateSessionEnded, ...availableSurface',
    assertion: 'replaces the previous object address through actual Store events' },
  { id: 'bookmark-object-owner-bypassed', file: 'apps/desktop/src/renderer/src/store.ts', suite: tests[2],
    from: '      const browser = capsuleId\n', to: '      const browser = false\n',
    assertion: 'opens an actual saved Capsule bookmark' },
  { id: 'canonical-address-identity-mismatch-accepted', file: 'apps/desktop/src/main/capsule-presentation.ts', suite: tests[0],
    from: "if (target.kind !== 'capsule' || target.capsuleId !== input.capsuleId)", to: 'if (false)',
    assertion: 'resolves a canonical Capsule address through its original acquisition owner' },
  { id: 'object-open-result-not-awaited', file: 'apps/desktop/src/main/ipc.ts', suite: tests[3],
    from: '    const issue = await args.spatialLinks.receive(rawUrl)',
    to: '    void args.spatialLinks.receive(rawUrl)\n    const issue = null',
    assertion: 'awaits the original object owner through actual preload IPC' }
]

const at = process.argv.indexOf('--output')
await mkdir(join(root, '.tmp/capsule-address-proof'), { recursive: true })
const output = at < 0 ? await mkdtemp(join(root, '.tmp/capsule-address-proof/run-')) : resolve(root, process.argv[at + 1])
await mkdir(output, { recursive: true })
const receipt = { schema: 'agentmux.capsule-address-proof.v1', passed: false, output,
  boundary: 'Original Node Capsule HTTP and BrowserViewManager through controlled native ports, public Unix RPC and current-source compiled CLI, actual BrowserPane/address draft/bookmark consumers. Native Electron pixels and restart are separate integrated proofs.',
  inputs: {}, cli: null, productionConsumers: [], baseline: null, mutations: [] }
const publish = () => writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n')
await publish()

async function run(name, mutation) {
  const consumerTests = mutation ? [mutation.suite] : tests
  const report = join(output, name + '.tests.json'), capture = join(output, name + '.capture.json')
  const config = join(output, name + '.config.mts')
  const mutated = mutation ? (await readFile(join(root, mutation.file), 'utf8')) : null
  if (mutation) assert.equal(mutated.split(mutation.from).length - 1, 1, 'Exactly one actual production mutation anchor: ' + mutation.id)
  await writeFile(config, `import base from ${JSON.stringify(join(root, 'apps/desktop/test/capsule-settings.config.mts'))}
import {readFileSync,writeFileSync} from 'node:fs';import {relative} from 'node:path';import {createHash} from 'node:crypto'
const files=${JSON.stringify(Object.keys(receipt.inputs))},mutation=${JSON.stringify(mutation ?? null)},capture={consumed:0,loaded:{}}
const sha=value=>createHash('sha256').update(value).digest('hex')
export default {...base,cacheDir:${JSON.stringify(join(output, 'cache-' + name))},plugins:[...(base.plugins??[]),
{name:'capsule-address-actual-source',enforce:'pre',transform(input,id){const file=relative(${JSON.stringify(root)},id.split('?')[0]);
if(!files.includes(file))return
let code=input;if(mutation?.file===file){if(code.split(mutation.from).length!==2)throw new Error('Actual source mutation was not unique');code=code.replace(mutation.from,mutation.to);capture.consumed++}
capture.loaded[file]={source:sha(readFileSync(id.split('?')[0])),loaded:sha(code)};writeFileSync(${JSON.stringify(capture)},JSON.stringify(capture));return {code,map:null}}}],
test:{...base.test,include:${JSON.stringify(consumerTests)},maxWorkers:1,passWithNoTests:false}}
`)
  const args = [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', config, '--reporter=json', '--outputFile.json=' + report]
  if (mutation) args.push('-t', mutation.assertion)
  const result = await new Promise((done, fail) => {
    const child = spawn(process.execPath, args, { cwd: root,
      env: { ...process.env, AGENTMUX_TEST_OBJECT_CLI: join(output, 'cli/bin/amux'), pnpm_config_verify_deps_before_run: 'false' },
      stdio: ['ignore', 'pipe', 'pipe'] })
    let log = ''; child.stdout.on('data', part => { log += part }); child.stderr.on('data', part => { log += part })
    child.once('error', fail); child.once('close', code => done({ code, log }))
  })
  await writeFile(join(output, name + '.log'), result.log)
  let data
  try { data = JSON.parse(await readFile(report, 'utf8')) }
  catch { throw new Error(name + ': collection/preparation failure is not semantic RED. ' + result.log.slice(-5000)) }
  const assertions = data.testResults.flatMap(item => item.assertionResults)
  assert.ok(assertions.length > 0, 'Nonempty actual consumer assertions required')
  assert.equal(data.numRuntimeErrorTestSuites ?? 0, 0, result.log.slice(-5000))
  const captured = JSON.parse(await readFile(capture, 'utf8'))
  if (mutation) {
    assert.ok(captured.consumed > 0, 'The designated actual production mutant must be consumed')
    assert.equal(result.code, 1, result.log.slice(-5000))
    assert.ok(assertions.some(item => item.status === 'failed' && item.fullName.includes(mutation.assertion) &&
      item.failureMessages.some(message => message.includes('AssertionError'))), name + ': designated behavior must fail. ' + result.log.slice(-5000))
  } else {
    for (const file of tests) assert.ok(data.testResults.some(suite => suite.name.endsWith(file) && suite.assertionResults.length > 0), 'Nonempty original consumer suite: ' + file)
    assert.equal(result.code, 0, result.log.slice(-6000)); assert.equal(data.numFailedTests, 0); assert.ok(data.numPassedTests > 0)
  }
  return { name, exitCode: result.code, passed: data.numPassedTests, failed: data.numFailedTests,
    reportSha256: sha(await readFile(report)), loaded: captured.loaded,
    ...(mutation ? { file: mutation.file, consumed: captured.consumed, assertion: mutation.assertion,
      loadedSha256: sha(mutated.replace(mutation.from, mutation.to)) } : {}) }
}

try {
  const files = [...tests, owner, helper, codec, 'packages/core/src/browser-targets.ts',
    'apps/desktop/src/main/browser-cold-descriptor.ts', 'apps/desktop/src/main/capsule-presentation.ts', 'apps/desktop/src/shared/contracts.ts',
    'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src/lib/workbench-persistence.ts',
    'apps/desktop/src/renderer/src/lib/browser-state.ts',
    'apps/desktop/src/renderer/src/store.ts', 'apps/desktop/src/main/ipc.ts',
    'apps/desktop/src/main/spatial-link-ingress.ts', 'apps/desktop/scripts/verify-capsule-address.mjs']
  for (const file of files) receipt.inputs[file] = sha(await readFile(join(root, file)))
  const cli = join(output, 'cli')
  await mkdir(join(cli, 'bin'), { recursive: true }); await mkdir(join(cli, 'dist'), { recursive: true })
  await writeFile(join(cli, 'package.json'), '{"type":"module"}\n')
  await copyFile(join(root, 'packages/core/bin/amux'), join(cli, 'bin/amux'))
  await symlink(join(root, 'packages/core/node_modules'), join(cli, 'node_modules'), 'dir')
  const compiled = await build({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: join(cli, 'dist/agentmux.js'),
    bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external', metafile: true,
    banner: { js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);" } })
  receipt.cli = { sha256: sha(await readFile(join(cli, 'dist/agentmux.js'))), inputs: {} }
  for (const file of Object.keys(compiled.metafile.inputs)) receipt.cli.inputs[file] = sha(await readFile(resolve(root, file)))
  for (const [symbol, definition, directory] of [
    ['browserObjectLink', helper, 'apps/desktop/src'],
    ['parseBrowserTargetsResult', codec, 'packages/core/src'],
    ['BrowserPane', 'apps/desktop/src/renderer/src/components/BrowserPane.tsx', 'apps/desktop/src/renderer/src']
  ]) {
    const matches = execFileSync('rg', ['-n', '-w', symbol, directory, '-g', '*.ts', '-g', '*.tsx'], { cwd: root, encoding: 'utf8' })
      .trim().split('\n').filter(line => !line.startsWith(definition + ':'))
    assert.ok(matches.length > 0, 'Definition-excluded product consumers: ' + symbol)
    receipt.productionConsumers.push({ symbol, definition, matches })
  }
  receipt.baseline = await run('baseline')
  for (const mutation of mutations) receipt.mutations.push(await run(mutation.id, mutation))
  for (const file of Object.keys(receipt.inputs)) assert.equal(sha(await readFile(join(root, file))), receipt.inputs[file], 'Input changed during proof: ' + file)
  receipt.passed = true
} finally { await publish() }
process.stdout.write(JSON.stringify({ passed: receipt.passed, receipt: join(output, 'receipt.json'), tests: receipt.baseline?.passed, mutations: receipt.mutations.length }) + '\n')
