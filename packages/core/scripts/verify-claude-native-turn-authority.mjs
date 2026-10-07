import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root = resolve(import.meta.dirname, '../../..')
const evidence = resolve(root, process.env.AGENTMUX_ACTIVITY_EVIDENCE_DIRECTORY ?? '.local/claude-native-activity')
await mkdir(evidence, {recursive:true})
const sources = ['client.ts','hook-normalizer.ts','agent-status-freshness.ts','agent-session-identity.ts','rpc-native-codec.ts',
  'types.ts','providers/claude.ts','providers/claude-native-activity.ts'].map(name=>'packages/core/src/'+name)
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const fingerprints = async () => Object.fromEntries(await Promise.all(sources.map(async file=>[file,hash(await readFile(join(root,file)))])))
const before = await fingerprints()
const run = (args, env = {}) => spawnSync(process.execPath,args,{cwd:root,env:{...process.env,...env},encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024})
const build = run(['packages/core/scripts/build.mjs'])
await writeFile(join(evidence,'build.log'),build.stdout+build.stderr);assert.equal(build.status,0,'Core build must pass')
const tests = async mutation => {
  const label = mutation ?? 'baseline', report = join(evidence,label+'.json'), loaded = join(evidence,label+'-source.jsonl')
  await writeFile(loaded,'')
  const result = run(['node_modules/vitest/vitest.mjs','run','--config','packages/core/test/fixtures/claude-native-activity/vitest.config.mts',
    '--reporter=json','--outputFile',report], {AGENTMUX_ACTIVITY_MUTATION:mutation ?? '',AGENTMUX_ACTIVITY_MUTATION_RECEIPT:loaded})
  await writeFile(join(evidence,label+'.log'),result.stdout+result.stderr)
  const actual = JSON.parse(await readFile(report,'utf8'))
  assert.ok(actual.numTotalTests>=17 && actual.numTotalTestSuites>=2,'Actual nonempty owning collection required')
  const failed = actual.testResults.flatMap(file=>file.assertionResults).filter(test=>test.status==='failed')
  if (mutation) {
    const changed = (await readFile(loaded,'utf8')).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line))
    assert.ok(changed.length>0 && changed.every(item=>item.original===before[item.path] && item.original!==item.loaded))
    assert.ok(result.status!==0 && failed.some(test=>test.failureMessages.some(message=>/AssertionError|expected /u.test(message))),'Real behavior must fail after source mutation')
    return {mutation,result:'assertion-red',failed:failed.map(test=>test.fullName),changed}
  }
  assert.equal(result.status,0,result.stdout+result.stderr);assert.equal(actual.numFailedTests,0)
  return {result:'green',tests:actual.numPassedTests}
}
const baseline = await tests();console.log(JSON.stringify({baseline}))
const mutations=[]
for(const name of ['main-turn','child-turn','projection']){mutations.push(await tests(name));console.log(JSON.stringify({mutation:name,result:'assertion-red'}))}
const restored = await tests()
const callers = {}
for(const symbol of ['projectCurrentActivity(', 'agentHasActiveSubagents(', 'claudeNativeActivity(', 'currentActivity: session.currentActivity']){
  const result=spawnSync('rg',['-n','--fixed-strings',symbol,'packages/core/src','apps/desktop/src'],{cwd:root,encoding:'utf8'})
  assert.equal(result.status,0);const hits=result.stdout.trim().split('\n').filter(line=>!line.includes('function '+symbol)&&!line.includes('private '+symbol))
  assert.ok(hits.length>0,'Nonempty product consumers required');callers[symbol]=hits
}
assert.deepEqual(await fingerprints(),before,'Source changed during candidate verification')
await writeFile(join(evidence,'qualification.json'),JSON.stringify({passed:true,inputs:before,baseline,mutations,restored,callers,
  boundary:'Current source/Core/Store/public service and compiled CLI; native process, visual review and installed identity require their separate receipts.'},null,2)+'\n')
console.log(JSON.stringify({passed:true,evidence}))
