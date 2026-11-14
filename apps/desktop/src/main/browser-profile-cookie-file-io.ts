import { readFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { localMutablePathWithin, runWorkspaceFileWorker } from '@agentmux/host/ordinary-files'
import type { BrowserProfileCookieFileLocation } from '@agentmux/core/control'
import type { WorkspaceFiles } from './workspace-files.js'
import type { WorkspaceRecord } from '../shared/contracts.js'
export type ProfileCookieFileWrite = { status:'written'|'rejected'|'unknown' }
export type ProfileCookieFileIo = { read(location:BrowserProfileCookieFileLocation):Promise<Uint8Array>;write(location:BrowserProfileCookieFileLocation,bytes:Uint8Array):Promise<ProfileCookieFileWrite>;reveal(location:BrowserProfileCookieFileLocation):Promise<boolean> }
/** Reuse the original root-confined native file writer; Cookie bodies never become an IPC result. */
export function createProfileCookieFileIo(ports:{ files:Pick<WorkspaceFiles,'snapshotBytes'|'writeBytes'|'localPathForReveal'>; workspace(resource:Extract<BrowserProfileCookieFileLocation,{kind:'workspace'}>['resource']):WorkspaceRecord;
  revealLocal(path:string):Promise<void>|void; helperPath?:string }):ProfileCookieFileIo {
  const local = (location:Extract<BrowserProfileCookieFileLocation,{kind:'local'}>)=>{if(!isAbsolute(location.path))throw Error('A selected local Cookie file requires an absolute Host path.');return location.path}
  return {
    read:async location=>{
      if(location.kind==='local')return readFile(local(location))
      const result=await ports.files.snapshotBytes(ports.workspace(location.resource),location.path)
      if(result.offset!==0||result.bytes.byteLength!==result.totalBytes)throw Error('The complete original Workspace Cookie file could not be read.')
      return result.bytes
    },
    write:async(location,bytes)=>{
      if(location.kind==='workspace'){
        const result=await ports.files.writeBytes(ports.workspace(location.resource),{path:location.path,bytes,createMode:0o600})
        return {status:result.status==='written'?'written':result.status==='unknown'?'unknown':'rejected'}
      }
      try{
        const path=local(location),target=await localMutablePathWithin(dirname(path),basename(path))
        const result=JSON.parse((await runWorkspaceFileWorker(target.parent,target.root,{action:'write',name:target.name,expectedRevision:null,exclusive:true,createMode:0o600},
          {helperPath:ports.helperPath??resolve(import.meta.dirname,'../../resources/bin/agentmux-workspace-move'),workerSource:''},bytes)).toString('utf8'))
        return {status:result.status==='written'?'written':result.status==='unknown'?'unknown':'rejected'}
      }catch(cause){return {status:typeof cause==='object'&&cause!==null&&'writeOutcomeUnknown'in cause&&cause.writeOutcomeUnknown===true?'unknown':'rejected'}}
    },
    reveal:async location=>{
      if(location.kind==='local'){await ports.revealLocal(local(location));return true}
      const workspace=ports.workspace(location.resource);if(workspace.hostId!=='local')return false
      await ports.revealLocal(await ports.files.localPathForReveal(workspace,location.path));return true
    }
  }
}
