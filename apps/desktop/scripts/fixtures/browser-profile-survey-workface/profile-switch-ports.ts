import assert from 'node:assert/strict'
import { session, type BrowserWindow, type WebContentsView } from 'electron'
import { browserProfilePartition } from '../../../src/main/browser-profile-store'
import { BROWSER_EVENT_CHANNEL } from '../../../src/shared/contracts'
import { unwrapIpcResult } from '../../../src/shared/ipc-result'

type HeldReply = { channel: 'browser:create' | 'browser:switchProfile'; browserId?: string; call?: any; release?: (lose: boolean) => void }

/** Fixture observation/ACK faults around the original handler; it never supplies a Main policy or result. */
export function profileSwitchPorts(window: BrowserWindow, receipt: any, directoryFault: (enabled: boolean) => void,
  metadataFault: (browserId: string | null) => void, nextCreateMetadataFault: () => void) {
  let held: HeldReply | null = null
  let heldUpdates: { browserId: string; events: { channel: string; args: any[]; send: (channel: string, ...args: any[]) => void }[] } | null = null
  const calls: any[] = []
  const originals = new Map<string, WebContentsView>()
  receipt.profileSwitchMainCalls = calls
  const tracked = new Set(['browser:create', 'browser:switchProfile', 'browser:navigate', 'browser:close', 'browser:setDefaultProfile'])
  return {
    directoryFault,
    metadataFault,
    nextCreateMetadataFault,
    calls,
    holdUpdates(browserId: string) { assert.equal(heldUpdates,null,'Keep the original held update delivery');heldUpdates={browserId,events:[]} },
    heldUpdateCount(profileId?: string) { return heldUpdates?.events.filter(event=>profileId===undefined||event.args[0].browser.profileId===profileId).length??0 },
    observeSend(channel: string,args: any[],send:(channel:string,...args:any[])=>void) {
      const event=args[0]
      if(!heldUpdates||channel!==BROWSER_EVENT_CHANNEL||event?.type!=='updated'||event.browser?.id!==heldUpdates.browserId)return false
      const original=structuredClone(args)
      heldUpdates.events.push({channel,args:original,send})
      ;(receipt.profileSwitchUpdateDelivery??=[]).push({state:'held',browserId:event.browser.id,profileId:event.browser.profileId,navigationId:event.browser.navigationId})
      return true
    },
    releaseUpdates() {
      const original=heldUpdates;heldUpdates=null
      if(!original)return
      for(const event of original.events){event.send(event.channel,...event.args);receipt.profileSwitchUpdateDelivery.push({state:'released',browserId:event.args[0].browser.id,profileId:event.args[0].browser.profileId,navigationId:event.args[0].browser.navigationId})}
    },
    hold(channel: HeldReply['channel'], browserId?: string) {
      assert.equal(held, null, 'Keep the existing held original ACK until it is explicitly released')
      held = { channel, ...(browserId===undefined?{}:{browserId}) }
    },
    held() { return held?.call ?? null },
    release(lose=false) { const release=held?.release;assert.ok(release,'The exact original handler has not completed yet');release(lose) },
    dispose() { held?.release?.(false);held=null;this.releaseUpdates();directoryFault(false);metadataFault(null) },
    original(browserId: string) { return originals.get(browserId) ?? null },
    async observe(channel: string, args: any[], invoke: () => Promise<any>) {
      if (!tracked.has(channel)) return await invoke()
      const before = new Set(window.contentView.children.map((view: any) => view.webContents?.id))
      const call: any = { index: calls.length, channel, browserId: args[0], state: 'dispatched',
        ...(channel==='browser:create'?{requestedProfileId:args[3]??null,url:args[1],mode:args[4]??'normal'}:{}),
        ...(channel==='browser:switchProfile'?{requestedProfileId:args[1]}:{}) }
      calls.push(call)
      let raw
      try { raw=await invoke() }
      catch (error) { call.state='rejected';throw error }
      let result=raw
      if(channel==='browser:switchProfile'){
        call.ownerReplyRaw=structuredClone(raw)
        try { result=unwrapIpcResult(raw) }
        catch(error) { call.state='owner-refused';call.refusal={code:(error as any).code,message:(error as Error).message};return raw }
      }
      call.state='owner-returned'
      if (result && typeof result.id === 'string') {
        call.returned={id:result.id,mode:result.mode,profileId:result.profileId,navigationId:result.navigationId,url:result.url}
        // This is only a correlation of the exact original reply with its newly
        // created native object. It is not a product Browser registry or a label lookup.
        try {
          const created=window.contentView.children.filter((view:any)=>view.webContents&&!view.webContents.isDestroyed()&&!before.has(view.webContents.id)&&
            (result.mode==='private'&&result.profileId===null?!view.webContents.session.isPersistent():typeof result.profileId==='string'&&view.webContents.session===session.fromPartition(browserProfilePartition(result.profileId)))) as WebContentsView[]
          call.createdCandidates=created.map(view=>({contentsId:view.webContents.id,url:view.webContents.getURL()}))
          if(created.length===1){originals.set(result.id,created[0]!);call.createdContentsId=created[0]!.webContents.id}
        } catch(error) {
          call.correlationUnconfirmed={message:(error as Error).message}
        }
      }
      const gate=held
      if(gate&&gate.channel===channel&&(gate.browserId===undefined||gate.browserId===args[0])){
        gate.call=call;call.state='owner-returned-ack-held'
        const lose=await new Promise<boolean>(resolve=>{gate.release=resolve})
        call.state=lose?'ack-lost':'ack-released';if(held===gate)held=null
        if(lose)throw new Error('Private fixture lost the original successful Main binding ACK; keep its original Browser and target')
      }
      return raw
    }
  }
}
export type ProfileSwitchPorts = ReturnType<typeof profileSwitchPorts>
