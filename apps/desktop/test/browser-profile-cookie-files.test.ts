import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
const fault=vi.hoisted(()=>({write:false,directory:false,root:''}))
const transport=vi.hoisted(()=>({open:vi.fn()}))
const person=vi.hoisted(()=>({show:vi.fn()}))
vi.mock('node:fs/promises',async original=>{const fs=await original<typeof import('node:fs/promises')>();return{...fs,open:async(...args:Parameters<typeof fs.open>)=>{
  if(fault.write&&String(args[0]).endsWith('.tmp')){fault.write=false;throw Error('private source token must stay private')}
  const file=await fs.open(...args);if(fault.directory&&String(args[0])===fault.root)file.sync=async()=>{fault.directory=false;throw Error('private directory ACK')};return file
}}})
vi.mock('electron',()=>({app:{getLocale:()=> 'en-US'},dialog:{showMessageBox:person.show},BrowserWindow:class{},session:{fromPartition:()=>{throw Error('No implicit Session')}},webContents:{getAllWebContents:()=>[]}}))
vi.mock('../src/main/browser-profile-cookie-file-native.js',()=>({openProfileCookieFileNative:transport.open}))
import { BrowserProfileManager } from '../src/main/browser-profile-manager.js'
import { BrowserProfileStore } from '../src/main/browser-profile-store.js'
import { BrowserProfileCookieFiles } from '../src/main/browser-profile-cookie-files.js'
import { createProfileCookieFileIo } from '../src/main/browser-profile-cookie-file-io.js'
import { confirmProfileCookieFile } from '../src/main/browser-profile-cookie-file-confirmation.js'
import { normalizeProfileFileCookie, profileCookieIdentity, profileCookieParam, planProfileCookieArray } from '../src/main/browser-profile-cookie-file-format.js'
import { registerBrowserProfileEditorIpc } from '../src/main/browser-profile-editor-ipc.js'
import { executeBrowserProfileControl } from '../src/main/browser-profile-control.js'
import { parseBrowserProfileCookieFilePayload,parseBrowserProfileCookieFileResult,parseBrowserProfileCookieFileReceipt,assertBrowserProfileCookieFileTarget } from '../../../packages/core/src/browser-profile-cookie-files.js'
import { rpcControlRequest } from '../../../packages/core/src/rpc-business-codec.js'
import { AgentMuxControlServer } from '../../../packages/core/src/control-host.js'
import { privateRpcCorePort } from '../../../packages/core/test/helpers/private-rpc-core.js'
import { objectCliEnvironment,runCompiledObjectCli } from '../../../packages/core/test/helpers/object-cli-rpc.js'
const roots:string[]=[]
const profileScope={kind:'profile' as const},siteScope={kind:'sites' as const,sites:['example.com']}
const cookie=(name='session-secret',extra:object={})=>({domain:'login.example.com',name,value:'VALUE-DO-NOT-PUBLISH',path:'/',secure:true,httpOnly:true,sameSite:'Lax',expires:Math.floor(Date.now()/1000)+86400,...extra})
afterEach(async()=>{vi.restoreAllMocks();transport.open.mockReset();person.show.mockReset();fault.write=false;fault.directory=false;await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})))})
async function fixture(){
  const root=await mkdtemp(join(tmpdir(),'amux-cookie-file-'));roots.push(root);fault.root=root
  const path=join(root,'profiles.json'),store=new BrowserProfileStore(path),sessions={prepare:()=>undefined,nativeSession:vi.fn((id:string)=>({id}))}
  const manager=new BrowserProfileManager(store,sessions as never,()=>root);await manager.initialize();const profile=manager.listProfiles()[0]!,other=await manager.createProfile('Independent Profile')
  const jars=new Map<string,Map<string,ReturnType<typeof normalizeProfileFileCookie>>>([[profile.id,new Map()],[other.id,new Map()]])
  const set=vi.fn(async(id:string,c:ReturnType<typeof normalizeProfileFileCookie>)=>{jars.get(id)!.set(profileCookieIdentity(c),structuredClone(c));return 'applied' as const})
  const read=vi.fn(async(id:string)=>[...jars.get(id)!.values()].map(c=>({...c,expires:c.expires??-1,session:c.expires===null})))
  transport.open.mockImplementation(async(target:{id:string})=>({set:(c:Parameters<typeof set>[1])=>set(target.id,c),read:()=>read(target.id),flush:async()=>{},close:async()=>{}}))
  const writes: {location:unknown;bytes:Uint8Array}[]=[],io={read:vi.fn(async(location:{path:string})=>readFile(location.path)),write:vi.fn(async(location:unknown,bytes:Uint8Array)=>{writes.push({location,bytes});return{status:'written' as const}}),reveal:vi.fn(async()=>true)}
  const confirm=vi.fn(async()=>true);manager.cookieFiles.setFileOwner(io);manager.cookieFiles.setConfirmationHandler(confirm)
  const source=async(raw:unknown,filename='private-token-source.json')=>{const path=join(root,filename);await writeFile(path,JSON.stringify(raw));return{kind:'local' as const,path}}
  const prepare=async(raw:unknown,id='original-import',scope:typeof profileScope|typeof siteScope=profileScope)=>manager.cookieFiles.prepareImport(profile.id,id,await source(raw),scope)
  const inspect=(id?:string,offset?:number,limit?:number)=>manager.cookieFiles.inspect(profile.id,id,offset,limit)
  const reboot=async()=>{const m=new BrowserProfileManager(new BrowserProfileStore(path),sessions as never,()=>root);await m.initialize();m.cookieFiles.setFileOwner(io);m.cookieFiles.setConfirmationHandler(confirm);return m}
  return{root,path,store,manager,profile,other,jars,set,read,io,confirm,source,prepare,inspect,writes,reboot,sessions}
}
describe('Profile Cookie file exchange keeps the original data, person and effect owners',()=>{
  it('the production trusted native dialog binds the original Profile, complete scope and private destination with Cancel as default',async()=>{
    const window={isDestroyed:()=>false},signal=new AbortController(),profile={id:'exact-profile',label:'Original'},request={kind:'export' as const,profileId:profile.id,profileLabel:profile.label,operationId:'native-approval',scope:siteScope,destination:{kind:'local' as const,path:'/private/source-secret-output.json'}}
    person.show.mockResolvedValueOnce({response:0}).mockResolvedValueOnce({response:1});expect(await confirmProfileCookieFile(request,signal.signal,window as never,profile)).toBe(false);expect(await confirmProfileCookieFile(request,signal.signal,window as never,profile)).toBe(true)
    expect(person.show).toHaveBeenCalledWith(window,expect.objectContaining({defaultId:0,cancelId:0,buttons:['Cancel','Export cookies'],detail:expect.stringContaining('Profile exact-profile\nSelected sites (all their Cookie partition keys): example.com\nNew export file: Local Host\n/private/source-secret-output.json')}))
    signal.abort();expect(await confirmProfileCookieFile(request,signal.signal,window as never,profile)).toBe(false);expect(await confirmProfileCookieFile(request,new AbortController().signal,window as never,{id:'foreign',label:'Other'})).toBe(false);expect(person.show).toHaveBeenCalledTimes(2)
  })
  it('same-path Workspace destinations on different Hosts remain distinguishable in the production trusted approval',async()=>{
    person.show.mockResolvedValue({response:0});for(const hostId of ['original-host','different-host'])await confirmProfileCookieFile({kind:'export',profileId:'profile',profileLabel:'Original',operationId:'operation',scope:profileScope,destination:{kind:'workspace',resource:{hostId,workspaceId:'exact-workspace',workspacePath:'/same-root'},path:'cookies.json'}},new AbortController().signal,{isDestroyed:()=>false} as never,{id:'profile',label:'Original'})
    expect(person.show.mock.calls[0]![1].detail).toContain('Host original-host\nWorkspace exact-workspace\nRoot /same-root\nFile cookies.json');expect(person.show.mock.calls[1]![1].detail).toContain('Host different-host');expect(person.show.mock.calls[0]![1].detail).not.toBe(person.show.mock.calls[1]![1].detail)
  })
  it('person cancellation and an unavailable confirmation owner expose no Cookie collection and cause no native effect or output',async()=>{
    const f=await fixture();f.confirm.mockResolvedValue(false)
    expect(await f.manager.cookieFiles.export(f.profile.id,'cancelled-export',{kind:'local',path:join(f.root,'out.json')},profileScope)).toMatchObject({status:'cancelled',fileOutcome:'not-written'})
    await f.prepare([cookie()]);expect((await f.manager.cookieFiles.import(f.profile.id,'original-import')).status).toBe('cancelled')
    expect(transport.open).not.toHaveBeenCalled();expect(f.io.write).not.toHaveBeenCalled()
    const bare=new BrowserProfileCookieFiles({read:async()=>[],change:async()=>{throw Error('No admission')},track:async p=>p,profile:id=>({id,label:'Original'}),native:transport.open})
    await expect(bare.export(f.profile.id,'no-person',{kind:'local',path:join(f.root,'out.json')},profileScope)).rejects.toMatchObject({code:'BROWSER_PROFILE_COOKIE_APPROVAL_UNAVAILABLE'});expect(transport.open).not.toHaveBeenCalled()
  })
  it('imports only the fixed prepared source bytes after exact native person confirmation; ordinary responses and metadata contain no names or values',async()=>{
    const f=await fixture(),source=await f.source([cookie()]);const review=await f.manager.cookieFiles.prepareImport(f.profile.id,'frozen-source',source,profileScope)
    await writeFile(source.path,JSON.stringify([cookie('replacement-unreviewed',{value:'UNREVIEWED'})]));const receipt=await f.manager.cookieFiles.import(f.profile.id,review.reviewId)
    expect(f.set).toHaveBeenCalledTimes(1);expect(f.set.mock.calls[0]).toMatchObject([f.profile.id,{name:'session-secret',value:'VALUE-DO-NOT-PUBLISH'}])
    expect(f.confirm).toHaveBeenCalledWith(expect.objectContaining({profileId:f.profile.id,operationId:'frozen-source',source,scope:profileScope}),expect.any(AbortSignal))
    expect(receipt.status).toBe('completed');expect(f.jars.get(f.other.id)!.size).toBe(0)
    expect(JSON.stringify([review,receipt,await f.inspect('frozen-source')])).not.toMatch(/session-secret|VALUE-DO-NOT-PUBLISH|private-token|UNREVIEWED/)
    expect(await readFile(f.path,'utf8')).not.toMatch(/session-secret|VALUE-DO-NOT-PUBLISH|UNREVIEWED/)
  })
  it('rejects malformed files before admission and permits later healthy use without clearing original cookies',async()=>{
    const f=await fixture(),source=await f.source([]);await writeFile(source.path,'invalid private JSON token')
    await expect(f.manager.cookieFiles.prepareImport(f.profile.id,'bad-file',source,profileScope)).rejects.toMatchObject({code:'BROWSER_PROFILE_COOKIE_FILE_REFUSED'})
    expect((await f.inspect('bad-file')).receipt).toBeNull();expect(f.confirm).not.toHaveBeenCalled();expect(transport.open).not.toHaveBeenCalled()
    await f.prepare([cookie()]);expect((await f.manager.cookieFiles.import(f.profile.id,'original-import')).counts.applied).toBe(1)
  })
  it('preserves host-only/domain/path and CHIPS ancestor identity rather than flattening matching names',()=>{
    const base=cookie(),p=planProfileCookieArray([base,{...base,hostOnly:false},{...base,path:'/account'},{...base,partitionKey:{topLevelSite:'https://top.example.net',hasCrossSiteAncestor:true}},{...base,partitionKey:{topLevelSite:'https://top.example.net',hasCrossSiteAncestor:false}}],profileScope,Date.now()/1000)
    expect(p.items.every(i=>i.cookie)).toBe(true);expect(new Set(p.items.map(i=>profileCookieIdentity(i.cookie!))).size).toBe(5)
    expect(profileCookieParam(p.items[0]!.cookie!)).not.toHaveProperty('domain');expect(profileCookieParam(p.items[1]!.cookie!)).toMatchObject({domain:'.login.example.com'})
    expect(profileCookieParam(p.items[3]!.cookie!)).toMatchObject({partitionKey:{topLevelSite:'https://example.net',hasCrossSiteAncestor:true}})
  })
  it.each([
    ['https://a.example.com:8443','https://b.example.com','https://example.com'],
    ['https://a.user.github.io:8443','https://b.user.github.io','https://user.github.io'],
    ['https://127.0.0.1:8443','https://127.0.0.1','https://127.0.0.1']
  ])('uses one real schemeful CHIPS key for %s and %s',(a,b,canonical)=>{
    const p=planProfileCookieArray([cookie('chips',{partitionKey:{topLevelSite:a,hasCrossSiteAncestor:true}}),cookie('chips',{partitionKey:{topLevelSite:b,hasCrossSiteAncestor:true}})],profileScope,Date.now()/1000)
    expect(p.items[0]!.cookie!.partitionKey!.topLevelSite).toBe(canonical);expect(p.items[1]!.result.reason).toBe('duplicate-in-file')
  })
  it('skips invalid, expired, duplicate, outside-scope and unsupported entries with original indexes while retaining unrelated data',async()=>{
    const f=await fixture();await f.prepare([cookie(),cookie(),cookie('expired',{expires:1}),cookie('outside',{domain:'other.test'}),cookie('opaque',{partitionKeyOpaque:true}),{...cookie('invalid'),value:'bad\nvalue'}],'mixed',siteScope)
    const r=await f.manager.cookieFiles.import(f.profile.id,'mixed'),inspection=await f.inspect('mixed')
    expect(r).toMatchObject({status:'partial',counts:{total:6,applied:1,skipped:5}});expect(inspection.items.map(i=>i.reason)).toEqual([undefined,'duplicate-in-file','expired','outside-scope','unsupported-cookie','invalid-cookie']);expect(f.set).toHaveBeenCalledTimes(1)
  })
  it('confirmation crossing expiry never dispatches a deleting set and preserves the target newer same-key Cookie',async()=>{
    const f=await fixture(),now=Date.now(),c=cookie('same-key',{expires:now/1000+1}),target=normalizeProfileFileCookie({...c,value:'newer-kept',expires:now/1000+86400},now/1000)
    f.jars.get(f.profile.id)!.set(profileCookieIdentity(target),target);await f.prepare([c],'delayed-confirmation')
    f.confirm.mockImplementation(async()=>{vi.spyOn(Date,'now').mockReturnValue(now+2000);return true})
    expect(await f.manager.cookieFiles.import(f.profile.id,'delayed-confirmation')).toMatchObject({counts:{applied:0,skipped:1}});expect((await f.inspect('delayed-confirmation')).items[0]?.reason).toBe('expired');expect(f.set).not.toHaveBeenCalled();expect(f.jars.get(f.profile.id)!.get(profileCookieIdentity(target))!.value).toBe('newer-kept')
  })
  it('a rejected native item permits independent items, while an unconfirmed native effect stops undispatched remainder',async()=>{
    const f=await fixture();await f.prepare([cookie('first'),cookie('second'),cookie('third')]);f.set.mockRejectedValueOnce(Error('private native packet')).mockResolvedValue('applied')
    const r=await f.manager.cookieFiles.import(f.profile.id,'original-import');expect(r.status).toBe('pending');expect(r.counts).toMatchObject({unknown:1,notAttempted:2});expect((await f.inspect()).pending.map(r=>r.operationId)).toContain('original-import');expect(f.set).toHaveBeenCalledTimes(1);expect(JSON.stringify(r)).not.toContain('private native packet')
    f.set.mockReset();f.set.mockResolvedValueOnce('rejected' as never).mockResolvedValue('applied');await f.prepare([cookie('first'),cookie('second')],'native-reject')
    expect((await f.manager.cookieFiles.import(f.profile.id,'native-reject')).counts).toMatchObject({applied:1,rejected:1});expect(f.set).toHaveBeenCalledTimes(2)
  })
  it('native connection failure before set is known not-attempted, without guessing any Cookie mutation',async()=>{
    const f=await fixture();await f.prepare([cookie(),cookie('two')]);transport.open.mockRejectedValueOnce(Error('private connection failed'))
    const r=await f.manager.cookieFiles.import(f.profile.id,'original-import');expect(r.counts).toMatchObject({unknown:0,notAttempted:2});expect((await f.inspect('original-import')).items.every(i=>i.reason==='not-dispatched')).toBe(true);expect(f.set).not.toHaveBeenCalled()
  })
  it('exports explicit sites including every CHIPS partition, preserves supported attributes and reports unsupported opaque rows',async()=>{
    const f=await fixture();f.read.mockResolvedValueOnce([cookie('plain'),cookie('chips',{partitionKey:{topLevelSite:'https://top.example.net',hasCrossSiteAncestor:true},priority:'High',sourceScheme:'Secure',sourcePort:443}),cookie('outside',{domain:'other.test'}),cookie('opaque',{partitionKeyOpaque:true})] as never)
    const r=await f.manager.cookieFiles.export(f.profile.id,'scoped-export',{kind:'local',path:join(f.root,'private-output.json')},siteScope)
    expect(r).toMatchObject({status:'partial',fileOutcome:'written',counts:{total:3,applied:2,skipped:1}})
    const output=JSON.parse(Buffer.from(f.writes[0]!.bytes).toString());expect(output).toHaveLength(2);expect(output[1]).toMatchObject({partitionKey:{topLevelSite:'https://example.net',hasCrossSiteAncestor:true},priority:'High',sourcePort:443,httpOnly:true});expect(JSON.stringify(output)).not.toContain('outside')
    expect(JSON.stringify([r,await f.inspect('scoped-export')])).not.toMatch(/VALUE-DO-NOT-PUBLISH|private-output|session-secret|chips/)
    expect(await f.manager.cookieFiles.reveal(f.profile.id,'scoped-export')).toMatchObject({revealed:true});expect(f.io.reveal).toHaveBeenCalledTimes(1)
  })
  it.each(['written','rejected','unknown'] as const)('records the exact export file outcome %s including an empty collection',async outcome=>{
    const f=await fixture();f.io.write.mockResolvedValueOnce({status:outcome} as never)
    const r=await f.manager.cookieFiles.export(f.profile.id,'empty-export',{kind:'local',path:join(f.root,'out.json')},profileScope)
    expect(r).toMatchObject({counts:{total:0},status:outcome==='written'?'completed':outcome==='unknown'?'pending':'failed',fileOutcome:outcome==='rejected'?'not-written':outcome})
    expect(()=>parseBrowserProfileCookieFileReceipt(r)).not.toThrow()
  })
  it('incomplete native reads do not write an invented empty collection',async()=>{
    const f=await fixture();f.read.mockRejectedValueOnce(Error('private read secret'));const r=await f.manager.cookieFiles.export(f.profile.id,'incomplete',{kind:'local',path:join(f.root,'out.json')},profileScope)
    expect(r).toMatchObject({status:'failed',fileOutcome:'not-written'});expect(f.io.write).not.toHaveBeenCalled();expect(JSON.stringify(r)).not.toContain('private read secret')
  })
  it('requires strong original pending admission before native effects; before-save and directory ACK failure never dispatch',async()=>{
    const f=await fixture();await f.prepare([cookie()]);fault.write=true
    await expect(f.manager.cookieFiles.import(f.profile.id,'original-import')).rejects.toThrow();expect(f.set).not.toHaveBeenCalled();expect(transport.open).not.toHaveBeenCalled()
    fault.directory=true;await expect(f.manager.cookieFiles.import(f.profile.id,'original-import')).rejects.toThrow();expect(f.set).not.toHaveBeenCalled();expect((await f.inspect('original-import')).receipt?.status).toBe('pending')
    const second=await f.reboot();await expect(second.cookieFiles.import(f.profile.id,'original-import')).rejects.toMatchObject({code:'BROWSER_PROFILE_COOKIE_FILE_ALREADY_ADMITTED'});expect(f.confirm).toHaveBeenCalledTimes(2)
  })
  it('a native effect followed by receipt-save failure remains discoverable after reconstruction and never confirms or dispatches that ID again',async()=>{
    const f=await fixture();await f.prepare([cookie()]);f.set.mockImplementationOnce(async(id,c)=>{f.jars.get(id)!.set(profileCookieIdentity(c),c);fault.write=true;return'applied'})
    await expect(f.manager.cookieFiles.import(f.profile.id,'original-import')).rejects.toThrow();expect(f.jars.get(f.profile.id)!.size).toBe(1)
    const second=await f.reboot();expect((await second.cookieFiles.inspect(f.profile.id)).pending).toMatchObject([{operationId:'original-import',status:'pending'}])
    await expect(second.cookieFiles.import(f.profile.id,'original-import')).rejects.toMatchObject({code:'BROWSER_PROFILE_COOKIE_FILE_ALREADY_ADMITTED'});await expect(second.cookieFiles.prepareImport(f.profile.id,'original-import',{kind:'local',path:join(f.root,'deleted-private-source.json')},profileScope)).rejects.toMatchObject({code:'BROWSER_PROFILE_COOKIE_FILE_ALREADY_ADMITTED'})
    expect(f.set).toHaveBeenCalledTimes(1);expect(f.confirm).toHaveBeenCalledTimes(1)
  })
  it('unknown file output stays pending across reconstruction and cannot repeat the original read/write or switch its destination',async()=>{
    const f=await fixture();f.io.write.mockResolvedValueOnce({status:'unknown'} as never)
    await f.manager.cookieFiles.export(f.profile.id,'original-output',{kind:'local',path:join(f.root,'one.json')},profileScope)
    const second=await f.reboot();await expect(second.cookieFiles.export(f.profile.id,'original-output',{kind:'local',path:join(f.root,'two.json')},siteScope)).rejects.toMatchObject({code:'BROWSER_PROFILE_COOKIE_FILE_ALREADY_ADMITTED'})
    expect(f.io.write).toHaveBeenCalledTimes(1);expect(f.read).toHaveBeenCalledTimes(1);expect(f.confirm).toHaveBeenCalledTimes(1)
  })
  it('discard is durable, records no data effects and cannot race a confirming import into a later dispatch',async()=>{
    const f=await fixture();await f.prepare([cookie()]);let approve:(value:boolean)=>void;f.confirm.mockImplementationOnce(()=>new Promise<boolean>(resolve=>{approve=resolve}))
    const applying=f.manager.cookieFiles.import(f.profile.id,'original-import');for(let i=0;i<50&&!f.confirm.mock.calls.length;i++)await new Promise(resolve=>setTimeout(resolve,2))
    await f.manager.cookieFiles.discard(f.profile.id,'original-import');approve!(true);await expect(applying).rejects.toMatchObject({code:'BROWSER_PROFILE_COOKIE_FILE_ALREADY_ADMITTED'});expect(f.set).not.toHaveBeenCalled();expect((await f.inspect('original-import')).receipt?.status).toBe('cancelled')
  })
  it('safe history preserves the Profile settings revision, pages every original item and is cold-readable',async()=>{
    const f=await fixture(),before=f.manager.listProfiles().find(p=>p.id===f.profile.id)!.revision
    await f.prepare(Array.from({length:70},(_,i)=>cookie('item'+i)));await f.manager.cookieFiles.import(f.profile.id,'original-import')
    const page=await f.inspect('original-import',0,64),next=await f.inspect('original-import',64,64);expect(page.nextOffset).toBe(64);expect(next.items.map(i=>i.index)).toEqual([64,65,66,67,68,69]);expect(next.nextOffset).toBeNull()
    expect(f.manager.listProfiles().find(p=>p.id===f.profile.id)!.revision).toBe(before);const second=await f.reboot();f.sessions.nativeSession.mockClear();await second.cookieFiles.inspect(f.profile.id);expect(f.sessions.nativeSession).not.toHaveBeenCalled()
  })
  it('rejects relative Host targets before confirmation or native Cookie read, keeping the original Profile usable',async()=>{
    const f=await fixture();await expect(f.manager.cookieFiles.export(f.profile.id,'relative',{kind:'local',path:'private-relative.json'},profileScope)).rejects.toMatchObject({code:'BROWSER_PROFILE_COOKIE_FILE_REFUSED'});expect(f.confirm).not.toHaveBeenCalled();expect(f.read).not.toHaveBeenCalled()
  })
  it('reuses exact original Workspace byte/reveal owners without weakening the private new-file write mode',async()=>{
    const files={snapshotBytes:vi.fn(async()=>({offset:0,totalBytes:2,bytes:Buffer.from('[]')})),writeBytes:vi.fn(async()=>({status:'written'})),localPathForReveal:vi.fn(async()=>'/original/private.json')},resource={hostId:'local',workspaceId:'workspace',workspacePath:'/original'},workspace={...resource,id:'workspace',path:'/original'}
    const io=createProfileCookieFileIo({files:files as never,workspace:r=>{expect(r).toEqual(resource);return workspace as never},revealLocal:vi.fn()}),location={kind:'workspace' as const,resource,path:'selected.json'}
    expect(Buffer.from(await io.read(location)).toString()).toBe('[]');expect(await io.write(location,Buffer.from('[]'))).toEqual({status:'written'});expect(files.writeBytes).toHaveBeenCalledWith(workspace,{path:'selected.json',bytes:Buffer.from('[]'),createMode:0o600});expect(await io.reveal(location)).toBe(true);expect(files.localPathForReveal).toHaveBeenCalledWith(workspace,'selected.json')
  })
  it('strict public DTOs cannot self-grant approval, leak Cookie content, accept another target, or certify unwritten exports',()=>{
    const request={operation:'browser.profile.cookie-file.export' as const,profileId:'profile',operationId:'original',destination:{kind:'local' as const,path:'/out.json'},scope:profileScope},counts={total:0,applied:0,skipped:0,rejected:0,unknown:0,notAttempted:0},receipt={profileId:'profile',operationId:'original',kind:'export' as const,scope:profileScope,status:'completed' as const,fileOutcome:'written' as const,counts}
    expect(()=>parseBrowserProfileCookieFilePayload({...request,approved:true})).toThrow();expect(()=>rpcControlRequest(request.operation,{...request,caller:{agentSessionId:'spoofed'}})).toThrow()
    for(const fileOutcome of [undefined,'unknown','not-written'])expect(()=>parseBrowserProfileCookieFileReceipt({...receipt,fileOutcome})).toThrow()
    expect(()=>parseBrowserProfileCookieFileReceipt({...receipt,value:'secret'})).toThrow();expect(()=>assertBrowserProfileCookieFileTarget(request,{operation:request.operation,receipt:{...receipt,profileId:'foreign'}})).toThrow()
    const actual=parseBrowserProfileCookieFileResult(request.operation,{receipt});expect(()=>assertBrowserProfileCookieFileTarget(request,actual)).not.toThrow();const{operation,...input}=request,rpc=rpcControlRequest(operation,input);expect(rpc.requestId).not.toBe('original');expect(rpc.operationId).toBe('original')
  })
  it('executes compiled public CLI and six trusted GUI handlers through the same original Profile owner and safe protocol',async()=>{
    const f=await fixture(),core=await privateRpcCorePort(join(f.root,'sessions.json'),join(f.root,'messages.ndjson')),server=new AgentMuxControlServer({socketPath:join(f.root,'control.sock'),coreClients:core.clients,execute:(request,context)=>executeBrowserProfileControl(request as never,{profiles:f.manager,usage:{} as never,network:{} as never},context?.actor)});await server.start()
    try{
      const env=objectCliEnvironment(f.root,{NODE_NO_WARNINGS:'1'}),cli=async(method:string,input:object)=>{const r=await runCompiledObjectCli(['browser','profile','cookie-file',method,'--input','-'],env,JSON.stringify(input));expect(r.code,r.stderr||r.stdout).toBe(0);expect(r.stdout+r.stderr).not.toMatch(/VALUE-DO-NOT-PUBLISH|private-token-source/);return JSON.parse(r.stdout).result}
      const review=await cli('prepare-import',{profileId:f.profile.id,operationId:'cli-original',source:await f.source([cookie()]),scope:siteScope});expect(review.review).toMatchObject({reviewId:'cli-original',valid:1})
      const imported=await cli('import',{profileId:f.profile.id,reviewId:'cli-original'});expect(imported.receipt).toMatchObject({status:'completed',operationId:'cli-original'});expect((await cli('inspect',{profileId:f.profile.id,operationId:'cli-original'})).receipt).toEqual(imported.receipt)
      const repeated=await runCompiledObjectCli(['browser','profile','cookie-file','import','--input','-'],env,JSON.stringify({profileId:f.profile.id,reviewId:'cli-original'}));expect(repeated.code).not.toBe(0);expect(JSON.parse(repeated.stdout||repeated.stderr).error.code).toBe('BROWSER_PROFILE_COOKIE_FILE_ALREADY_ADMITTED')
      const invalid=await runCompiledObjectCli(['browser','profile','cookie-file','prepare-import','--input','-'],env,JSON.stringify({profileId:f.profile.id,operationId:'cli-refused',source:{kind:'local',path:'relative-private.json'},scope:profileScope}));expect(invalid.code).not.toBe(0);expect(JSON.parse(invalid.stdout||invalid.stderr).error.code).toBe('BROWSER_PROFILE_COOKIE_FILE_REFUSED')
      const handlers=new Map<string,Function>();registerBrowserProfileEditorIpc({profiles:f.manager,handle:(name,handler)=>{handlers.set(name,handler)}})
      for(const method of ['prepareProfileCookieImport','importProfileCookies','exportProfileCookies','inspectProfileCookieFiles','discardProfileCookieImport','revealProfileCookieFile'])expect(handlers.has('browser:'+method)).toBe(true)
      expect(await handlers.get('browser:inspectProfileCookieFiles')!({},f.profile.id,'cli-original')).toEqual({ok:true,value:await f.inspect('cli-original')})
      const help=await runCompiledObjectCli(['browser','profile','cookie-file','export','--help'],env);expect(help.code).toBe(0);expect(help.stdout).toContain('request text cannot grant');expect(help.stdout).toContain('--input')
      const skill=await runCompiledObjectCli(['browser','--skill'],env);expect(skill.code).toBe(0);expect(skill.stdout).toContain('amux browser profile cookie-file --help');expect(skill.stdout).toContain('CHIPS')
    }finally{await server.stop();await core.dispose()}
  },30_000)
})
