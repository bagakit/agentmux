import { AgentMuxError } from './errors.js'
import type { ExecutionHost } from './execution-host.js'
import type {
  AgentId,
  AgentLaunchPlan,
  AgentProviderLaunchContext,
  BuiltInAgentId
} from './types.js'

export type AgentProvider = {
  readonly id: AgentId
  readonly label: string
  readonly executable: string
  detect(host: ExecutionHost, commandOverride?: string): Promise<boolean>
  buildLaunch(context: AgentProviderLaunchContext): AgentLaunchPlan
}

type ProviderDefinition = {
  id: BuiltInAgentId
  label: string
  executable: string
  buildArgs(prompt: string, args: readonly string[]): string[]
}

async function detectExecutable(host: ExecutionHost, executable: string): Promise<boolean> {
  const result = await host.run(
    'sh',
    ['-lc', 'command -v -- "$1" >/dev/null 2>&1', 'agentmux-detect', executable],
    { timeoutMs: 8_000 }
  )
  return result.exitCode === 0
}

function defineProvider(definition: ProviderDefinition): AgentProvider {
  return {
    id: definition.id,
    label: definition.label,
    executable: definition.executable,
    async detect(host, commandOverride) {
      return await detectExecutable(host, commandOverride ?? definition.executable)
    },
    buildLaunch(context) {
      const command = context.commandOverride?.trim() || definition.executable
      if (!command) throw new AgentMuxError('Agent command cannot be empty.', 'INVALID_AGENT_COMMAND')
      return {
        command,
        args: definition.buildArgs(context.prompt.trim(), context.args),
        env: { ...context.env }
      }
    }
  }
}

export const BUILT_IN_AGENT_PROVIDERS: readonly AgentProvider[] = [
  defineProvider({
    id: 'codex',
    label: 'Codex',
    executable: 'codex',
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])]
  }),
  defineProvider({
    id: 'claude',
    label: 'Claude',
    executable: 'claude',
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])]
  }),
  defineProvider({
    id: 'hermes',
    label: 'Hermes',
    executable: 'hermes',
    buildArgs: (prompt, args) =>
      prompt ? ['chat', '--query', prompt, ...args, '--tui'] : [...args, '--tui']
  }),
  defineProvider({
    id: 'pi',
    label: 'Pi',
    executable: 'pi',
    buildArgs: (prompt, args) => [...args, ...(prompt ? [prompt] : [])]
  })
]

export class AgentProviderRegistry {
  private readonly providers = new Map<AgentId, AgentProvider>()

  constructor(providers: readonly AgentProvider[] = BUILT_IN_AGENT_PROVIDERS) {
    for (const provider of providers) this.register(provider)
  }

  register(provider: AgentProvider): void {
    if (this.providers.has(provider.id)) {
      throw new AgentMuxError(`Agent provider already registered: ${provider.id}`, 'DUPLICATE_PROVIDER')
    }
    this.providers.set(provider.id, provider)
  }

  replace(provider: AgentProvider): void {
    this.providers.set(provider.id, provider)
  }

  get(id: AgentId): AgentProvider {
    const provider = this.providers.get(id)
    if (!provider) throw new AgentMuxError(`Unknown agent provider: ${id}`, 'UNKNOWN_PROVIDER')
    return provider
  }

  list(): AgentProvider[] {
    return [...this.providers.values()]
  }
}
