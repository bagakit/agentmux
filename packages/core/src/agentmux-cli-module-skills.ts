import { guideIndex, guideSharedModuleCommandContract } from './generated/agentmux-guides.js'
import { AGENTMUX_CLI_COMMANDS } from './agentmux-cli-commands.js'
import { AGENTMUX_GOAL_SKILL_ENTRY } from './goal-role-guidance.js'
import { AGENTMUX_PROTOCOL_CATALOG } from './agent-message-render.js'
import { guideText } from './guide-text.js'
import { MODULE_GUIDES } from './generated/agentmux-guides-index.js'

interface ModuleDefinition {
  summary: string
  roles: string
  when: string
  guide: string
}

/** Markdown owns guidance; module names and availability follow the executable registry. */
const definitions: Readonly<Record<string, ModuleDefinition>> = Object.fromEntries(Object.entries(MODULE_GUIDES).map(([root, definition]) => [root, {
  ...definition,
  guide: guideText(definition.guide, {
    'goal-skill-entry': AGENTMUX_GOAL_SKILL_ENTRY,
    'protocol-catalog': AGENTMUX_PROTOCOL_CATALOG.map(entry => `- ${entry.title} (${entry.id}, ${entry.form})\n  ${entry.description}`).join('\n')
  })
}]))

export interface AgentMuxCliModule {
  root: string
  summary: string
  roles: string
  when: string
  readCommand: string
}

function registeredRoots(): string[] {
  return [...new Set(AGENTMUX_CLI_COMMANDS.map(command => command.method.split('.')[0]!))]
}

export function agentMuxModuleSkillEntry(root: string): string | null {
  return registeredRoots().includes(root) && Object.hasOwn(definitions, root) ? `amux ${root} --skill` : null
}

/** Includes unsupported document slots honestly, so a missing owner is never silently hidden. */
export function agentMuxCliModuleCatalog(): readonly AgentMuxCliModule[] {
  return registeredRoots().map(root => {
    const definition = Object.hasOwn(definitions, root) ? definitions[root] : undefined
    return { root, summary: definition?.summary ?? 'Module guidance unavailable in this version',
      roles: definition?.roles ?? 'Use current command help', when: definition?.when ?? 'Inspect supported commands before acting',
      readCommand: `amux ${root} --skill` }
  })
}

/** Local versioned document rendering only: no service, filesystem or Runtime access. */
export function agentMuxModuleSkill(root: string): string | null {
  if (!agentMuxModuleSkillEntry(root)) return null
  const definition = definitions[root]!
  return `---\nname: amux-${root}\ndescription: ${definition.summary}.\n---\n\n# ${root} module\n\nRoles: ${definition.roles}.\nRead when: ${definition.when}.\n\n${definition.guide}\n\n${guideText(guideSharedModuleCommandContract, { 'module-root': root })}`
}

export function agentMuxBaseSkill(): string {
  const directory = agentMuxCliModuleCatalog().map(module =>
    `| ${module.root} | ${module.when} | \`${module.readCommand}\` |`).join('\n')
  return guideText(guideIndex, { 'module-directory': directory }) + '\n'
}
