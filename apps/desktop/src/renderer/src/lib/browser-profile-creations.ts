import { mintObjectId } from '@agentmux/core/object-id'
import { browserProfileCreationCanonical, isBrowserProfileCreationOperation, parseBrowserProfileControlPayload,
  type BrowserProfileControlPayload, type BrowserProfileCreationOperation } from '@agentmux/core/control'
import { desktopUserFragments } from './desktop-user-state'
import { api } from './api'

type Request = Extract<BrowserProfileControlPayload, { operation: BrowserProfileCreationOperation }>
type Draft = Request extends infer R ? R extends Request ? Omit<R, 'operationId'> : never : never
type Pending = Partial<Record<BrowserProfileCreationOperation, Request>>
const member = 'browserProfileCreations' as const
function parse(raw: string | null | undefined): Pending {
  if (raw == null) return {}
  const value = JSON.parse(raw)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Original Profile creation requests are unreadable. Their bytes are retained.')
  for (const [action, request] of Object.entries(value)) {
    if (!isBrowserProfileCreationOperation(action) || parseBrowserProfileControlPayload(request as Record<string, unknown>, ['operation']).operation !== action)
      throw new Error('An original Profile creation request belongs to another action. Its bytes are retained.')
  }
  return value
}
/** Only unfinished client input is kept here; Main's original Store owns all created identities. */
export function createProfileCreationClient(profiles: Pick<typeof api.browser, 'createProfileIdentity' | 'inspectProfileCreation' | 'confirmProfileCreation'>,
  fragments: Pick<typeof desktopUserFragments, 'load' | 'read' | 'write' | 'checkpoint'>) {
  const inFlight = new Set<BrowserProfileCreationOperation>()
  const listeners = new Set<() => void>()
  const changed = () => { for (const listener of listeners) { try { listener() } catch { /* A presentation observer cannot change an original operation. */ } } }
  const write = (pending: Pending) => { fragments.write(member, JSON.stringify(pending)); changed() }
  const clearConfirmed = async (request: Request, createdId: string) => {
    const current = parse(fragments.read(member))
    if (current[request.operation]?.operationId !== request.operationId) return
    delete current[request.operation]
    write(current)
    try { await fragments.checkpoint(member) }
    catch (cause) {
      // A failed cleanup ACK must not forget the original request in the live cache.
      const latest = parse(fragments.read(member))
      if (!latest[request.operation]) { latest[request.operation] = request; write(latest) }
      throw Object.assign(new Error('Original creation ' + request.operationId + ' produced ' + createdId + ', but saving its client confirmation is unconfirmed. The original request and your input are retained.'), { cause })
    }
  }
  const submit = async function submitProfileCreation(draft: Draft) {
    const action = draft.operation
    if (inFlight.has(action)) throw new Error('This original Profile creation is already awaiting its result.')
    inFlight.add(action)
    try {
      await fragments.load(member, parse)
      const pending = parse(fragments.read(member)), held = pending[action]
      const request = held ?? { ...structuredClone(draft), operationId: mintObjectId() } as Request
      if (held) {
        const { operationId: _id, ...original } = held
        const sameDraft = browserProfileCreationCanonical(original) === browserProfileCreationCanonical(draft)
        const observed = await profiles.inspectProfileCreation(held.operationId)
        if (observed.creation.receipt) {
          if (!sameDraft) throw new Error('Original creation ' + held.operationId + ' identifies ' + observed.creation.receipt.createdId + ', but its storage is unconfirmed. Your later input is retained; use Confirm creation before repeating this action.')
          return observed
        }
        if (!sameDraft) throw new Error('Original creation ' + held.operationId + ' is still awaiting confirmation. Its exact request is retained; resolve it before submitting another ' + action + '.')
        // This invocation is an explicit retry of the same idempotent request, never a new identity.
      } else {
        pending[action] = request
        write(pending)
      }
      // Also required after an earlier checkpoint failed: memory presence is not a durable client request.
      try { await fragments.checkpoint(member) }
      catch (cause) { throw Object.assign(new Error('Original creation ' + request.operationId + ' has not been dispatched: its client request save is unconfirmed. Keep this input and retry the same request. ' + (cause instanceof Error ? cause.message : String(cause))), { cause }) }
      let result
      try { result = await profiles.createProfileIdentity(request) }
      catch (cause) {
        try {
          const observed = await profiles.inspectProfileCreation(request.operationId)
          if (observed.creation.receipt) result = observed
        } catch { /* Keep the original request, never replay from an observation failure. */ }
        if (!result) throw Object.assign(new Error('Original creation ' + request.operationId + ' is awaiting confirmation. Its request is retained. ' + (cause instanceof Error ? cause.message : String(cause))), { code: 'BROWSER_PROFILE_CREATION_UNCONFIRMED', cause })
      }
      if (result.creation.durability === 'confirmed' && result.creation.confirmation !== 'observation') await clearConfirmed(request, result.creation.receipt!.createdId)
      return result
    } finally { inFlight.delete(action); changed() }
  }
  return Object.assign(submit, {
    isInFlight(action: BrowserProfileCreationOperation) { return inFlight.has(action) },
    async pending(): Promise<Request[]> { await fragments.load(member, parse); return structuredClone(Object.values(parse(fragments.read(member)))) as Request[] },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async confirm(action: BrowserProfileCreationOperation) {
      if (inFlight.has(action)) throw new Error('This original creation is already awaiting its result.')
      inFlight.add(action)
      try {
        await fragments.load(member, parse)
        const request = parse(fragments.read(member))[action]
        if (!request) throw new Error('There is no pending original creation to confirm.')
        const result = await profiles.confirmProfileCreation(structuredClone(request))
        if (result.creation.durability !== 'confirmed' || result.creation.confirmation !== 'current-metadata-sync') throw new Error('The original creation storage is still unconfirmed. Its complete request is retained.')
        await clearConfirmed(request, result.creation.receipt!.createdId)
        return result
      } finally { inFlight.delete(action); changed() }
    }
  })
}

export const submitProfileCreation = createProfileCreationClient(api.browser, desktopUserFragments)
