import type { WorkbenchInputQueueChange, WorkbenchInputQueueDelta, WorkbenchUserStateReceipt } from '../../../shared/workbench-user-state'
import { createBatchedPersistentStorage } from './persisted-ui-writer'
import { DESKTOP_FRAGMENT_KEYS, type DesktopFragmentName, type DesktopFragmentValues } from './desktop-user-fragments'
import { sameSpatialValue } from './spatial-merge'

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

type QueueAttempt = Map<string, Set<string>>
type InputQueueEviction = { ownerKey: string; entry: Record<string, unknown> }
const missingQueues: Record<string, unknown> = {}

function queueEntries(value: unknown): Map<string, Record<string, unknown>[]> {
  const entries = new Map<string, Record<string, unknown>[]>()
  if (!Array.isArray(value)) return entries
  for (const entry of value) {
    // Unaddressable legacy bytes remain with their native owner. A changed
    // addressable row can be saved independently of a neighboring legacy row.
    if (object(entry) && typeof entry.operationId === 'string' && entry.operationId && !entry.operationId.includes('\0')) {
      const matching = entries.get(entry.operationId)
      if (matching) matching.push(entry)
      else entries.set(entry.operationId, [entry])
    }
  }
  return entries
}

function inputQueueChanges(before: Record<string, unknown>, next: Record<string, unknown>, uncertain: QueueAttempt): WorkbenchInputQueueChange[] {
  if (before === next && uncertain.size === 0) return []
  const changes: WorkbenchInputQueueChange[] = []
  for (const ownerKey of new Set([...Object.keys(before), ...Object.keys(next), ...uncertain.keys()])) {
    const previous = Object.hasOwn(before, ownerKey) ? before[ownerKey] : undefined
    const current = Object.hasOwn(next, ownerKey) ? next[ownerKey] : undefined
    const attempted = uncertain.get(ownerKey)
    if (previous === current && !attempted) continue
    const old = queueEntries(previous), latest = queueEntries(current)
    const order = [...latest.keys()]
    const upsert: WorkbenchInputQueueChange['upsert'][number][] = []
    const remove: string[] = []
    for (const operationId of new Set([...old.keys(), ...order, ...attempted ?? []])) {
      const original = old.get(operationId), current = latest.get(operationId)
      if (!attempted?.has(operationId) && sameSpatialValue(original, current)) continue
      if ((original?.length ?? 0) > 1 || (current?.length ?? 0) > 1) {
        throw new Error('An original queue operation has more than one saved entry. Its current input and original rows are retained.')
      }
      if (current) upsert.push({ operationId, entry: current[0]! })
      else remove.push(operationId)
    }
    if (attempted || upsert.length || remove.length || !sameSpatialValue(order, [...old.keys()])) {
      changes.push({ ownerKey, order, upsert, remove })
    }
  }
  return changes
}

function withoutArchivedInputs(queues: Record<string, unknown>, evictions: readonly InputQueueEviction[]): Record<string, unknown> {
  let next = queues
  for (const { ownerKey, entry } of evictions) {
    const entries = next[ownerKey]
    if (!Array.isArray(entries) || !entries.includes(entry)) continue
    if (next === queues) next = { ...queues }
    const remaining = entries.filter(item => item !== entry)
    if (remaining.length) next[ownerKey] = remaining
    else delete next[ownerKey]
  }
  return next
}

/** One original Renderer owns this cache and writer, including borrowed native windows. */
export function createWorkbenchUserDocument(port: UserStatePort, original: () => Storage, onError?: (error: unknown) => void,
  onRecovered?: (error: unknown) => void) {
  const root = createWorkbenchUserStorage(port, original)
  let document: Document | undefined, hydration: Promise<void> | undefined
  let confirmedQueues = missingQueues
  let confirmedDocument: Document | undefined
  let confirmedDigest: string | null = null
  let sequence = 0
  let confirmedSequence = 0
  let clearSequence = 0
  let confirmedClearSequence = 0
  const uncertainInputs: QueueAttempt = new Map()
  const ready = new Set<DesktopFragmentName>(), loading = new Map<DesktopFragmentName, Promise<unknown>>()
  const failedLoads = new Set<DesktopFragmentName>()
  const imports = new Map<DesktopFragmentName, [string, string][]>()
  const listeners = new Set<() => void>()
  const archiveListeners = new Set<(owners: ReadonlySet<string> | null) => void>()
  const evictionListeners = new Set<(rows: InputQueueEviction[]) => void>()
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
      if (object(value.state.agentSteerQueues)) confirmedQueues = value.state.agentSteerQueues
    })().finally(() => { hydration = undefined })
    await hydration
  }
  const batch = createBatchedPersistentStorage<unknown>({
    async getItem(key) {
      await hydrate()
      if (key === WORKBENCH_USER_STATE_KEY) {
        const { desktopFragments: _private, ...projection } = requireDocument()
        return projection
      }
      const name = names.find(name => fragmentKey(name) === key)
      if (!name) throw new Error('Unknown Desktop document member')
      return { state: fragments()[name], version: 1 }
    },
    async writeProjection(key, captured, checkpoint) {
      const current = requireDocument()
      const name = names.find(name => fragmentKey(name) === key)
      // The active cache keeps later edits. Only this captured input is sent;
      // its late ACK never replaces the current cache or another member.
      const submitted = key === WORKBENCH_USER_STATE_KEY
        ? { ...current, ...captured, ...(Object.hasOwn(current, 'desktopFragments') ? { desktopFragments: current.desktopFragments } : {}) }
        : name ? { ...current, desktopFragments: { ...fragments(), [name]: captured.state } }
        : null
      if (!submitted || !object(submitted.state)) throw new Error('Unknown Desktop document member')
      const { agentSteerQueues, ...state } = submitted.state
      const queues = object(agentSteerQueues) ? agentSteerQueues : missingQueues
      const capturedClear = clearSequence
      const clearing = capturedClear !== confirmedClearSequence
      const changes = inputQueueChanges(clearing ? missingQueues : confirmedQueues, queues, clearing ? new Map() : uncertainInputs)
      const inputQueueDelta: WorkbenchInputQueueDelta = clearing ? { changes, clear: true } : { changes }
      const replacement = { ...submitted, state, version: submitted.version ?? 1 }
      if (!checkpoint && !clearing && !changes.length && sequence === confirmedSequence && sameSpatialValue(replacement, confirmedDocument)) return

      const encoded = JSON.stringify({ ...replacement, inputQueueDelta })
      const request = ++sequence
      // A timed-out IPC can still replace native state. Retain all its
      // touched rows until the latest cumulative request is confirmed,
      // even when a later user edit restores a previously confirmed value.
      for (const change of changes) {
        const touched = uncertainInputs.get(change.ownerKey) ?? new Set<string>()
        for (const { operationId } of change.upsert) touched.add(operationId)
        for (const operationId of change.remove) touched.add(operationId)
        uncertainInputs.set(change.ownerKey, touched)
      }
      const receipt = await root.setItem(WORKBENCH_USER_STATE_KEY, encoded)
      if (request === sequence) {
        const evictions: InputQueueEviction[] = []
        if (evictionListeners.size) for (const { ownerKey, operationId } of receipt.inputQueueArchived ?? []) {
          const entry = changes.find(change => change.ownerKey === ownerKey)?.upsert.find(update => update.operationId === operationId)?.entry
          if (entry) evictions.push({ ownerKey, entry })
        }
        confirmedDocument = replacement
        // A published eviction is an ACK effect. Base the next diff on what
        // Main retains hot, so dropping the exact live object never deletes it.
        confirmedQueues = withoutArchivedInputs(queues, evictions)
        confirmedDigest = receipt.contentDigest
        confirmedSequence = request
        uncertainInputs.clear()
        confirmedClearSequence = capturedClear
        if (evictions.length) {
          const latest = requireDocument()
          if (object(latest.state.agentSteerQueues)) {
            const next = withoutArchivedInputs(latest.state.agentSteerQueues, evictions)
            if (next !== latest.state.agentSteerQueues) document = { ...latest, state: { ...latest.state, agentSteerQueues: next } }
          }
          for (const listener of evictionListeners) listener(evictions)
        }
      }
      const owners = receipt.inputQueueArchiveOwners
      if (owners === null || owners?.length) {
        const changedOwners = owners === null ? null : new Set(owners)
        for (const listener of archiveListeners) listener(changedOwners)
      }
    },
    async removeItem(key) {
      if (key !== WORKBENCH_USER_STATE_KEY) throw new Error('Unknown Desktop document member')
      const current = requireDocument()
      await root.setItem(WORKBENCH_USER_STATE_KEY, JSON.stringify({ ...current, state: {}, version: 1 }))
    }
  }, 400, onError, onRecovered)
  const checkpoint = async (name: DesktopFragmentName) => {
    const value = read(name)
    await batch.checkpoint(fragmentKey(name), { state: value, version: 1 })
  }
  return {
    hydrate, read, checkpoint,
    /** The last exact native ACK, interpreted together with pending current input. */
    confirmedProjectionDigest: () => confirmedDigest,
    subscribeInputQueueCommits(listener: (owners: ReadonlySet<string> | null) => void) {
      archiveListeners.add(listener)
      return () => { archiveListeners.delete(listener) }
    },
    subscribeInputQueueEvictions(listener: (rows: InputQueueEviction[]) => void) {
      evictionListeners.add(listener)
      return () => { evictionListeners.delete(listener) }
    },
    /** Pending original input, independent of whether a settings reader consumed it.
     * Native opaque members remain in this document; unread legacy bytes need
     * the original load/import ACK before they can leave browser custody. */
    pending(): boolean {
      if (batch.pending() || imports.size > 0 || !document) return true
      try {
        const native = fragments()
        let source: Storage | undefined
        for (const name of names) {
          if (name === 'browserProfileTextDrafts' || ready.has(name) || Object.hasOwn(native, name)) continue
          source ??= original()
          if (name === 'moteAvatarSaveDrafts') {
            const count = source.length
            if (!Number.isSafeInteger(count) || count < 0) return true
            for (let index = 0; index < count; index++) {
              const key = source.key(index)
              if (key === null) return true
              if (key.startsWith(DESKTOP_FRAGMENT_KEYS.moteAvatarSaveDrafts) && source.getItem(key) !== null) return true
            }
            if (source.length !== count) return true
          } else if (source.getItem(DESKTOP_FRAGMENT_KEYS[name]) !== null) return true
        }
        return false
      } catch { return true } // Unknown browser/native custody never means absence.
    },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    /** Read diagnostics do not turn already durable opaque bytes into unsaved input. */
    hasReadFailure: () => failedLoads.size > 0,
    isReady: (name: DesktopFragmentName) => ready.has(name),
    async load<N extends DesktopFragmentName>(name: N, validate: (value: DesktopFragmentValues[N]) => void): Promise<DesktopFragmentValues[N]> {
      if (ready.has(name)) return read(name)
      const previous = loading.get(name)
      if (previous) return await previous as DesktopFragmentValues[N]
      const work = (async () => {
        await hydrate()
        let value = fragments()[name] as DesktopFragmentValues[N]
        if (!Object.hasOwn(fragments(), name) && name === 'browserProfileTextDrafts') {
          // The structured Profile text member has no Desktop localStorage predecessor.
          value = null as DesktopFragmentValues[N]
        } else if (!Object.hasOwn(fragments(), name)) {
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
        failedLoads.delete(name)
        ready.add(name); notify()
        return value
      })().catch(error => { failedLoads.add(name); throw error }).finally(() => { loading.delete(name) })
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
          ++clearSequence
          // Native clear is an explicit empty document in the same revisioned
          // writer, not a second delete effect behind an unresponsive old ACK.
          return batch.checkpoint(name, { state: {}, version: 1 })
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
  const save = async (value: string): Promise<WorkbenchUserStateReceipt> => {
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
    return receipt as WorkbenchUserStateReceipt
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
      // The import reply proves custody of the exact legacy bytes. The
      // original native read projects the hot document after that import.
      const current = await port.readWorkbenchState()
      if (current === null) throw new Error('Imported Desktop user state could not be read from its original owner. Browser bytes are retained.')
      if (imported === held && original().getItem(name) === held) original().removeItem(name)
      return current
    },
    async setItem(name: string, value: string): Promise<WorkbenchUserStateReceipt> {
      target(name)
      return await save(value)
    },
    async removeItem(name: string): Promise<void> {
      target(name)
      // Retain an explicit empty document so old imported bytes cannot revive.
      await save(JSON.stringify({ state: {}, version: 1 }))
    }
  }
}
