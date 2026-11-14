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
  return `Help me install, diagnose and prepare Tailcat setup for AgentMux using its existing settings, CLI and native UI capabilities.\n\n` +
    `Installation and diagnosis target: the Desktop Mac where I clicked this request. Its Host route is local; its original Core Runtime ID is ${runtimeId ? JSON.stringify(runtimeId) : 'unconfirmed'}.\n` +
    `First verify your own execution/tool Host identity against that original Runtime. Another device's local is not this Mac. If the target is unknown or different, give instructions or use its existing authorized route; do not install on your own local by assumption.\n\n` +
    `The connection being edited is a separate target:\n${JSON.stringify(context, null, 2)}\n\n` +
    `Start at the recorded settings target and preparation step. Use the original machine code when present; an unknown cause stays unknown. RPC_METHOD_NOT_FOUND or CONTROL_UNAVAILABLE refers to the serving AgentMux setup capability; check that service before any CLI installation. TAILCAT_CLI_MISSING means that service cannot find the CLI in its PATH, even if another terminal can.\n` +
    `Dependency command, only after confirming the CLI is needed on that exact Mac: brew install tailcat. Check the original CLI/environment, reuse existing keys, and help prepare the missing fields through available public/native capabilities. Do not claim settings drafts have a general Agent write API or are already saved.\n` +
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
