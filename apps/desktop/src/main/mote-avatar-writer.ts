import { nativeTheme } from 'electron'
import { avatarSeriesCanonical, isMoteAvatarSeriesChoice } from '@agentmux/core/mote-avatar-series'
import { parseMoteAvatarSave, parseMoteAvatarTarget, type MoteAvatarTarget, type MoteAvatarSave,
  type MoteAvatarRead, type MoteAvatarSaveResult, type MoteAvatarOperation } from '@agentmux/core/mote-avatar-write'
import { avatarActorIdentity, parseAvatarActor, type AvatarExecutionContext, type SpaceObjectImageTarget } from '@agentmux/core/object-avatar'
import type { AppConfig } from '../shared/contracts.js'
import type { MoteAvatarImage, MoteAvatarInput, MoteAvatarRef } from '../shared/mote-avatars.js'
import { rasterizeMoteAvatar } from './mote-avatar-raster.js'
import type { ConfigOwner } from './config-owner.js'
import type { MoteAvatarSeriesOwner } from './mote-avatar-series.js'
import type { ScratchTopics } from './scratch-topics.js'
import type { ConfigStore } from './config-store.js'
import { AvatarPublicationWriter } from './avatar-publication.js'
import { moteAvatarSnapshot, moteAvatarRevision } from './mote-avatar-snapshot.js'
export { moteAvatarRevision } from './mote-avatar-snapshot.js'
const message = (error: unknown) => (error instanceof Error ? error.message : String(error)).slice(0,2048)
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
    render: rasterizeMoteAvatar,
    prefersDark: () => nativeTheme.shouldUseDarkColors,
    confirm:saved=>store.confirmSaved(saved)
  })
}

/** Original ConfigOwner/PNG owner remain authoritative; this journal contains history only. */
export class MoteAvatarWriter {
  private readonly publication: AvatarPublicationWriter
  constructor(private readonly config: ConfigOwner, private readonly sources: MoteAvatarSeriesOwner,
    private readonly original: {
      directory(target:MoteAvatarTarget):Promise<string>;
      save(target:MoteAvatarTarget,input:MoteAvatarInput):Promise<MoteAvatarRef>;
      read(target:MoteAvatarTarget,ref:MoteAvatarRef):Promise<MoteAvatarImage>;
      render(svg:string):Promise<MoteAvatarImage>;
      prefersDark():boolean;
      /** Original configuration owner must acknowledge the exact saved bytes and directory sync. */
      confirm(saved:AppConfig):Promise<void>
    }) {
    const target = (value: MoteAvatarTarget | SpaceObjectImageTarget): MoteAvatarTarget => {
      if ('kind' in value) throw new Error('This is not the original Mote avatar target.')
      return value
    }
    this.publication = new AvatarPublicationWriter(config, sources, {
      directory: value => original.directory(target(value)), save: (value, input) => original.save(target(value), input),
      prefersDark: original.prefersDark, confirm: original.confirm
    })
  }

  async read(rawTarget:MoteAvatarTarget,operationId?:string):Promise<MoteAvatarRead> {
    const target=parseMoteAvatarTarget(rawTarget)
    await this.original.directory(target)
    const current=await this.config.inspect(config=>moteAvatarSnapshot(config,target,this.original.prefersDark()))
    const result:MoteAvatarRead={target,choice:current.choice,revision:current.revision,issues:current.issue ? [current.issue] : []}
    if (operationId!==undefined) { const operation=await this.publication.inspect(target,operationId);if (operation) result.operation=operation as MoteAvatarOperation }
    if (isMoteAvatarSeriesChoice(current.choice)) {
      try { result.image=await this.original.read(target,current.choice.image) } catch(error) { result.issues.push(message(error)) }
      try { const {origin,seriesId,entryId,revision}=current.choice.source;const prepared=await this.sources.preview({source:{origin,seriesId,entryId},expectedRevision:revision});if (avatarSeriesCanonical(prepared.definition)!==avatarSeriesCanonical(current.choice.definition)) throw new Error('The exact original definition is unavailable.');result.source={state:'available'} }
      catch(error) { result.source={state:(error as {code?:string}).code==='AVATAR_SOURCE_REVISION_CONFLICT'?'changed':'unavailable',issue:message(error)} }
    } else if (current.choice && typeof current.choice==='object' && 'kind' in current.choice && current.choice.kind==='image') {
      try { result.image=await this.original.read(target,current.choice as MoteAvatarRef) } catch(error) { result.issues.push(message(error)) }
    } else if (current.svg) {
      try {
        const image = await this.original.render(current.svg)
        const after = await this.config.inspect(config => moteAvatarRevision(config,target,this.original.prefersDark()))
        if (after !== current.revision) throw new Error('This Mote avatar changed while its image was being read. Refresh the same Mote profile.')
        result.image = image
      } catch (error) { result.issues.push(message(error)) }
    } else if (!current.issue) {
      result.issues.push('This saved Mote appearance is unsupported. Its original choice is retained; inspect the same avatar before creating its identity.')
    }
    return result
  }
  async save(raw:MoteAvatarSave, context?: AvatarExecutionContext):Promise<MoteAvatarSaveResult> {
    const input = structuredClone(parseMoteAvatarSave(raw))
    const readerIdentity = context ? avatarActorIdentity(parseAvatarActor(context.actor, 'CONTROL_PERMISSION_DENIED')) : undefined
    const result = await this.publication.save(input, context)
    return { ...result, current: { ...await this.read(input.target, input.operationId), ...(readerIdentity ? { readerIdentity } : {}) } } as MoteAvatarSaveResult
  }
}
