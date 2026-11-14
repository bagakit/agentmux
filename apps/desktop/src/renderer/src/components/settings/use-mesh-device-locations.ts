import { useEffect, useMemo, useState } from 'react'
import type { HostConfig } from '../../../../shared/contracts'
import type { MeshDeviceLocation } from '../../../../shared/mesh-map-locations'
import type { NodePublishingResults } from '@agentmux/core/node-publishing'
import { meshDeviceMapId, readMeshDeviceLink } from '../../../../shared/mesh-device-link'
import { useAppStore } from '../../store'
import { api } from '../../lib/api'
import { clusterHostKey } from './cluster-resource-observation'
import { SAVED_CLIENT_ID, savedHostId } from './MeshSavedConnections'

type NodeRead = NodePublishingResults['node.location']

function mapPoints(replies: ReadonlyMap<string, NodeRead>, networkId?: string): ReadonlyMap<string, MeshDeviceLocation> {
  const points = new Map<string, MeshDeviceLocation>()
  const origins = new Map<string, string | null>()
  for (const [hostId, reply] of replies) {
    if (!reply.location) continue
    points.set(hostId, reply.location)
    if (!reply.meshPeer || reply.meshPeer.networkId !== networkId) continue
    const peer = 'relay:' + reply.meshPeer.peerId
    if (origins.has(peer) && origins.get(peer) !== reply.node.runtimeId) {
      origins.set(peer, null)
      points.delete(peer)
    } else {
      origins.set(peer, reply.node.runtimeId)
      points.set(peer, reply.location)
    }
  }
  return points
}

const empty = new Map<string, NodeRead>()

/** The original Node is reached through its own saved carrier. Viewing the hidden graph starts no work. */
export function useMeshDeviceLocations(hosts: readonly HostConfig[], active: boolean, refresh: number, networkId?: string) {
  const links = useAppStore(state => state.meshDeviceLinks.saved)
  const key = JSON.stringify([hosts.map(clusterHostKey), links])
  const [observed, setObserved] = useState<{ key: string; replies: ReadonlyMap<string, NodeRead> }>()
  useEffect(() => {
    if (!active) return
    const cancel = new AbortController(), replies = new Map<string, NodeRead>()
    let next = 0
    const update = () => setObserved({ key, replies: new Map(replies) })
    const read = async () => {
      while (!cancel.signal.aborted && next < hosts.length) {
        const host = hosts[next++]!
        const expectedRuntimeId = host.kind === 'ssh' ? host.runtimeId : undefined
        try {
          const reply = await api.nodePublishing.call('node.location', { hostId: host.id, ...(expectedRuntimeId ? { expectedRuntimeId } : {}) }, cancel.signal)
          if (cancel.signal.aborted) return
          if (reply?.node && (!expectedRuntimeId || reply.node.runtimeId === expectedRuntimeId)) {
            replies.set(host.kind === 'local' ? SAVED_CLIENT_ID : savedHostId(host.id), reply)
          }
        } catch { if (cancel.signal.aborted) return }
        update()
      }
    }
    for (let index = 0; index < Math.min(hosts.length, 3); index++) void read()
    // A saved access link may be this device’s only carrier. Read its own pin inside the paired device partition.
    // Only one additional partition is read at a time. Viewing another settings page releases it.
    void (async () => {
      for (const link of links) {
        if (cancel.signal.aborted) return
        try {
          const id = meshDeviceMapId(readMeshDeviceLink(link).offer)
          if (replies.has(id)) continue
          const reply = await api.nodePublishing.deviceLocation(link, cancel.signal)
          if (cancel.signal.aborted) return
          if (reply) replies.set(id, reply)
        } catch { if (cancel.signal.aborted) return }
        update()
      }
    })()
    return () => cancel.abort()
  }, [active, key, refresh])
  const replies = observed?.key === key ? observed.replies : empty
  return useMemo(() => mapPoints(replies, networkId), [replies, networkId])
}
