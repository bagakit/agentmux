import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const base = resolve(root, '.bagakit/design/settings-followups-20261004/toolkit-metrics-evidence')
await mkdir(base, { recursive: true })
const evidence = await mkdtemp(resolve(base, 'run-'))
const sha = value => createHash('sha256').update(value).digest('hex')
const mode = process.argv[2]
assert.ok(['--unit','--cli','--lifecycle','--mutations','--callers'].includes(mode), 'Choose one owning verification mode')
const config = 'apps/desktop/scripts/fixtures/toolkit-metrics/vitest.config.mts'
const ownSources = ['packages/core/src/metrics.ts','packages/core/src/control.ts','packages/core/src/control-host.ts',
  'packages/core/src/agentmux.ts','packages/core/src/agentmux-cli-help.ts','apps/desktop/src/main/resource-usage-control.ts',
  'apps/desktop/src/main/process-resource-sampler.ts','apps/desktop/src/main/runtime-controller.ts','apps/desktop/src/main/ipc.ts',
  'apps/desktop/src/main/control-ipc-bridge.ts','apps/desktop/src/shared/process-usage.ts','apps/desktop/src/shared/contracts.ts',
  'apps/desktop/src/renderer/src/lib/control-api.ts','apps/desktop/src/renderer/src/lib/resource-owner-counts.ts',
  'apps/desktop/src/renderer/src/store.ts','apps/desktop/src/renderer/src/components/performance/PerformanceOverview.tsx']
const proofPaths = [config,'apps/desktop/scripts/verify-toolkit-metrics.mjs','packages/core/test/metrics-control-host.test.ts',
  'packages/core/test/metrics-cli.test.ts','apps/desktop/test/metrics-main-control.test.ts',
  'apps/desktop/test/resource-owner-counts.test.ts','apps/desktop/test/resource-usage-observability.test.tsx','vitest.setup.ts']
const inputs = {}
for (const path of [...ownSources,...proofPaths]) {
  const bytes = await readFile(resolve(root, path)); assert.ok(bytes.length > 0, `Input must be nonempty: ${path}`)
  inputs[path] = sha(bytes)
  const snapshot = resolve(evidence, 'inputs', path); await mkdir(dirname(snapshot), { recursive: true }); await writeFile(snapshot, bytes)
}
const identity = sha(JSON.stringify(Object.fromEntries(ownSources.map(path => [path,inputs[path]]))))
const results = []
if (mode === '--callers') {
  const read = async path => { const text = await readFile(resolve(root,path),'utf8'); assert.ok(text.length > 0); return text }
  const cli = await read('packages/core/src/agentmux.ts')
  const start = cli.indexOf('async function metricsCommand('), end = cli.indexOf('async function main()',start)
  assert.ok(start >= 0 && end > start, 'Metrics CLI slice must be the real nonempty function')
  const body = cli.slice(start,end); assert.ok(body.length > 0 && body.includes("'metrics.get'") && body.includes("'metrics.watch'"))
  const exports = (await read('packages/core/src/control-host.ts')).matchAll(/export (?:async )?function (\w+)\(/gu)
  const used = [...exports].map(match => match[1]).filter(name => new RegExp(`\\b${name}\\(`,'u').test(body))
  assert.equal(used.length,2,'Both actual exported Core request/stream capabilities must have external CLI callers')
  const core = await read('packages/core/src/control-host.ts'), main = await read('apps/desktop/src/main/ipc.ts')
  const helper = await read('apps/desktop/src/main/resource-usage-control.ts'), store = await read('apps/desktop/src/renderer/src/store.ts')
  const edges = [{ edge:'CLI→Core', caller:'packages/core/src/agentmux.ts', definition:'packages/core/src/control-host.ts', matches:used },
    { edge:'Core port→registered Main', caller:'apps/desktop/src/main/ipc.ts', definition:'packages/core/src/control.ts',
      matches:main.match(/new AgentMuxControlServer\(\{\s*execute: executeControl,\s*metrics,/gu) ?? [] },
    { edge:'Main owner→same sampler', caller:'apps/desktop/src/main/resource-usage-control.ts', definition:'apps/desktop/src/main/process-resource-sampler.ts',
      matches:helper.match(/args\.sampler\.subscribe\(/gu) ?? [] },
    { edge:'Main→Renderer bridge', caller:'apps/desktop/src/main/ipc.ts', definition:'apps/desktop/src/main/resource-usage-control.ts',
      matches:main.match(/observeRendererResources\(controlBridge, currentMetricsWindow, signal\)/gu) ?? [] },
    { edge:'Renderer request→shared reader', caller:'apps/desktop/src/renderer/src/store.ts', definition:'apps/desktop/src/renderer/src/lib/resource-owner-counts.ts',
      matches:store.match(/request\.operation === 'metrics\.renderer'[\s\S]{0,220}counts: readRendererResourceOwnerCounts\(\)/gu) ?? [] }]
  assert.ok(core.includes('this.control.metrics.subscribe('))
  assert.ok(edges.length > 0)
  for (const edge of edges) { assert.notEqual(edge.caller,edge.definition); assert.ok(!/test|fixture/u.test(edge.caller)); assert.ok(edge.matches.length > 0,`Nonempty external product edge: ${edge.edge}`) }
  await writeFile(resolve(evidence,'callers.json'),JSON.stringify(edges,null,2)+'\n')
  results.push({ mode, edges })
} else {
  const require = createRequire(resolve(root,'packages/core/package.json'))
  const { build } = require('esbuild')
  const aliases = new Map()
  for (const name of ['core','demand','layout']) {
    const dir = resolve(root,'packages',name), pkg = JSON.parse(await readFile(resolve(dir,'package.json'),'utf8'))
    for (const [key,value] of Object.entries(pkg.exports)) {
      const target = typeof value === 'string' ? value : value.import
      const path = resolve(dir,target.replace('./dist/src/','./src/').replace('./dist/','./src/').replace(/\.js$/u,'.ts'))
      assert.ok((await readFile(path)).length > 0); aliases.set(`@agentmux/${name}${key === '.' ? '' : key.slice(1)}`,path)
    }
  }
  async function compileCli(mutant = 'baseline') {
    const dir = resolve(evidence, mutant === 'baseline' ? 'cli' : 'help-cli')
    const cli = resolve(dir,'agentmux.mjs'); await mkdir(dir,{recursive:true})
    await symlink(resolve(root,'packages/core/node_modules'),resolve(dir,'node_modules'),'dir')
    const compiledInputs = {}, loaded = []
    await build({ entryPoints:[resolve(root,'packages/core/src/agentmux.ts')], outfile:cli, bundle:true, platform:'node',
    format:'esm', target:'node24', packages:'external', sourcemap:false, metafile:true,
    plugins:[{ name:'private-current-WT-source', setup(builder) {
      builder.onResolve({filter:/^@agentmux\//}, args => aliases.has(args.path) ? {path:aliases.get(args.path)} : undefined)
      builder.onLoad({filter:/\.(ts|json)$/}, async args => {
        if (!args.path.startsWith(root+'/packages/')) return
        const bytes = await readFile(args.path), path = relative(root,args.path)
        compiledInputs[path] = sha(bytes)
        let contents = bytes.toString()
        if (mutant === 'help' && path === 'packages/core/src/agentmux-cli-help.ts') {
          const anchor = "  ['metrics.get', METRICS_HELP],\n  ['metrics.watch', METRICS_HELP],\n"
          assert.equal(contents.split(anchor).length-1,1,'Actual built CLI help mutant requires one nonempty Source anchor')
          contents = contents.replace(anchor,'')
        }
        loaded.push({path,originalSHA256:sha(bytes),consumedSHA256:sha(contents),mutant,bytes:Buffer.byteLength(contents)})
        return {contents,loader:args.path.endsWith('.json') ? 'json' : 'ts'}
      })
    }}] })
    assert.equal(compiledInputs['packages/core/src/agentmux.ts'],inputs['packages/core/src/agentmux.ts'])
    assert.ok(Object.keys(compiledInputs).length > 0)
    await writeFile(resolve(dir,'inputs.json'),JSON.stringify(compiledInputs,null,2)+'\n')
    await writeFile(resolve(dir,'loaded-source.jsonl'),loaded.map(value=>JSON.stringify(value)+'\n').join(''))
    return {cli,compiledInputs,loaded}
  }
  const candidate = await compileCli()
  const exec = promisify(execFile)
  async function run(name,mutant='baseline',expected) {
    const output = resolve(evidence,name); await mkdir(output,{recursive:true})
    const built = mutant === 'help' ? await compileCli(mutant) : candidate
    const allFiles = proofPaths.filter(path => /\.test\.tsx?$/u.test(path))
    const files = mode === '--cli' ? ['packages/core/test/metrics-cli.test.ts','apps/desktop/test/metrics-main-control.test.ts']
      : mode === '--lifecycle' ? ['packages/core/test/metrics-control-host.test.ts','apps/desktop/test/metrics-main-control.test.ts'] : allFiles
    let exitCode=0,stdout='',stderr=''
    try { const value=await exec('pnpm',['exec','vitest','run','--config',config,...files,'--reporter=json','--outputFile',resolve(output,'vitest.json')],
      {cwd:root,env:{...process.env,pnpm_config_verify_deps_before_run:'false',AGENTMUX_METRICS_CLI:built.cli,
        AGENTMUX_METRICS_EVIDENCE:output,AGENTMUX_METRICS_MUTANT:mutant},timeout:180_000,maxBuffer:20*1024*1024}); stdout=value.stdout;stderr=value.stderr }
    catch(error) { exitCode=typeof error.code==='number'?error.code:-1;stdout=error.stdout??'';stderr=error.stderr??'' }
    await writeFile(resolve(output,'run.log'),stdout+stderr)
    const report=JSON.parse(await readFile(resolve(output,'vitest.json'),'utf8'))
    assert.ok(report.numTotalTests>0 && report.testResults.length>0,`${name}: actual collection must be nonempty`)
    for (const path of files) {
      const file = report.testResults.find(value => value.name === resolve(root,path))
      assert.ok(file && file.assertionResults.length > 0, `${name}: actual owning fixture must collect nonempty assertions: ${path}`)
    }
    const assertions=report.testResults.flatMap(file=>file.assertionResults)
    assert.ok(assertions.length>0)
    const loaded=(await readFile(resolve(output,'loaded-source.jsonl'),'utf8')).split('\n').filter(Boolean).map(JSON.parse)
    assert.ok(loaded.length>0)
    const owns=[...loaded,...built.loaded].filter(value=>ownSources.includes(value.path))
    assert.ok(owns.length>0)
    for(const value of owns) assert.equal(value.originalSHA256,inputs[value.path],`${name}: loaded Source candidate drifted`)
    let oracle=[]
    if(expected) {
      assert.notEqual(exitCode,0,`${name}: mutant stayed GREEN`)
      const failures=assertions.filter(value=>value.status==='failed' && expected.test(value.fullName))
      assert.ok(failures.length>0 && failures.some(value=>value.failureMessages.some(message=>message.includes('AssertionError'))),`${name}: specific behavior AssertionRED required`)
      assert.ok(owns.some(value=>value.consumedSHA256!==value.originalSHA256),`${name}: actual source mutation must be consumed`)
      oracle=failures.map(value=>value.fullName)
    } else { assert.equal(exitCode,0,`${name}: GREEN required; inspect ${output}/run.log`);assert.equal(report.numFailedTests,0) }
    results.push({name,mutant,exitCode,collected:report.numTotalTests,oracle,reportSHA256:sha(await readFile(resolve(output,'vitest.json'))),loadedSHA256:sha(await readFile(resolve(output,'loaded-source.jsonl'))),
      cliSHA256:sha(await readFile(built.cli)),cliLoadedSHA256:sha(await readFile(resolve(dirname(built.cli),'loaded-source.jsonl')))})
    await rm(resolve(output,'cache'),{recursive:true,force:true})
    console.log(`${name}: ${expected?'AssertionRED':'GREEN'} (${report.numTotalTests} collected)`)
  }
  await run('baseline')
  if(mode==='--mutations') {
    await run('registration','registration',/shares one nonempty sampler/u)
    await run('shared','shared',/shares one nonempty sampler/u)
    await run('get-finally','get-finally',/get finally releases/u)
    await run('establish','establish',/disposes delayed establishment/u)
    await run('identity','identity',/opening whose request identity/u)
    await run('callback-cancel','callback-cancel',/ended consumer receives no same-chunk snapshots/u)
    await run('age','age',/retains real success ages/u)
    await run('nullable','nullable',/missing Monaco getters unknown/u)
    await run('panel','panel',/unknown Monaco as neutral marks/u)
    await run('help','help',/supports actual metrics .* subcommand help/u)
    await run('restored')
  }
  results.push({cliSHA256:sha(await readFile(candidate.cli)),cliSourceInputs:candidate.compiledInputs})
}
for(const [path,hash] of Object.entries(inputs)) assert.equal(sha(await readFile(resolve(root,path))),hash,`Exact Source/proof restore; real tree must not mutate: ${path}`)
const receipt={schema:'agentmux.toolkit-metrics-source-proof.v1',completed:true,mode,sourceIdentity:identity,inputs,
  sourceWriterUsed:false,mutationsInPrivateSourceTransformsOnly:true,mutationTransforms:['Vitest','esbuild-onLoad'],evidenceDirectory:evidence,results}
await writeFile(resolve(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n')
await writeFile(resolve(base,`${mode.slice(2)}-receipt.json`),JSON.stringify(receipt,null,2)+'\n')
console.log(`receipt: ${resolve(evidence,'receipt.json')}`)
