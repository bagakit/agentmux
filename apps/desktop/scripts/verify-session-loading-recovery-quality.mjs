import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const root=resolve(import.meta.dirname,'../../..'), evidence=join(root,'.tmp/session-loading-recovery-quality')
const slice=process.argv[process.argv.indexOf('--slice')+1]
assert.ok(['source','scene','review'].includes(slice),'Use --slice source|scene|review')
await mkdir(evidence,{recursive:true})
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const json=async path=>JSON.parse(await readFile(path,'utf8'))
async function run(command,args,extra={}){
 const child=spawn(command,args,{cwd:root,env:{...process.env,...extra},stdio:'inherit'})
 const code=await new Promise((done,fail)=>{child.once('error',fail);child.once('exit',(code,signal)=>signal?fail(new Error(`${command} ended by ${signal}`)):done(code))})
 assert.equal(code,0,`${command} ${args.join(' ')} failed`)
}
async function currentInputs(scene){
 assert.ok(Object.keys(scene.runtime.inputsAfter).length>0)
 for(const[path,expected]of Object.entries(scene.runtime.inputsAfter))assert.equal(hash(await readFile(path)),expected,`Runtime GUI candidate changed: ${path}`)
 assert.ok(Object.keys(scene.presentation.inputsAfter).length>0)
 for(const[path,expected]of Object.entries(scene.presentation.inputsAfter))assert.equal(hash(await readFile(join(root,path))),expected,`Presentation candidate changed: ${path}`)
 assert.equal(hash(await readFile(new URL(import.meta.url))),scene.verifierSha256,'Verifier changed after capture')
}
function frames(scene){return [...Object.entries(scene.runtime).filter(([key,value])=>key.startsWith('screenshot')&&value?.path).map(([label,frame])=>({label,kind:'ordinary-runtime-gui',...frame})),...scene.presentation.images.map(frame=>({kind:'production-component-fixture',...frame}))]}
if(slice==='source'){
 const tests=['session-recap','full-page-loading-surface','session-native-history-surface','terminal-history-wheel','session-connecting-surface'].map(name=>`apps/desktop/test/${name}.test.tsx`)
 tests.push('apps/desktop/test/session-connecting-surface-browser-e2e.test.ts','apps/desktop/test/full-page-loading-contract.test.ts')
 for(const path of tests)assert.ok((await readFile(join(root,path))).length>0,`Required test is missing: ${path}`)
 const testPath=join(evidence,'tests.json')
 await run('pnpm',['exec','vitest','run','--maxWorkers=1',...tests,'--reporter=json',`--outputFile=${testPath}`])
 const result=await json(testPath);assert.equal(result.success,true);assert.ok(result.numPassedTests>=50);assert.equal(result.numFailedTests,0)
 const callers=[]
 async function visit(directory){for(const entry of await readdir(directory,{withFileTypes:true})){const path=join(directory,entry.name);if(entry.isDirectory())await visit(path);else if(entry.isFile()&&path.endsWith('.tsx')&&!['FullPageLoadingSurface.tsx','SessionRecap.tsx'].includes(entry.name)){const source=await readFile(path,'utf8');source.split('\n').forEach((line,i)=>{if(/<(?:FullPageLoadingSurface|SessionRecap)\b/u.test(line))callers.push({path:path.slice(root.length+1),line:i+1,text:line.trim()})})}}}
 await visit(join(root,'apps/desktop/src/renderer/src'))
 assert.ok(callers.length>0);assert.ok(callers.some(c=>c.path.endsWith('/SessionPane.tsx')&&c.text.includes('<SessionRecap')));assert.ok(callers.some(c=>c.path.endsWith('/TerminalView.tsx')&&c.text.includes('<SessionRecap')));assert.ok(callers.some(c=>c.path.endsWith('/SessionConnectingSurface.tsx')))
 const mutationPath=join(evidence,'source-mutations.json')
 let mutations
 try { mutations=await json(mutationPath) } catch(error) { if(error.code!=='ENOENT')throw error }
 if(!mutations){await run(process.execPath,['apps/desktop/scripts/fixtures/session-loading-recovery-quality/source-mutations.mjs']);mutations=await json(mutationPath)}
 for(const mutation of mutations.mutations){
  assert.equal(hash(await readFile(join(root,mutation.source))),mutation.restored_sha256,`Mutation receipt expired: ${mutation.name}`)
  assert.equal(hash(await readFile(join(root,mutation.test))),mutation.test_sha256,`Mutation test changed: ${mutation.name}`)
  for(const phase of ['red','green'])assert.equal(hash(await readFile(join(root,mutation[`${phase}_log`]))),mutation[`${phase}_log_sha256`])
 }
 const ssotRefs=[['docs/design/behavior/session-recovery.md','启动与 restoring 的不同重量'],['docs/design/presentation/session-recovery.md','启动与恢复的分量分开'],['docs/design/behavior/terminal-reading.md','Terminal resume 画面中的 recap']]
 for(const[path,heading]of ssotRefs){const source=await readFile(join(root,path),'utf8');assert.ok(source.includes(`## ${heading}`),`Owning SSOT anchor missing: ${path}#${heading}`)}
 assert.equal(mutations.passed,true);assert.ok(mutations.mutations.length>0)
 await writeFile(join(evidence,'source.json'),JSON.stringify({passed:true,testsPassed:result.numPassedTests,testsSha256:hash(await readFile(testPath)),callers,mutationsSha256:hash(await readFile(mutationPath))},null,2)+'\n')
 console.log(`Loading/recovery source passed: ${result.numPassedTests} tests, ${callers.length} nondefinition product callers, finite production mutation RED/restored GREEN.`)
}else if(slice==='scene'){
 const runtimePath=join(evidence,'runtime.json'),presentationPath=join(evidence,'presentation.json')
 let runtime
 try{runtime=await json(runtimePath);if(runtime.passed!==true)runtime=null;else for(const[path,expected]of Object.entries(runtime.inputsAfter))if(hash(await readFile(path))!==expected){runtime=null;break}}catch(error){if(error.code!=='ENOENT')throw error}
 if(!runtime){await run(process.execPath,['apps/desktop/scripts/fixtures/terminal-resume-recap/scene.mjs'],{AGENTMUX_VERIFY_RECEIPT:runtimePath});runtime=await json(runtimePath)};assert.equal(runtime.passed,true);assert.equal(runtime.userRuntimeTouched,false);assert.equal(runtime.cleanup.rootRemoved,true);assert.deepEqual(runtime.cleanup.remaining,[])
 let presentation
 try{presentation=await json(presentationPath);if(presentation.passed!==true)presentation=null;else for(const[path,expected]of Object.entries(presentation.inputsAfter))if(hash(await readFile(join(root,path)))!==expected){presentation=null;break}}catch(error){if(error.code!=='ENOENT')throw error}
 if(!presentation){await run(process.execPath,['apps/desktop/scripts/fixtures/session-loading-recovery-quality/presentation.mjs'],{AGENTMUX_VERIFY_PRESENTATION_RECEIPT:presentationPath});presentation=await json(presentationPath)};assert.equal(presentation.passed,true);assert.equal(presentation.userRuntimeTouched,false);assert.ok(presentation.images.length>=8)
 const scene={schema:'agentmux.session-loading-recovery-quality-scene.v1',passed:true,captureOnly:true,aestheticReview:'not-performed',runtime,presentation,verifierSha256:hash(await readFile(new URL(import.meta.url)))}
 await currentInputs(scene);for(const frame of frames(scene))assert.equal(hash(await readFile(frame.path)),frame.sha256)
 await writeFile(join(evidence,'scene.json'),JSON.stringify(scene,null,2)+'\n');console.log('Exact private GUI scene passed; independent actual-image review pending.')
}else{
 const scenePath=join(evidence,'scene.json'),sceneBytes=await readFile(scenePath),scene=JSON.parse(sceneBytes)
 assert.equal(scene.passed,true);await currentInputs(scene)
 const review=await json(join(evidence,'review.json'))
 assert.equal(review.schema,'agentmux.session-loading-recovery-quality-review.v1');assert.equal(review.sceneSha256,hash(sceneBytes));assert.equal(review.verdict,'satisfied');assert.equal(review.actualImagesOpened,true);assert.ok(review.reviewedBy&&review.reviewedBy!=='/root');assert.deepEqual(review.unresolvedMustFix,[])
 const images=frames(scene);assert.ok(images.length>=13);assert.equal(review.images.length,images.length)
 for(const frame of images){assert.equal(hash(await readFile(frame.path)),frame.sha256);assert.ok(review.images.some(image=>image.path===frame.path&&image.sha256===frame.sha256&&image.opened===true),`Actual full frame not reviewed: ${frame.label}`)}
 const report=await readFile(resolve(root,review.reportPath));assert.ok(report.length>0);assert.equal(hash(report),review.reportSha256)
 console.log(`Independent visual review satisfied: ${review.reviewedBy}, ${images.length} exact full frames.`)
}
