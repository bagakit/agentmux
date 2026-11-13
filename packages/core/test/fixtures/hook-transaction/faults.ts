import { DatabaseSync } from 'node:sqlite'
import { open, stat } from 'node:fs/promises'
import { vi } from 'vitest'

export function trigger(path: string, action: 'ABORT' | 'ROLLBACK', condition = "NEW.record_id='original-tool'") {
  const db = new DatabaseSync(path)
  try { db.exec(`CREATE TRIGGER controlled_history BEFORE INSERT ON captured_record_versions WHEN ${condition}
    BEGIN SELECT RAISE(${action}, 'controlled original history failure'); END`) } finally { db.close() }
}

export async function syncFault(path: string, shouldFail: (db: DatabaseSync) => boolean) {
  const probe = await open(path, 'r'), prototype = Object.getPrototypeOf(probe), identity = await stat(path)
  await probe.close()
  const original = prototype.sync, failure = Object.assign(new Error('Controlled original SQLite sync loss'), { code: 'ENOSPC' })
  let hits = 0
  const spy = vi.spyOn(prototype, 'sync').mockImplementation(async function(this: Awaited<ReturnType<typeof open>>) {
    const current = await this.stat()
    if (!hits && current.ino === identity.ino && current.dev === identity.dev) {
      const db = new DatabaseSync(path, { readOnly: true })
      let fail: boolean
      try { fail = shouldFail(db) } finally { db.close() }
      if (fail) { hits++; throw failure }
    }
    return await original.call(this)
  })
  return { failure, spy, hits: () => hits }
}

export async function holdReceiptSync(path: string, agentSessionId: string, receiptId: string) {
  const probe = await open(path, 'r'), prototype = Object.getPrototypeOf(probe), identity = await stat(path); await probe.close()
  let enter!: () => void, release!: () => void, held = false
  const entered = new Promise<void>(resolve => { enter = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  const original = prototype.sync
  vi.spyOn(prototype, 'sync').mockImplementation(async function(this: Awaited<ReturnType<typeof open>>) {
    const current = await this.stat()
    if (!held && current.ino === identity.ino && current.dev === identity.dev) {
      const db = new DatabaseSync(path, { readOnly: true }); let matches: boolean
      try { matches = JSON.parse(String(db.prepare('SELECT json FROM sessions WHERE id=?').get(agentSessionId)!.json)).hookReceipt?.id === receiptId }
      finally { db.close() }
      if (matches) { held = true; enter(); await gate }
    }
    return await original.call(this)
  })
  return { entered, release }
}
