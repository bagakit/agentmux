import { AgentMuxRuntime, type AgentId } from '@agentmux/core'
import type { WebContents } from 'electron'
import type {
  AgentDetection,
  AgentLaunchInput,
  AppConfig,
  TerminalLaunchInput
} from '../shared/contracts.js'
import { createExecutionHost } from './host-factory.js'

export class RuntimeController {
  private runtime: AgentMuxRuntime | null = null
  private unsubscribe: (() => void) | null = null
  private readonly clients = new Set<WebContents>()
  private readonly hostSignatures = new Map<string, string>()

  assertConfigurable(config: AppConfig): void {
    if (!this.runtime) return
    const nextHosts = new Map(config.hosts.map((host) => [host.id, JSON.stringify(host)]))
    for (const session of this.runtime.snapshot().sessions) {
      if (nextHosts.get(session.hostId) !== this.hostSignatures.get(session.hostId)) {
        throw new Error(`Stop sessions on ${session.hostId} before changing that host`)
      }
    }
  }

  async configure(config: AppConfig): Promise<void> {
    if (!this.runtime) {
      this.runtime = new AgentMuxRuntime({ hosts: config.hosts.map(createExecutionHost) })
      for (const host of config.hosts) this.hostSignatures.set(host.id, JSON.stringify(host))
      this.unsubscribe = this.runtime.onEvent((event) => {
        for (const client of this.clients) {
          if (!client.isDestroyed()) client.send('agentmux:session-event', event)
        }
      })
      await this.runtime.start()
      return
    }
    this.assertConfigurable(config)
    const configuredHostIds = new Set(config.hosts.map((host) => host.id))
    for (const hostId of [...this.hostSignatures.keys()]) {
      if (configuredHostIds.has(hostId)) continue
      await this.runtime.hosts.remove(hostId)
      this.hostSignatures.delete(hostId)
    }
    for (const host of config.hosts) {
      const signature = JSON.stringify(host)
      if (this.hostSignatures.get(host.id) === signature) continue
      await this.runtime.hosts.replace(createExecutionHost(host))
      this.hostSignatures.set(host.id, signature)
      await this.runtime.discover(host.id)
    }
  }

  attach(client: WebContents): () => void {
    this.clients.add(client)
    return () => this.clients.delete(client)
  }

  get value(): AgentMuxRuntime {
    if (!this.runtime) throw new Error('Runtime is not configured')
    return this.runtime
  }

  async detect(agentId: AgentId, hostId: string, config: AppConfig): Promise<AgentDetection> {
    const agent = config.agents[agentId]
    return {
      agentId,
      hostId,
      installed: await this.value.detect(agentId, hostId, agent?.command)
    }
  }

  async launchAgent(request: AgentLaunchInput, config: AppConfig) {
    const agent = config.agents[request.agentId]
    if (!agent) throw new Error(`Missing agent configuration: ${request.agentId}`)
    return await this.value.launch({
      ...request,
      kind: 'agent',
      args: agent.args,
      env: agent.env,
      commandOverride: agent.command
    })
  }

  async launchTerminal(request: TerminalLaunchInput) {
    return await this.value.launch({ ...request, kind: 'terminal' })
  }

  async dispose(): Promise<void> {
    this.unsubscribe?.()
    this.unsubscribe = null
    await this.runtime?.dispose()
    this.runtime = null
    this.clients.clear()
    this.hostSignatures.clear()
  }
}
