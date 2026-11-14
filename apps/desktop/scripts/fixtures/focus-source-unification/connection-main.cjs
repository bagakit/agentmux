const assert=require('node:assert/strict')
module.exports=async({win,read,until,settle,click,capture,result})=>{
 await until('original sources read',()=>read('window.sourceConnectionProof&&window.unifiedFocusProof?.ready&&document.querySelectorAll(".focus-context").length>=5'))
 result.before=await read('window.unifiedFocusProof.facts()')
 await read('window.sourceConnectionProof.lose()')
 await until('original source notice',()=>read('!!document.querySelector("section[aria-label^=Source]")'))
 for(const[width,height,theme]of[[1440,900,'dark'],[420,800,'dark'],[1440,900,'light'],[420,800,'light']]){
  win.setContentSize(width,height);await read(`window.unifiedFocusProof.theme(${JSON.stringify(theme)})`);await settle()
  const notice=await read(`(()=>{const n=document.querySelector('section[aria-label^=Source]');return{label:n.getAttribute('aria-label'),open:n.querySelector('details').open,text:n.textContent,overflow:document.documentElement.scrollWidth>innerWidth+1}})()`)
  assert.ok(notice.label.includes('业务分析项目'));assert.equal(notice.open,false);assert.equal(notice.overflow,false)
  await capture('source-connection-'+width+'-'+theme+'.png','Retained exact project and source recovery with secondary original connection details')
 }
 await click('section[aria-label^=Source] summary')
 await capture('source-connection-details.png','Original endpoint diagnosis and original Runtime/Space are available on demand')
 const before=await read('window.sourceConnectionProof.reads()')
 await read('window.sourceConnectionProof.recover()')
 await until('same original source rereading',()=>read('window.sourceConnectionProof.reads()').then(n=>n>before))
 assert.equal(await read('document.querySelector("section[aria-label^=Source]")?.textContent.includes("Checking the original source")'),true)
 await capture('source-connection-checking.png','Ready Host still keeps the source error visible until its original read is confirmed')
 await read('window.sourceConnectionProof.finish()')
 await until('original source confirmed',()=>read('!document.querySelector("section[aria-label^=Source]")'))
 await capture('source-connection-recovered.png','Same tasks and workface after the original source confirms the new read')
 result.after=await read('window.unifiedFocusProof.facts()')
 assert.deepEqual(result.after.runs,result.before.runs);assert.deepEqual(result.after.drafts,result.before.drafts)
 result.scenes.push({sourceConnection:true,readsBeforeRecovery:before,readsAfterRecovery:await read('window.sourceConnectionProof.reads()')});result.passed=true
}
