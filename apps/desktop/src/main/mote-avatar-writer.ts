import { createHash } from 'node:crypto'
import { constants, lstat, mkdir, open, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteFile } from '@agentmux/core'
import { avatarSeriesCanonical, isMoteAvatarSeriesChoice, type MoteAvatarSeriesChoice } from '@agentmux/core/mote-avatar-series'
import { parseMoteAvatarSave, parseMoteAvatarTarget, parseMoteAvatarOperationId,
  type MoteAvatarTarget, type MoteAvatarSave, type MoteAvatarOperation, type MoteAvatarRead, type MoteAvatarSaveResult } from '@agentmux/core/mote-avatar-write'
import type { AppConfig } from '../shared/contracts.js'
import type { MoteAvatarImage, MoteAvatarInput, MoteAvatarRef } from '../shared/mote-avatars.js'
import type { ConfigOwner } from './config-owner.js'
import type { MoteAvatarSeriesOwner } from './mote-avatar-series.js'
import type { ScratchTopics } from './scratch-topics.js'
import type { ConfigStore } from './config-store.js'

const hash = (value: string) => 'sha256:' + createHash('sha256').update(value).digest('hex')
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0,2048)
function rawChoice(config: AppConfig, target: MoteAvatarTarget): unknown {
  const icons = config.appearance.spaceObjectIcons
  return icons && Object.hasOwn(icons,target.objectKey) ? icons[target.objectKey] : undefined
}
export function moteAvatarRevision(config: AppConfig, target: MoteAvatarTarget): string {
  const value = rawChoice(config,target)
  return hash(avatarSeriesCanonical({...(value===undefined?{present:false}:{present:true,value}),publication:config.appearance.spaceObjectIconRevisions?.[target.objectKey]??null}))
}

/** Production IPC, native RPC and bounded fixtures share the actual original owners. */
export function createMoteAvatarWriter(config:ConfigOwner,sources:MoteAvatarSeriesOwner,topics:ScratchTopics,store:ConfigStore):MoteAvatarWriter {
  const workspace=(target:MoteAvatarTarget)=>{
    const selected=config.current.workspaces.find(value=>value.id===target.workspaceId)
    if (!selected) throw new Error('The original Mote workspace is unavailable. Its appearance and work are retained.')
    return selected
  }
  return new MoteAvatarWriter(config,sources,{
    directory:target=>topics.avatarTargetDirectory(workspace(target),target.topicId,target.objectKey),
    save:(target,input)=>topics.saveAvatar(workspace(target),target.topicId,input,target.objectKey),
    read:(target,ref)=>topics.readAvatar(workspace(target),target.topicId,ref,target.objectKey),
    confirm:saved=>store.confirmSaved(saved)
  })
}
type Record = { schema:'agentmux.avatar-operation.v1'; target:MoteAvatarTarget; operation:MoteAvatarOperation }

/** Original ConfigOwner/PNG owner remain authoritative; this journal contains history only. */
export class MoteAvatarWriter {
  private readonly active = new Map<string,Promise<void>>()
  constructor(private readonly config: ConfigOwner, private readonly sources: MoteAvatarSeriesOwner,
    private readonly original: {
      directory(target:MoteAvatarTarget):Promise<string>;
      save(target:MoteAvatarTarget,input:MoteAvatarInput):Promise<MoteAvatarRef>;
      read(target:MoteAvatarTarget,ref:MoteAvatarRef):Promise<MoteAvatarImage>;
      /** Original configuration owner must acknowledge the exact saved bytes and directory sync. */
      confirm(saved:AppConfig):Promise<void>
    }) {}

  private async journalDirectory(target:MoteAvatarTarget, create=false):Promise<string> {
    const original=await this.original.directory(target)
    let current=original
    for (const name of ['', '.agentmux','avatar-operations']) {
      if (name) current=join(current,name)
      if (create && name) { try { await mkdir(current,{mode:0o700}) } catch(error) { if ((error as NodeJS.ErrnoException).code!=='EEXIST') throw error } }
      const info=await lstat(current)
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(current)!==current) throw new Error('The original avatar operation directory is unconfirmed.')
      if (create) { const handle=await open(current,constants.O_RDONLY|constants.O_NOFOLLOW);try { await handle.sync() } finally { await handle.close() } }
    }
    // Persist newly created metadata/receipt directory entries in their actual parents.
    if (create) for (const parent of [join(original,'.agentmux'),original]) {
      const handle=await open(parent,constants.O_RDONLY|constants.O_NOFOLLOW);try { await handle.sync() } finally { await handle.close() }
    }
    return current
  }
  private async inspect(target:MoteAvatarTarget, operationId:string):Promise<MoteAvatarOperation|undefined> {
    parseMoteAvatarOperationId(operationId)
    try {
      const file=join(await this.journalDirectory(target),operationId+'.json')
      const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
      let bytes:Buffer
      try { const stat=await handle.stat();if (!stat.isFile() || stat.size>32*1024*1024) throw new Error('The original avatar receipt is unreadable.');bytes=await handle.readFile();const after=await handle.stat();if (bytes.length!==stat.size || after.size!==stat.size || after.mtimeMs!==stat.mtimeMs) throw new Error('The original avatar receipt changed while reading.') } finally { await handle.close() }
      const record=JSON.parse(bytes.toString()) as Record
      if (record.schema!=='agentmux.avatar-operation.v1' || avatarSeriesCanonical(record.target)!==avatarSeriesCanonical(target) || record.operation?.operationId!==operationId || !/^sha256:[a-f0-9]{64}$/u.test(record.operation.requestHash) || !['intent','asset','publication-unknown','published'].includes(record.operation.phase) || !['unknown','confirmed'].includes(record.operation.durability) || record.operation.phase!=='intent' && !isMoteAvatarSeriesChoice(record.operation.choice) || record.operation.durability==='confirmed' && record.operation.phase!=='published') throw new Error('The original avatar receipt is unreadable. Keep this operationId and inspect its original file.')
      return record.operation
    } catch(error) { if ((error as NodeJS.ErrnoException).code==='ENOENT') return undefined; throw error }
  }
  private async record(target:MoteAvatarTarget,operation:MoteAvatarOperation):Promise<void> {
    await durableWriteFile(join(await this.journalDirectory(target,true),operation.operationId+'.json'),JSON.stringify({schema:'agentmux.avatar-operation.v1',target,operation})+'\n',{requireDirectorySync:true})
  }
  async read(rawTarget:MoteAvatarTarget,operationId?:string):Promise<MoteAvatarRead> {
    const target=parseMoteAvatarTarget(rawTarget)
    await this.original.directory(target)
    const current=await this.config.inspect(config=>({choice:structuredClone(rawChoice(config,target)??null),revision:moteAvatarRevision(config,target)}))
    const result:MoteAvatarRead={target,...current,issues:[]}
    if (operationId!==undefined) { const operation=await this.inspect(target,operationId);if (operation) result.operation=operation }
    if (isMoteAvatarSeriesChoice(current.choice)) {
      try { result.image=await this.original.read(target,current.choice.image) } catch(error) { result.issues.push(message(error)) }
      try { const {origin,seriesId,entryId,revision}=current.choice.source;const prepared=await this.sources.preview({source:{origin,seriesId,entryId},expectedRevision:revision});if (avatarSeriesCanonical(prepared.definition)!==avatarSeriesCanonical(current.choice.definition)) throw new Error('The exact original definition is unavailable.');result.source={state:'available'} }
      catch(error) { result.source={state:(error as {code?:string}).code==='AVATAR_SOURCE_REVISION_CONFLICT'?'changed':'unavailable',issue:message(error)} }
    } else if (current.choice && typeof current.choice==='object' && 'kind' in current.choice && current.choice.kind==='image') {
      try { result.image=await this.original.read(target,current.choice as MoteAvatarRef) } catch(error) { result.issues.push(message(error)) }
    }
    return result
  }
  async save(raw:MoteAvatarSave):Promise<MoteAvatarSaveResult> {
    const input=structuredClone(parseMoteAvatarSave(raw)), key=avatarSeriesCanonical(input.target)
    const previous=this.active.get(key)
    let release!:()=>void
    const complete=new Promise<void>(resolve=>{release=resolve})
    const reserved=Promise.resolve(previous).then(()=>complete)
    this.active.set(key,reserved)
    await previous
    try { return await this.commit(input) } finally { release();if (this.active.get(key)===reserved) this.active.delete(key) }
  }
  private async commit(input:MoteAvatarSave):Promise<MoteAvatarSaveResult> {
    const {target,operationId}=input, requestHash=hash(avatarSeriesCanonical(input))
    const originalWorkspace=await this.config.inspect(current=>{
      const workspace=current.workspaces.find(value=>value.id===target.workspaceId)
      if (!workspace) throw new Error('The original Mote workspace is unavailable.')
      return {id:workspace.id,hostId:workspace.hostId,path:workspace.path,kind:workspace.kind}
    })
    // Exact target proof is repeated by the original asset owner and each journal write.
    await this.original.directory(target)
    let operation=await this.inspect(target,operationId)
    if (operation && operation.requestHash!==requestHash) return {state:'refused',issue:'This operationId belongs to a different original request.',operation,current:await this.read(target,operationId)}
    if (operation && ['publication-unknown','published'].includes(operation.phase)) return {state:operation.phase==='published'&&operation.durability==='confirmed'?'saved':'unknown',operation,current:await this.read(target,operationId)}
    try {
      const {origin,seriesId,entryId,revision}=input.source
      const prepared=await this.sources.preview({source:{origin,seriesId,entryId},expectedRevision:revision})
      if (avatarSeriesCanonical(prepared.definition)!==avatarSeriesCanonical(input.definition)) throw new Error('The selected original avatar definition changed.')
      await this.config.inspect(config=>{if (moteAvatarRevision(config,target)!==input.beforeRevision) throw new Error('This Mote avatar changed while editing. Read its current choice before saving again.')})
    } catch(error) { return {state:'refused',issue:message(error),...(operation?{operation}:{}),current:await this.read(target,operationId)} }
    try {
      operation??={operationId,requestHash,phase:'intent',durability:'unknown'}
      await this.record(target,operation)
      const image=await this.original.save(target,{mimeType:'image/png',dataUrl:input.pngDataUrl})
      const choice:MoteAvatarSeriesChoice={kind:'series',source:input.source,definition:input.definition,parameters:input.parameters,image}
      operation={operationId,requestHash,phase:'asset',durability:'unknown',choice}
      await this.record(target,operation)
      // Persist ambiguity BEFORE attempting publication. A crash/lost ACK never permits replay.
      operation={...operation,phase:'publication-unknown'}
      await this.record(target,operation)
      await this.original.directory(target)
      const saved=await this.config.update(current=>{
        const workspace=current.workspaces.find(value=>value.id===target.workspaceId)
        if (!workspace || avatarSeriesCanonical({id:workspace.id,hostId:workspace.hostId,path:workspace.path,kind:workspace.kind})!==avatarSeriesCanonical(originalWorkspace))
          throw new Error('The original Mote workspace changed before publication. Its current avatar and work remain available.')
        if (moteAvatarRevision(current,target)!==input.beforeRevision) throw new Error('This Mote avatar changed while the image was saving. Its later choice is retained.')
        return {...current,appearance:{...current.appearance,spaceObjectIcons:{...current.appearance.spaceObjectIcons,[target.objectKey]:choice}}}
      })
      await this.original.confirm(saved)
      operation={...operation,phase:'published',durability:'confirmed'}
      await this.record(target,operation)
      return {state:'saved',operation,current:await this.read(target,operationId)}
    } catch(error) {
      // Retain PNG/current preference and the original request. Never infer prior publication
      // from today's value or start a replacement operation automatically.
      return {state:'unknown',...(operation?{operation:{...operation,issue:message(error)}}:{}),issue:message(error),current:await this.read(target,operationId)}
    }
  }
}
