const {app,BrowserWindow,ipcMain}=require('electron'),fs=require('node:fs/promises'),path=require('node:path'),assert=require('node:assert/strict')
const {FileBookRealms,WorkspaceFileSources,WorkspaceCbrArchives}=require('./host.cjs')
app.on('window-all-closed',()=>{});const root=process.argv[2]
for(const[k,v]of Object.entries({home:process.env.HOME,appData:path.join(root,'app-data'),userData:path.join(root,'profile'),sessionData:path.join(root,'session-data')}))app.setPath(k,v)
app.whenReady().then(async()=>{
  const report={checks:0,formats:{}};const costs=new Map(),fdCosts=new Map(),nativefs=require('node:fs'),read=nativefs.read;nativefs.read=function(fd,...args){const callback=args.pop();return read.call(this,fd,...args,(error,bytes,...rest)=>{const cost=fdCosts.get(fd);if(cost&&!error){cost.bytes+=bytes;cost.calls++}callback(error,bytes,...rest)})};let owner,realms,top
  const check=(value,label)=>{report.checks++;assert.ok(value,label)}
  try{
    top=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true,preload:path.join(root,'proof-preload.cjs'),backgroundThrottling:false}})
    await top.loadFile(path.join(root,'renderer/packages/editor-extensions/test/book-reader/index.html'))
    const ws={id:'original',path:path.join(root,'workspace'),hostId:'local',name:'Original',kind:'folder'}
    owner=new WorkspaceFileSources({async openMediaHandle(w,name){assert.equal(w,ws);const handle=await fs.open(path.join(w.path,name),'r'),stat=await handle.stat(),cost={bytes:0,calls:0,fileBytes:stat.size};costs.set(name,cost);fdCosts.set(handle.fd,cost);const original=handle.read.bind(handle);handle.read=async(...args)=>{const result=await original(...args);cost.bytes+=result.bytesRead;cost.calls++;return result};return{handle,byteLength:stat.size,current:async()=> 'same',unmodified:async()=>true}}},()=>ws)
    realms=new FileBookRealms(owner,new WorkspaceCbrArchives(owner),{rendererFile:path.join(root,'renderer/apps/desktop/src/renderer/book-reader/index.html'),preload:path.join(root,'book-reader.cjs')})
    ipcMain.handle('proof:book',(event,method,args)=>{assert.equal(event.sender,top.webContents);assert.equal(event.senderFrame,event.sender.mainFrame);switch(method){case 'open':return realms.open(event.sender.id,...args);case 'load':return realms.load(event.sender.id,...args);case 'unload':return realms.unload(event.sender.id,...args);case 'resolve':return realms.resolve(event.sender.id,...args);case 'close':return realms.close(event.sender.id,...args);default:throw new Error('Unknown test command')}})
    for(const format of ['epub','mobi','azw3','fb2','cbz','cbr','djvu']){
      const source=await owner.open(top.webContents.id,ws,'book.'+format);assert.equal(source.status,'ready')
      const opening=performance.now();const opened=await realms.open(top.webContents.id,{sourceId:source.id,size:source.size,format,name:'book.'+format})
      const metadataMs=performance.now()-opening,openingBytes=costs.get('book.'+format).bytes
      const record=realms.realms.get(opened.id),child=record.window.webContents,parserPid=child.getOSProcessId()
      check(parserPid!==top.webContents.getOSProcessId(),'DOM parser has a separate OS process')
      check(await child.executeJavaScript('typeof window.agentmux === "undefined" && window.opener===null && typeof window.bookBytes.read === "function"'),'Parser has only its assigned byte port')
      let wrong=false;try{await realms.load(top.webContents.id+100,opened.id,0)}catch{wrong=true}
      check(wrong,'Another caller cannot use the assigned realm')
      const firstStarted=performance.now();const url=await realms.load(top.webContents.id,opened.id,0)
      const firstLoadMs=performance.now()-firstStarted;const pixels=await top.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const frame=document.createElement('iframe');frame.sandbox='allow-same-origin';frame.src=${JSON.stringify(url)};frame.onload=async()=>{try{const doc=frame.contentDocument;await Promise.all([...doc.images].filter(i=>i.src).map(i=>i.decode()));resolve({text:doc.body?.textContent?.length||0,images:doc.images.length,title:doc.title,unprivileged:typeof frame.contentWindow.agentmux==='undefined'&&typeof frame.contentWindow.bookBytes==='undefined'});frame.remove()}catch(e){reject(String(e))}};document.body.append(frame)})`)
      check(pixels.text>0||pixels.images>0,'The App consumes the exact realm Blob document and real decoded pixels')
      check(pixels.unprivileged,'The displayed book frame has no App bridge or parser byte port')
      await realms.unload(top.webContents.id,opened.id,0)
      check(await top.webContents.executeJavaScript(`fetch(${JSON.stringify(url)}).then(()=>false,()=>true)`),'Section unload revokes its real cross-window URL')
      const distantStarted=performance.now(),distantBefore=costs.get('book.'+format).bytes;const again=await realms.load(top.webContents.id,opened.id,opened.book.sections.length-1);const distantLoadMs=performance.now()-distantStarted,distantBytes=costs.get('book.'+format).bytes-distantBefore
      realms.releaseSource(top.webContents.id,source.id);await owner.release(top.webContents.id,source.id)
      check(record.window.isDestroyed()&&!realms.realms.has(opened.id),'Source release destroys only its exact parser realm')
      for(let i=0;i<60;i++){let alive=true;try{process.kill(parserPid,0)}catch{alive=false}if(!alive)break;await new Promise(r=>setTimeout(r,25))}
      let alive=true;try{process.kill(parserPid,0)}catch{alive=false}check(!alive,'The exact private parser OS process exits after its source closes')
      check(await top.webContents.executeJavaScript(`fetch(${JSON.stringify(again)}).then(()=>false,()=>true)`),'Closing the parser releases its real document URLs')
      report.formats[format]={sections:opened.book.sections.length,title:opened.book.metadata.title,pixels,appPid:top.webContents.getOSProcessId(),parserPid,cost:{metadataMs,openingBytes,firstLoadMs,distantLoadMs,distantBytes,...costs.get('book.'+format)}}
    }
    const large=await owner.open(top.webContents.id,ws,'large.cbr');assert.equal(large.status,'ready')
    const largeStart=performance.now(),largeBook=await realms.open(top.webContents.id,{sourceId:large.id,size:large.size,format:'cbr',name:'large.cbr'}),largeMetadataMs=performance.now()-largeStart,largeOpeningBytes=costs.get('large.cbr').bytes
    check(largeBook.book.sections.length===128,'The actual 32 MiB CBR exposes all 128 original pages')
    const largeFirstStart=performance.now(),largeFirst=await realms.load(top.webContents.id,largeBook.id,0),largeFirstMs=performance.now()-largeFirstStart
    await realms.unload(top.webContents.id,largeBook.id,0)
    const largeFarStart=performance.now(),largeBefore=costs.get('large.cbr').bytes,largeFar=await realms.load(top.webContents.id,largeBook.id,127),largeFarMs=performance.now()-largeFarStart
    check(await top.webContents.executeJavaScript(`new Promise((resolve,reject)=>{const image=new Image();image.src=${JSON.stringify(largeFar)};fetch(image.src).then(r=>r.text()).then(text=>{const doc=new DOMParser().parseFromString(text,'text/html'),actual=new Image();actual.src=doc.querySelector('img').src;actual.decode().then(()=>resolve(actual.naturalWidth===256),reject)})})`),'A distant large CBR page decodes its actual pixels')
    report.largeCbr={pages:128,fileBytes:large.size,metadataMs:largeMetadataMs,openingBytes:largeOpeningBytes,firstPageMs:largeFirstMs,distantPageMs:largeFarMs,distantBytes:costs.get('large.cbr').bytes-largeBefore,...costs.get('large.cbr'),limitation:'CBR listing scans the complete archive; distant pages rescan preceding entries. Only the selected page is retained in JavaScript.'}
    realms.releaseSource(top.webContents.id,large.id);await owner.release(top.webContents.id,large.id)
    const fb2=await owner.open(top.webContents.id,ws,'large.fb2');assert.equal(fb2.status,'ready');check(fb2.size>16*1024*1024,'The saved FB2 is larger than the text snapshot budget')
    const fb2Start=performance.now(),fb2Book=await realms.open(top.webContents.id,{sourceId:fb2.id,size:fb2.size,format:'fb2',name:'large.fb2'})
    check(fb2Book.book.sections.length===128,'A large FB2 opens through the exact original source without a text snapshot quota')
    const fb2URL=await realms.load(top.webContents.id,fb2Book.id,0)
    check(await top.webContents.executeJavaScript(`fetch(${JSON.stringify(fb2URL)}).then(r=>r.text()).then(t=>t.includes('Original XML book content'))`),'The large FB2 produces a real selected section')
    report.largeFb2={fileBytes:fb2.size,openAndFirstSectionMs:performance.now()-fb2Start,...costs.get('large.fb2'),limitation:'FB2 is one XML document; the private parser initially reads/parses the whole XML. The App consumes one section.'}
    realms.releaseSource(top.webContents.id,fb2.id);await owner.release(top.webContents.id,fb2.id)
    const execute = source => top.webContents.executeJavaScript(source)
    const pause = ms => new Promise(resolve=>setTimeout(resolve,ms))
    const state = () => execute('bookState()')
    const wait = async (expected, section) => {const until=Date.now()+10000;while(Date.now()<until){const now=await state();if(now.state===expected&&(!section||now.section===section))return now;await pause(25)}throw new Error('The native reader did not reach '+expected+': '+JSON.stringify(await state()))}
    const captureNames=new Set((process.argv[4]||'').split(',').filter(Boolean));const capture = async name => {if(process.argv[3]&&(!captureNames.size||captureNames.has(name))){await fs.mkdir(process.argv[3],{recursive:true});const bytes=(await top.webContents.capturePage()).toPNG();await fs.writeFile(path.join(process.argv[3],name+'.png'),bytes);(report.captures??=[]).push({name:name+'.png',sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex'),state:await state()})}}
    const source=await owner.open(top.webContents.id,ws,'long.epub');assert.equal(source.status,'ready')
    const request={sourceId:source.id,size:source.size,format:'epub',name:'long.epub'}
    top.setSize(1000,780)
    await execute('renderBook('+JSON.stringify(request)+')');let shown=await wait('ready')
    check(shown.text.includes('missing illustration')&&shown.notice.includes('illustration'),'A failed illustration leaves the real reflowable text readable')
    const opened=await execute('proofOpened'),record=realms.realms.get(opened.id),firstURL=shown.src
    await capture('reader-dark')
    const before=shown.positions
    await execute(`(()=>{const d=document.querySelector('iframe').contentDocument,s=d.scrollingElement;s.scrollTop=(s.scrollHeight-s.clientHeight)*.6;for(let i=0;i<200;i++)d.dispatchEvent(new Event('scroll'))})()`)
    await pause(620);shown=await state()
    check(shown.position.progress>.59&&shown.positions-before<=2,'Scroll combines position writes while preserving the actual reading place')
    const saved=shown.position
    await execute("switchBookTheme('light')");await pause(50);shown=await state()
    check(shown.background==='rgb(255, 255, 255)'&&shown.src===firstURL&&realms.realms.size===1,'Theme changes update the existing document without reopening the realm')
    await capture('reader-light')
    const custom=await execute("switchBookTheme('custom')");check(custom.applied,'The actual theme runtime accepts the custom palette')
    await pause(50);shown=await state();check(shown.background==='rgb(246, 239, 217)'&&shown.color==='rgb(53, 38, 21)'&&shown.src===firstURL,'The current book adopts the custom palette in place')
    await capture('reader-custom');top.setSize(360,640);await pause(50);await capture('reader-narrow')
    await execute(`document.querySelector('.book-reader__tools button').click()`);await pause(30)
    await execute(`window.deferLink=true;document.querySelector('.book-reader__outline li button').click();document.querySelector('[aria-label="Next section"]').click()`)
    shown=await wait('ready');check(shown.section==='2'&&shown.text.includes('Second chapter'),'The next section is the actual selected chapter')
    await execute('releaseLink()');await pause(80);shown=await state();check(shown.section==='2','An old asynchronous link cannot override a newer navigation')
    await execute('closeBook()');await pause(40)
    check(!realms.realms.has(opened.id),'Reader unmount closes its assigned parser process')
    await execute('renderBook('+JSON.stringify(request)+','+JSON.stringify(saved)+')');shown=await wait('ready')
    check(shown.section==='1'&&Math.abs(shown.position.progress-saved.progress)<.03,'Remount restores the original section identity and reading position')
    await capture('reader-restored')
    const positions=shown.positions
    await execute(`(()=>{const d=document.querySelector('iframe').contentDocument,s=d.scrollingElement;s.scrollTop=(s.scrollHeight-s.clientHeight)*.8;d.dispatchEvent(new Event('scroll'));capturePositionCheckpoint();window.__checkpointPosition=proofPositions.at(-1);closeBook()})()`)
    const checkpointed=await execute('__checkpointPosition');check(checkpointed.progress>.79,'The active view captures its actual DOM position before any 500ms timer');const flushed=await execute('proofPositions.at(-1)');check(flushed.progress>.79,'Closing flushes the final place before the throttled write')
    realms.releaseSource(top.webContents.id,source.id);await owner.release(top.webContents.id,source.id)
    const fixedText=await owner.open(top.webContents.id,ws,'fixed-text.epub');assert.equal(fixedText.status,'ready')
    await execute('renderBook('+JSON.stringify({sourceId:fixedText.id,size:fixedText.size,format:'epub',name:'fixed-text.epub'})+')');shown=await wait('ready')
    check((await execute('proofOpened')).book.layout==='pre-paginated'&&shown.text.includes('missing illustration')&&shown.notice.includes('illustration'),'A fixed-layout EPUB keeps readable text when its illustration fails')
    await execute('closeBook()');realms.releaseSource(top.webContents.id,fixedText.id);await owner.release(top.webContents.id,fixedText.id)
    const broken=await owner.open(top.webContents.id,ws,'broken.cbz');assert.equal(broken.status,'ready')
    await execute('renderBook('+JSON.stringify({sourceId:broken.id,size:broken.size,format:'cbz',name:'broken.cbz'})+')');shown=await wait('error')
    check(shown.section==='1','A broken fixed-page image reports the accurate page failure');await capture('reader-page-failure')
    await execute(`window.proofRetry=false;[...document.querySelectorAll('button')].find(b=>b.textContent==='Reload original file').click()`);check(await execute('proofRetry'),'Every opened-book failure offers an explicit original-source reload')
    await execute(`document.querySelector('[aria-label="Next section"]').click()`);shown=await wait('ready');check(shown.section==='2','Another healthy fixed page remains readable after a decode failure');check(await execute(`(()=>{const d=document.querySelector('iframe').contentDocument,i=d.querySelector('img'),r=i.getBoundingClientRect();return i.naturalWidth===1200&&i.naturalHeight===1600&&r.width>0&&r.height>0&&Math.abs(r.width/r.height-.75)<.005&&r.left>=-.5&&r.top>=-.5&&r.right<=d.documentElement.clientWidth+.5&&r.bottom<=d.documentElement.clientHeight+.5})()`),'The complete original large CBZ page fits the actual narrow viewport');await capture('reader-fixed-page')
    await execute('closeBook()');realms.releaseSource(top.webContents.id,broken.id);await owner.release(top.webContents.id,broken.id)
    let externalRequests=0
    top.webContents.session.webRequest.onBeforeRequest({urls:['https://book.invalid/*','file://*/*']},(details,done)=>{const blocked=details.url.startsWith('https://book.invalid/')||details.url.includes('/book-secret-sentinel.css');if(blocked)externalRequests++;done({cancel:blocked})})
    const svg=await owner.open(top.webContents.id,ws,'svg.epub');assert.equal(svg.status,'ready')
    await execute('renderBook('+JSON.stringify({sourceId:svg.id,size:svg.size,format:'epub',name:'svg.epub'})+')');await wait('ready');await pause(60)
    check(await execute(`document.querySelector('iframe').contentDocument.documentElement.localName==='svg'`),'A real SVG spine remains displayable')
    check(externalRequests===0,'The actual embedded CSP blocks SVG network and private-file CSS without relying on an HTML meta tag')
    await execute('closeBook()');realms.releaseSource(top.webContents.id,svg.id);await owner.release(top.webContents.id,svg.id)
    const vertical=await owner.open(top.webContents.id,ws,'vertical.epub');assert.equal(vertical.status,'ready')
    const verticalRequest={sourceId:vertical.id,size:vertical.size,format:'epub',name:'vertical.epub'}
    await execute('renderBook('+JSON.stringify(verticalRequest)+')');await wait('ready')
    const flow=await execute(`(()=>{const d=document.querySelector('iframe').contentDocument,s=d.scrollingElement;s.scrollLeft=-(s.scrollWidth-s.clientWidth)*.6;d.dispatchEvent(new Event('scroll'));return{left:s.scrollLeft,width:s.scrollWidth-s.clientWidth,height:s.scrollHeight-s.clientHeight}})()`)
    check(flow.left<0&&flow.width>flow.height,'The actual vertical-rl chapter scrolls horizontally with negative RTL offsets')
    await pause(550);const verticalSaved=(await state()).position;check(verticalSaved.progress>.59,'Reading position follows the actual horizontal book axis')
    await execute('closeBook()');await pause(30);await execute('renderBook('+JSON.stringify(verticalRequest)+','+JSON.stringify(verticalSaved)+')');await wait('ready')
    const restoredAxis=await execute(`(()=>{const s=document.querySelector('iframe').contentDocument.scrollingElement;return Math.abs(s.scrollLeft)/Math.max(1,s.scrollWidth-s.clientWidth)})()`)
    check(Math.abs(restoredAxis-verticalSaved.progress)<.02,'A vertical book restores its real horizontal reading position')
    await capture('reader-vertical');await execute('closeBook()');realms.releaseSource(top.webContents.id,vertical.id);await owner.release(top.webContents.id,vertical.id)
    const djvu=await owner.open(top.webContents.id,ws,'book.djvu');assert.equal(djvu.status,'ready')
    top.setSize(1000,780);await execute("switchBookTheme('dark')")
    await execute('renderBook('+JSON.stringify({sourceId:djvu.id,size:djvu.size,format:'djvu',name:'Chinese Cook Book.djvu'})+')');await wait('ready');for(let section=2;section<=4;section++){await execute(`document.querySelector('[aria-label="Next section"]').click()`);await wait('ready',String(section))}check((await state()).background==='rgb(17, 20, 25)','Dark image pages use the actual host canvas without changing their original pixels');await capture('reader-djvu-dark')
    await execute(`document.querySelector('.book-reader__tools button').click()`);await pause(25);await capture('reader-contents')
    await execute(`document.querySelector('.book-reader__outline>div button').click();switchBookTheme('light')`);await pause(25);check((await state()).background==='rgb(255, 255, 255)','Light image pages update the same native document canvas');await capture('reader-djvu-light')
    await execute('closeBook()');realms.releaseSource(top.webContents.id,djvu.id);await owner.release(top.webContents.id,djvu.id)
    report.ui={saved,flushed,positionsAfterRestore:positions,last:shown}
  }catch(error){report.failure=String(error.stack||error)}
  finally{realms?.dispose();await owner?.dispose();await fs.writeFile(path.join(root,'report.json'),JSON.stringify(report,null,2));if(top&&!top.isDestroyed())top.destroy();app.exit(report.failure?1:0)}
})
