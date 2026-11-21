import { createHash } from 'node:crypto'
import { JSONRPCErrorException } from 'json-rpc-2.0'
import type { AgentProviderNativeInputPreparationContext } from '../agent-provider.js'
import type { AgentConfigurationChoice, AgentConfigurationSet, AgentConfigurationSnapshot } from '../agent-configuration.js'
import { AgentMuxError } from '../errors.js'
import { connectCodexSessionControl } from './codex-session-control.js'

const unavailable = () => new AgentMuxError('The original native model configuration is unconfirmed.', 'AGENT_CONFIGURATION_UNAVAILABLE')
const text = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\0\r\n]/u.test(value)

async function snapshot(connection: Awaited<ReturnType<typeof connectCodexSessionControl>>): Promise<AgentConfigurationSnapshot> {
  const original = await connection.readThread()
  if (!text(original.model) || !text(original.modelProvider)) throw unavailable()
  const choices: AgentConfigurationChoice[] = [], seen = new Set<string>(), cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await connection.request('model/list', { modelProvider: original.modelProvider, limit: 100, includeHidden: false,
      ...(cursor ? { cursor } : {}) })
    if (!Array.isArray(page?.data) || page.data.length > 100) throw unavailable()
    for (const model of page.data) {
      if (!text(model?.model) || !text(model.displayName) || typeof model.hidden !== 'boolean' ||
          model.description !== undefined && typeof model.description !== 'string' || seen.has(model.model)) throw unavailable()
      seen.add(model.model)
      if (!model.hidden) choices.push({ value: model.model, name: model.displayName,
        ...(model.description ? { description: model.description } : {}) })
      if (seen.size > 256) throw unavailable()
    }
    if (page.nextCursor !== null && page.nextCursor !== undefined && !text(page.nextCursor)) throw unavailable()
    cursor = page.nextCursor ?? undefined
    if (cursor && cursors.has(cursor)) throw unavailable()
    if (cursor) cursors.add(cursor)
  } while (cursor)
  const current = await connection.assertCurrent()
  if (current.model !== original.model || current.modelProvider !== original.modelProvider || !choices.some(choice => choice.value === current.model)) throw unavailable()
  const options = [{ id: 'model', name: 'Model', category: 'model', type: 'select' as const, currentValue: original.model, choices }]
  const revision = createHash('sha256').update(JSON.stringify([connection.sourceId, original.modelProvider, options])).digest('base64url')
  return { revision, options }
}

export async function readCodexConfiguration(context: AgentProviderNativeInputPreparationContext, nativeSessionId: string): Promise<AgentConfigurationSnapshot | null> {
  if (!context.nativeActor) return null
  const connection = await connectCodexSessionControl(context, nativeSessionId)
  try { return await snapshot(connection) } finally { connection.dispose() }
}

/** Native settings affect subsequent turns; no new turn, prompt, resume or user default is written. */
export async function setCodexConfiguration(context: AgentProviderNativeInputPreparationContext, nativeSessionId: string,
  request: Pick<AgentConfigurationSet, 'configId' | 'value' | 'expectedRevision'> & { requestId: string }): Promise<AgentConfigurationSnapshot> {
  const refused = (message: string) => new AgentMuxError(message, 'AGENT_CONFIGURATION_NOT_APPLIED', undefined,
    { disposition: 'not_applied', confirmedInputBytes: 0 })
  if (request.configId !== 'model' || !text(request.value)) throw refused('The native configuration selection is unsupported.')
  const connection = await connectCodexSessionControl(context, nativeSessionId)
  try {
    const before = await snapshot(connection)
    if (before.revision !== request.expectedRevision || !before.options.some(option => option.type === 'select' &&
        option.id === request.configId && option.choices.some(choice => choice.value === request.value))) throw refused('The original native model choices changed. Read them again.')
    const current = await connection.assertCurrent()
    if (current.model !== before.options.find(option => option.id === 'model')?.currentValue) throw refused('The original native model changed before dispatch. Read it again.')
    try { await connection.request('thread/settings/update', { threadId: nativeSessionId, model: request.value }, { requestId: request.requestId }) }
    catch (error) {
      // Only a native explicit whole-request refusal proves no setting was applied.
      if (error instanceof JSONRPCErrorException && [-32600, -32602].includes(error.code)) throw refused('The native actor refused this model selection.')
      throw error
    }
    // The native response is {}, not a model acknowledgement. Confirm the original thread's value.
    const after = await snapshot(connection)
    if (!after.options.some(option => option.id === request.configId && option.currentValue === request.value)) throw unavailable()
    return after
  } finally { connection.dispose() }
}
