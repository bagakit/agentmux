import { AgentMuxRuntime, type AgentId, type AgentLaunchRequest } from '@agentmux/core'
import type { WebContents } from 'electron'
import type { AgentDetection, AppConfig } from '../shared/contracts.js'
import { createExecutionHost } from './host-factory.js'

export class RuntimeController {
  private runtime: AgentMuxRuntime | null = null
  private unsubscribe: (() => void) | null = null
  private readonly clients = new Set<WebContents>()
  private readonly hostSignatures = new Map<string, string>()

  async configure(config: AppConfig): Promise<void> {
    if (!this.runtime) {
      this.runtime = new AgentMuxRuntime({ hosts: config.hosts.map(createExecutionHost) })
      for (const host of config.hosts) this.hostSignatures.set(host.id, JSON.stringify(host))
      this.unsubscribe = this.runtime.onEvent((event) => {
        for (const client of this.clients) {
          if (!client.isDestroyed()) client.send('agentmux:event', event)
        }
      })
      await this.runtime.start()
      return
    }
    for (const host of config.hosts) {
      const signature = JSON.stringify(host)
      if (this.hostSignatures.get(host.id) === signature) continue
      if (this.runtime.snapshot().sessions.some((session) => session.hostId === host.id)) {
        throw new Error(`Stop sessions on ${host.label} before changing its connection settings`)
      }
      await this.runtime.hosts.replace(createExecutionHost(host))
      this.hostSignatures.set(host.id, signature)
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

  async launch(request: Omit<AgentLaunchRequest, 'args' | 'env' | 'commandOverride'>, config: AppConfig) {
    const agent = config.agents[request.agentId]
    if (!agent) throw new Error(`Missing agent configuration: ${request.agentId}`)
    return await this.value.launch({
      ...request,
      args: agent.args,
      env: agent.env,
      commandOverride: agent.command
    })
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
