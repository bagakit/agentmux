import type { HostConfig } from '../../../shared/contracts'
import type { TailcatKeyRole } from '@agentmux/core'
import { api } from './api'
import { useAppStore } from '../store'

/** Explicit allowlist of nonsecret context. Host configuration and raw failures never become task payloads. */
export function tailcatSetupContext(host: HostConfig, role: TailcatKeyRole) {
  return { configuredHost: { id: host.id, label: host.label, kind: host.kind }, role,
    fields: { keyFieldFilled: Boolean(host.tailcat?.keyFile),
      privateDestinationFieldFilled: host.kind === 'ssh' && Boolean(host.tailcat?.address),
      allowedClientsFieldFilled: host.kind === 'local' && Boolean(host.tailcat?.allowedClients.length) },
    configuration: 'Current settings fields; saving and application are not confirmed by this request.' }
}
export function tailcatSetupPrompt(context: ReturnType<typeof tailcatSetupContext>, runtimeId: string | null): string {
  return `Help me install, diagnose and prepare Tailcat setup for AgentMux using its existing settings, CLI and native UI capabilities.\n\n` +
    `Installation and diagnosis target: the Desktop Mac where I clicked this request. Its Host route is local; its original Core Runtime ID is ${runtimeId ? JSON.stringify(runtimeId) : 'unconfirmed'}.\n` +
    `First verify your own execution/tool Host identity against that original Runtime. Another device's local is not this Mac. If the target is unknown or different, give instructions or use its existing authorized route; do not install on your own local by assumption.\n\n` +
    `The connection being edited is a separate target:\n${JSON.stringify(context, null, 2)}\n\n` +
    `Dependency command for the person or an authorized operator on that exact Mac: brew install tailcat. Check the original CLI/environment, reuse existing keys, and help prepare the missing fields through available public/native capabilities. Do not claim settings drafts have a general Agent write API or are already saved.\n` +
    `Explain any required person action. Keep original keys, private credentials, drafts and healthy Agent work. You may help fill ordinary fields and user-provided public-key drafts through the existing authorized UI. Granting a client access, enabling incoming connections and the final save still require the original person's confirmation; do not write configuration files directly, approve access for them or claim the connection succeeded. Key preparation retains its original local-person permission and must not be bypassed through another UI path. Do not copy private addresses, private keys or raw error output into replies.`
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
