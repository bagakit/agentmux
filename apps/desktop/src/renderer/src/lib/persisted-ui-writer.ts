import type { StateStorage } from 'zustand/middleware'

// A layout drag (dock resize, split-ratio, tab reorder) fires many state changes per second, and the
// old storage wrote localStorage synchronously on every one. Coalesce them: the newest value per key
// lands once, this long after activity settles. The window it opens — a change living only in memory —
// is closed by `flush`, which an unload handler calls so a hard shutdown mid-drag still keeps it.
const DEFAULT_DEBOUNCE_MS = 400

type FlushablePersistentStorage = {
  storage: StateStorage
  /** Write any debounced value to the base storage now. A no-op when nothing is pending. */
  flush: () => void
}

/**
 * Wrap a base StateStorage so writes are trailing-debounced instead of synchronous per change. Reads
 * and removes pass straight through — only writes are deferred, because only writes are the frequent,
 * coalescable operation. The base is still the authority on whether a write actually lands (the write
 * fence lives there); this layer only decides *when* the base is asked.
 */
export function createDebouncedPersistentStorage(
  base: StateStorage,
  delayMs: number = DEFAULT_DEBOUNCE_MS
): FlushablePersistentStorage {
  // Keyed by storage name: a later setItem for a key overwrites its pending value rather than queuing
  // a second write, and a removeItem drops any pending value so it cannot resurrect after deletion.
  const pending = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const writePending = (): void => {
    timer = null
    for (const [name, value] of pending) base.setItem(name, value)
    pending.clear()
  }

  const flush = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    writePending()
  }

  const storage: StateStorage = {
    getItem: (name) => base.getItem(name),
    setItem: (name, value) => {
      pending.set(name, value)
      // Trailing debounce: reset the clock on each change so the write lands after the gesture ends,
      // not once per frame during it.
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(writePending, delayMs)
    },
    removeItem: (name) => {
      pending.delete(name)
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

type WriteFencedStorage = {
  storage: StateStorage
  /** Let writes through from here on. Idempotent; there is no way back — see the doc comment. */
  openWrites: () => void
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
export function createWriteFencedStorage(base: StateStorage): WriteFencedStorage {
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
    }
  }
}
