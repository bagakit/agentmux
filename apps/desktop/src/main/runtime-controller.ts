import {
  AgentMuxRuntime,
  type AgentId,
  type ExecutionHost,
  type PreparedExecutionHost
} from '@agentmux/core'
import type { WebContents } from 'electron'
import type {
  AgentDetection,
  AgentLaunchInput,
  AppConfig,
  TerminalLaunchInput
} from '../shared/contracts.js'
import { createExecutionHost } from './host-factory.js'

type InitialRuntimePreparation = {
  kind: 'initial'
  runtime: AgentMuxRuntime
  hostSignatures: Map<string, string>
}

type RuntimeUpdatePreparation = {
  kind: 'update'
  hosts: PreparedExecutionHost[]
  removedHostIds: string[]
  hostSignatures: Map<string, string>
}

export type RuntimePreparation = InitialRuntimePreparation | RuntimeUpdatePreparation

function signatures(config: AppConfig): Map<string, string> {
  return new Map(config.hosts.map((host) => [host.id, JSON.stringify(host)]))
}

async function disposeHosts(hosts: readonly ExecutionHost[]): Promise<void> {
  const results = await Promise.allSettled(hosts.map(async (host) => await host.dispose()))
  const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
  if (errors.length > 0) throw new AggregateError(errors, 'Failed to dispose prepared execution hosts.')
}

export class RuntimeController {
  private runtime: AgentMuxRuntime | null = null
  private unsubscribe: (() => void) | null = null
  private readonly clients = new Set<WebContents>()
  private hostSignatures = new Map<string, string>()

  async prepare(config: AppConfig): Promise<RuntimePreparation> {
    const nextSignatures = signatures(config)
    if (!this.runtime) {
      const runtime = new AgentMuxRuntime({ hosts: config.hosts.map(createExecutionHost) })
      try {
        await runtime.start()
      } catch (error) {
        try {
          await runtime.dispose()
        } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Runtime preparation and cleanup both failed.')
        }
        throw error
      }
      return { kind: 'initial', runtime, hostSignatures: nextSignatures }
    }

    this.assertConfigurable(nextSignatures)
    const changedHosts = config.hosts
      .filter((host) => this.hostSignatures.get(host.id) !== nextSignatures.get(host.id))
      .map(createExecutionHost)
    const preparationResults = await Promise.allSettled(
      changedHosts.map(async (host) => await this.runtime!.prepareHost(host))
    )
    const preparationErrors = preparationResults.flatMap(
      (result) => result.status === 'rejected' ? [result.reason] : []
    )
    if (preparationErrors.length > 0) {
      try {
        await disposeHosts(changedHosts)
      } catch (cleanupError) {
        throw new AggregateError(
          [...preparationErrors, cleanupError],
          'Host discovery and cleanup both failed.'
        )
      }
      if (preparationErrors.length === 1) throw preparationErrors[0]
      throw new AggregateError(preparationErrors, 'Multiple execution hosts failed discovery.')
    }
    const preparedHosts = preparationResults.flatMap(
      (result) => result.status === 'fulfilled' ? [result.value] : []
    )
    return {
      kind: 'update',
      hosts: preparedHosts,
      removedHostIds: [...this.hostSignatures.keys()].filter((id) => !nextSignatures.has(id)),
      hostSignatures: nextSignatures
    }
  }

  commit(preparation: RuntimePreparation): void {
    if (preparation.kind === 'initial') {
      if (this.runtime) throw new Error('Runtime is already configured')
      this.runtime = preparation.runtime
      this.hostSignatures = preparation.hostSignatures
      this.subscribe()
      return
    }
    if (!this.runtime) throw new Error('Runtime is not configured')
    const retiredHosts: ExecutionHost[] = []
    for (const hostId of preparation.removedHostIds) {
      const retired = this.runtime.removeHost(hostId)
      if (retired) retiredHosts.push(retired)
    }
    for (const preparedHost of preparation.hosts) {
      const retired = this.runtime.commitHost(preparedHost)
      if (retired) retiredHosts.push(retired)
    }
    this.hostSignatures = preparation.hostSignatures
    for (const host of retiredHosts) {
      void host.dispose().catch((error) => {
        console.error(`Failed to dispose retired execution host ${host.id}`, error)
      })
    }
  }

  async discard(preparation: RuntimePreparation): Promise<void> {
    if (preparation.kind === 'initial') {
      await preparation.runtime.dispose()
      return
    }
    await disposeHosts(preparation.hosts.map((prepared) => prepared.host))
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

  private assertConfigurable(nextSignatures: ReadonlyMap<string, string>): void {
    if (!this.runtime) return
    for (const session of this.runtime.snapshot().sessions) {
      if (nextSignatures.get(session.hostId) !== this.hostSignatures.get(session.hostId)) {
        throw new Error(`Stop sessions on ${session.hostId} before changing that host`)
      }
    }
  }

  private subscribe(): void {
    this.unsubscribe = this.runtime!.onEvent((event) => {
      for (const client of this.clients) {
        if (client.isDestroyed()) continue
        try {
          client.send('agentmux:session-event', event)
        } catch (error) {
          console.error('Failed to publish AgentMux Runtime event', error)
        }
      }
    })
  }
}
