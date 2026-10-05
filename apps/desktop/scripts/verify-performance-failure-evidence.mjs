import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statfsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
const root=resolve(import.meta.dirname,'../../..')
const evidence=resolve(process.env.AGENTMUX_PERFORMANCE_FAILURE_EVIDENCE_ROOT??resolve(root,'.local/state/performance-failure-acceptance'))
mkdirSync(evidence,{recursive:true})
const sha=bytes=>createHash('sha256').update(bytes).digest('hex')
const stat=statfsSync(root),availableBytes=stat.bavail*stat.bsize
if(availableBytes<1610612736){
 writeFileSync(resolve(evidence,'resource-hold.json'),JSON.stringify({schema:'agentmux.performance-failure-resource-hold.v1',availableBytes,minimumBytes:1610612736,action:'normal Core build/Desktop types and full source qualification',reason:'This heavy diagnostic proof only; no user capability is gated.'},null,2)+'\n')
 process.stderr.write('Heavy source qualification held: available disk below1536MiB. No build or product attempt dispatched.\n');process.exit(2)
}
const run=(command,args,env={})=>spawnSync(command,args,{cwd:root,encoding:'utf8',maxBuffer:8*1024*1024,env:{...process.env,pnpm_config_verify_deps_before_run:'',...env}})
for(const [name,command,args] of [
 ['demand-build','pnpm',['--filter','@agentmux/demand','build']],
 ['core-build',process.execPath,['packages/core/scripts/build.mjs']],
 ['desktop-source-types','pnpm',['--filter','@agentmux/desktop','typecheck']]
]){
 const result=run(command,args);writeFileSync(resolve(evidence,name+'.log'),result.stdout+result.stderr)
 assert.equal(result.signal,null,'Proof process interrupted: '+name);assert.equal(result.status,0,'Normal source check failed: '+name)
}
assert.ok(existsSync(resolve(root,'packages/core/dist/agentmux.js')),'Normal compiled public CLI required')
const mutants=['capture-opt-in','origin-stage','original-run','durable-ack','clip-range','failure-byte-budget','codec-range','public-option','reader-dispose','safe-read','issue-safe-read','stack-opt-in','bounded-pending','event-stage','original-code','write-phase'],results=[]
for(const mutant of ['baseline',...mutants]){
 const folder=resolve(evidence,mutant);mkdirSync(folder,{recursive:true});writeFileSync(resolve(folder,'loaded-source.jsonl'),'')
 const output=resolve(folder,'tests.json'),result=run(process.execPath,['node_modules/vitest/vitest.mjs','run','--config','apps/desktop/scripts/fixtures/performance-failure-evidence/vitest.config.mts','--reporter=json','--outputFile',output],{AGENTMUX_PERFORMANCE_FAILURE_MUTANT:mutant,AGENTMUX_PERFORMANCE_FAILURE_EVIDENCE:folder,AGENTMUX_PERFORMANCE_FAILURE_FORMAL_CLI:'1'})
 writeFileSync(resolve(folder,'run.log'),result.stdout+result.stderr);assert.equal(result.signal,null,'Proof process interrupted: '+mutant)
 assert.ok(existsSync(output),'Missing real test receipt');const report=JSON.parse(readFileSync(output,'utf8'))
 assert.equal(report.numTotalTests,40,'Exact nonempty suites including compiled CLI required');assert.equal(report.numPendingTests,0);assert.equal(report.numTodoTests,0)
 const failed=report.testResults.flatMap(file=>file.assertionResults).filter(test=>test.status==='failed')
 const loaded=readFileSync(resolve(folder,'loaded-source.jsonl'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
 assert.ok(loaded.some(row=>row.path==='apps/desktop/src/main/toolkit-owner.ts'),'Actual original Owner must execute')
 if(mutant==='baseline'){assert.equal(result.status,0);assert.equal(report.numPassedTests,40);assert.equal(failed.length,0)}
 else{assert.notEqual(result.status,0);assert.ok(loaded.some(row=>row.sourceSHA256!==row.consumedSHA256),'Nonempty actual production mutation');assert.ok(failed.some(test=>test.failureMessages.some(message=>message.includes('AssertionError'))),'Actual behavior assertion must kill mutant')}
 results.push({mutant,exitCode:result.status,tests:report.numTotalTests,failed:failed.map(test=>test.fullName)})
}
const callers=[['packages/core/src/public-rpc-service.ts','this.ports.toolkit.subscribe('],['packages/core/src/public-rpc-client.ts','parseToolkitSnapshot('],['apps/desktop/src/main/toolkit-owner.ts','parseToolkitPerformanceFailureDetails('],['packages/core/src/agentmux-cli-commands.ts',"toolkit('watch'"]].map(([path,symbol])=>{
 const source=readFileSync(resolve(root,path),'utf8');assert.ok(source.includes(symbol),'Missing external production consumer '+path);return {path,symbol,sha256:sha(source)}
})
writeFileSync(resolve(evidence,'acceptance.json'),JSON.stringify({schema:'agentmux.performance-failure-source-acceptance.v1',scope:'Normal source build/types and original Owner/API/compiled CLI only; no Native/installed qualification',results,callers,cliSHA256:sha(readFileSync(resolve(root,'packages/core/dist/agentmux.js')))},null,2)+'\n')
