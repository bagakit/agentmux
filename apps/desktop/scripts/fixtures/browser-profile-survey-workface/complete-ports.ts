import { BrowserViewManager } from '../../../src/main/browser-view-manager'
import { BrowserOperationJournal } from '@agentmux/browser/browser-operation-journal'
import { session } from 'electron'
import type { BrowserSnapshot } from '../../../src/shared/contracts'

/** Private counters around the actual owners. Every original return, callback and refusal is kept. */
export function completePorts(receipt: any) {
  const facts: any = { bvm: [], journal: [], sessionFactory: [], browserEvents: [] }
  receipt.completeOwnerObservation = facts
  const restorations: (() => void)[] = []
  let manager: any
  for (const name of ['create', 'restore', 'runScript'] as const) {
    const original = BrowserViewManager.prototype[name] as (...args: any[]) => any
    ;(BrowserViewManager.prototype as any)[name] = function (...args: any[]) {
      manager = this
      facts.bvm.push({ method: name, browserId: args[0] })
      return Reflect.apply(original, this, args)
    }
    restorations.push(() => { (BrowserViewManager.prototype as any)[name] = original })
  }
  const subscribe = BrowserOperationJournal.prototype.subscribe
  BrowserOperationJournal.prototype.subscribe = async function (...args: Parameters<typeof subscribe>) {
    const observed: any = { operationId: args[0], open: false, closed: false, delivered: 0 }
    facts.journal.push(observed)
    const listener = args[2]
    const original = await subscribe.call(this, args[0], args[1], event => { observed.delivered++; return listener(event) })
    observed.open = true; observed.browserId = original.operation?.browserId
    const dispose = original.dispose
    return { ...original, dispose() { const value = dispose(); observed.closed = true; return value } }
  }
  restorations.push(() => { BrowserOperationJournal.prototype.subscribe = subscribe })
  const fromPartition = session.fromPartition
  session.fromPartition = function (...args: Parameters<typeof fromPartition>) {
    facts.sessionFactory.push({ partition: args[0] })
    return Reflect.apply(fromPartition, session, args)
  }
  restorations.push(() => { session.fromPartition = fromPartition })
  return {
    event(channel: string, args: any[]) {
      if (channel !== 'agentmux:browser-event') return
      const event = args[0]
      facts.browserEvents.push({ type: event.type, browserId: event.browser?.id ?? event.id,
        ...(event.type === 'native-opened' ? { browser: structuredClone(event.browser), workspaceId: event.workspaceId } : {}) })
    },
    snapshot() {
      return {
        bvm: facts.bvm.length,
        runScript: facts.bvm.filter((call: any) => call.method === 'runScript').length,
        sessionFactory: facts.sessionFactory.length,
        browserEvents: facts.browserEvents.length,
        subscriptions: { opened: facts.journal.filter((value: any) => value.open).length,
          active: facts.journal.filter((value: any) => value.open && !value.closed).length,
          delivered: facts.journal.reduce((total: number, value: any) => total + value.delivered, 0) },
        native: manager ? [...manager.entries.values()].map((entry: any) => ({ browserId: entry.id,
          profileId: entry.storage?.profileId ?? null, contentsId: entry.view?.webContents?.id ?? null,
          alive: Boolean(entry.view?.webContents && !entry.view.webContents.isDestroyed()) })) : []
      }
    },
    presentation() {
      return manager ? [...manager.entries.values()].map((entry:any)=>({browserId:entry.id,contentsId:entry.view.webContents.id,
        visible:entry.view.getVisible(),bounds:entry.view.getBounds(),windowId:manager.windowForView(entry.view).id,inputLeaseId:entry.inputLeaseId})) : []
    },
    native(browserId: string) { return manager?.entries.get(browserId)?.view ?? null },
    childOf(browserId: string) { return facts.browserEvents.find((event: any) => event.type === 'native-opened' && event.browser.source?.browserId === browserId) ?? null },
    childrenOf(browserId: string): { browser: BrowserSnapshot }[] {
      return facts.browserEvents.filter((event: any) => event.type === 'native-opened' && event.browser.source?.browserId === browserId)
    },
    dispose() { for (const restore of restorations.reverse()) restore() }
  }
}
export type CompletePorts = ReturnType<typeof completePorts>
