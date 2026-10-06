import { avatarSeriesCanonical } from '@agentmux/core/mote-avatar-series'
import { parseMoteAvatarSave, parseMoteAvatarTarget, type MoteAvatarSave, type MoteAvatarTarget } from '@agentmux/core/mote-avatar-write'
import { api } from './api'

/** Original submitted request only; saved choices and receipts stay with their native owners. */
export function moteAvatarSaveDraftKey(target: MoteAvatarTarget): string {
  const exact = parseMoteAvatarTarget(target)
  return 'agentmux.mote-avatar-save-draft.v1:' + JSON.stringify([exact.workspaceId, exact.topicId, exact.objectKey])
}

export function readMoteAvatarSaveDraft(target: MoteAvatarTarget): MoteAvatarSave | null {
  const bytes = localStorage.getItem(moteAvatarSaveDraftKey(target))
  if (bytes === null) return null
  const request = parseMoteAvatarSave(JSON.parse(bytes))
  if (moteAvatarSaveDraftKey(request.target) !== moteAvatarSaveDraftKey(target)) throw new Error('The kept save request belongs to another Mote. Its original bytes are retained.')
  return request
}

export async function moteAvatarSaveRequestHash(request: MoteAvatarSave): Promise<string> {
  parseMoteAvatarSave(request)
  const bytes = new TextEncoder().encode(avatarSeriesCanonical(request))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return 'sha256:' + [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
}

async function withDraftLock(target: MoteAvatarTarget, work: () => Promise<void>): Promise<void> {
  // One original target per key; concurrent windows cannot replace or retire another request.
  if (!navigator.locks) throw new Error('Save request storage cannot be coordinated. This save was not sent.')
  await navigator.locks.request(moteAvatarSaveDraftKey(target), work)
}

export async function keepMoteAvatarSaveDraft(request: MoteAvatarSave): Promise<void> {
  parseMoteAvatarSave(request)
  await withDraftLock(request.target, async () => {
    const existing = readMoteAvatarSaveDraft(request.target)
    if (existing && avatarSeriesCanonical(existing) !== avatarSeriesCanonical(request)) throw new Error('Another original save request is kept for this Mote. Inspect it before saving again.')
    if (!existing) localStorage.setItem(moteAvatarSaveDraftKey(request.target), JSON.stringify(request))
    // The IPC acknowledgement confirms the platform flush request, not a disk/fsync guarantee.
    await api.ui.requestStorageFlush()
  })
}

/** Only called after a native refusal or acknowledged original publication. */
export async function retireMoteAvatarSaveDraft(request: MoteAvatarSave): Promise<void> {
  await withDraftLock(request.target, async () => {
    const key = moteAvatarSaveDraftKey(request.target), bytes = localStorage.getItem(key)
    if (bytes === null) return
    const existing = readMoteAvatarSaveDraft(request.target)
    if (existing?.operationId !== request.operationId || avatarSeriesCanonical(existing) !== avatarSeriesCanonical(request)) throw new Error('Another original save request is kept. Its bytes are retained.')
    try {
      localStorage.removeItem(key)
      await api.ui.requestStorageFlush()
    } catch (cause) {
      // Restore the exact original bytes under the same lock; keep the request for read-only reconciliation.
      localStorage.setItem(key, bytes)
      throw cause
    }
  })
}
