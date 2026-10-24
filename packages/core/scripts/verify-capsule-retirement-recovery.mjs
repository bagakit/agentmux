import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const require = createRequire(join(root, 'packages/core/package.json')), { build } = require('esbuild')
const sha = x => createHash('sha256').update(x).digest('hex'), provisional = process.argv.includes('--provisional')
const owner = 'packages/core/src/capsule-run-manager.ts', codec = 'packages/core/src/capsule-runtime.ts', adapter = 'packages/core/src/ctxmux-run-adapter.ts'
const files = [owner, codec, adapter, 'packages/core/src/client.ts', 'packages/core/src/terminal-creation-retirement.ts', 'packages/core/src/hosted-client-contract.ts',
  'packages/core/src/capsule-cli.ts', 'packages/core/src/terminal-preparation.ts', 'packages/core/src/agentmux.ts', 'packages/core/test/capsule-retirement-recovery.test.ts',
  ...(!provisional ? ['packages/core/test/capsule-retirement-native.test.ts'] : []), 'packages/core/test/helpers/capsule-recovery-fixture.ts', 'packages/core/scripts/verify-capsule-retirement-recovery.mjs']
const sources = Object.fromEntries(await Promise.all(files.map(async path => [path, await readFile(join(root, path), 'utf8')])))
// The client is shared with unrelated Agent creation work. Bind the actually consumed terminal API slice.
function boundSource(file, text) {
  if (file !== 'packages/core/src/client.ts') return text
  const start = text.indexOf('  terminalCreationRuntimeIdentity(): '), end = text.indexOf('  async attachTerminal(', start)
  assert.ok(start >= 0 && end > start, 'The exact public terminal retirement API must exist')
  return text.slice(start, end)
}
const mutations = [
  { id: 'foreign-target-accepted', file: owner, from: 'command.params.expectedRevision !== target.revision || !this.matchesRecoveryBinding(b, target)', to: 'false',
    test: 'refuses every foreign recovery target', failure: 'Foreign target must be refused before Native retirement' },
  { id: 'fresh-id-repeats-retirement', file: owner, from: "if (previous?.recovery?.phase !== 'not_applied') throw", to: 'if (false) throw',
    test: 'continues only the original retirement intent after unknown', failure: 'A fresh command ID cannot repeat the original retirement' },
  { id: 'original-retirement-never-redriven', file: owner, from: 'await retireOriginal()\n            }', to: "throw unavailable('Original retirement remains unknown')\n            }",
    test: 'continues the exact durable retirement intent after a crash', failure: 'A durable predispatch intent must retain a reachable explicit continuation' },
  { id: 'retirement-durability-skipped', file: owner, from: 'await this.confirmDurable(path)\n      if (record.recovery.phase', to: 'void path\n      if (record.recovery.phase',
    test: 'requires receipt file and directory reconfirmation', failure: 'Receipt durability must gate the fresh launch' },
  { id: 'original-history-rewritten', file: owner, from: "if (record.recovery.phase === 'retired') {\n        b.run = null", to: "if (record.recovery.phase === 'retired') {\n        await this.retainReceipt(target.managementOperationId, 'not_applied', {code:'MUTANT',message:'Old unknown rewritten'})\n        b.run = null",
    test: 'recovers only after a durable exact retirement', failure: 'Old unknown history must remain unchanged' },
  { id: 'inspection-writes-binding', file: owner, from: 'if (record?.recovery) observed.recovery = structuredClone(record.recovery)', to: 'if (b) await this.save(b); if (record?.recovery) observed.recovery = structuredClone(record.recovery)',
    test: 'continues only the original retirement intent after unknown', failure: 'Inspection cannot dispatch or save lifecycle work' },
  { id: 'uncalled-retirement-lost', file: owner, from: "const phase = invoked ? 'unknown' : 'not_applied'", to: "const phase = 'unknown'",
    test: 'retains a live uncalled retirement refusal', failure: 'A live owner must preserve its exact uncalled retirement fact' },
  { id: 'foreign-receipt-runtime-accepted', file: codec, from: 'if (runtime.runtimeId !== target.runtime.runtimeId)', to: 'if (false)',
    test: 'refuses a valid-shaped durable retirement receipt', failure: 'Foreign durable runtime receipt must not authorize a successor' },
  { id: 'retained-native-launch-unchecked', file: adapter, from: 'if (!isDeepStrictEqual(retirement.run.spec, request))', to: 'if (false)',
    test: 'recovers through actual private Native', failure: 'Retained full launch mismatch must refuse only this operation', native: true },
]
for (const m of mutations) assert.equal(sources[m.file].split(m.from).length - 1, 1, 'Unique loaded source mutation: ' + m.id)
const nativePath = process.env.CAPSULE_RETIREMENT_NATIVE ?? join(root, 'packages/core/vendor/ctxmux', process.platform + '-' + process.arch, 'bin/ctxmuxd')
const nativeHash = provisional ? null : sha(await readFile(nativePath))
const sdkRoot = dirname(fileURLToPath(import.meta.resolve('@ctxmux/sdk')))
const sdkInputs = Object.fromEntries(await Promise.all(['client.js', 'control.js', 'generated/RuntimeIdentity.d.ts'].map(async file => [file, sha(await readFile(join(sdkRoot, file)))])))
const receipt = { schema: 'agentmux.capsule-retirement-recovery-proof.v1', passed: false, provisional,
  boundary: provisional ? 'Preparation only: controlled Native results, actual Core manager/Unix RPC/source compiled CLI. No actual Native qualification.' : 'Actual private persistent Native daemon/SDK, source Core Adapter/client/manager, Unix RPC and source compiled CLI; controlled response/storage loss plus actual retirement/retained fence, another healthy Run and manager churn. No user Runtime is contacted.',
  inputs: Object.fromEntries(Object.entries(sources).map(([file, text]) => [file, { sha256: sha(boundSource(file, text)), scope: file === 'packages/core/src/client.ts' ? 'terminalCreationRuntimeIdentity through observePreparedTerminalCreationRetirement' : 'complete file' }])), sdkInputs, nativePath, nativeSha256: nativeHash, runs: [] }
function qualifyRun(name, mutation, code, result, facts, log) {
    const assertions = result.testResults.flatMap(x=>x.assertionResults).filter(x=>!['pending','skipped'].includes(x.status))
    assert.ok(assertions.length > 0,'Actual nonempty assertions: '+name)
    assert.equal(result.numRuntimeErrorTestSuites ?? 0,0,'Collection/setup failure cannot qualify: '+name)
    assert.doesNotMatch(log,/Unhandled Rejection|Unhandled Errors|Uncaught Exception/u,'Unhandled failure cannot qualify: '+name)
    for (const suite of result.testResults) { assert.equal(suite.message ?? '','','Suite setup failure: '+name); if(suite.status==='failed')assert.ok(suite.assertionResults.some(x=>x.status==='failed'),'Real failed assertion required: '+name) }
    if (!mutation) {
      assert.equal(code,0,log.slice(-7000)); assert.equal(result.numFailedTests,0); assert.equal(result.numPassedTests,provisional ? 12 : 13)
      assert.equal(assertions.length,provisional ? 12 : 13,'Complete approved collection required')
      const expected = ['packages/core/test/capsule-retirement-recovery.test.ts', ...(!provisional ? ['packages/core/test/capsule-retirement-native.test.ts'] : [])].map(path => resolve(root,path)).sort()
      assert.deepEqual(result.testResults.map(suite => resolve(suite.name)).sort(),expected,'Exact production consumer suites required')
      for (const suite of result.testResults) assert.ok(suite.assertionResults.some(item => item.status === 'passed'),'Every baseline consumer must run assertions')
      for (const file of [owner,codec,adapter,'packages/core/src/client.ts']) { assert.equal(facts.bound[file],sha(boundSource(file,sources[file]))); assert.ok(facts.compiled[file]) }
    } else {
      assert.equal(code,1,'Actual business failure required: '+name)
      assert.ok(facts.consumed>0 && facts.compiled[mutation.file]); assert.equal(facts.loaded[mutation.file],sha(sources[mutation.file].replace(mutation.from,mutation.to)))
      assert.ok(assertions.some(x=>x.status==='failed'&&x.fullName.includes(mutation.test)&&x.failureMessages.some(y=>y.includes('AssertionError')&&y.includes(mutation.failure))),'Designated semantic assertion must fail: '+name+'\n'+log.slice(-3000))
    }
}

const latestReceipt = join(root, '.bagakit/capsule/takeover/retirement-proof-latest.json')
async function qualifiedPrevious() {
  if (provisional || process.argv.includes('--fresh')) return null
  try {
    const pointer = JSON.parse(await readFile(latestReceipt, 'utf8'))
    assert.ok(typeof pointer.directory === 'string' && pointer.directory.startsWith(join(root, '.tmp/capsule-retirement-')))
    const bytes = await readFile(join(pointer.directory, 'receipt.json')), previous = JSON.parse(bytes)
    assert.equal(sha(bytes), pointer.sha256)
    assert.equal(previous.schema, receipt.schema); assert.equal(previous.passed, true); assert.equal(previous.provisional, false)
    assert.deepEqual(previous.inputs, receipt.inputs); assert.deepEqual(previous.sdkInputs, sdkInputs); assert.equal(previous.nativeSha256, nativeHash)
    assert.equal(sha(await readFile(join(pointer.directory, 'amux.mjs'))), previous.cliSha256)
    const required = [null, ...(process.argv.includes('--mutations') ? mutations : [])]
    for (const mutation of required) {
      const name = mutation?.id ?? 'baseline', rows = previous.runs.filter(x => x.name === name)
      assert.equal(rows.length, 1)
      const row = rows[0], report = await readFile(join(pointer.directory, name + '.json')), capture = await readFile(join(pointer.directory, name + '.loaded.json')), log = await readFile(join(pointer.directory, name + '.log'), 'utf8')
      assert.equal(sha(report), row.reportSha256); assert.equal(sha(capture), row.captureSha256); assert.equal(sha(log), row.logSha256)
      qualifyRun(name, mutation, row.code, JSON.parse(report), JSON.parse(capture), log)
    }
    return { passed: true, reused: true, output: pointer.directory, mutations: required.length - 1 }
  } catch (error) { if (error.code !== 'ENOENT') process.stdout.write('Prior receipt needs current qualification: ' + error.message.split('\n')[0] + '\n'); return null }
}
const previous = await qualifiedPrevious()
if (previous) { process.stdout.write(JSON.stringify(previous) + '\n'); process.exit(0) }
await mkdir(join(root, '.tmp'), { recursive: true })
const output = await mkdtemp(join(root, '.tmp/capsule-retirement-')), cli = join(output, 'amux.mjs')
await symlink(join(root, 'packages/core/node_modules'), join(output, 'node_modules'), 'dir')
try {
  await build({ entryPoints: [join(root, 'packages/core/src/agentmux.ts')], outfile: cli, bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external',
    banner: { js: "import {createRequire as __createRequire} from 'node:module';const require=__createRequire(import.meta.url);" } })
  receipt.cliSha256 = sha(await readFile(cli))
  async function run(mutation) {
    const name = mutation?.id ?? 'baseline', config = join(output, name + '.config.mts'), report = join(output, name + '.json'), capture = join(output, name + '.loaded.json')
    const tests = ['packages/core/test/capsule-retirement-recovery.test.ts', ...(!provisional ? ['packages/core/test/capsule-retirement-native.test.ts'] : [])]
    await writeFile(config, `import{writeFileSync}from'node:fs';import{createHash}from'node:crypto';import{relative}from'node:path';
const mutation=${JSON.stringify(mutation ?? null)},sources=${JSON.stringify([owner,codec,adapter,'packages/core/src/client.ts'])},loaded={},bound={},compiled={};let consumed=0;
const hash=x=>createHash('sha256').update(x).digest('hex');const scope=(file,text)=>file==='packages/core/src/client.ts'?text.slice(text.indexOf('  terminalCreationRuntimeIdentity(): '),text.indexOf('  async attachTerminal(',text.indexOf('  terminalCreationRuntimeIdentity(): '))):text;const save=()=>writeFileSync(${JSON.stringify(capture)},JSON.stringify({loaded,bound,compiled,consumed}));
export default {root:${JSON.stringify(root)},cacheDir:${JSON.stringify(join(output,'cache-'+name))},test:{include:${JSON.stringify(tests)},passWithNoTests:false,maxWorkers:1,testTimeout:45000},plugins:[
{name:'retirement-loaded-source',enforce:'pre',transform(code,id){const file=relative(${JSON.stringify(root)},id.split('?')[0]);if(!sources.includes(file))return;let next=code;if(mutation?.file===file){if(code.split(mutation.from).length!==2)throw new Error('Mutation anchor unavailable');next=code.replace(mutation.from,mutation.to);consumed++}loaded[file]=hash(next);bound[file]=hash(scope(file,next));save();return{code:next,map:null}}},
{name:'retirement-compiled-source',enforce:'post',transform(code,id){const file=relative(${JSON.stringify(root)},id.split('?')[0]);if(sources.includes(file)){compiled[file]=hash(code);save()}}}]};`)
    const logs = [], args = [join(root,'node_modules/vitest/vitest.mjs'),'run','--config',config,'--reporter=json','--outputFile.json='+report]
    if (mutation) args.push('-t',mutation.test)
    const code = await new Promise((yes,no) => { const child = spawn(process.execPath,args,{cwd:root,env:{...process.env,CAPSULE_RETIREMENT_CLI:cli,CAPSULE_RETIREMENT_NATIVE:nativePath},stdio:['ignore','pipe','pipe']}); child.stdout.on('data',x=>logs.push(x)); child.stderr.on('data',x=>logs.push(x)); child.on('error',no); child.on('close',yes) })
    const log = Buffer.concat(logs).toString(); await writeFile(join(output,name+'.log'),log)
    const result = JSON.parse(await readFile(report,'utf8')), facts = JSON.parse(await readFile(capture,'utf8'))
    qualifyRun(name, mutation, code, result, facts, log)
    receipt.runs.push({name,code,passed:result.numPassedTests,failed:result.numFailedTests,capture:facts,reportSha256:sha(await readFile(report)),captureSha256:sha(await readFile(capture)),logSha256:sha(log)}); process.stdout.write(JSON.stringify({name,code,passed:result.numPassedTests,failed:result.numFailedTests})+'\n')
  }
  await run()
  if (process.argv.includes('--mutations')) for (const mutation of mutations) if (!provisional || !mutation.native) await run(mutation)
  // Verify only the actual owned consumer inputs. Unrelated shared-tree edits do not invalidate this receipt.
  for (const [file,text] of Object.entries(sources)) assert.equal(sha(boundSource(file,await readFile(join(root,file),'utf8'))),sha(boundSource(file,text)),'Owned consumer source changed during proof: '+file)
  for (const [file,hash] of Object.entries(sdkInputs)) assert.equal(sha(await readFile(join(sdkRoot,file))),hash,'Actual SDK changed during proof: '+file)
  if (!provisional) assert.equal(sha(await readFile(nativePath)),nativeHash,'Actual Native changed during proof')
  receipt.passed = !provisional
  process.stdout.write(JSON.stringify({passed:receipt.passed,provisional,output,mutations:receipt.runs.length-1})+'\n')
} catch (error) { receipt.error = { message:error.message }; throw error }
finally {
  const bytes = JSON.stringify(receipt,null,2)+'\n'
  await writeFile(join(output,'receipt.json'),bytes)
  if (receipt.passed) { await mkdir(dirname(latestReceipt),{recursive:true}); await writeFile(latestReceipt,JSON.stringify({directory:output,sha256:sha(bytes)})+'\n') }
  for (const name of await readdir(output)) if (name==='node_modules'||name.endsWith('.config.mts')||name.startsWith('cache-')) await rm(join(output,name),{recursive:true,force:true})
}
