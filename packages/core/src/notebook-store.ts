import { watch, type FSWatcher } from 'node:fs'
import { mkdir, open, readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { createRequire } from 'node:module'
import { setTimeout as delay } from 'node:timers/promises'
import { durableWriteFile } from './durable-write.js'
import { defaultAgentMuxStateDirectory } from './runtime-paths.js'
import { AgentMuxError } from './errors.js'
import { applyNotebookChange, emptyNotebookState, parseNotebookState, type NotebookActor, type NotebookObservation, type NotebookState, type NotebookWrite } from './notebook-catalog.js'
export * from './notebook-catalog.js'
const nativeRequire = createRequire(import.meta.url)
/** One durable catalog, independent from App windows, open documents and spatial lifecycle. */
export class AgentMuxNotebookStore {
  constructor(readonly path = join(defaultAgentMuxStateDirectory(), 'notebooks.json')) {
    if(!isAbsolute(path))throw new AgentMuxError('Notebook storage needs an absolute owner path.','NOTEBOOK_INPUT_INVALID')
  }
  async read(): Promise<NotebookState> {
    try{return parseNotebookState(JSON.parse(await readFile(this.path,'utf8')))}catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return emptyNotebookState()
      throw new AgentMuxError('The Notebook directory could not be read. Original bytes, Note files and work surfaces are kept; restore or repair this same catalog.','NOTEBOOK_READ_UNCONFIRMED',error instanceof Error?error.message:String(error))
    }
  }
  async apply(input: NotebookWrite, actor: NotebookActor): Promise<NotebookState> {
    await mkdir(dirname(this.path),{recursive:true,mode:0o700})
    const lock=await open(this.path+'.lock','a+',0o600)
    try{
      const native:{tryLock(fd:number):boolean}=nativeRequire('fs-native-extensions'),deadline=Date.now()+5000
      while(!native.tryLock(lock.fd)){if(Date.now()>=deadline)throw new AgentMuxError('The original Notebook writer is busy. Keep the page and retry this same operation.','NOTEBOOK_BUSY');await delay(10)}
      const before=await this.read(),next=applyNotebookChange(before,input,actor,Date.now())
      if(next!==before)await durableWriteFile(this.path+'.previous',JSON.stringify(before)+'\n',{requireDirectorySync:true})
      // Reapplying an exact operation confirms the same current bytes after an unknown flush; it never rewrites Note bodies or repeats history.
      await durableWriteFile(this.path,JSON.stringify(next)+'\n',{requireDirectorySync:true})
      this.emit({state:next});return next
    }finally{await lock.close()}
  }
  private listeners=new Set<(event:NotebookObservation)=>void>()
  private watcher:FSWatcher|null=null
  private generation=0
  private emit(event:NotebookObservation):void{for(const listener of this.listeners)try{listener(structuredClone(event))}catch(error){process.emitWarning(String(error),{code:'NOTEBOOK_OBSERVATION_FAILED'})}}
  subscribe(listener:(event:NotebookObservation)=>void):()=>void{
    this.listeners.add(listener)
    if(this.listeners.size===1){const generation=++this.generation;void mkdir(dirname(this.path),{recursive:true,mode:0o700}).then(()=>{
      if(generation!==this.generation||!this.listeners.size)return
      this.watcher=watch(dirname(this.path),(_kind,name)=>{if(name!==null&&String(name)!==basename(this.path))return;void this.read().then(state=>{if(generation===this.generation)this.emit({state})}).catch(error=>{if(generation===this.generation)this.emit({issue:error.message})})})
      this.watcher.on('error',error=>this.emit({issue:'Notebook observation failed. Original knowledge is kept. '+error.message}))
      return this.read().then(state=>{if(generation===this.generation)this.emit({state})})
    }).catch(error=>{if(generation===this.generation)this.emit({issue:error.message})})}
    return()=>{this.listeners.delete(listener);if(!this.listeners.size){this.generation++;this.watcher?.close();this.watcher=null}}
  }
}
