import { isDeepStrictEqual } from 'node:util'
import { AgentMuxError, assertTailcatConfigurationWriter, isTailcatNodePublicKey, parseTailcatConfigurationParams, tailcatConfigurationRevision,
  type TailcatListenerObservation, type TailcatConfigurationMethod, type TailcatConfigurationParamsMap, type TailcatConfigurationContext, type TailcatConfigurationObservation } from '@agentmux/core'
import { hostSchema } from './config-store.js'
import type { ConfigOwner } from './config-owner.js'
import type { AppConfig } from '../shared/contracts.js'
import type { LocalHostConfig } from '@agentmux/host/host-configuration'

function localHost(config: AppConfig): LocalHostConfig {
  const hosts = config.hosts.filter(host => host.id === 'local')
  if (hosts.length !== 1 || hosts[0]!.kind !== 'local') throw new AgentMuxError('The answering App’s original local Host record is unavailable or ambiguous. Existing Agents and configuration remain available.', 'HOST_CONFIGURATION_CHANGED')
  return hosts[0] as LocalHostConfig
}
const capture = (config: AppConfig): TailcatConfigurationObservation['configuration'] => {
  const value = structuredClone(localHost(config).tailcat ?? null)
  return { source: 'original-config-owner', value, revision: tailcatConfigurationRevision(value), readAt: Date.now() }
}

/** One fixed slice of the original ConfigOwner; the original Host watcher owns adoption. */
export class SettingsTailcatConfiguration {
  constructor(private readonly config: ConfigOwner, private readonly readListener: (signal?: AbortSignal) => Promise<TailcatListenerObservation | undefined>) {}
  async call<M extends TailcatConfigurationMethod>(method: M, params: TailcatConfigurationParamsMap[M], context: TailcatConfigurationContext): Promise<TailcatConfigurationObservation> {
    const input = parseTailcatConfigurationParams(method, params)
    let configuration: TailcatConfigurationObservation['configuration']
    if (method === 'settings.hosts.tailcat.configure') {
      assertTailcatConfigurationWriter(context)
      const change = input as TailcatConfigurationParamsMap['settings.hosts.tailcat.configure']
      const saved = await this.config.update(current => {
        const local = localHost(current)
        if (!isDeepStrictEqual(local.tailcat ?? null, change.expected)) throw new AgentMuxError('The original incoming Tailcat slice changed. Inspect it before deciding the next exact save; no listener was restarted by this rejection.', 'CONFIG_CONFLICT')
        const { tailcat: _previous, ...base } = local
        const candidate = hostSchema.parse(change.candidate === null ? base : { ...base, tailcat: change.candidate })
        if (change.candidate?.enabled && change.candidate.allowedClients.some(key => !isTailcatNodePublicKey(key))) throw new AgentMuxError('Enable incoming Tailcat only with original node public keys. No configuration or listener was changed.', 'INVALID_CONTROL_REQUEST')
        return { ...current, hosts: current.hosts.map(host => host === local ? candidate : host) }
      })
      configuration = capture(saved)
    } else configuration = await this.config.inspect(capture)
    // Never wait for a remote/Host observation while holding ConfigOwner’s save queue.
    let listener: TailcatListenerObservation
    try { listener = await this.readListener(context.signal) ?? { state: 'unknown', detail: 'The original local Host did not return its listener observation. Keep the saved configuration and refresh this read.' } }
    catch { listener = { state: 'unknown', detail: 'The original local Host listener observation is unavailable. Keep the saved configuration and refresh this read.' } }
    return { routeHostId: 'local', configuration, listener: { source: 'original-local-host-listener', value: listener, readAt: Date.now() } }
  }
}
