import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, relative } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(process.env.AGENTMUX_PROTOCOL_EVIDENCE_ROOT ?? resolve(root, '.local/state/performance-protocol-boundaries-acceptance'))
mkdirSync(evidence, { recursive: true }); if (!process.argv.includes('--receipt')) rmSync(resolve(evidence, 'acceptance.json'), { force: true })
const sha = value => createHash('sha256').update(value).digest('hex')
const run = (args, env = {}) => spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', maxBuffer: 8*1024*1024, env: { ...process.env, pnpm_config_verify_deps_before_run: 'false', ...env } })
if (!process.env.AGENTMUX_PROTOCOL_SKIP_BUILD && !process.argv.includes('--receipt')) {
  const build = run(['packages/core/scripts/build.mjs']); writeFileSync(resolve(evidence, 'core-build.log'), build.stdout+build.stderr)
  assert.equal(build.signal, null); assert.equal(build.status, 0, 'Normal Core production build required')
}
const { build, transform } = createRequire(resolve(root, 'packages/core/package.json'))('esbuild')
const script = resolve(root, 'apps/desktop/resources/toolkit/performance.mjs'), frame = resolve(root, 'packages/core/src/public-rpc-frame.ts')
const scriptMutations = {
  'script-input-budget': [frame, 'export const AGENTMUX_RPC_MAX_MESSAGE_BYTES = 64 * 1024 * 1024', 'export const AGENTMUX_RPC_MAX_MESSAGE_BYTES = 256 * 1024'],
  'script-output-budget': [script, 'process.stdout.write(rpcEncode(value))', "process.stdout.write((line => { if (Buffer.byteLength(line)>256*1024) throw new Error('Mutated script frame budget'); return line })(rpcEncode(value)))"],
  'script-backpressure-reject': [script, "await once(process.stdout, 'drain', { signal: cancelled.signal })", "throw new Error('Mutated normal backpressure rejection')"],
  'script-backpressure-ignore': [script, "await once(process.stdout, 'drain', { signal: cancelled.signal })", 'void 0'],
  'script-cancel-unblock': [script, 'cancelled.abort();', '/* cancelled reader does not unblock drain */']
}
const codecMutations = ['host-test-depth','host-list-depth','refresh-depth','host-array-descriptor','settings-leaf-depth','receipt-byte-budget','host-header']
const cliSource = resolve(root, 'packages/core/src/agentmux.ts')
const cliMutations = {
  'cli-highwater-rejection': ["  stream.write(line)", "  if (!stream.write(line) && boundedReader) throw new AgentMuxError('Mutated HWM rejection', 'CONTROL_UNAVAILABLE')"],
  'cli-pending-unbounded': ['stream.writableLength + Buffer.byteLength(line) > AGENTMUX_RPC_MAX_MESSAGE_BYTES + 1', 'false'],
  'cli-exit-abandoned': ["if (outputAbandoned) process.stderr.write('', () => process.exit(process.exitCode ?? 0))", "if (false) process.stderr.write('', () => process.exit(process.exitCode ?? 0))"]
}
const ownedSources = ['apps/desktop/resources/toolkit/performance.mjs','packages/core/src/control-codec.ts','packages/core/src/agentmux.ts','packages/core/src/settings-resource-json.ts','packages/core/src/public-rpc-frame.ts']
if (process.argv.includes('--receipt')) {
  const receipt = JSON.parse(readFileSync(resolve(evidence,'acceptance.json'),'utf8'))
  assert.equal(receipt.status,'passed')
  assert.equal(receipt.results.length, 16)
  for (const row of receipt.sources) assert.equal(sha(readFileSync(resolve(root,row.path))),row.sourceSHA256,'Stale source receipt: '+row.path)
  assert.equal(sha(readFileSync(resolve(root,'packages/core/dist/agentmux.js'))),receipt.cliSHA256,'Stale CLI build')
  process.stdout.write('Source-bound acceptance receipt verified\n'); process.exit(0)
}
const results = []
for (const mutant of ['baseline', ...Object.keys(scriptMutations), ...codecMutations, ...Object.keys(cliMutations)]) {
  const folder = resolve(evidence, mutant); mkdirSync(folder, { recursive: true })
  const loaded = resolve(folder, 'loaded-source.jsonl'); rmSync(loaded, { force: true })
  const bundle = resolve(folder, 'official-performance.mjs'), change = scriptMutations[mutant]
  let mutated = false
  await build({ entryPoints: [script], outfile: bundle, bundle: true, format: 'esm', platform: 'node', target: 'node24',
    alias: { '@agentmux/core/control': resolve(root, 'packages/core/src/control.ts'), '@agentmux/core/public-rpc-http': resolve(root, 'packages/core/src/public-rpc-http.ts'), '@agentmux/demand/goals': resolve(root, 'packages/demand/src/goals.ts'), '@agentmux/demand': resolve(root, 'packages/demand/src/index.ts') },
    plugins: [{ name: 'actual-official-script-mutant', setup(builder) { builder.onLoad({ filter: /(?:performance\.mjs|public-rpc-frame\.ts)$/ }, ({ path }) => {
      const input = readFileSync(path, 'utf8'); let code = input
      if (change?.[0] === path) { assert.ok(input.includes(change[1]), 'Nonempty production mutation'); code = input.replace(change[1], change[2]); assert.notEqual(code,input); mutated = true }
      writeFileSync(loaded, JSON.stringify({ path: relative(root,path), sourceSHA256: sha(input), consumedSHA256: sha(code) })+'\n', { flag: 'a' })
      return { contents: code, loader: path.endsWith('.ts') ? 'ts' : 'js' }
    }) } }], logLevel: 'silent' })
  if (change) assert.ok(mutated, 'Actual script mutant must be consumed')
  let publicCli = resolve(root,'packages/core/bin/agentmux')
  const cliChange = cliMutations[mutant]
  if (cliChange) {
    const input = readFileSync(cliSource,'utf8'); assert.ok(input.includes(cliChange[0])); const changed = input.replace(cliChange[0],cliChange[1]); assert.notEqual(changed,input)
    const compiled = await transform(changed,{loader:'ts',target:'node24',format:'esm'})
    const leaf = 'agentmux-protocol-'+mutant+'.js'
    writeFileSync(resolve(root,'packages/core/dist',leaf),compiled.code)
    publicCli = resolve(root,'packages/core/bin','agentmux-protocol-'+mutant)
    writeFileSync(publicCli, "import '../dist/"+leaf+"'\n")
    writeFileSync(resolve(folder,'compiled-cli-mutant.js'),compiled.code)
    writeFileSync(loaded,JSON.stringify({path:'packages/core/src/agentmux.ts',sourceSHA256:sha(input),consumedSHA256:sha(changed),compiledSHA256:sha(compiled.code)})+'\n',{flag:'a'})
  }
  const output = resolve(folder, 'tests.json'); rmSync(output, { force: true })
  const test = run(['node_modules/vitest/vitest.mjs', 'run', '--config', 'apps/desktop/scripts/fixtures/performance-protocol-boundaries/vitest.config.mts', '--reporter=json', '--outputFile', output], { AGENTMUX_PROTOCOL_MUTANT: mutant, AGENTMUX_PROTOCOL_LOADED: loaded, AGENTMUX_PERFORMANCE_SCRIPT: bundle, AGENTMUX_PROTOCOL_PUBLIC_CLI: publicCli, AGENTMUX_TEST_OBJECT_CLI: publicCli })
  if (cliChange) { rmSync(publicCli); rmSync(resolve(root,'packages/core/dist','agentmux-protocol-'+mutant+'.js')) }
  writeFileSync(resolve(folder, 'run.log'), test.stdout + test.stderr)
  assert.equal(test.signal, null); assert.ok(Number.isInteger(test.status))
  const report = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(report.numPendingTests, 0); assert.equal(report.numTodoTests, 0)
  assert.equal(report.numPassedTests+report.numFailedTests, 21, 'Every behavioral assertion must run')
  const failed = report.testResults.flatMap(file=>file.assertionResults).filter(test=>test.status==='failed')
  const sources = readFileSync(loaded, 'utf8').trim().split('\n').map(line=>JSON.parse(line))
  assert.ok(sources.some(row=>row.path==='apps/desktop/resources/toolkit/performance.mjs'))
  assert.ok(sources.some(row=>row.path==='packages/core/src/control-codec.ts'))
  if (mutant === 'baseline') { assert.equal(test.status,0,'Baseline failed'); assert.equal(failed.length,0) }
  else { assert.notEqual(test.status,0,'Surviving production mutant: '+mutant); assert.ok(sources.some(row=>row.sourceSHA256!==row.consumedSHA256)); assert.ok(failed.some(test=>test.failureMessages.some(message=>message.includes('AssertionError'))),'Behavior assertion RED required: '+mutant) }
  results.push({ mutant, exitCode: test.status, passed: report.numPassedTests, failed: failed.map(test=>test.fullName), bundleSHA256: sha(readFileSync(bundle)) })
  process.stdout.write(mutant+': '+(mutant==='baseline'?'PASS':'ASSERTION_RED')+'\n')
}
const consumers = [['apps/desktop/src/main/ipc.ts','ToolkitOwner'], ['apps/desktop/src/main/toolkit-owner.ts','parseMetricsObservation('], ['packages/core/src/rpc-business-codec.ts','parseAgentMuxControlReceipt('], ['packages/core/src/public-rpc-client.ts','parseRpcControlResult(']].map(([path,symbol]) => {
  const source = readFileSync(resolve(root,path),'utf8'); assert.ok(source.includes(symbol),'External production consumer required: '+path); return { path, symbol, sourceSHA256: sha(source) }
})
const sources = ownedSources.map(path=>({path,sourceSHA256:sha(readFileSync(resolve(root,path)))}))
writeFileSync(resolve(evidence,'acceptance.json'),JSON.stringify({schema:'agentmux.performance-protocol-boundaries-acceptance.v1',status:'passed',sources,consumers,results,cliSHA256:sha(readFileSync(resolve(root,'packages/core/dist/agentmux.js'))),scope:'Actual source/script pipes and public Unix/compiled CLI; no installed GUI or original Terminal latency claim. No user Run modified.'},null,2)+'\n')
