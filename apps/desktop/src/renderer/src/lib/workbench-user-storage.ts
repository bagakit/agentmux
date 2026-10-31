import { createBatchedPersistentStorage } from './persisted-ui-writer'
import { DESKTOP_FRAGMENT_KEYS, type DesktopFragmentName, type DesktopFragmentValues } from './desktop-user-fragments'

/** Original Desktop user projection. Native storage owns the only durable copy. */
export const WORKBENCH_USER_STATE_KEY = 'agentmux-workbench-v1'

type UserStatePort = {
  readWorkbenchState(): Promise<string | null>
  importWorkbenchState(value: string): Promise<string>
  writeWorkbenchState(value: string): Promise<unknown>
}

type Document = { state: Record<string, unknown>; version: number; desktopFragments?: Partial<DesktopFragmentValues> }
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value))
const fragmentKey = (name: DesktopFragmentName) => 'desktop-fragment:' + name
const names = Object.keys(DESKTOP_FRAGMENT_KEYS) as DesktopFragmentName[]

/** One original Renderer owns this cache and writer, including borrowed native windows. */
export function createWorkbenchUserDocument(port: UserStatePort, original: () => Storage, onError?: (error: unknown) => void) {
  const root = createWorkbenchUserStorage(port, original)
  let document: Document | undefined, hydration: Promise<void> | undefined
  const ready = new Set<DesktopFragmentName>(), loading = new Map<DesktopFragmentName, Promise<unknown>>()
  const imports = new Map<DesktopFragmentName, [string, string][]>()
  const listeners = new Set<() => void>()
  const notify = () => { for (const listener of listeners) listener() }
  const requireDocument = () => {
    if (!document) throw new Error('Original Desktop user storage is not yet readable. Current input is retained without dispatch.')
    return document
  }
  const fragments = () => {
    const current = requireDocument()
    if (current.desktopFragments !== undefined && !object(current.desktopFragments)) throw new Error('Original Desktop fragments are unreadable. Their bytes are retained.')
    return current.desktopFragments ?? {}
  }
  const read = <N extends DesktopFragmentName>(name: N): DesktopFragmentValues[N] => {
    if (!ready.has(name)) throw new Error('Original ' + name + ' data is not yet readable. Current input and original bytes are retained.')
    return fragments()[name] as DesktopFragmentValues[N]
  }
  const hydrate = async () => {
    if (document) return
    if (!hydration) hydration = (async () => {
      const raw = await root.getItem(WORKBENCH_USER_STATE_KEY)
      const value = raw === null ? { state: {}, version: 1 } : JSON.parse(raw)
      if (!object(value) || !object(value.state) || typeof value.version !== 'number') throw new Error('Original Desktop document is invalid. Its bytes are retained.')
      document = value as Document
    })().finally(() => { hydration = undefined })
    await hydration
  }
  const batch = createBatchedPersistentStorage<unknown>({
    async getItem(key) {
      await hydrate()
      if (key === WORKBENCH_USER_STATE_KEY) {
        const { desktopFragments: _private, ...projection } = requireDocument()
        return JSON.stringify(projection)
      }
      const name = names.find(name => fragmentKey(name) === key)
      if (!name) throw new Error('Unknown Desktop document member')
      return JSON.stringify({ state: fragments()[name], version: 1 })
    },
    async setItem(key, raw) {
      const captured = JSON.parse(raw), current = requireDocument()
      const name = names.find(name => fragmentKey(name) === key)
      // The active cache keeps later edits. Only this captured input is sent;
      // its late ACK never replaces the current cache or another member.
      const submitted = key === WORKBENCH_USER_STATE_KEY
        ? { ...current, ...captured, ...(Object.hasOwn(current, 'desktopFragments') ? { desktopFragments: current.desktopFragments } : {}) }
        : name ? { ...current, desktopFragments: { ...fragments(), [name]: captured.state } }
        : null
      if (!submitted) throw new Error('Unknown Desktop document member')
      await root.setItem(WORKBENCH_USER_STATE_KEY, JSON.stringify(submitted))
    },
    async removeItem(key) {
      if (key !== WORKBENCH_USER_STATE_KEY) throw new Error('Unknown Desktop document member')
      const current = requireDocument()
      await root.setItem(WORKBENCH_USER_STATE_KEY, JSON.stringify({ ...current, state: {}, version: 1 }))
    }
  }, 400, onError)
  const checkpoint = async (name: DesktopFragmentName) => {
    const value = read(name)
    await batch.checkpoint(fragmentKey(name), { state: value, version: 1 })
  }
  return {
    hydrate, read, checkpoint,
    /** Observation only: no disk read, save request or producer ACK is created. */
    encodeProjection(projection?: { state: unknown; version: number }): string | null {
      if (!document) return null
      return JSON.stringify({ ...document, ...projection,
        ...(Object.hasOwn(document, 'desktopFragments') ? { desktopFragments: document.desktopFragments } : {}) })
    },
    unreadFragments: () => names.filter(name => !ready.has(name)),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    isReady: (name: DesktopFragmentName) => ready.has(name),
    async load<N extends DesktopFragmentName>(name: N, validate: (value: DesktopFragmentValues[N]) => void): Promise<DesktopFragmentValues[N]> {
      if (ready.has(name)) return read(name)
      const previous = loading.get(name)
      if (previous) return await previous as DesktopFragmentValues[N]
      const work = (async () => {
        await hydrate()
        let value = fragments()[name] as DesktopFragmentValues[N]
        if (!Object.hasOwn(fragments(), name)) {
          const source = original(), held: [string, string][] = []
          if (name === 'moteAvatarSaveDrafts') {
            const entries: Record<string, string> = {}
            for (let index = 0; index < source.length; index++) {
              const key = source.key(index)
              if (!key?.startsWith(DESKTOP_FRAGMENT_KEYS.moteAvatarSaveDrafts)) continue
              const raw = source.getItem(key)
              if (raw !== null) { entries[key] = raw; held.push([key, raw]) }
            }
            value = entries as DesktopFragmentValues[N]
          } else {
            value = source.getItem(DESKTOP_FRAGMENT_KEYS[name]) as DesktopFragmentValues[N]
            if (value !== null) held.push([DESKTOP_FRAGMENT_KEYS[name], value as string])
          }
          validate(value)
          document = { ...requireDocument(), desktopFragments: { ...fragments(), [name]: value } }
          imports.set(name, held)
        } else {
          try { validate(value) }
          catch (cause) {
            // A failed consumer read may be retried after repair at the same
            // native owner. Refresh only this original member; current input
            // in the root and neighboring members must never be replaced.
            const raw = await port.readWorkbenchState()
            const current = raw === null ? null : JSON.parse(raw)
            if (!object(current?.desktopFragments) || !Object.hasOwn(current.desktopFragments, name)) throw cause
            const repaired = current.desktopFragments[name] as DesktopFragmentValues[N]
            validate(repaired)
            document = { ...requireDocument(), desktopFragments: { ...fragments(), [name]: repaired } }
            value = repaired
          }
        }
        if (imports.has(name)) {
          // This import, including a prior unknown write, gets a producer ACK
          // before the exact unchanged outgoing bytes can be removed.
          await batch.checkpoint(fragmentKey(name), { state: value, version: 1 })
          for (const [key, raw] of imports.get(name)!) if (original().getItem(key) === raw) original().removeItem(key)
          imports.delete(name)
        }
        ready.add(name); notify()
        return value
      })().finally(() => { loading.delete(name) })
      loading.set(name, work)
      return await work
    },
    write<N extends DesktopFragmentName>(name: N, value: DesktopFragmentValues[N]): void {
      const previous = read(name)
      if (previous === value) return
      document = { ...requireDocument(), desktopFragments: { ...fragments(), [name]: value } }
      batch.storage.setItem(fragmentKey(name), { state: value, version: 1 })
    },
    persistent: {
      ...batch,
      storage: {
        ...batch.storage,
        async getItem(name: string) { await hydrate(); return await batch.storage.getItem(name) },
        setItem(name: string, value: { state: unknown; version?: number }) {
          if (name !== WORKBENCH_USER_STATE_KEY || !object(value.state)) throw new Error('Invalid Desktop projection')
          document = { ...requireDocument(), state: value.state, version: value.version ?? 1 }
          return batch.storage.setItem(name, value)
        },
        removeItem(name: string) {
          if (name !== WORKBENCH_USER_STATE_KEY) throw new Error('Unknown Desktop document member')
          // Clear is an admitted input. A later root edit stays in the cache
          // while the old write and this clear obtain their own ordered ACKs.
          document = { ...requireDocument(), state: {}, version: 1 }
          return batch.storage.removeItem(name)
        }
      },
      async checkpoint(name: string, value: { state: unknown; version?: number }) {
        if (name !== WORKBENCH_USER_STATE_KEY || !object(value.state)) throw new Error('Invalid Desktop projection')
        document = { ...requireDocument(), state: value.state, version: value.version ?? 1 }
        await batch.checkpoint(name, value)
      }
    }
  }
}

export function createWorkbenchUserStorage(port: UserStatePort, original: () => Pick<Storage, 'getItem' | 'removeItem'>) {
  const target = (name: string) => {
    if (name !== WORKBENCH_USER_STATE_KEY) throw new Error('This storage owner accepts only the original Desktop user-state document.')
  }
  const save = async (value: string) => {
    const receipt = await port.writeWorkbenchState(value)
    const bytes = new TextEncoder().encode(value)
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
    if (!receipt || typeof receipt !== 'object' || !('diskDurability' in receipt) || receipt.diskDurability !== 'confirmed' ||
      !('path' in receipt) || typeof receipt.path !== 'string' || !receipt.path.trim() ||
      !('contentDigest' in receipt) || receipt.contentDigest !== digest ||
      !('sizeBytes' in receipt) || receipt.sizeBytes !== bytes.byteLength ||
      !('confirmedAt' in receipt) || typeof receipt.confirmedAt !== 'number' || !Number.isFinite(receipt.confirmedAt)) {
      throw new Error('Native Desktop write acknowledgement did not confirm the submitted document. Current input and original bytes are retained.')
    }
  }
  return {
    async getItem(name: string): Promise<string | null> {
      target(name)
      const saved = await port.readWorkbenchState()
      if (saved !== null) return saved
      // Import existing user bytes only on confirmed native absence. Read failure
      // never enters this path; failed import retains the original exact bytes.
      const held = original().getItem(name)
      if (held === null) return null
      const parsed = JSON.parse(held)
      if (!parsed || typeof parsed !== 'object' || !parsed.state || typeof parsed.state !== 'object' || Array.isArray(parsed.state)) {
        throw new Error('The original Desktop user state is invalid. Its bytes were retained; restore the original storage before saving.')
      }
      const imported = await port.importWorkbenchState(held)
      if (imported === held && original().getItem(name) === held) original().removeItem(name)
      return imported
    },
    async setItem(name: string, value: string): Promise<void> {
      target(name)
      await save(value)
    },
    async removeItem(name: string): Promise<void> {
      target(name)
      // Retain an explicit empty document so old imported bytes cannot revive.
      await save(JSON.stringify({ state: {}, version: 1 }))
    }
  }
}
