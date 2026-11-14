import { BrowserWindow, type Session } from 'electron'
import { profileCookieParam, type ProfileFileCookie } from './browser-profile-cookie-file-format.js'
export type ProfileCookieFileNative = { read(): Promise<unknown[]>; set(cookie: ProfileFileCookie): Promise<'applied'|'rejected'|'expired'>; flush(): Promise<void>; close(): Promise<void> }
/** Target-bound Network Cookie calls preserve this Session's partition keys; never attach to a user's page. */
export async function openProfileCookieFileNative(target: Session, signal?:AbortSignal): Promise<ProfileCookieFileNative> {
  signal?.throwIfAborted()
  const helper = new BrowserWindow({ show:false, webPreferences:{session:target,contextIsolation:true,nodeIntegration:false,sandbox:true} })
  const abort=()=>{try{if(!helper.isDestroyed())helper.destroy()}catch{}};signal?.addEventListener('abort',abort,{once:true})
  try {
    await helper.loadURL('data:text/html,<!doctype html><title>Profile Cookie file operation</title>')
    if (helper.webContents.session !== target) throw new Error('The original Cookie Session binding is unavailable.')
    helper.webContents.debugger.attach('1.3'); await helper.webContents.debugger.sendCommand('Network.enable')
    const exact = () => { signal?.throwIfAborted();if (helper.isDestroyed() || helper.webContents.isDestroyed() || helper.webContents.session !== target || !helper.webContents.debugger.isAttached()) throw new Error('The original Cookie Session connection is unavailable.') }
    return {
      read:async()=>{exact();const result=await helper.webContents.debugger.sendCommand('Network.getAllCookies');if(!result||!Array.isArray(result.cookies))throw new Error('The original Cookie Session returned no complete Cookie collection.');return result.cookies},
      set:async cookie=>{exact();if(cookie.expires!==null&&cookie.expires<=Date.now()/1000)return 'expired';const result=await helper.webContents.debugger.sendCommand('Network.setCookie',profileCookieParam(cookie));if(!result||typeof result.success!=='boolean')throw new Error('The original Cookie write receipt is unavailable.');return result.success?'applied':'rejected'},
      flush:async()=>{exact();await target.cookies.flushStore()},
      close:async()=>{signal?.removeEventListener('abort',abort);let failed=false;try{if(!helper.isDestroyed()&&helper.webContents.debugger.isAttached())helper.webContents.debugger.detach()}catch{failed=true}finally{if(!helper.isDestroyed())helper.destroy()}if(failed)throw new Error('The auxiliary Cookie connection cleanup is unconfirmed.')}
    }
  } catch { signal?.removeEventListener('abort',abort);if(!helper.isDestroyed())helper.destroy();throw new Error('The original Profile Cookie connection could not be opened. Its existing pages remain available.') }
}
