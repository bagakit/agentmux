import { renderAmuxProtocol } from '@agentmux/core/amux-protocol'
import type { HostConfig } from '../../../shared/contracts'
import type { TailcatKeyRole } from '@agentmux/core'
import { api } from './api'
import { useAppStore } from '../store'
import type { TailcatPreparationCode } from './tailcat-preparation-failure'

export type TailcatSetupFailure = { step: 'prepare-key'; code: TailcatPreparationCode | null }

/** Explicit allowlist of nonsecret context. Host configuration and raw failures never become task payloads. */
export function tailcatSetupContext(host: HostConfig, role: TailcatKeyRole, failure?: TailcatSetupFailure) {
  return { configuredHost: { id: host.id, label: host.label, kind: host.kind }, role,
    settingsTarget: { section: 'hosts', hostId: host.id, item: role === 'server' ? 'incoming' : 'connection' },
    ...(failure ? { failure: { step: failure.step, code: failure.code } } : {}),
    fields: { keyFieldFilled: Boolean(host.tailcat?.keyFile),
      privateDestinationFieldFilled: host.kind === 'ssh' && Boolean(host.tailcat?.address),
      allowedClientsFieldFilled: host.kind === 'local' && Boolean(host.tailcat?.allowedClients.length) },
    configuration: 'Current settings fields; saving and application are not confirmed by this request.' }
}
export function tailcatSetupPrompt(context: ReturnType<typeof tailcatSetupContext>, runtimeId: string | null): string {
  return renderAmuxProtocol('tailcat-setup', 'setup', {
    runtimeId: runtimeId ? JSON.stringify(runtimeId) : 'unconfirmed',
    context: JSON.stringify(context, null, 2)
  })
}

/** One explicit-help read identifies this Desktop's original owner; an observation failure does not close help. */
export async function createTailcatSetupTask(context: ReturnType<typeof tailcatSetupContext>): Promise<string> {
  const local = useAppStore.getState().config?.hosts.find(host => host.id === 'local' && host.kind === 'local')
  let runtimeId: string | null = null
  if (local) {
    try {
      const observation = await api.hosts.inspect(local)
      if (observation.routeHostId === local.id && observation.owner.state === 'available') runtimeId = observation.owner.value.runtimeId
    } catch { /* Only this owner observation is unknown; the explicit Mote request remains available. */ }
  }
  return tailcatSetupPrompt(context, runtimeId)
}
