import { createHash } from 'node:crypto'
import { isAbsolute, resolve } from 'node:path'
import { AgentMuxError, parseBrowserProfileCookieScope, parseBrowserProfileCookieFileLocation, type BrowserProfileCookieFileLocation as Location, type BrowserProfileCookieScope as Scope,
  type BrowserProfileCookieFileReceipt as Receipt, type BrowserProfileCookieFileItem as Item, type BrowserProfileCookieFileCounts as Counts, type BrowserProfileCookieImportReview as Review, type BrowserProfileCookieFileInspection } from '@agentmux/core/control'
import { canonicalCookieScope, decodeProfileCookieFile, planProfileCookieArray, cookieInScope, normalizeProfileFileCookie, profileCookieSite, type ProfileCookiePlan } from './browser-profile-cookie-file-format.js'
import type { BrowserProfileCookieFileRecord as Record } from './browser-profile-cookie-file-record.js'
import type { ProfileCookieFileNative } from './browser-profile-cookie-file-native.js'
import type { ProfileCookieFileIo } from './browser-profile-cookie-file-io.js'
export type ProfileCookieFileConfirmation = { kind:'import'|'export';profileId:string;profileLabel:string;operationId:string;scope:Scope;total?:number;valid?:number;source?:Location;destination?:Location }
type Ports = { read(profileId:string):Promise<Record[]>;change(profileId:string,action:(records:Record[])=>Record[]):Promise<Record[]>;
  track<T>(job:Promise<T>):Promise<T>;profile(profileId:string):{id:string;label:string};native(profileId:string,signal:AbortSignal):Promise<ProfileCookieFileNative>;now?:()=>number }
type Prepared = {review:Review;source:Location;sourceDigest:string;plan:ProfileCookiePlan;confirming:boolean}
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex')
const refused=(message:string):never=>{throw new AgentMuxError(message,'BROWSER_PROFILE_COOKIE_FILE_REFUSED')}
const already=():never=>{throw new AgentMuxError('This original Cookie file operation already has an intent or receipt. Inspect the same Profile and original ID; it will not be replayed.','BROWSER_PROFILE_COOKIE_FILE_ALREADY_ADMITTED')}
const original=(records:Record[],id:string)=>{if(typeof id!=='string'||!id.trim()||/[\u0000-\u001f\u007f]/u.test(id))refused('Keep a valid original Cookie file operation ID.');if(records.some(r=>r.receipt.operationId===id))already()}
const safe=(r:Record):Receipt=>structuredClone(r.receipt)
function counts(items:Item[]):Counts {const c:Counts={total:items.length,applied:0,skipped:0,rejected:0,unknown:0,notAttempted:0};for(const item of items){if(item.status==='not-attempted')c.notAttempted++;else c[item.status]++}return c}
function status(c:Counts):Receipt['status'] {return c.unknown?'pending':c.rejected||c.skipped||c.notAttempted?c.applied?'partial':'failed':'completed'}
const key=(profileId:string,id:string)=>profileId+'\0'+id
/** Native Cookie values never enter the Profile record or ordinary response. */
export class BrowserProfileCookieFiles {
  private readonly prepared=new Map<string,Prepared>()
  private readonly active=new Set<string>()
  private io:ProfileCookieFileIo|undefined
  private confirm:((request:ProfileCookieFileConfirmation,signal:AbortSignal)=>Promise<boolean>)|undefined
  private readonly confirmations=new Set<AbortController>()
  private readonly nativeControllers=new Set<AbortController>()
  private disposed=false
  constructor(private readonly ports:Ports){}
  setFileOwner(io:ProfileCookieFileIo):void{this.io=io}
  setConfirmationHandler(confirm:(request:ProfileCookieFileConfirmation,signal:AbortSignal)=>Promise<boolean>):void{this.confirm=confirm}
  private fileOwner():ProfileCookieFileIo {if(!this.io)throw new AgentMuxError('The original Cookie file owner is unavailable. Profiles and existing pages remain available.','HOST_CAPABILITY_UNAVAILABLE');return this.io}
  private confirmation():NonNullable<BrowserProfileCookieFiles['confirm']>{if(!this.confirm)throw new AgentMuxError('Cookie import and export require the original host person-confirmation owner. Request text cannot grant permission.','BROWSER_PROFILE_COOKIE_APPROVAL_UNAVAILABLE');return this.confirm}
  private async approve(request:ProfileCookieFileConfirmation):Promise<boolean>{
    const confirm=this.confirmation(),controller=new AbortController();this.confirmations.add(controller)
    try{if(this.disposed)controller.abort();return await confirm(request,controller.signal)===true}catch{throw new AgentMuxError('The original person confirmation could not be obtained. Cookie data and healthy pages remain available.','BROWSER_PROFILE_COOKIE_APPROVAL_UNAVAILABLE')}finally{this.confirmations.delete(controller)}
  }
  private now():number{return (this.ports.now?.()??Date.now())/1000}
  private async record(profileId:string,id:string):Promise<Record|undefined>{return(await this.ports.read(profileId)).find(r=>r.receipt.operationId===id)}
  private scope(scope:Scope):Scope{try{return canonicalCookieScope(parseBrowserProfileCookieScope(scope))}catch{return refused('Choose the entire Profile or exact current site names for this Cookie operation.')}}
  private location(location:Location):Location{try{const parsed=parseBrowserProfileCookieFileLocation(location);if(parsed.kind==='local'){if(!isAbsolute(parsed.path))throw Error('relative');return{kind:'local',path:resolve(parsed.path)}}return parsed}catch{return refused('Choose an exact local file or an original Workspace file resource.')}}
  async prepareImport(profileId:string,operationId:string,source:Location,scope:Scope):Promise<Review>{
    original(await this.ports.read(profileId),operationId);this.ports.profile(profileId)
    const id=key(profileId,operationId);if(this.prepared.has(id)||this.active.has(id))already()
    if(this.disposed)refused('The original Cookie file owner has been disposed.');const actualSource=this.location(source),actualScope=this.scope(scope)
    let bytes:Uint8Array|undefined,plan:ProfileCookiePlan|undefined,failure:string|undefined
    try{bytes=await this.fileOwner().read(actualSource)}catch{failure='The complete selected Cookie file could not be read through its original file owner. Its filename and content are kept private; the Profile is unchanged.'}
    if(bytes)try{plan=decodeProfileCookieFile(bytes,actualScope,this.now())}catch{failure='The selected Cookie file must contain a valid UTF-8 JSON array. The original file, Profile and cookies are kept.'}
    original(await this.ports.read(profileId),operationId);if(this.prepared.has(id)||this.active.has(id))already();if(failure)refused(failure);if(this.disposed)refused('The original Cookie file owner has been disposed.')
    const review:Review={reviewId:operationId,profileId,scope:actualScope,total:plan!.items.length,valid:plan!.items.filter(i=>i.cookie).length,skipped:plan!.items.filter(i=>!i.cookie).length,sites:plan!.sites,sourceKind:actualSource.kind}
    if(this.prepared.has(id)||this.active.has(id))already()
    this.prepared.set(id,{review,source:actualSource,sourceDigest:sha(bytes!),plan:plan!,confirming:false});return structuredClone(review)
  }
  async discard(profileId:string,reviewId:string):Promise<{profileId:string;reviewId:string;discarded:true}>{
    const id=key(profileId,reviewId),stage=this.prepared.get(id)
    await this.ports.change(profileId,records=>{original(records,reviewId);if(!stage)refused('The original prepared import is unavailable. Choose the file again as a new explicit operation.');records.push(this.importRecord(stage!,'cancelled',false));return records})
    this.prepared.delete(id);return{profileId,reviewId,discarded:true}
  }
  private importRecord(stage:Prepared,state:Receipt['status'],approved:boolean):Record{
    const items=stage.plan.items.map(i=>i.cookie&&state==='cancelled'?{index:i.index,status:'not-attempted' as const,reason:'not-dispatched' as const}:structuredClone(i.result))
    return{receipt:{operationId:stage.review.reviewId,profileId:stage.review.profileId,kind:'import',scope:structuredClone(stage.review.scope),status:state,counts:counts(items)},items,approved,source:structuredClone(stage.source),sourceDigest:stage.sourceDigest}
  }
  private async append(profileId:string,record:Record):Promise<void>{await this.ports.change(profileId,records=>{original(records,record.receipt.operationId);records.push(structuredClone(record));return records})}
  private async update(profileId:string,record:Record):Promise<Receipt>{
    const records=await this.ports.change(profileId,records=>{const index=records.findIndex(r=>r.receipt.operationId===record.receipt.operationId);if(index<0||records[index]!.receipt.status!=='pending')already();records[index]=structuredClone(record);return records})
    return safe(records.find(r=>r.receipt.operationId===record.receipt.operationId)!)
  }
  import(profileId:string,reviewId:string):Promise<Receipt>{return this.ports.track(this.importOwned(profileId,reviewId))}
  private async importOwned(profileId:string,reviewId:string):Promise<Receipt>{
    original(await this.ports.read(profileId),reviewId)
    const id=key(profileId,reviewId),stage=this.prepared.get(id);if(!stage)refused('The original prepared Cookie import is unavailable. Select the source again as a new explicit operation.')
    if(stage!.confirming||this.active.has(id))already()
    this.confirmation();const profile=this.ports.profile(profileId);stage!.confirming=true
    try{
      const approved=await this.approve({kind:'import',profileId,profileLabel:profile.label,operationId:reviewId,scope:structuredClone(stage!.review.scope),total:stage!.review.total,valid:stage!.review.valid,source:structuredClone(stage!.source)})
      if(this.prepared.get(id)!==stage)already()
      const record=this.importRecord(stage!,approved?'pending':'cancelled',approved)
      await this.append(profileId,record);this.prepared.delete(id)
      if(!approved)return safe(record)
      this.active.add(id)
      const nativeAbort=new AbortController();this.nativeControllers.add(nativeAbort);if(this.disposed)nativeAbort.abort()
      let native:ProfileCookieFileNative|undefined
      try{
        for(const item of stage!.plan.items)if(item.cookie?.expires!==null&&item.cookie?.expires!==undefined&&item.cookie.expires<=this.now())record.items[item.index]={index:item.index,status:'skipped',reason:'expired'}
        if(stage!.plan.items.some(i=>i.cookie&&record.items[i.index]!.status!=='skipped'))native=await this.ports.native(profileId,nativeAbort.signal)
        let stopped=false
        for(const item of stage!.plan.items){
          if(!item.cookie||record.items[item.index]!.status==='skipped')continue
          if(stopped){record.items[item.index]={index:item.index,status:'not-attempted',reason:'not-dispatched'};continue}
          if(item.cookie.expires!==null&&item.cookie.expires<=this.now()){record.items[item.index]={index:item.index,status:'skipped',reason:'expired'};continue}
          try{this.ports.profile(profileId)}catch{record.items[item.index]={index:item.index,status:'not-attempted',reason:'not-dispatched'};stopped=true;continue}
          try{const accepted=await native!.set(item.cookie);record.items[item.index]=accepted==='applied'?{index:item.index,status:'applied'}:accepted==='expired'?{index:item.index,status:'skipped',reason:'expired'}:{index:item.index,status:'rejected',reason:'native-rejected'}}
          catch{record.items[item.index]={index:item.index,status:'unknown',reason:'native-unconfirmed'};stopped=true}
        }
        if(native)try{await native.flush()}catch{record.receipt.warning='Cookie persistence confirmation is unavailable. The original Profile and received item outcomes are kept; inspect this original operation before another action.'}
      }catch{record.items=record.items.map(i=>i.status==='unknown'?{index:i.index,status:'not-attempted' as const,reason:'not-dispatched' as const}:i);record.receipt.warning='The original Profile Cookie connection is unavailable. Its existing pages and original data remain; no automatic retry will be made.'}
      finally{if(native)try{await native.close()}catch{record.receipt.warning='The auxiliary Cookie connection cleanup is unconfirmed. Existing pages remain available.'}this.nativeControllers.delete(nativeAbort)}
      record.receipt.counts=counts(record.items);record.receipt.status=status(record.receipt.counts)
      if(record.receipt.warning&&record.receipt.status==='completed')record.receipt.status='partial'
      return await this.update(profileId,record)
    }finally{if(this.prepared.get(id)===stage)stage!.confirming=false;this.active.delete(id)}
  }
  export(profileId:string,operationId:string,destination:Location,scope:Scope):Promise<Receipt>{return this.ports.track(this.exportOwned(profileId,operationId,destination,scope))}
  private async exportOwned(profileId:string,operationId:string,destination:Location,scope:Scope):Promise<Receipt>{
    original(await this.ports.read(profileId),operationId)
    const id=key(profileId,operationId);if(this.active.has(id)||this.prepared.has(id))already()
    const actualDestination=this.location(destination),actualScope=this.scope(scope),profile=this.ports.profile(profileId);this.confirmation();this.active.add(id)
    try{
      const approved=await this.approve({kind:'export',profileId,profileLabel:profile.label,operationId,scope:structuredClone(actualScope),destination:structuredClone(actualDestination)})
      const record:Record={receipt:{operationId,profileId,kind:'export',scope:actualScope,status:approved?'pending':'cancelled',fileOutcome:approved?'unknown':'not-written',counts:counts([])},items:[],approved,destination:actualDestination}
      await this.append(profileId,record);if(!approved)return safe(record)
      const nativeAbort=new AbortController();this.nativeControllers.add(nativeAbort);if(this.disposed)nativeAbort.abort()
      let native:ProfileCookieFileNative|undefined,raw:unknown[]
      try{native=await this.ports.native(profileId,nativeAbort.signal);raw=await native.read();if(!Array.isArray(raw))throw Error('Incomplete Cookie source')}
      catch{record.receipt.status='failed';record.receipt.fileOutcome='not-written';record.receipt.warning='The original Profile did not provide a complete Cookie collection. No export file was written; its existing pages and data are kept.';return await this.update(profileId,record)}
      finally{if(native)try{await native.close()}catch{record.receipt.warning='The auxiliary Cookie connection cleanup is unconfirmed. Existing pages remain available.'}this.nativeControllers.delete(nativeAbort)}
      // Select only the explicit site scope before building a file; never broaden a failed match.
      const selected=raw!.filter(value=>{try{return actualScope.kind==='profile'||actualScope.sites.includes(profileCookieSite((value as {domain:string}).domain))}catch{return true}})
      const plan=planProfileCookieArray(selected,actualScope,this.now()),cookies=plan.items.flatMap(i=>i.cookie?[i.cookie]:[])
      record.items=plan.items.map(i=>structuredClone(i.result));record.receipt.counts=counts(record.items)
      const bytes=Buffer.from(JSON.stringify(cookies,null,2)+'\n');record.outputDigest=sha(bytes)
      await this.update(profileId,record) // Same original durable writer confirms exact output bytes before file effects.
      let outcome:'written'|'rejected'|'unknown'='unknown';try{outcome=(await this.fileOwner().write(actualDestination,bytes)).status}catch{}
      if(outcome==='written'){
        record.receipt.fileOutcome='written';record.items=record.items.map(i=>i.status==='unknown'?{index:i.index,status:'applied' as const}:i);record.receipt.counts=counts(record.items);record.receipt.status=status(record.receipt.counts)
      }else{record.receipt.fileOutcome=outcome==='unknown'?'unknown':'not-written';if(outcome==='rejected')record.items=record.items.map(i=>i.status==='unknown'?{index:i.index,status:'not-attempted' as const,reason:'not-dispatched' as const}:i);record.receipt.counts=counts(record.items);record.receipt.status=outcome==='unknown'?'pending':'failed';record.receipt.warning=outcome==='unknown'?'The original export file write is unconfirmed. Keep this operation ID and inspect its selected output; it will not be written again automatically.':'The selected export file was not written. An existing file was kept; choose a new explicit destination after inspecting this original operation.'}
      return await this.update(profileId,record)
    }finally{this.active.delete(id)}
  }
  async inspect(profileId:string,operationId?:string,offset=0,limit=64):Promise<BrowserProfileCookieFileInspection>{
    if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>64)throw new AgentMuxError('Choose a valid original Cookie item page.','INVALID_CONTROL_REQUEST')
    const records=await this.ports.read(profileId),record=operationId===undefined?undefined:records.find(r=>r.receipt.operationId===operationId),items=record?.items.slice(offset,offset+limit)??[]
    return{profileId,pending:records.filter(r=>r.receipt.status==='pending').map(safe),recent:records.slice(-5).reverse().map(safe),...(operationId===undefined?{}:{receipt:record?safe(record):null}),items:structuredClone(items),offset,nextOffset:record&&offset+items.length<record.items.length?offset+items.length:null}
  }
  async reveal(profileId:string,operationId:string):Promise<{profileId:string;operationId:string;revealed:boolean}>{
    const record=await this.record(profileId,operationId);if(!record||record.receipt.kind!=='export'||!record.approved||!record.destination){throw new AgentMuxError('Only an original person-approved export location can be revealed.','INVALID_CONTROL_REQUEST')}
    let revealed=false;try{revealed=await this.fileOwner().reveal(record!.destination!)}catch{}
    return{profileId,operationId,revealed}
  }
  dispose():void{this.disposed=true;for(const controller of this.confirmations)controller.abort();for(const controller of this.nativeControllers)controller.abort();this.prepared.clear()}
}
