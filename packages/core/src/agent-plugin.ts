import { AgentMuxError } from './errors.js'
import {
  AgentProviderRegistry,
  BUILT_IN_AGENT_PROVIDERS,
  type AgentProvider
} from './agent-provider.js'
import type { AgentCatalogEntry } from './types.js'

const PLUGIN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** A Skill contributed by a plugin. The host decides how its content is surfaced. */
export type AgentMuxPluginSkill = {
  id: string
  name: string
  description: string
}

/** A command contribution is metadata only; execution remains owned by the host contract. */
export type AgentMuxPluginCommand = {
  id: string
  description: string
}

/**
 * Host-neutral extension declaration. Providers are already normalized AgentProvider objects, so a
 * plugin never gets a second process/runtime abstraction hidden behind the editor.
 */
export type AgentMuxPlugin = {
  id: string
  version: string
  providers?: readonly AgentProvider[]
  skills?: readonly AgentMuxPluginSkill[]
  commands?: readonly AgentMuxPluginCommand[]
}

export type AgentMuxPluginSummary = {
  id: string
  version: string
  providerIds: readonly string[]
  skillIds: readonly string[]
  commandIds: readonly string[]
}

function assertContributionId(value: string, label: string): void {
  if (!PLUGIN_ID.test(value)) throw new AgentMuxError(`${label} is invalid.`, 'INVALID_PLUGIN_MANIFEST')
}

function assertContributionText(value: string, label: string): void {
  if (!value.trim()) throw new AgentMuxError(`${label} is invalid.`, 'INVALID_PLUGIN_MANIFEST')
}

function uniqueContributionIds(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) throw new AgentMuxError(`Duplicate ${label}: ${value}`, 'DUPLICATE_PLUGIN_CONTRIBUTION')
    seen.add(value)
  }
}

function summarize(plugin: AgentMuxPlugin): AgentMuxPluginSummary {
  return {
    id: plugin.id,
    version: plugin.version,
    providerIds: (plugin.providers ?? []).map((provider) => provider.id),
    skillIds: (plugin.skills ?? []).map((skill) => skill.id),
    commandIds: (plugin.commands ?? []).map((command) => command.id)
  }
}

function validatePlugin(plugin: AgentMuxPlugin): void {
  assertContributionId(plugin.id, 'Plugin id')
  assertContributionText(plugin.version, 'Plugin version')
  for (const provider of plugin.providers ?? []) {
    assertContributionId(provider.id, 'Provider id')
  }
  for (const skill of plugin.skills ?? []) {
    assertContributionId(skill.id, 'Skill id')
    assertContributionText(skill.name, 'Skill name')
    assertContributionText(skill.description, 'Skill description')
  }
  for (const command of plugin.commands ?? []) {
    assertContributionId(command.id, 'Command id')
    assertContributionText(command.description, 'Command description')
  }
  uniqueContributionIds((plugin.skills ?? []).map((skill) => skill.id), 'plugin Skill id')
  uniqueContributionIds((plugin.commands ?? []).map((command) => command.id), 'plugin command id')
}

/**
 * The one registry boundary used by hosts. Discovery (summary) is separate from activation (register),
 * and all provider contributions still enter the existing AgentProviderRegistry.
 */
export class AgentMuxPluginRegistry {
  readonly providers: AgentProviderRegistry
  private readonly plugins = new Map<string, AgentMuxPluginSummary>()
  private readonly skills = new Map<string, AgentMuxPluginSkill>()
  private readonly commands = new Map<string, AgentMuxPluginCommand>()

  constructor(plugins: readonly AgentMuxPlugin[] = []) {
    this.providers = new AgentProviderRegistry([])
    for (const plugin of plugins) this.register(plugin)
  }

  register(plugin: AgentMuxPlugin): void {
    validatePlugin(plugin)
    if (this.plugins.has(plugin.id)) {
      throw new AgentMuxError(`AgentMux plugin already registered: ${plugin.id}`, 'DUPLICATE_PLUGIN')
    }
    const providerIds = new Set(this.providers.list().map((provider) => provider.id))
    for (const provider of plugin.providers ?? []) {
      if (providerIds.has(provider.id)) {
        throw new AgentMuxError(`Agent provider already registered: ${provider.id}`, 'DUPLICATE_PROVIDER')
      }
      providerIds.add(provider.id)
    }
    for (const skill of plugin.skills ?? []) {
      if (this.skills.has(skill.id)) throw new AgentMuxError(`AgentMux Skill already registered: ${skill.id}`, 'DUPLICATE_PLUGIN_CONTRIBUTION')
    }
    for (const command of plugin.commands ?? []) {
      if (this.commands.has(command.id)) throw new AgentMuxError(`AgentMux command already registered: ${command.id}`, 'DUPLICATE_PLUGIN_CONTRIBUTION')
    }
    for (const provider of plugin.providers ?? []) this.providers.register(provider)
    for (const skill of plugin.skills ?? []) this.skills.set(skill.id, { ...skill })
    for (const command of plugin.commands ?? []) this.commands.set(command.id, { ...command })
    this.plugins.set(plugin.id, summarize(plugin))
  }

  list(): AgentMuxPluginSummary[] {
    return [...this.plugins.values()].map((plugin) => ({
      ...plugin,
      providerIds: [...plugin.providerIds],
      skillIds: [...plugin.skillIds],
      commandIds: [...plugin.commandIds]
    }))
  }

  skillsList(): AgentMuxPluginSkill[] { return [...this.skills.values()].map((skill) => ({ ...skill })) }

  commandsList(): AgentMuxPluginCommand[] { return [...this.commands.values()].map((command) => ({ ...command })) }

  catalog(): AgentCatalogEntry[] { return this.providers.catalog() }
}

/** Built-ins are a plugin contribution too, so the default host exercises the same public boundary. */
export function createBuiltInAgentMuxPlugin(): AgentMuxPlugin {
  return {
    id: 'agentmux.builtins',
    version: '1.0.0',
    providers: BUILT_IN_AGENT_PROVIDERS
  }
}

export function createDefaultAgentMuxPluginRegistry(
  plugins: readonly AgentMuxPlugin[] = []
): AgentMuxPluginRegistry {
  return new AgentMuxPluginRegistry([createBuiltInAgentMuxPlugin(), ...plugins])
}
