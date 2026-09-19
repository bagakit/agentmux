import type {
  AgentMuxControlErrorCode, AgentMuxControlSettingsResourceFields as Fields,
  AgentMuxControlSettingsResourceItem as Item, AgentMuxControlSettingsResourceKind as Kind,
  AgentMuxControlSettingsResourceRequest as Request, AgentMuxControlSettingsResourceResult as Result
} from '@agentmux/core'
import { ZodError } from 'zod'
import type { AppConfig, ComposerShortcut } from '../shared/contracts.js'
import { configValuesEqual, ConfigConflict } from '../shared/config-edit.js'
import { composerShortcutSchema, executorIdSchema, executorSchema } from './config-store.js'
import type { ConfigOwner } from './config-owner.js'

const promptFields = composerShortcutSchema.omit({ id: true })
const schemas = { executors: executorSchema, prompts: promptFields }
function fail(code: AgentMuxControlErrorCode, message: string): never {
  throw Object.assign(new Error(message), { code })
}
function items(config: AppConfig, resource: Kind): Item[] {
  return resource === 'executors'
    ? Object.entries(config.executors).map(([id, value]) => ({ id, value: structuredClone(value) as Fields }))
    : (config.composerShortcuts ?? []).map(({ id, ...value }) => ({ id, value: structuredClone(value) }))
}
function find(config: AppConfig, resource: Kind, id: string): Item {
  const item = findOptional(config, resource, id)
  return item ?? fail('SETTING_RESOURCE_NOT_FOUND', `${resource} “${id}” does not exist.`)
}
function findOptional(config: AppConfig, resource: Kind, id: string): Item | undefined {
  if (resource === 'executors') return Object.hasOwn(config.executors, id)
    ? { id, value: structuredClone(config.executors[id]!) as Fields } : undefined
  const prompt = config.composerShortcuts?.find((candidate) => candidate.id === id)
  if (!prompt) return undefined
  const { id: _identity, ...value } = prompt
  return { id, value: structuredClone(value) }
}
function validate(resource: Kind, value: Fields, partial: boolean): Fields {
  if (Object.hasOwn(value, 'id')) fail('SETTING_IDENTITY_IMMUTABLE', 'Resource identity belongs in the command, never in its editable value.')
  const result = (partial ? schemas[resource].partial() : schemas[resource]).safeParse(value)
  if (!result.success) invalidValue(resource, result.error)
  return result.data as Fields
}
function invalidValue(resource: Kind, error: ZodError): never {
  fail('INVALID_SETTING_VALUE', `Invalid ${resource} value: ${error.issues.map((issue) => `${issue.path.join('.') || 'value'}: ${issue.code}`).join('; ')}.`)
}
function normalizePrompt(value: Fields): Fields {
  const normalized = { ...value }
  if (typeof normalized.keyword === 'string') normalized.keyword = normalized.keyword.trim()
  if (typeof normalized.label === 'string') normalized.label = normalized.label.trim() || String(normalized.keyword ?? '')
  // null is the explicit unbind intent; absence in an update means leave the binding alone.
  if (normalized.providerId === null) delete normalized.providerId
  return normalized
}
function validateExpected(resource: Kind, value: Fields): Fields {
  // Partial expectations can name an absent optional field explicitly with null.
  const absent = Object.entries(value).filter(([key, field]) => field === null && optionalField(resource, key))
  const fields = Object.fromEntries(Object.entries(value).filter(([key]) => !absent.some(([name]) => name === key)))
  return { ...validate(resource, fields, true), ...Object.fromEntries(absent) }
}
function optionalField(resource: Kind, key: string): boolean {
  const shape = schemas[resource].shape as Record<string, { isOptional(): boolean }>
  return Object.hasOwn(shape, key) && shape[key]!.isOptional()
}
function replace(config: AppConfig, resource: Kind, id: string, value: Fields | undefined): AppConfig {
  if (resource === 'executors') {
    const executors = { ...config.executors }
    if (value === undefined) delete executors[id]
    else Object.defineProperty(executors, id, { value, enumerable: true, configurable: true, writable: true })
    return { ...config, executors: executors as AppConfig['executors'] }
  }
  const prompts = (config.composerShortcuts ?? []).filter((prompt) => prompt.id !== id)
  if (value) {
    const index = (config.composerShortcuts ?? []).findIndex((prompt) => prompt.id === id)
    const prompt = { id, ...value } as ComposerShortcut
    if (index < 0) prompts.push(prompt)
    else prompts.splice(index, 0, prompt)
  }
  const keywords = new Set<string>()
  for (const prompt of prompts) {
    if (!prompt.keyword.trim() || !prompt.body.trim() || keywords.has(prompt.keyword.trim())) {
      fail('INVALID_SETTING_VALUE', `Prompt “${prompt.id}” needs a unique keyword and a nonempty body.`)
    }
    keywords.add(prompt.keyword.trim())
  }
  return { ...config, composerShortcuts: prompts }
}

/** Fixed resource operations consume the same typed Main schema and the same short owner transaction. */
export async function executeSettingsResourcesControl(request: Request, owner: ConfigOwner): Promise<Result> {
  const { resource } = request
  if (request.operation === 'settings.resource.list') return { operation: request.operation, resource, items: items(owner.current, resource), partial: true }
  if (request.operation === 'settings.resource.get') return { operation: request.operation, resource, item: find(owner.current, resource, request.id) }
  if (resource === 'executors' && !executorIdSchema.safeParse(request.id).success) fail('INVALID_SETTING_VALUE', `Invalid Executor identity: ${request.id}`)
  let changed = false
  const saved = await owner.update((current) => {
    const existing = findOptional(current, resource, request.id)
    if (request.operation === 'settings.resource.add') {
      if (existing) fail('SETTING_RESOURCE_EXISTS', `${resource} “${request.id}” already exists; use update.`)
      const value = validate(resource, resource === 'prompts' ? normalizePrompt(request.value) : request.value, false)
      changed = true
      return replace(current, resource, request.id, value)
    }
    if (!existing) fail('SETTING_RESOURCE_NOT_FOUND', `${resource} “${request.id}” does not exist; update never adds an identity.`)
    if (request.operation === 'settings.resource.remove') {
      if (request.expected !== undefined && !configValuesEqual(validate(resource, request.expected, false), existing.value)) throw new ConfigConflict(`${resource}.${request.id}`)
      changed = true
      return replace(current, resource, request.id, undefined)
    }
    // Null names Prompt unbind or avatar reset, never arbitrary field deletion.
    if (Object.hasOwn(request.changes, 'id')) fail('SETTING_IDENTITY_IMMUTABLE', 'Resource identity cannot be changed.')
    const combined = { ...existing.value, ...request.changes }
    if (resource === 'executors' && request.changes.avatar === null) combined.avatar = {}
    const value = validate(resource, resource === 'prompts' ? normalizePrompt(combined) : combined, false)
    const changes = Object.fromEntries(Object.keys(request.changes).map((key) => [key,
      resource === 'prompts' && key === 'providerId' && request.changes[key] === null ? null : value[key]])) as Fields
    const expected = request.expected === undefined ? undefined : validateExpected(resource, request.expected)
    const completeExpected = request.expected !== undefined && schemas[resource].safeParse(request.expected).success
    if (expected && Object.keys(changes).some((key) => !Object.hasOwn(expected, key) && !(completeExpected && optionalField(resource, key)))) fail('INVALID_SETTING_VALUE', 'Expected must cover every changed field.')
    for (const key of Object.keys(changes)) {
      const requested = key === 'providerId' && changes[key] === null ? undefined : changes[key]
      const previous = expected?.[key] === null && optionalField(resource, key) ? undefined : expected?.[key]
      if (expected && !configValuesEqual(existing.value[key], requested) && !configValuesEqual(existing.value[key], previous)) throw new ConfigConflict(`${resource}.${request.id}.${key}`)
    }
    if (resource === 'executors' && value.providerId !== existing.value.providerId) fail('SETTING_IDENTITY_IMMUTABLE', `Executor “${request.id}” has a fixed Provider. Create a new identity.`)
    changed = !configValuesEqual(value, existing.value)
    return changed ? replace(current, resource, request.id, value) : current
  }).catch((cause: unknown) => {
    // Full persistence validation owns cross-record constraints such as Provider membership.
    if (cause instanceof ZodError) invalidValue(resource, cause)
    throw cause
  })
  return request.operation === 'settings.resource.remove'
    ? { operation: request.operation, resource, id: request.id, removed: true }
    : { operation: request.operation, resource, item: find(saved, resource, request.id), changed }
}
