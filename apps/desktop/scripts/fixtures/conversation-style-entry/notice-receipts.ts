import { useStore } from 'zustand'
import { createStore } from 'zustand/vanilla'

type Receipts = Record<string, Record<string, string>>
type State = { noticeReadReceipts: Receipts }
const calls = { selectors: 0, reads: 0, writes: 0, changes: 0, rejected: 0 }
function reject(key: PropertyKey): never {
  calls.rejected++
  throw new Error(`The stylesheet proof owns only noticeReadReceipts UI acknowledgement IO; unsupported key/action: ${String(key)}`)
}
function checked(value: State): State {
  return new Proxy(value, {
    get(target, key) { if (key !== 'noticeReadReceipts') return reject(key); calls.reads++; return target.noticeReadReceipts },
    has(_target, key) { if (key !== 'noticeReadReceipts') return reject(key); return true },
    set(_target, key) { return reject(key) }, deleteProperty(_target, key) { return reject(key) }
  })
}
// Private UI read receipts only. This is not a Runtime, Browser, Session or service fact store.
const store = createStore<State>(() => checked({ noticeReadReceipts: {} }))
function setState(update: Partial<State> | ((state: State) => Partial<State> | State)): void {
  calls.writes++
  const previous = store.getState(), next = typeof update === 'function' ? update(previous) : update
  if (next === previous) return
  if (!next || typeof next !== 'object') return reject('setState(non-object)')
  for (const key of Reflect.ownKeys(next)) if (key !== 'noticeReadReceipts') return reject(key)
  if (!Object.prototype.hasOwnProperty.call(next, 'noticeReadReceipts')) return reject('setState(missing noticeReadReceipts)')
  const receipts = next.noticeReadReceipts
  if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts)) return reject('noticeReadReceipts schema')
  for (const entries of Object.values(receipts)) {
    if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.values(entries).some(value => typeof value !== 'string')) return reject('noticeReadReceipts values')
  }
  if (receipts === previous.noticeReadReceipts) return
  calls.changes++
  store.setState(checked({ noticeReadReceipts: receipts }), true)
}
const hook = Object.assign((selector: (state: State) => unknown) => { calls.selectors++; return useStore(store, selector) },
  { getState: () => store.getState(), setState })
export const useAppStore = new Proxy(hook, {
  get(target, key) { if (key !== 'getState' && key !== 'setState') return reject(key); return Reflect.get(target, key) }
})
export const noticeReceiptsFacts = () => ({ ...calls, scopes: Object.keys(store.getState().noticeReadReceipts) })
