import { randomUUID } from 'node:crypto'
import { AgentMuxError } from '@agentmux/core'
import { ZodError } from 'zod'
import { parseToolkitToolFields, type ToolkitRequest, type ToolkitResult,
  type ToolkitToolDefinition, type ToolkitToolFields } from '@agentmux/core/control'
import type { AppConfig } from '../shared/contracts.js'
import { ConfigConflict, configValuesEqual } from '../shared/config-edit.js'
import { toolkitToolSchema } from './config-store.js'
import type { ConfigOwner } from './config-owner.js'

export function toolkitTools(config: AppConfig): ToolkitToolDefinition[] { return config.toolkit?.tools ?? [] }
export function toolkitFields({ id: _id, revision: _revision, ...fields }: ToolkitToolDefinition): ToolkitToolFields { return fields }
export function findToolkitTool(config: AppConfig, id: string): ToolkitToolDefinition {
  return toolkitTools(config).find(tool => tool.id === id) ?? fail('SETTING_RESOURCE_NOT_FOUND', `Tool “${id}” does not exist.`)
}
function fail(code: string, message: string): never { throw new AgentMuxError(message, code) }

/** Every ConfigOwner writer shares deletion admission checks and server-issued revisions. */
export async function prepareToolkitConfig(current: AppConfig, next: AppConfig,
  guardDelete: (id: string) => Promise<void>): Promise<AppConfig> {
  const before = new Map(toolkitTools(current).map(tool => [tool.id, tool]))
  const tools = toolkitTools(next)
  for (const id of before.keys()) if (!tools.some(tool => tool.id === id)) await guardDelete(id)
  const prepared = tools.map(tool => {
    const old = before.get(tool.id)
    const same = old && configValuesEqual(toolkitFields(old), toolkitFields(tool))
    return toolkitToolSchema.parse({ ...tool, revision: same ? old.revision : randomUUID() })
  })
  if (configValuesEqual(tools, prepared)) return next
  return { ...next, toolkit: { ...next.toolkit, tools: prepared } }
}

export async function executeToolkitConfig(request: Extract<ToolkitRequest,
  { operation: 'toolkit.add' | 'toolkit.update' | 'toolkit.remove' }>, owner: ConfigOwner): Promise<ToolkitResult> {
  if (request.toolId === 'performance') fail('SETTING_IDENTITY_IMMUTABLE', 'Performance is an official read-only tool.')
  let changed = false
  const saved = await owner.update(current => {
    const tools = toolkitTools(current), old = tools.find(tool => tool.id === request.toolId)
    let next: ToolkitToolDefinition | undefined
    if (request.operation === 'toolkit.add') {
      if (old) fail('SETTING_RESOURCE_EXISTS', `Tool “${request.toolId}” already exists.`)
      const fields = parseToolkitToolFields(request.value, false, 'INVALID_SETTING_VALUE') as ToolkitToolFields
      next = { id: request.toolId, revision: randomUUID(), ...fields }
      changed = true
    } else {
      if (!old) fail('SETTING_RESOURCE_NOT_FOUND', `Tool “${request.toolId}” does not exist.`)
      const fields = toolkitFields(old)
      if (request.operation === 'toolkit.remove') {
        if (request.expected !== undefined && !configValuesEqual(fields, request.expected)) throw new ConfigConflict(`toolkit.tools.${request.toolId}`)
        changed = true
      } else {
        const changes = parseToolkitToolFields(request.changes, true, 'INVALID_SETTING_VALUE')
        const expected = request.expected === undefined ? undefined : parseToolkitToolFields(request.expected, true, 'INVALID_SETTING_VALUE')
        for (const key of Object.keys(changes) as (keyof ToolkitToolFields)[]) {
          if (expected && !Object.hasOwn(expected, key)) fail('INVALID_SETTING_VALUE', 'Expected must cover every changed field.')
          if (expected && !configValuesEqual(fields[key], changes[key]) && !configValuesEqual(fields[key], expected[key])) {
            throw new ConfigConflict(`toolkit.tools.${request.toolId}.${key}`)
          }
        }
        const requested = parseToolkitToolFields({ ...fields, ...changes }, false, 'INVALID_SETTING_VALUE') as ToolkitToolFields
        changed = !configValuesEqual(fields, requested)
        next = changed ? { ...old, ...requested } : old
      }
    }
    const updated = tools.filter(tool => tool.id !== request.toolId)
    if (next) {
      const index = tools.findIndex(tool => tool.id === request.toolId)
      updated.splice(index < 0 ? updated.length : index, 0, next)
    }
    return changed ? { ...current, toolkit: { ...current.toolkit, tools: updated } } : current
  }).catch((cause: unknown) => {
    if (cause instanceof ConfigConflict) throw new AgentMuxError(cause.message, cause.code)
    if (cause instanceof ZodError) {
      fail('INVALID_SETTING_VALUE', `Invalid Toolkit value: ${cause.issues.map(issue => `${issue.path.join('.') || 'value'}: ${issue.code}`).join('; ')}.`)
    }
    throw cause
  })
  return request.operation === 'toolkit.remove'
    ? { operation: request.operation, toolId: request.toolId, removed: true }
    : { operation: request.operation, definition: findToolkitTool(saved, request.toolId), changed }
}
