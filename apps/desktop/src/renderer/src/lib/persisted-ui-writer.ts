import { createJSONStorage, type PersistStorage, type StorageValue } from 'zustand/middleware'

// Bound both encoding and browser storage work to one batch. Continuous input
// replaces the immutable pending projection without postponing its save deadline.
const DEFAULT_BATCH_MS = 400

type SynchronousStateStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

type FlushablePersistentStorage<State> = {
  storage: PersistStorage<State>
  flush: () => void
}

/** Own the original JSON boundary and latest immutable Zustand projection per key.
 * The startup fence wraps this owner so rejected defaults never enter a batch.
 * Ordinary unload flushes the latest input; abrupt exit cannot run that handler.
 */
export function createBatchedPersistentStorage<State>(
  base: SynchronousStateStorage,
  delayMs: number = DEFAULT_BATCH_MS
): FlushablePersistentStorage<State> {
  const pending = new Map<string, StorageValue<State>>()
  // Input identity does not imply that its pending write has reached storage.
  const inputs = new Map<string, StorageValue<State>>()
  const jsonStorage = createJSONStorage<State>(() => base)!
  let timer: ReturnType<typeof setTimeout> | null = null

  const writePending = (): void => {
    timer = null
    for (const [name, value] of pending) {
      const encoded = JSON.stringify(value)
      if (base.getItem(name) !== encoded) base.setItem(name, encoded)
      // Encoding, read or write failure leaves the original input available to retry.
      pending.delete(name)
    }
  }
  const flush = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null }
    writePending()
  }
  const schedule = (): void => {
    if (timer === null) timer = setTimeout(writePending, delayMs)
  }
  const storage: PersistStorage<State> = {
    getItem: name => {
      inputs.delete(name)
      return jsonStorage.getItem(name)
    },
    setItem: (name, value) => {
      const previous = inputs.get(name)
      if (previous?.state === value.state && previous.version === value.version) {
        if (pending.has(name)) schedule()
        return
      }
      pending.set(name, value)
      inputs.set(name, value)
      schedule()
    },
    removeItem: name => {
      pending.delete(name)
      inputs.delete(name)
      if (pending.size === 0 && timer !== null) { clearTimeout(timer); timer = null }
      base.removeItem(name)
    }
  }
  return { storage, flush }
}

/**
 * Register the unload trailing flush. `pagehide` is the reliable modern signal — it fires on tab
 * close, navigation, and app quit, including the bfcache path where `beforeunload` may not — and
 * `beforeunload` is kept as a fallback for environments that skip it. Returns a disposer; a call in a
 * non-DOM environment is a no-op so the store module can import this unconditionally.
 */
export function registerUnloadFlush(flush: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onUnload = (): void => flush()
  window.addEventListener('pagehide', onUnload)
  window.addEventListener('beforeunload', onUnload)
  return () => {
    window.removeEventListener('pagehide', onUnload)
    window.removeEventListener('beforeunload', onUnload)
  }
}

type PersistentStorage<Value> = {
  getItem: (name: string) => Value | null | Promise<Value | null>
  setItem: (name: string, value: Value) => unknown
  removeItem: (name: string) => unknown
}

type WriteFencedStorage<Value> = {
  storage: PersistentStorage<Value>
  /** Let writes through from here on. Idempotent; there is no way back — see the doc comment. */
  openWrites: () => void
  isOpen: () => boolean
}

/**
 * 把一个 base storage 包成「读随时通，写要等闸开」。
 *
 * 这道闸是「重启后 Tab / 分屏 / 侧栏宽度 / 换行开关全没了」那一族（#59/#79）的一条承重防线，与
 * migrate 恒等并列。它防的是这个顺序：hydration 还没完成（或读失败）时，启动路径上任何一次
 * `set(...)` 都会触发 persist 写入，而那时内存里装的是**默认值**——于是磁盘上用户唯一的那份布局
 * 记录被一份空默认覆盖，不可逆。读始终放行，因为 hydration 本身要读；只有写被押后到启动确认过
 * 「记录已读到」或「已经装好带可见告警的兜底外壳」之后。
 *
 * 为什么收进 lib 而不留在 store 模块里：闸原来是 store.ts 里的一个模块级 `let` 加一行 `if`，于是
 * 「闸关着时写入真的被拦住了吗」这件事在测试里根本不可观测——只能靠扫源码文本判断那个标识符还
 * 在。实测过：把那行 `if (!enabled) return` 整行删掉（写入变无条件），五个持久化测试文件 62 条
 * 全绿。文本守卫看得见「名字被引用了」，看不见极性被反转、或整条判断被删。
 *
 * 只提供「开」而不提供「关」：闸的语义是一次性的启动放行，不是可反复开合的开关。给出关闭入口就等于
 * 造出「运行期把闸关上导致此后用户改动永不落盘」这条新的静默丢失路径。
 */
export function createWriteFencedStorage<Value>(base: PersistentStorage<Value>): WriteFencedStorage<Value> {
  let writesEnabled = false
  return {
    storage: {
      getItem: (name) => base.getItem(name),
      setItem: (name, value) => {
        // 极性是这一整道防线：这里放过一次，磁盘上的记录就被内存默认值替掉了。
        if (!writesEnabled) return undefined
        return base.setItem(name, value)
      },
      // 删除不受闸约束：它表达的是「这条记录该消失」，而闸防的是「用空值覆盖有值」。押后一次删除
      // 只会让一条本该消失的陈旧记录多活一会儿，方向与这道闸要防的损失相反。
      removeItem: (name) => base.removeItem(name)
    },
    openWrites: () => {
      writesEnabled = true
    },
    isOpen: () => writesEnabled
  }
}
