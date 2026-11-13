import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const root=resolve(import.meta.dirname,'../../..'),out=join(root,'.tmp/editor-extension-previews')
await mkdir(out,{recursive:true})
const run=async(name,filter=[],env={})=>{
 const file=join(out,name+'.json'),p=spawnSync(join(root,'node_modules/.bin/vitest'),['run','--config','packages/editor-extensions/vitest.previews.config.mts','--reporter=json','--outputFile='+file,...filter],{cwd:root,env:{...process.env,...env},encoding:'utf8',maxBuffer:8*1024*1024})
 const report=JSON.parse(await readFile(file,'utf8'))
 return {status:p.status,report,log:p.stderr||p.stdout}
}
const green=await run('green');assert.equal(green.status,0,green.log);assert.ok(green.report.numPassedTests>=90)
const hit=join(out,'loaded.txt');await rm(hit,{force:true})
const red=await run('stale-diagram',['-t','starts only in the viewport; cancels old source and rejects its late result'],{EDITOR_PREVIEW_MUTATION:'stale-diagram',EDITOR_PREVIEW_HITS:hit})
assert.notEqual(red.status,0);assert.equal(red.report.numFailedTests,1)
assert.match(JSON.stringify(red.report),/AssertionError/);assert.match(await readFile(hit,'utf8'),/src\/ui\/DiagramFilePreview.tsx/)
const restored=await run('restored',['-t','starts only in the viewport; cancels old source and rejects its late result']);assert.equal(restored.status,0,restored.log)
const receipt={passed:true,tests:green.report.numPassedTests,mutation:{name:'stale-diagram',failedTests:red.report.numFailedTests,loaded:true},restored:true}
await writeFile(join(out,'receipt.json'),JSON.stringify(receipt,null,2)+'\n');console.log(JSON.stringify(receipt))
