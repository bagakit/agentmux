import { AgentMuxError, type AgentMuxControlSettingsResourceFields as Fields,
  type AgentMuxControlSettingsResourceItem as Item, type AgentMuxControlSettingsResourceKind as Kind,
  type AgentMuxControlSettingsResourceRequest as Request, type AgentMuxControlSettingsResourceResult as Result } from '@agentmux/core'
import { getThemeCatalog, getSemanticIconCatalog, themeDocumentSchema, serializeThemeFile } from '@agentmux/client-ui/theme'
import { readOriginalMoteConfiguration } from './mote-resources.js'

type BasicKind = Exclude<Kind, 'themes'>
export type SettingsResourceReadRequest = Extract<Request, { operation: 'settings.resource.list' | 'settings.resource.get' }>
/** The original resource slices only; no writable application configuration lives here. */
export type SettingsResourceConfiguration = {
  executors: Record<string, unknown>
  composerShortcuts?: readonly unknown[]
  appearance: { customThemes?: Record<string, unknown> }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)
function fail(code: 'SETTING_RESOURCE_NOT_FOUND' | 'INVALID_SETTING_VALUE' | 'CONTROL_UNAVAILABLE', message: string): never {
  throw new AgentMuxError(message, code)
}
export function settingsResourceItems(config: SettingsResourceConfiguration, resource: BasicKind): Item[] {
  if (resource === 'executors') return Object.entries(config.executors).map(([id, value]) => {
    if (!record(value)) fail('CONTROL_UNAVAILABLE', 'An original Executor record is unreadable. Its saved identity and healthy Agents are retained.')
    return { id, value: structuredClone(value) as Fields }
  })
  return (config.composerShortcuts ?? []).map(value => {
    if (!record(value) || typeof value.id !== 'string') fail('CONTROL_UNAVAILABLE', 'An original Command record is unreadable. Existing Commands and drafts are retained.')
    const { id, ...fields } = value
    return { id: id as string, value: structuredClone(fields) as Fields }
  })
}
export function settingsResourceItemOptional(config: SettingsResourceConfiguration, resource: BasicKind, id: string): Item | undefined {
  if (resource === 'executors') {
    if (!Object.hasOwn(config.executors, id)) return undefined
    const value = config.executors[id]
    if (!record(value)) fail('CONTROL_UNAVAILABLE', 'The original Executor record is unreadable. Its saved identity and healthy Agents are retained.')
    return { id, value: structuredClone(value) as Fields }
  }
  const prompt = config.composerShortcuts?.find(value => record(value) && value.id === id)
  if (!record(prompt)) return undefined
  const { id: _identity, ...value } = prompt
  return { id, value: structuredClone(value) as Fields }
}
export function settingsResourceItem(config: SettingsResourceConfiguration, resource: BasicKind, id: string): Item {
  return settingsResourceItemOptional(config, resource, id) ?? fail('SETTING_RESOURCE_NOT_FOUND', `${resource} “${id}” does not exist.`)
}
export function themeResourceItem(config: Pick<SettingsResourceConfiguration, 'appearance'>, id: string): Item {
  const catalog = getThemeCatalog(config.appearance.customThemes)
  const found = catalog.items.find(candidate => candidate.id === id)
  if (found) return { ...found, value: found.value as Fields }
  if (catalog.issues.some(issue => issue.id === id)) fail('INVALID_SETTING_VALUE', `Theme “${id}” is unavailable or unsupported. Its original data is retained. Inspect the theme catalog, then replace it with a valid theme or explicitly delete this exact record with its raw expected value.`)
  return fail('SETTING_RESOURCE_NOT_FOUND', `Theme “${id}” does not exist.`)
}
/** Desktop and Host interpret each original read through this same resource projection. */
export function readSettingsResource(config: SettingsResourceConfiguration, request: SettingsResourceReadRequest): Result {
  const { resource } = request
  if (resource === 'themes') {
    if (request.operation === 'settings.resource.list') {
      const catalog = getThemeCatalog(config.appearance.customThemes)
      return { operation: request.operation, resource, partial: true,
        items: catalog.items.map(candidate => ({ ...candidate, value: candidate.value as Fields })), issues: catalog.issues,
        iconCatalog: getSemanticIconCatalog() }
    }
    if (request.id === undefined) fail('INVALID_SETTING_VALUE', 'A theme lookup requires its exact ID.')
    const item = themeResourceItem(config, request.id)
    const document = themeDocumentSchema.parse({ id: item.id, ...item.value })
    serializeThemeFile(document)
    return { operation: request.operation, resource, item: { ...item, document: document as Fields } }
  }
  if (request.operation === 'settings.resource.list') return { operation: request.operation, resource, items: settingsResourceItems(config, resource), partial: true }
  const item = request.keyword === undefined ? settingsResourceItem(config, resource, request.id)
    : settingsResourceItems(config, 'prompts').find(candidate => candidate.value.keyword === request.keyword)
      ?? fail('SETTING_RESOURCE_NOT_FOUND', `Prompt keyword “${request.keyword}” does not exist.`)
  return { operation: request.operation, resource, item }
}
export function createHostSettingsResourceRead(configurationPath: string) {
  return async (request: SettingsResourceReadRequest): Promise<Result> => {
    const raw = await readOriginalMoteConfiguration(configurationPath)
    if (!record(raw) || request.resource === 'executors' && !record(raw.executors)
      || request.resource === 'prompts' && raw.composerShortcuts !== undefined && !Array.isArray(raw.composerShortcuts)
      || request.resource === 'themes' && raw.appearance !== undefined && !record(raw.appearance)) fail('CONTROL_UNAVAILABLE', 'The original Settings resource metadata is unreadable. Saved settings and healthy Agents are retained.')
    return readSettingsResource({ executors: record(raw.executors) ? raw.executors : {}, ...(Array.isArray(raw.composerShortcuts) ? { composerShortcuts: raw.composerShortcuts } : {}), appearance: (record(raw.appearance) ? raw.appearance : {}) as SettingsResourceConfiguration['appearance'] }, request)
  }
}
