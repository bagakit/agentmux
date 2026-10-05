import { provePerformanceOwner, sha } from './performance-owner-proof.mjs'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const parser='packages/core/src/toolkit-result-document.ts', metrics='packages/core/src/metrics.ts', toolkit='packages/core/src/toolkit.ts'
const usage='apps/desktop/src/shared/process-usage.ts', sampler='apps/desktop/src/main/process-resource-sampler.ts'
const bridge='apps/desktop/src/main/resource-usage-control.ts', script='apps/desktop/resources/toolkit/performance.mjs', owner='apps/desktop/src/main/toolkit-owner.ts'
const test='apps/desktop/test/toolkit-agent-cards-public.test.ts'
const proof=provePerformanceOwner({name:'toolkit-agent-cards-public',owners:[parser,metrics,toolkit,usage,sampler,bridge,script,owner],
  astOwners:[[script,'__AGENTMUX_TOOLKIT_PERFORMANCE_SOURCE__']],
  tests:[test,'apps/desktop/test/toolkit-owner.test.ts','packages/core/test/toolkit-control.test.ts','packages/core/test/toolkit-metrics-json.test.ts'],minimumTests:30,
  mutantTests:[test],mutants:[
    ['field-whitelist-lost',parser,"!(TOOLKIT_AGENT_CARD_FIELDS as readonly unknown[]).includes(value)","false"],
    ['duplicate-fields-accepted',parser,"fields.has(value as string)","false"],
    ['legal-opaque-identity-restricted',parser,'value.length > 4096) invalid()\n}','value.length > 128) invalid()\n}'],
    ['exclusive-reference-arm-lost',parser,"!Object.hasOwn(ref, 'sessionId') || Object.hasOwn(ref, 'runId')","!Object.hasOwn(ref, 'sessionId')"],
    ['utf8-budget-counts-codeunits',parser,'utf8.encode(JSON.stringify(r)).length > TOOLKIT_RESULT_DOCUMENT_MAX_BYTES','JSON.stringify(r).length > TOOLKIT_RESULT_DOCUMENT_MAX_BYTES'],
    ['document-budget-lost',parser,'if (utf8.encode(JSON.stringify(r)).length > TOOLKIT_RESULT_DOCUMENT_MAX_BYTES) invalid()','if (false) invalid()'],
    ['card-count-budget-lost',parser,'array(cards.items, 128, value =>','array(cards.items, 129, value =>'],
    ['card-metrics-budget-lost',parser,'array(card.metrics, 16, item)','array(card.metrics, 17, item)'],
    ['public-snapshot-document-unvalidated',toolkit,'if (r.document !== null) parseToolkitResultDocument(r.document)','if (false) parseToolkitResultDocument(r.document)'],
    ['public-coverage-incoherent',metrics,'if (totals.coverage.trackedRuns !== totals.coverage.observedRoots + totals.coverage.missingRoots) invalid()','if (false) invalid()'],
    ['public-missing-source-fabricates-totals',metrics,'if (totals.coverage.missingRoots > 0 && [totals.processCount, totals.cpuPercent, totals.rssKib].some(v => v !== null)) invalid()','if (false) invalid()'],
    ['shared-root-counted-missing',usage,'const observedRoots = roots.filter(root => pids.has(root.pid)).length','const observedRoots = [...usage.values()].filter(Boolean).length'],
    ['missing-root-fabricates-zero',usage,'if (coverage.missingRoots > 0) return { coverage, processCount: null, cpuPercent: null, rssKib: null }','if (coverage.missingRoots > 0) return { coverage, processCount: 0, cpuPercent: 0, rssKib: 0 }'],
    ['adds-independent-run-peaks',sampler,'    const application = this.sampleApp(windowAt)','    if(runTotals) runTotals = {...runTotals,cpuPercent:runs.reduce((sum,run)=>sum+(run.cpuPercent??0),0)}\n    const application = this.sampleApp(windowAt)'],
    ['total-window-uses-wall-clock',sampler,'aggregateUsage(this.runTotalSamples, windowAt).cpuPercent','aggregateUsage(this.runTotalSamples, this.now()).cpuPercent'],
    ['total-history-survives-last-lease',sampler,'    this.runTotalSamples = []\n','    // mutant retains old total history\n'],
    ['history-cap-lost',usage,').slice(-limit)',')'],
    ['public-totals-consumer-disconnected',bridge,'runTotals: sample.processObservedAt === null ? null : sample.runTotals','runTotals: null'],
    ['main-document-consumer-disconnected',owner,'this.value.document = document','this.value.document = null'],
    ['main-document-parse-disconnected',owner,'const document = parseToolkitResultDocument(frame.document)','const document = frame.document as any'],
    ['official-document-disconnected',script,'payload: observation, document: documentFor(observation)','payload: observation, document: null'],
    ['official-omission-count-lost',script,'document.agentCards.omittedItems--','document.agentCards.omittedItems -= 0'],
    ['official-byte-budget-lost',script,'if (bytes + extra > TOOLKIT_RESULT_DOCUMENT_MAX_BYTES) break','if (false) break']
  ],callers:[
    ['apps/desktop/src/main/runtime-controller.ts','this.resourceSampler.trackRun(event.run.runId, event.pid, hostId)'],
    [sampler,'summarizeRunSubtrees(rows, roots, usage)'],[bridge,'runTotals: sample.processObservedAt === null ? null : sample.runTotals'],
    [script,'payload: observation, document: documentFor(observation)'],[owner,'this.value.document = document'],
    ['packages/core/src/public-rpc-service.ts',"method === 'toolkit.watch'"],
    ['packages/core/src/agentmux-cli-resource-guide.ts','agentmux.toolkit.result.v1']
  ]})
try {
  proof.receipt.scriptExecutions=[]
  for(const run of proof.receipt.runs){
    const records=readFileSync(join(proof.directory,run.name+'.ast-loaded.jsonl.script'),'utf8').trim().split('\n').map(line=>JSON.parse(line))
    assert.ok(records.length>0,'Actual frozen official script child execution missing')
    for(const row of records){
      assert.equal(row.sourceSHA256,run.loadedSources[row.path]);assert.ok(row.childPid>0&&row.frames>0)
      assert.ok(row.launchArgs.some(arg=>arg.endsWith('/packages/core/bin/amux')))
      proof.receipt.scriptExecutions.push({run:run.name,...row})
    }
  }
  const customFile=join(proof.directory,'normal.custom-result.json'), custom=JSON.parse(readFileSync(customFile,'utf8'))
  assert.equal(custom.snapshot.state,'succeeded');assert.equal(custom.executionProof.privateChildExited,true)
  assert.equal(custom.executionProof.userRunTouched,false);assert.ok(custom.executionProof.childPid>0)
  assert.equal(custom.executionProof.outputSHA256,sha(custom.snapshot.latestConfirmed.text))
  proof.receipt.customResult={path:customFile,sha256:sha(readFileSync(customFile)),executionProof:custom.executionProof}
  proof.receipt.compiledArtifacts=Object.fromEntries(['packages/core/dist/metrics.js','packages/core/dist/toolkit.js','packages/core/dist/toolkit-result-document.js','packages/core/dist/agentmux.js','packages/core/bin/amux'].map(path=>[path,sha(readFileSync(join(proof.receipt.root,path)))]))
  proof.receipt.boundaries=['Actual Unix owner + compiled CLI inspect/watch + typed RPC subscriptions; actual official Node script consumes the compiled public CLI.',
    'Ordinary Custom script uses the real ToolkitOwner/CustomToolkitOwner, a controlled ToolkitRunPort, and an actual private Node child; no new native Runtime or user Run.',
    'Generic mounted Renderer card consumer and independent actual App visual review are separate T002/T003 gates.']
}catch(error){proof.receipt.passed=false;throw error}
finally{writeFileSync(join(proof.directory,'receipt.json'),JSON.stringify(proof.receipt,null,2)+'\n')}
