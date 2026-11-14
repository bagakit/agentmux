import { createJSONStorage, type PersistStorage, type StorageValue } from 'zustand/middleware'

// Bound both encoding and browser storage work to one batch. Continuous input
// replaces the immutable pending projection without postponing its save deadline.
const DEFAULT_BATCH_MS = 400
export const USER_SAVE_REPLY_MS = 15_000

type StateStorage = {
  getItem(name: string): string | null | Promise<string | null>
  setItem(name: string, value: string): void | Promise<unknown>
  removeItem(name: string): void | Promise<unknown>
}
const asynchronous = <T>(value: T | Promise<T>): value is Promise<T> =>
  value !== null && typeof value === 'object' && typeof (value as Promise<T>).then === 'function'

type FlushablePersistentStorage<State> = {
  storage: PersistStorage<State>
  flush: () => void | Promise<void>
  checkpoint: (name: string, value: StorageValue<State>) => void | Promise<void>
  pending: () => boolean
}

/** Own the original JSON boundary and latest immutable Zustand projection per key.
 * The startup fence wraps this owner so rejected defaults never enter a batch.
 * Ordinary unload flushes the latest input; abrupt exit cannot run that handler.
 */
export function createBatchedPersistentStorage<State>(
  base: StateStorage,
  delayMs: number = DEFAULT_BATCH_MS,
  onError?: (error: unknown) => void,
  onRecovered?: (error: unknown) => void
): FlushablePersistentStorage<State> {
  const pending = new Map<string, StorageValue<State>>()
  // Input identity does not imply that its pending write has reached storage.
  const inputs = new Map<string, StorageValue<State>>()
  const removals = new Map<string, number>()
  const jsonStorage = createJSONStorage<State>(() => base)!
  let timer: ReturnType<typeof setTimeout> | null = null
  let timerDue = 0
  let flushing: Promise<void> | null = null
  let attempt = 0, failures = 0
  let reportedFailure: unknown

  const writePending = (generation = attempt): void | Promise<void> => {
    if (generation !== attempt) return
    for (const [name, value] of pending) {
      if (removals.has(name)) continue
      const encoded = JSON.stringify(value)
      const finish = () => {
        // An ACK belongs to its captured input; newer edits remain pending.
        if (generation === attempt && pending.get(name) === value) pending.delete(name)
      }
      const save = (current: string | null, confirm = false): void | Promise<void> => {
        if (generation !== attempt) return
        // A native read may observe an earlier replacement whose directory ACK
        // failed. Let that owner reconfirm equal bytes through its write API.
        if (current === encoded && !confirm) { finish(); return }
        const result = base.setItem(name, encoded)
        if (asynchronous(result)) return result.then(finish)
        finish()
      }
      const current = base.getItem(name)
      const result = asynchronous(current) ? current.then(value => save(value, true)) : save(current)
      // Serial drain protects ordering across native IPC waits. Encoding, read,
      // or durable write failure keeps the exact latest input available.
      if (asynchronous(result)) return result.then(() => writePending(generation))
    }
  }
  const track = (result: Promise<void>): Promise<void> => {
    const generation = attempt
    let deadline: ReturnType<typeof setTimeout>
    const observed = new Promise<void>((resolve, reject) => {
      deadline = setTimeout(() => reject(Object.assign(new Error('Desktop saving is still unconfirmed. Current input is retained; the original writer is retrying without replaying input.'),
        { code: 'WORKBENCH_USER_STATE_REPLY_OVERDUE' })), USER_SAVE_REPLY_MS)
      result.then(resolve, reject)
    })
    const active = observed.then(() => {
      failures = 0
      if (!pending.size && reportedFailure !== undefined) { const error = reportedFailure; reportedFailure = undefined; onRecovered?.(error) }
    }, error => {
      if (attempt === generation) attempt++ // retire observation only; Main owns every admitted effect
      failures++
      schedule(Math.min(120_000, 1000 * 2 ** Math.min(failures - 1, 7)))
      throw error
    }).finally(() => { clearTimeout(deadline); if (flushing === active) flushing = null })
    flushing = active
    return active
  }
  const flush = (): void | Promise<void> => {
    if (timer !== null) { clearTimeout(timer); timer = null; timerDue = 0 }
    if (flushing) return flushing.then(() => flush())
    try {
      const result = writePending()
      return asynchronous(result) ? track(result) : result
    } catch (error) { failures++; schedule(Math.min(120_000, 1000 * 2 ** Math.min(failures - 1, 7))); throw error }
  }
  const report = (error: unknown) => {
    if (reportedFailure === error) return
    reportedFailure = error
    if (onError) onError(error)
    else throw error
  }
  const schedule = (delay = delayMs): void => {
    if (!pending.size) return
    const due = Date.now() + delay
    if (timer !== null) {
      if (due >= timerDue) return
      clearTimeout(timer)
    }
    timerDue = due
    timer = setTimeout(() => {
      timer = null; timerDue = 0
      try {
        const result = flush()
        if (asynchronous(result)) void result.catch(error => {
          report(error)
        })
      } catch (error) { report(error) }
    }, delay)
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
      // An already accepted write must settle before removal, otherwise its
      // late ACK could resurrect a cleared document.
      removals.set(name, (removals.get(name) ?? 0) + 1)
      let released = false
      const release = () => {
        if (released) return
        released = true
        const remaining = removals.get(name)! - 1
        if (remaining) removals.set(name, remaining)
        else removals.delete(name)
      }
      const remove = (): void | Promise<void> => {
        try {
          const result = base.removeItem(name)
          if (asynchronous(result)) return result.then(() => { release(); return writePending() }, error => { release(); throw error })
          release()
          return writePending()
        } catch (error) { release(); throw error }
      }
      if (flushing) return track(flushing.then(remove, error => { release(); throw error }))
      const result = remove()
      return asynchronous(result) ? track(result) : result
    }
  }
  return { storage, flush, pending: () => pending.size > 0 || flushing !== null,
    checkpoint(name, value) {
      // Explicit save captures current inputs even when observation missed a
      // mutation or the original native file was removed after an earlier ACK.
      pending.set(name, value)
      inputs.set(name, value)
      return flush()
    } }
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
