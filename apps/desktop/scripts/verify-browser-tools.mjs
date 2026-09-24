import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile, copyFile, cp } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const root=resolve(import.meta.dirname,'../../..')
const exec=promisify(execFile)
const digest=bytes=>createHash('sha256').update(bytes).digest('hex')
const args=process.argv.slice(2)
const checkIndex=args.indexOf('--check-evidence'),publishIndex=args.indexOf('--publish-evidence')
assert.ok(args.length===0||(args.length===2&&(checkIndex===0||publishIndex===0)),'Choose a fresh run, --publish-evidence <dir>, or --check-evidence <dir>')
for(const index of [checkIndex,publishIndex])if(index>=0)assert.ok(args[index+1]&&!args[index+1].startsWith('--'),'An explicit evidence directory is required')

function validateReceipt(receipt) {
  assert.equal(receipt.schema,'agentmux.browser-recovery-restart.v1')
  assert.equal(receipt.passed,true);assert.equal(receipt.failure,null)
  assert.equal(receipt.case,'browser-tools');assert.equal(receipt.completeGate,true)
  assert.equal(receipt.browserTools?.complete,true)
  assert.equal(receipt.browserTools.profileRestored,true);assert.equal(receipt.browserTools.preferenceRestored,true)
  assert.equal(receipt.browserTools.searchSurfaceRestored,true);assert.equal(receipt.browserTools.queryOpenedInCurrentWorkspace,true);assert.equal(receipt.browserTools.moreRoutesSameWorkspace,true)
  assert.equal(receipt.browserTools.annotationDeleteAndClear,true);assert.equal(receipt.browserTools.noAgentHandoffDisabled,true)
  assert.ok(receipt.browserTools.nativeInput.length>0)
  assert.equal(receipt.browserTools.visual?.length,6)
  const searchFrames=receipt.visual.frames.filter(frame=>frame.content==='search-tools')
  assert.equal(searchFrames.length,6)
  assert.deepEqual(receipt.browserTools.visual.map(frame=>frame.label).sort(),searchFrames.map(frame=>frame.label).sort())
  for(const frame of receipt.browserTools.visual) {
    assert.ok(frame.profiles>0&&frame.annotations>0)
    assert.equal(frame.settingsOpen,frame.label.endsWith('-settings'))
  }
  for(const frame of searchFrames) {
    assert.ok(frame.observation.searchTools.bounds.width>0&&frame.observation.searchTools.bounds.height>0)
    assert.ok(frame.observation.searchTools.profiles>0&&frame.observation.searchTools.annotations>0)
    assert.equal(frame.observation.stage,undefined)
    assert.equal(frame.nativePage.captureSource,'native-browser-parked')
    assert.equal(frame.nativePage.file,undefined)
    assert.equal(frame.nativeBounds.length,1)
    assert.deepEqual(frame.nativePage.owners,frame.nativeBounds)
    const owner=frame.nativeBounds[0]
    assert.equal(owner.parked,true);assert.ok(owner.webContentsId>0)
    assert.ok(!owner.visible||owner.bounds.width===0||owner.bounds.height===0)
  }
  const expectedLabels=['normal','narrow','short'].flatMap(size=>[size+'-search-browser-tools',size+'-search-browser-settings'])
    .concat(['normal-browser-after-search','normal-browser-after-search-restart'])
  assert.deepEqual(receipt.visual.frames.map(frame=>frame.label).sort(),expectedLabels.sort())
  assert.ok(receipt.browserTools.searchParking.length>0)
  for(const parked of receipt.browserTools.searchParking)assert.deepEqual(parked,{hidden:true,inert:true,ariaHidden:'true',width:0,height:0,containsFocus:false})
  const typing=receipt.nativeInputAttempts.filter(input=>input.selector==='#tools-input'&&input.typing)
  assert.equal(typing.length,2,'The original native input is exercised after Search and after restart')
  for(const input of typing) {
    assert.ok(input.after.click>input.before.click&&input.after.input>input.before.input)
    assert.equal(input.after.lastTarget,'tools-input');assert.ok(input.types.includes('char')&&input.types.includes('mouseUp'))
    assert.equal(input.owner.viewVisible,true);assert.ok(input.bounds.width>0&&input.bounds.height>0)
  }
  assert.ok(receipt.first.pid>1&&receipt.second.pid>1);assert.notEqual(receipt.first.pid,receipt.second.pid)
  assert.equal(receipt.first.home,receipt.second.home)
  for(const exit of [receipt.firstExit,receipt.secondExit]) { assert.equal(exit.exitCode,0);assert.equal(exit.signal,null) }
  assert.equal(receipt.browserTools.searchBeforeQuit.mainSurface,'search')
  assert.deepEqual(receipt.browserTools.searchBeforeQuit.workbench,receipt.firstUi.restored)
  assert.deepEqual(receipt.firstUi.restored,receipt.secondUi.restored)
  assert.equal(receipt.firstUi.expected.regions.length,2)
  for(const ui of [receipt.firstUi,receipt.secondUi]) {
    const tab=ui.restored.tabs[receipt.firstUi.expected.tabId]
    assert.ok(tab,'The original Browser Tab remains present')
    assert.equal(tab.layout.activeRegionId,receipt.firstUi.expected.focus)
    const regions=Object.values(tab.regions).filter(region=>region.kind==='browser')
    assert.equal(regions.length,2)
    for(const expected of receipt.firstUi.expected.regions) {
      const region=regions.find(candidate=>candidate.regionId===expected.regionId)
      assert.ok(region);assert.equal(region.browserId,expected.browserId);assert.equal(region.url,expected.url)
      assert.equal(region.workspaceId,receipt.browserTools.searchBeforeQuit.activeWorkspaceId)
    }
    assert.equal(ui.geometry.length,2)
    for(const region of ui.geometry)assert.ok(region.width>100&&region.height>100)
    assert.equal(ui.pages.length,2)
    assert.deepEqual(ui.pages.map(page=>page.url),receipt.firstUi.expected.regions.map(region=>region.url))
  }
  assert.equal(receipt.secondUi.ensure.id,receipt.firstUi.expected.regions[0].browserId)
  assert.equal(receipt.secondUi.ensure.url,receipt.firstUi.expected.regions[0].url);assert.equal(receipt.secondUi.ensure.error,null)
  assert.deepEqual(receipt.identityBefore,receipt.identityAfter)
  assert.equal(receipt.cleanup.privateProcessesReaped,true);assert.equal(receipt.cleanup.temporaryRootRemoved,true)
  assert.deepEqual(receipt.cleanup.remaining,[]);assert.deepEqual(receipt.cleanup.errors,[])
  if(process.env.AGENTMUX_VISUAL_ORCA_CLI)assert.ok(receipt.visual.osFrames?.length>0)
}

async function checkPng(path,expectedHash) {
  const bytes=await readFile(path)
  assert.ok(bytes.length>24,path)
  assert.deepEqual(bytes.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]),path)
  assert.ok(bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0,path)
  assert.equal(digest(bytes),expectedHash,path)
}
async function validateEvidence(receipt,evidence) {
  validateReceipt(receipt)
  const identity=Object.entries(receipt.identityBefore)
  assert.ok(identity.length>0,'The original source and compiled identity is required')
  for(const key of ['apps/desktop/scripts/verify-browser-tools.mjs','apps/desktop/src/renderer/src/App.tsx',
    'apps/desktop/src/renderer/src/components/GlobalSearchSurface.tsx','apps/desktop/src/renderer/src/components/SearchBrowserTools.tsx',
    'apps/desktop/out/main/index.js','apps/desktop/out/preload/index.cjs','apps/desktop/out/renderer/index.html'])assert.ok(Object.hasOwn(receipt.identityBefore,key),key)
  assert.ok(identity.some(([key])=>/^apps\/desktop\/out\/renderer\/assets\/.+\.js$/.test(key)))
  assert.ok(identity.some(([key])=>/^apps\/desktop\/out\/renderer\/assets\/.+\.css$/.test(key)))
  for(const [key,hash] of identity) {
    assert.match(hash,/^[a-f\d]{64}$/)
    const bytes=await readFile(isAbsolute(key)?key:join(root,key))
    assert.ok(bytes.length>0,key);assert.equal(digest(bytes),hash,'Current candidate differs: '+key)
  }
  assert.equal(receipt.sourceCommit,(await exec('git',['rev-parse','HEAD'],{cwd:root})).stdout.trim(),'Evidence must belong to the current committed candidate')
  for(const frame of receipt.visual.frames) {
    await checkPng(join(evidence,frame.label+'.png'),frame.sha256)
    if(frame.content!=='search-tools') {
      assert.equal(frame.nativePage.captureSource,'native-browser-webcontents')
      assert.ok(frame.nativePage.bounds.width>0&&frame.nativePage.bounds.height>0)
      await checkPng(join(evidence,frame.label+'-native-page.png'),frame.nativePage.sha256)
    }
  }
  for(const frame of receipt.visual.osFrames??[]) {
    await checkPng(join(evidence,frame.label+'-os-compositor.png'),frame.sha256)
    const state=JSON.parse(await readFile(join(evidence,frame.label+'-os-state.json'),'utf8'))
    assert.deepEqual(state.before,state.after,'OS capture preserves the original native owners')
  }
}

if(checkIndex>=0) {
  // This branch only consumes explicitly published original evidence. It never launches the harness.
  const evidence=resolve(root,args[checkIndex+1])
  const receipt=JSON.parse(await readFile(join(evidence,'receipt.json'),'utf8'))
  await validateEvidence(receipt,evidence)
  console.log(JSON.stringify({passed:true,mode:'check-evidence',evidence,runtimeControlCalls:0,aestheticReview:'not-performed',physicalDeviceTested:false}))
} else {
  const result=await new Promise((done,fail)=>{
    const child=spawn(process.execPath,[join(import.meta.dirname,'verify-browser-recovery-restart.mjs'),'--case-browser-tools'],{cwd:root,stdio:'inherit'})
    child.once('error',fail);child.once('exit',(code,signal)=>done({code,signal}))
  })
  const original=await readFile(join(root,'.tmp/browser-tools-last.json'))
  const receipt=JSON.parse(original.toString('utf8'))
  const evidence=await mkdtemp(join(root,'.tmp/browser-tools-proof-'))
  await writeFile(join(evidence,'receipt.json'),original)
  for(const frame of receipt.visual?.frames??[]) {
    await copyFile(frame.file,join(evidence,frame.label+'.png'))
    if(frame.nativePage.file)await copyFile(frame.nativePage.file,join(evidence,frame.label+'-native-page.png'))
  }
  for(const frame of receipt.visual?.osFrames??[]) {
    await copyFile(frame.file,join(evidence,frame.label+'-os-compositor.png'))
    await copyFile(frame.stateFile,join(evidence,frame.label+'-os-state.json'))
  }
  console.log(JSON.stringify({receipt:join(evidence,'receipt.json')}))
  assert.equal(result.code,0,JSON.stringify(receipt.failure));assert.equal(result.signal,null)
  await validateEvidence(receipt,evidence)
  if(publishIndex>=0) {
    const published=resolve(root,args[publishIndex+1])
    await mkdir(resolve(published,'..'),{recursive:true})
    await cp(evidence,published,{recursive:true,force:false,errorOnExist:true})
  }
  console.log(JSON.stringify({passed:true,evidence,aestheticReview:'not-performed',physicalDeviceTested:false}))
}
