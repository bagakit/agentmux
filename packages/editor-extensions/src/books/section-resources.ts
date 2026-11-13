/** One owner for a format adapter's shared assets, including interests registered before an asynchronous read completes. */
export class SectionResources<Key, Section> {
  #entries = new Map<Key, { owners: Set<Section>; pending: Promise<string>; url?: string }>()
  #bySection = new Map<Section, Set<Key>>()
  #waiting = new Map<Key, Set<Key>>()
  constructor(private readonly urls: { revokeObjectURL(url: string): void }) {}

  load(key: Key, section: Section, create: () => Promise<string>, parent?: Key): Promise<string> {
    if (parent !== undefined && this.#waitsOn(key, parent)) return Promise.resolve('')
    if (parent !== undefined) {
      const targets = this.#waiting.get(parent) ?? new Set<Key>()
      targets.add(key); this.#waiting.set(parent, targets)
    }
    const settle = (pending: Promise<string>) => parent === undefined ? pending : pending.finally(() => {
      const targets = this.#waiting.get(parent)
      targets?.delete(key)
      if (!targets?.size) this.#waiting.delete(parent)
    })
    let keys = this.#bySection.get(section)
    if (!keys) { keys = new Set(); this.#bySection.set(section, keys) }
    keys.add(key)
    const existing = this.#entries.get(key)
    if (existing) { existing.owners.add(section); return settle(existing.pending) }
    const entry = { owners: new Set([section]), pending: Promise.resolve('') } as { owners: Set<Section>; pending: Promise<string>; url?: string }
    this.#entries.set(key, entry)
    entry.pending = Promise.resolve().then(create).then(url => {
      if (this.#entries.get(key) !== entry || entry.owners.size === 0) {
        this.urls.revokeObjectURL(url)
        throw new DOMException('The section was released', 'AbortError')
      }
      entry.url = url
      return url
    }).catch(error => {
      if (this.#entries.get(key) === entry) this.#entries.delete(key)
      for (const owner of entry.owners) {
        const keys = this.#bySection.get(owner)
        keys?.delete(key)
        if (!keys?.size) this.#bySection.delete(owner)
      }
      throw error
    })
    return settle(entry.pending)
  }

  #waitsOn(key: Key, target: Key, seen = new Set<Key>()): boolean {
    if (key === target) return true
    if (seen.has(key)) return false
    seen.add(key)
    return [...(this.#waiting.get(key) ?? [])].some(next => this.#waitsOn(next, target, seen))
  }

  release(section: Section): void {
    const keys = this.#bySection.get(section)
    this.#bySection.delete(section)
    for (const key of keys ?? []) {
      const entry = this.#entries.get(key)
      if (!entry) continue
      entry.owners.delete(section)
      // A pending entry retains its empty owner set so a new section can join the same read.
      if (entry.owners.size === 0 && entry.url !== undefined) {
        this.urls.revokeObjectURL(entry.url)
        this.#entries.delete(key)
      }
    }
  }

  destroy(): void {
    for (const entry of this.#entries.values()) if (entry.url !== undefined) this.urls.revokeObjectURL(entry.url)
    this.#entries.clear(); this.#bySection.clear(); this.#waiting.clear()
  }
}
