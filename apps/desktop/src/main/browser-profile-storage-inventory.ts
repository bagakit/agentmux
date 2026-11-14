import { constants, type Stats } from 'node:fs'
import { lstat, open, opendir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
import { BinaryReader, WireType } from '@bufbuild/protobuf'
import type { BrowserProfileStorageSnapshot, BrowserProfileStorageUsage } from '@agentmux/core/control'

type Index = { origin?: string; storageKey?: string; bucketId?: string; isDefault?: boolean }
const empty = (): BrowserProfileStorageUsage => ({ logicalBytes: 0, allocatedBytes: 0, complete: true })
function add(to: BrowserProfileStorageUsage, from: BrowserProfileStorageUsage): void {
  to.logicalBytes += from.logicalBytes
  to.allocatedBytes = to.allocatedBytes === null || from.allocatedBytes === null ? null : to.allocatedBytes + from.allocatedBytes
  to.complete &&= from.complete
}
const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
const unchanged = (a: Stats, b: Stats): boolean => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs

/** Chromium150 CacheStorageIndex, fields 2–5 only. No request/response/cache-name decoding.
 * https://github.com/chromium/chromium/blob/150.0.7871.250/content/browser/cache_storage/cache_storage.proto */
async function readIndex(directory: string): Promise<Index> {
  const file = await open(join(directory, 'index.txt'), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await file.stat()
    if (!before.isFile()) throw new Error('Not a regular index')
    const bytes = await file.readFile(), reader = new BinaryReader(bytes, new TextDecoder('utf-8', { fatal: true })), index: Index = {}
    const fields = new Set<number>()
    while (reader.pos < reader.len) {
      const [field, wire] = reader.tag()
      if (field >= 2 && field <= 5) {
        if (fields.has(field)) throw new Error('Ambiguous index field')
        fields.add(field)
        if (field === 2 || field === 3) {
          if (wire !== WireType.LengthDelimited) throw new Error('Invalid index field')
          const value = reader.string()
          if (field === 2) index.origin = value
          else index.storageKey = value
        } else {
          if (wire !== WireType.Varint) throw new Error('Invalid index field')
          if (field === 4) index.bucketId = String(reader.int64())
          else index.isDefault = reader.bool()
        }
      } else reader.skip(wire, field)
    }
    if (!unchanged(before, await file.stat()) || !unchanged(before, await lstat(join(directory, 'index.txt')))) throw new Error('Index changed while sampled')
    return index
  } finally { await file.close() }
}

/** Positive verification of the recorded machine origin, never reverse hash/URL guessing. */
function originFacts(index: Index): { origin: string; key: string; identifier: string } | null {
  if (!index.origin || !index.storageKey || /[\u0000-\u001f\u007f]/u.test(index.storageKey)) return null
  let url: URL
  try { url = new URL(index.origin) } catch { return null }
  if (!['http:', 'https:'].includes(url.protocol) || url.href !== index.origin || url.pathname !== '/' || url.username || url.password || url.search || url.hash) return null
  if (index.storageKey.split('^', 1)[0] !== index.origin) return null
  // Chromium storage::GetIdentifierFromOrigin: canonical default port is 0, IPv6 ':' becomes '_'.
  const identifier = `${url.protocol.slice(0, -1)}_${url.hostname.replaceAll(':', '_')}_${url.port || '0'}`
  return { origin: url.origin, key: index.storageKey, identifier }
}

/** Ephemeral disk projection owned by the original Profile. Reads only index metadata and stat. */
export async function inspectBrowserProfileStorage(root: string, profileId: string, profileRevision: string): Promise<BrowserProfileStorageSnapshot> {
  const snapshot: BrowserProfileStorageSnapshot = { profileId, profileRevision, observedAt: Date.now(), usage: empty(), sites: [], unattributed: empty(), issues: [] }
  const groups = new Map<string, { keys: Set<string>; usage: BrowserProfileStorageUsage }>()
  const keyOrigins = new Map<string, string>()
  const issue = (message: string): void => { if (!snapshot.issues.includes(message)) snapshot.issues.push(message) }
  async function measure(path: string): Promise<BrowserProfileStorageUsage> {
    const result = empty()
    try {
      const before = await lstat(path)
      if (before.isSymbolicLink() || !before.isDirectory() && !before.isFile()) throw new Error('Unsupported storage entry')
      result.logicalBytes = before.isFile() ? before.size : 0
      result.allocatedBytes = Number.isSafeInteger(before.blocks) ? before.blocks * 512 : null
      if (before.isDirectory()) {
        for await (const entry of await opendir(path)) add(result, await measure(join(path, entry.name)))
        if (!unchanged(before, await lstat(path))) result.complete = false
      }
      if (!Number.isSafeInteger(result.logicalBytes) || result.allocatedBytes !== null && !Number.isSafeInteger(result.allocatedBytes)) throw new Error('Storage counter overflow')
    } catch {
      result.complete = false
      issue('Some offline storage could not be measured or changed while sampled. Refresh to observe it again.')
    }
    return result
  }
  async function bucket(path: string, legacy: boolean): Promise<void> {
    let index: Index | null = null
    try { index = await readIndex(path) } catch { issue('Some offline storage has an unreadable, missing or changing index; its known bytes are unattributed.') }
    const facts = index && originFacts(index)
    let attributable = !!facts
    if (facts && index) {
      if (legacy) {
        const hash = (text: string) => createHash('sha1').update(text).digest('hex')
        // CacheStorageOwner::kBackgroundFetch=1 shares this legacy parent; it is not CacheAPI.
        if (basename(path) === hash(facts.identifier + '-1')) { issue('Background Fetch storage is separate and excluded from Cache API usage.'); return }
        attributable &&= basename(path) === hash(facts.identifier) && facts.key === index.origin && index.isDefault !== false
      } else attributable &&= index.bucketId === basename(join(path, '..')) && index.isDefault !== undefined
      if (keyOrigins.has(facts.key) && keyOrigins.get(facts.key) !== facts.origin) attributable = false
    }
    const usage = await measure(path)
    if (!attributable || !facts) {
      add(snapshot.unattributed, usage)
      snapshot.unattributed.complete = false
      snapshot.usage.complete = false
      issue('Some offline storage has an unconfirmed origin, key, bucket or owner. It is kept and cannot be selected for clearing.')
      return
    }
    keyOrigins.set(facts.key, facts.origin)
    let group = groups.get(facts.origin)
    if (!group) groups.set(facts.origin, group = { keys: new Set(), usage: empty() })
    group.keys.add(facts.key)
    add(group.usage, usage)
  }
  async function directories(path: string, visit: (path: string) => Promise<void>, unrelatedFiles = false): Promise<void> {
    let before: Stats
    try {
      before = await lstat(path)
    } catch (error) {
      if (missing(error)) return
      snapshot.usage.complete = false; snapshot.unattributed.complete = false
      issue('An offline storage directory is unavailable; the known values are partial, not a complete zero.')
      return
    }
    try {
      if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Unconfirmed parent')
      for await (const entry of await opendir(path)) {
        const child = join(path, entry.name), info = await lstat(child)
        if (info.isDirectory() && !info.isSymbolicLink()) await visit(child)
        else if (!unrelatedFiles) { snapshot.usage.complete = false; issue('An unexpected offline storage entry was kept without following links.'); add(snapshot.unattributed, await measure(child)) }
      }
      if (!unchanged(before, await lstat(path))) { snapshot.usage.complete = false; issue('Offline storage directories changed while sampled. Refresh for a new observation.') }
    } catch {
      snapshot.usage.complete = false
      snapshot.unattributed.complete = false
      issue('An offline storage directory is unavailable; the known values are partial, not a complete zero.')
    }
  }
  try {
    const info = await lstat(root)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unconfirmed Profile root')
    try {
      const parent = await lstat(join(root, 'Service Worker'))
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('Unconfirmed Service Worker parent')
      await directories(join(root, 'Service Worker', 'CacheStorage'), path => bucket(path, true))
    } catch (error) {
      if (!missing(error)) { snapshot.usage.complete = false; snapshot.unattributed.complete = false; issue('The offline storage parent could not be confirmed without following links.') }
    }
    await directories(join(root, 'WebStorage'), async path => {
      const cache = join(path, 'CacheStorage')
      try {
        const info = await lstat(cache)
        if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Unconfirmed cache directory')
        await bucket(cache, false)
      } catch (error) {
        if (!missing(error)) { snapshot.usage.complete = false; snapshot.unattributed.complete = false; issue('A bucket CacheStorage directory is unavailable; its scope is kept unknown.') }
      }
    }, true)
  } catch {
    snapshot.usage.complete = false
    snapshot.unattributed.complete = false
    issue('The original Profile storage path is unavailable. Existing Profile data and Browser work are kept.')
  }
  snapshot.sites = [...groups].map(([origin, group]) => ({ origin, storageKeys: [...group.keys].sort(), usage: group.usage })).sort((a, b) => b.usage.logicalBytes - a.usage.logicalBytes || a.origin.localeCompare(b.origin))
  for (const site of snapshot.sites) add(snapshot.usage, site.usage)
  add(snapshot.usage, snapshot.unattributed)
  return snapshot
}
