import type { CapsuleInspection, CapsuleOpenResult, CapsulePort } from '@agentmux/core/capsule'
import type { CapsuleRemoteSource } from '../shared/contracts.js'
import type { BrowserColdDescriptor } from './browser-cold-descriptor.js'
import { browserColdDescriptor } from './browser-cold-descriptor.js'
import { capsulePresentation, type CapsulePresentationPorts } from './capsule-presentation.js'
import { RemoteCapsuleProxy } from './remote-capsule-proxy.js'
import { browserObjectLink } from '../shared/browser-object-link.js'

export type RemoteCapsuleTarget = { hostId: string; expectedRuntimeId: string; capsuleId: string; operationId: string;
  objectLink?: string;
  placement?: import('@agentmux/core/capsule').CapsuleParamsMap['capsule.open']['placement'] }
type Carrier = { source: CapsuleRemoteSource; proxy: RemoteCapsuleProxy; objectLink?: string }

/** One Main owner of local carriers. Original Core owns the page, policy and interaction records. */
export function createRemoteCapsulePresentation(ports: Omit<CapsulePresentationPorts, 'inspect'> & {
  acquire(target: CapsuleRemoteSource, signal?: AbortSignal): Promise<CapsulePort>
}) {
  const carriers = new Map<string, Promise<Carrier>>()
  const byOrigin = new Map<string, Carrier>()
  const key = (source: CapsuleRemoteSource, capsuleId: string) => JSON.stringify([source.runtimeId, capsuleId])
  const retainLink = (carrier: Carrier, objectLink: string | undefined, prefer: boolean) => {
    const confirmed = browserObjectLink({ url: carrier.proxy.origin + '/', capsuleOrigin: carrier.proxy.origin,
      capsuleId: carrier.proxy.capsule.record.capsuleId, capsuleRemote: carrier.source,
      ...(objectLink === undefined ? {} : { capsuleObjectLink: objectLink }) })
    if (confirmed && (prefer || !carrier.objectLink)) carrier.objectLink = confirmed
  }
  const prepare = async (source: CapsuleRemoteSource, capsuleId: string,
    { savedOrigin, signal, objectLink, preferLink = false }: { savedOrigin?: string | undefined; signal?: AbortSignal | undefined;
      objectLink?: string | undefined; preferLink?: boolean } = {}): Promise<Carrier> => {
    signal?.throwIfAborted()
    if (source.hostId === 'local') throw Error('Open this local Capsule through its original local owner and storage. No remote container was created.')
    const client = await ports.acquire(source, signal)
    const inspection = await client.call('capsule.inspect', { capsuleId }, { ...(signal ? { signal } : {}) })
    if (inspection.endpoint.status !== 'available') throw Error(inspection.endpoint.issue.message)
    signal?.throwIfAborted()
    const id = key(source, capsuleId), existing = carriers.get(id)
    if (existing) {
      const carrier = await existing
      if (savedOrigin !== undefined && savedOrigin !== carrier.proxy.origin) throw Error('The saved Capsule origin differs from its current carrier. Both original workfaces are retained.')
      carrier.proxy.client = client; carrier.proxy.capsule = inspection; carrier.source = { ...source }
      retainLink(carrier, objectLink, preferLink)
      return carrier
    }
    const pending = (async () => {
      const proxy = new RemoteCapsuleProxy(inspection, client)
      try { await proxy.listen(savedOrigin); const carrier: Carrier = { source: { ...source }, proxy };
        retainLink(carrier, objectLink, true); byOrigin.set(proxy.origin, carrier); return carrier }
      catch (error) { await proxy.close(); throw error }
    })()
    carriers.set(id, pending)
    try { return await pending }
    catch (error) { if (carriers.get(id) === pending) carriers.delete(id); throw error }
  }
  return {
    /** The exact URI resolver calls this only after normal configured-Host authorization. */
    async openRemoteCapsule(input: RemoteCapsuleTarget, signal?: AbortSignal): Promise<CapsuleOpenResult> {
      const source = { hostId: input.hostId, runtimeId: input.expectedRuntimeId }
      const graph = await ports.graph()
      const saved = graph?.regions.flatMap(region => {
        if (region.kind !== 'browser' || !region.browserId) return []
        try {
          const page = browserColdDescriptor(graph, region.browserId)
          return page.capsuleId === input.capsuleId && page.capsuleRemote?.runtimeId === source.runtimeId ? [page] : []
        } catch { return [] }
      }) ?? []
      const origins = new Set(saved.map(page => page.capsuleOrigin))
      if (origins.size > 1) throw Error('This original Capsule has multiple saved local origins. Inspect its exact Browser before opening; no container was replaced.')
      const carrier = await prepare(source, input.capsuleId, { savedOrigin: saved[0]?.capsuleOrigin, signal,
        objectLink: input.objectLink ?? saved[0]?.capsuleObjectLink, preferLink: input.objectLink !== undefined })
      signal?.throwIfAborted()
      const presenter = capsulePresentation({ ...ports, inspect: async () => carrier.proxy.capsule,
        recordOpen: (id, capsuleId, operationId) => ports.recordOpen(id, capsuleId, operationId, carrier.objectLink),
        presentationUrl: () => carrier.proxy.origin + '/' })
      return await presenter.call('capsule.open', { capsuleId: input.capsuleId, operationId: input.operationId,
        ...(input.placement ? { placement: input.placement } : {}) }, { ...(signal ? { signal } : {}) })
    },
    /** Only Main's acquired origin can attach remote provenance to a new native page. */
    async document(url: string, capsuleId: string): Promise<{ capsule: CapsuleInspection; capsuleOrigin: string; capsuleRemote: CapsuleRemoteSource; capsuleObjectLink?: string } | null> {
      const origin = new URL(url).origin
      const carrier = byOrigin.get(origin)
      if (!carrier) return null
      if (carrier.proxy.capsule.record.capsuleId !== capsuleId) throw Error('The local carrier belongs to another original Capsule.')
      return { capsule: carrier.proxy.capsule, capsuleOrigin: origin, capsuleRemote: { ...carrier.source },
        ...(carrier.objectLink === undefined ? {} : { capsuleObjectLink: carrier.objectLink }) }
    },
    async restore(saved: BrowserColdDescriptor): Promise<BrowserColdDescriptor> {
      if (!saved.capsuleRemote || !saved.capsuleId || !saved.capsuleOrigin) throw Error('The saved remote Capsule owner is incomplete. Its original Region remains available.')
      const carrier = await prepare(saved.capsuleRemote, saved.capsuleId, { savedOrigin: saved.capsuleOrigin, objectLink: saved.capsuleObjectLink })
      return { ...saved, capsule: carrier.proxy.capsule }
    },
    async inspect(source: CapsuleRemoteSource, capsuleId: string): Promise<CapsuleInspection> {
      return (await prepare(source, capsuleId)).proxy.capsule
    },
    async client(source: CapsuleRemoteSource, capsuleId: string): Promise<CapsulePort> {
      // The confirmed document already owns a fenced transport. Re-probing Runtime
      // identity before every SDK read could revoke healthy work on an observation gap.
      const original = carriers.get(key(source, capsuleId))
      return original ? (await original).proxy.client : await ports.acquire(source)
    },
    async dispose(): Promise<void> {
      const active = [...carriers.values()]; carriers.clear(); byOrigin.clear()
      await Promise.all(active.map(async pending => { try { await (await pending).proxy.close() } catch { /* Acquisition failure has its original caller diagnostic. */ } }))
    }
  }
}
