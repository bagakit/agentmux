import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import type { StateStorage } from 'zustand/middleware'
import {
  createDebouncedPersistentStorage,
  createWriteFencedStorage,
  registerUnloadFlush
} from '../src/renderer/src/lib/persisted-ui-writer.js'

/**
 * The renderer-side debounced layout writer. A layout gesture (dock drag, split-ratio, tab reorder)
 * fires many state changes per second; writing localStorage synchronously on each one is what this
 * coalesces into one trailing write. The flush closes the in-memory window a hard shutdown would lose,
 * and is what the unload handler calls.
 *
 * Mutation intent:
 *  - removing the debounce (writing straight through) fails 'coalesces a burst into a single write'.
 *  - removing the flush (or not calling it on unload) fails the flush / pagehide tests below.
 *  - dropping removeItem's pending-drop fails 'a remove cancels a pending write for that key'.
 */

function recordingStorage() {
  const writes: Array<{ name: string; value: string }> = []
  const removes: string[] = []
  const backing = new Map<string, string>()
  const storage: StateStorage = {
    getItem: (name) => backing.get(name) ?? null,
    setItem: (name, value) => {
      writes.push({ name, value })
      backing.set(name, value)
    },
    removeItem: (name) => {
      removes.push(name)
      backing.delete(name)
    }
  }
  return { storage, writes, removes }
}

describe('createDebouncedPersistentStorage', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reads pass straight through to the base storage', () => {
    const base = recordingStorage()
    base.storage.setItem('k', 'seed')
    const { storage } = createDebouncedPersistentStorage(base.storage, 400)
    expect(storage.getItem('k')).toBe('seed')
  })

  it('coalesces a burst of writes into a single trailing write of the newest value', () => {
    const base = recordingStorage()
    const { storage } = createDebouncedPersistentStorage(base.storage, 400)

    storage.setItem('layout', 'a')
    storage.setItem('layout', 'b')
    storage.setItem('layout', 'c')
    // Nothing lands during the gesture — the whole point of the debounce.
    expect(base.writes).toEqual([])

    vi.advanceTimersByTime(400)
    // Exactly one durable write, carrying the last value, not one per change.
    expect(base.writes).toEqual([{ name: 'layout', value: 'c' }])
  })

  it('flush lands the pending value immediately without waiting for the timer', () => {
    const base = recordingStorage()
    const { storage, flush } = createDebouncedPersistentStorage(base.storage, 400)

    storage.setItem('layout', 'pending')
    expect(base.writes).toEqual([])

    flush()
    expect(base.writes).toEqual([{ name: 'layout', value: 'pending' }])

    // The flush also cancels the timer, so it does not double-write when the timer would have fired.
    vi.advanceTimersByTime(400)
    expect(base.writes).toEqual([{ name: 'layout', value: 'pending' }])
  })

  it('flush is a no-op when nothing is pending', () => {
    const base = recordingStorage()
    const { flush } = createDebouncedPersistentStorage(base.storage, 400)
    flush()
    expect(base.writes).toEqual([])
  })

  it('a remove cancels a pending write for that key and removes from the base', () => {
    const base = recordingStorage()
    const { storage } = createDebouncedPersistentStorage(base.storage, 400)

    storage.setItem('layout', 'stale')
    storage.removeItem('layout')
    vi.advanceTimersByTime(400)

    // The debounced value must not resurrect a key the store just deleted.
    expect(base.writes).toEqual([])
    expect(base.removes).toEqual(['layout'])
  })
})

describe('registerUnloadFlush', () => {
  const listeners = new Map<string, EventListener[]>()
  const originalWindow = globalThis.window

  beforeEach(() => {
    listeners.clear()
    vi.stubGlobal('window', {
      addEventListener: (type: string, handler: EventListener) => {
        listeners.set(type, [...(listeners.get(type) ?? []), handler])
      },
      removeEventListener: (type: string, handler: EventListener) => {
        listeners.set(type, (listeners.get(type) ?? []).filter((entry) => entry !== handler))
      }
    })
  })

  afterEach(() => {
    if (originalWindow === undefined) vi.unstubAllGlobals()
    else vi.stubGlobal('window', originalWindow)
  })

  it('flushes on pagehide — the reliable modern unload signal, including bfcache', () => {
    const flush = vi.fn()
    registerUnloadFlush(flush)
    for (const handler of listeners.get('pagehide') ?? []) handler(new Event('pagehide'))
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('also flushes on beforeunload as a fallback', () => {
    const flush = vi.fn()
    registerUnloadFlush(flush)
    for (const handler of listeners.get('beforeunload') ?? []) handler(new Event('beforeunload'))
    expect(flush).toHaveBeenCalledTimes(1)
  })

  it('the disposer removes every listener it added', () => {
    const flush = vi.fn()
    const dispose = registerUnloadFlush(flush)
    dispose()
    for (const handler of listeners.get('pagehide') ?? []) handler(new Event('pagehide'))
    for (const handler of listeners.get('beforeunload') ?? []) handler(new Event('beforeunload'))
    expect(flush).not.toHaveBeenCalled()
  })
})

describe('createWriteFencedStorage', () => {
  /**
   * 这道闸是「重启后 Tab / 分屏 / 侧栏宽度 / 换行开关全没了」那一族（#59/#79）的一条承重防线，与
   * migrate 恒等并列。它防的顺序是：hydration 还没完成（或读失败）时，启动路径上任何一次 `set(...)`
   * 都会触发 persist 写入，而那时内存里装的是**默认值**——磁盘上用户唯一那份布局记录被空默认覆盖。
   *
   * 此前它是 store.ts 里一个模块级 `let` 加一行 `if`，于是「闸关着时写入真的被拦了吗」在测试里
   * 结构性不可观测：唯一提到它的两处都只扫源码文本（那个标识符还在不在）。实测把那行
   * `if (!persistWritesEnabled) return undefined` 整行删掉（写入变无条件），五个持久化测试文件
   * 62 条全绿。文本守卫看得见「名字被引用了」，看不见极性被反转、或整条判断被删。
   */

  function recording() {
    const base = recordingStorage()
    return { base, fence: createWriteFencedStorage(base.storage) }
  }

  it('闸关着时写入一个字节都不落——这是那份记录唯一的保护', () => {
    // 缺陷的正脸。删掉产品里那行 `if (!writesEnabled) return`，只有这条会红。
    const { base, fence } = recording()
    fence.storage.setItem('workbench', '{"tabs":{}}')
    expect(base.writes).toEqual([])
  })

  it('开闸之后写入照常落地——闸不是把持久化关掉', () => {
    // 独立承重：上面那条单独存在时，把 setItem 改成永不写入（闸恒关）也能全绿，而那会让用户的
    // 任何改动永远不落盘。两条一起才把极性的两侧钉住。
    const { base, fence } = recording()
    fence.openWrites()
    fence.storage.setItem('workbench', '{"tabs":{}}')
    expect(base.writes).toEqual([{ name: 'workbench', value: '{"tabs":{}}' }])
  })

  it('闸关着期间的写入不排队，开闸后不会补写那份默认值', () => {
    // 闸的语义是「丢弃」而不是「押后」。若改成缓存起来等开闸再写，启动期那次用默认值的写入就会在
    // 开闸的瞬间落盘——正是这道闸存在要防的那次覆盖，只是晚了几毫秒。
    const { base, fence } = recording()
    fence.storage.setItem('workbench', '{"tabs":{}}')
    fence.openWrites()
    expect(base.writes).toEqual([])
  })

  it('读始终放行，因为 hydration 自己就要读', () => {
    // 闸若连读也拦，hydration 永远读不到记录，于是每次启动都是全新窗口——与它要防的症状同形。
    const { base, fence } = recording()
    base.storage.setItem('workbench', 'from-disk')
    expect(fence.storage.getItem('workbench')).toBe('from-disk')
  })

  it('删除不受闸约束——它表达的是「该消失」，不是「用空值覆盖有值」', () => {
    const { base, fence } = recording()
    fence.storage.removeItem('workbench')
    expect(base.removes).toEqual(['workbench'])
  })
})

describe('store.ts wiring: the persist layer uses the debounced writer with an unload flush', () => {
  // The store module runs its top-level persist setup on import, and localStorage/window are absent in
  // this node env, so the wiring cannot be exercised behaviorally here — the debounce and flush units
  // above cover behavior. This scans the source for the load-bearing wiring, the same technique
  // main-window-setup.test.ts uses for index.ts. Comments are stripped so a comment cannot supply a
  // match.
  const here = dirname(fileURLToPath(import.meta.url))
  const storePath = join(here, '../src/renderer/src/store.ts')

  function stripComments(source: string): string {
    return source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
  }

  it('feeds the debounced writer as the persist storage, not the raw synchronous one', async () => {
    const source = stripComments(await readFile(storePath, 'utf8'))
    expect(source).toContain('createDebouncedPersistentStorage(guardedWorkbenchStorage)')
    // The persist config must consume the debounced storage; reverting it to the raw guarded storage
    // (a synchronous write per layout change) is the regression this guards.
    expect(source).toContain('createJSONStorage(() => persistentWorkbenchStorage.storage)')
    expect(source).not.toMatch(/createJSONStorage\(\(\)\s*=>\s*guardedWorkbenchStorage\)/)
  })

  it('registers the unload trailing flush so a shutdown mid-drag keeps the last layout write', async () => {
    const source = stripComments(await readFile(storePath, 'utf8'))
    expect(source).toContain('registerUnloadFlush(() => persistentWorkbenchStorage.flush())')
  })

  it('persist 写入真的穿过那道写闸，且闸没有第二份手写实现', async () => {
    // 上面那五条行为断言证的是「闸自己拦得住」，这一条证的是「persist 确实从它后面写」。两者必须分开：
    // 闸的单元测试全绿，而 store 里把 `guardedWorkbenchStorage` 改回裸的 `workbenchStorage()` 转发，
    // 那些行为断言一条都不会红——闸变成一个没人经过的正确实现（本仓「抽进 lib 只解决一半」那一族）。
    const source = stripComments(await readFile(storePath, 'utf8'))

    // 闸必须在场，且 persist 消费的那条链是 fence → debounce → createJSONStorage。
    expect(source).toContain('createWriteFencedStorage(')
    expect(source).toContain('workbenchWriteFence.storage')
    expect(source).toContain('createDebouncedPersistentStorage(guardedWorkbenchStorage)')

    // 闸的判断必须只有 lib 里那一份。这个模块里若又出现一个「按标志决定要不要写」的分支，就是第二份
    // 手抄——而它会与 lib 那份独立漂移（漏改一处不会红，正是这个缺陷此前的形状）。
    expect(source).not.toMatch(/if\s*\(\s*!\s*\w*[wW]rites\w*\s*\)/)

    // 开闸只能有一个入口。散着直接改标志的写法会绕过这一处，让「谁放行了写入」重新变成 N 处判断。
    const openCalls = source.match(/openPersistWrites\(\)/g) ?? []
    // 一处定义 + 启动路径上三个开启点（读成功、兜底外壳装好、启动整体失败）。
    expect(openCalls.length).toBe(4)
    expect(source).not.toMatch(/workbenchWriteFence\.openWrites\(\)[\s\S]{0,40}workbenchWriteFence\.openWrites\(\)/)
  })
})
