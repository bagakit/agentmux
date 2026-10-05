import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
const root=resolve(import.meta.dirname,'../../..'), evidence=join(root,'.tmp/ui-design-cohesion/recall-mutation')
await mkdir(evidence,{recursive:true})
const source='apps/desktop/src/renderer/src/components/NotebookViews.tsx', before=await readFile(join(root,source),'utf8')
const anchor='onChange={onChange} active={active} ariaLabel="Notebook presentation"'
assert.equal(before.split(anchor).length,2,'One actual production control owner')
const config=join(evidence,'vitest.mjs'), report=join(evidence,'mutant.json'), receipt={passed:false,source,sourceSHA256:createHash('sha256').update(before).digest('hex')}
await writeFile(config,`import {mergeConfig} from 'vitest/config'; import base from ${JSON.stringify(join(root,'vitest.config.ts'))}; export default mergeConfig(base,{plugins:[{name:'break-actual-recall-view-change',enforce:'pre',transform(code,id){if(id.split('?')[0]!==${JSON.stringify(join(root,source))})return; if(!code.includes(${JSON.stringify(anchor)}))throw Error('Mutation anchor missing');return code.replace(${JSON.stringify(anchor)},${JSON.stringify(anchor.replace('onChange={onChange}','onChange={() => {}}'))});}}]});`)
const result=spawnSync(process.execPath,[join(root,'node_modules/vitest/vitest.mjs'),'run','apps/desktop/test/recall-notebook-views.test.tsx','--config',config,'--maxWorkers=1','--testTimeout=15000','--testNamePattern=^switches real Notebook','--reporter=json','--outputFile='+report],{cwd:root,encoding:'utf8',timeout:120000,maxBuffer:8*1024*1024})
await writeFile(join(evidence,'mutant.log'),result.stdout+result.stderr)
const facts=JSON.parse(await readFile(report,'utf8'))
assert.equal(result.status,1);assert.equal(facts.numFailedTests,1);assert.equal(facts.numPassedTests,0)
const failed=facts.testResults.flatMap(file=>file.assertionResults).filter(item=>item.status==='failed')
assert.equal(failed.length,1);assert.ok(failed[0].title.startsWith('switches real Notebook'))
assert.ok(failed[0].failureMessages.some(message=>message.includes('AssertionError')&&message.includes('true')),'Keyboard state assertion kills actual no-op selection, not an import/setup error')
assert.equal(await readFile(join(root,source),'utf8'),before,'Mutation never writes shared production source')
receipt.passed=true;receipt.failedAssertions=failed.map(item=>({title:item.title,messages:item.failureMessages}));await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2));console.log(JSON.stringify({passed:true,receipt:join(evidence,'receipt.json')}))
