import { dialog, type BrowserWindow } from 'electron'
import type { ProfileCookieFileConfirmation } from './browser-profile-cookie-files.js'

/** The original Main native dialog is the only source of person approval. */
export async function confirmProfileCookieFile(request:ProfileCookieFileConfirmation,signal:AbortSignal,window:BrowserWindow,profile:{id:string;label:string}|undefined):Promise<boolean>{
  if(!profile||profile.id!==request.profileId||window.isDestroyed()||signal.aborted)return false
  const verb=request.kind==='import'?'Import':'Export',location=request.kind==='import'?request.source:request.destination
  const target=location?.kind==='workspace'?`Host ${location.resource.hostId}\nWorkspace ${location.resource.workspaceId}\nRoot ${location.resource.workspacePath}\nFile ${location.path}`:location?`Local Host\n${location.path}`:undefined
  const scope=request.scope.kind==='profile'?'All cookies in this Profile':`Selected sites (all their Cookie partition keys): ${request.scope.sites.join(', ')}`
  const answer=await dialog.showMessageBox(window,{type:'warning',buttons:['Cancel',verb+' cookies'],defaultId:0,cancelId:0,signal,
    message:`${verb} cookies ${request.kind==='import'?'into':'from'} “${profile.label}”?`,
    detail:`Profile ${request.profileId}\n${scope}\n${request.kind==='import'?'Selected source':'New export file'}: ${target??'Unavailable'}\n\n${request.kind==='import'?`${request.valid??0} eligible of ${request.total??0} source items. Exact matching Cookie keys may be replaced; unrelated Cookie keys and this Profile remain.`:'The new JSON file will contain private sign-in cookies in clear text. It is written only to this selected destination; existing files are kept.'}\n\nCookie values are not shown or returned through ordinary replies. An Agent request does not grant this permission.`})
  return answer.response===1&&!signal.aborted
}
