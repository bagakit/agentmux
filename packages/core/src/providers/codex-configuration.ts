import { JSONRPCErrorException } from 'json-rpc-2.0'
import type { AgentProviderNativeInputPreparationContext } from '../agent-provider.js'
import type { AgentConfigurationChoice, AgentConfigurationSet, AgentConfigurationSnapshot } from '../agent-configuration.js'
import { AgentMuxError } from '../errors.js'
import { connectCodexSessionControl } from './codex-session-control.js'
import { codexConfigurationSnapshot, codexConfigurationText as text } from './codex-configuration-source.js'
import { readCodexConfigurationControl } from './codex-managed-frontend.js'

const unavailable = () => new AgentMuxError('The original native model configuration is unconfirmed.', 'AGENT_CONFIGURATION_UNAVAILABLE')
export async function readCodexModelChoices(connection: Pick<Awaited<ReturnType<typeof connectCodexSessionControl>>, 'request'>,
  modelProvider: string): Promise<AgentConfigurationChoice[]> {
  const choices: AgentConfigurationChoice[] = [], seen = new Set<string>(), cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await connection.request('model/list', { modelProvider, limit: 100, includeHidden: false,
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
  return choices
}

function unconfirmed(snapshot: AgentConfigurationSnapshot, code: string, message: string): AgentConfigurationSnapshot {
  const { sequence: _sequence, ...observation } = snapshot.observation!
  return { ...snapshot, observation: { ...observation, state: 'unconfirmed', issue: { code, message } } }
}

async function orderedSnapshot(context: AgentProviderNativeInputPreparationContext,
  connection: Awaited<ReturnType<typeof connectCodexSessionControl>>, current: Awaited<ReturnType<typeof connection.readThread>>,
  choices: AgentConfigurationChoice[], historical = false): Promise<AgentConfigurationSnapshot> {
  if (!text(current.model)) throw unavailable()
  const point = codexConfigurationSnapshot(connection.configurationSource(current), current.model, choices)
  if (!context.nativeActor?.configurationObservation) {
    if (point.observation && !point.observation.issue) point.observation.issue = {
      code: 'AGENT_CONFIGURATION_OBSERVATION_UNSUPPORTED',
      message: 'The current native model is confirmed. This original Run does not expose continuous model observation.' }
    return point
  }
  try {
    const barrier = await readCodexConfigurationControl({ ...context, nativeActor: context.nativeActor }, point.observation!.nativeSessionId)
    if (barrier.state !== 'confirmed' || barrier.nativeRuntimeSessionId !== current.sessionId) throw unavailable()
    if (barrier.sourceId !== connection.configurationSource({ ...current, modelProvider: barrier.modelProvider }).sourceId) throw unavailable()
    if (historical && (barrier.sourceId !== point.observation!.sourceId || barrier.model !== current.model))
      return unconfirmed(point, 'AGENT_NATIVE_CONFIGURATION_SUPERSEDED',
        'This model selection was applied and read back on the original thread. A later native configuration superseded it; this receipt does not describe the current model.')
    return codexConfigurationSnapshot(barrier, barrier.model, barrier.sourceId === point.observation!.sourceId ? choices : [])
  } catch {
    return unconfirmed(point, 'AGENT_NATIVE_CONFIGURATION_ORDERING_UNAVAILABLE',
      historical ? 'This model selection was applied and read back on the original thread. Its order relative to the current observation stream is unconfirmed.'
        : 'The original native model was read, but its order relative to the observation stream is unconfirmed. Existing input and settings remain available.')
  }
}

async function snapshot(context: AgentProviderNativeInputPreparationContext,
  connection: Awaited<ReturnType<typeof connectCodexSessionControl>>): Promise<AgentConfigurationSnapshot> {
  const original = await connection.readThread()
  if (!text(original.model) || !text(original.modelProvider)) throw unavailable()
  const choices = await readCodexModelChoices(connection, original.modelProvider), current = await connection.assertCurrent()
  if (!text(current.model) || !text(current.modelProvider)) throw unavailable()
  // A current model can be absent from this catalog. A provider change cannot inherit old choices.
  return orderedSnapshot(context, connection, current,
    current.modelProvider === original.modelProvider ? choices : [])
}

export async function readCodexConfiguration(context: AgentProviderNativeInputPreparationContext, nativeSessionId: string): Promise<AgentConfigurationSnapshot | null> {
  if (!context.nativeActor) return null
  const connection = await connectCodexSessionControl(context, nativeSessionId)
  try { return await snapshot(context, connection) } finally { connection.dispose() }
}

/** Native settings affect subsequent turns; no new turn, prompt, resume or user default is written. */
export async function setCodexConfiguration(context: AgentProviderNativeInputPreparationContext, nativeSessionId: string,
  request: Pick<AgentConfigurationSet, 'configId' | 'value' | 'expectedRevision'> & { requestId: string; configuration?: AgentConfigurationSnapshot }): Promise<AgentConfigurationSnapshot> {
  const refused = (message: string) => new AgentMuxError(message, 'AGENT_CONFIGURATION_NOT_APPLIED', undefined,
    { disposition: 'not_applied', confirmedInputBytes: 0 })
  if (request.configId !== 'model' || !text(request.value)) throw refused('The native configuration selection is unsupported.')
  let connection: Awaited<ReturnType<typeof connectCodexSessionControl>> | undefined, dispatched = false
  try {
    connection = await connectCodexSessionControl(context, nativeSessionId)
    const observed = await connection.assertCurrent()
    if (!text(observed.model) || !text(observed.modelProvider)) throw unavailable()
    const scope = connection.configurationSource(observed), retained = request.configuration
    const cachedModel = retained?.options.find(option => option.id === 'model' && option.category === 'model')
    const sameCatalog = retained?.observation?.nativeSessionId === nativeSessionId && retained.observation.sourceId === scope.sourceId
    if (retained?.revision === request.expectedRevision && !sameCatalog) throw refused('The original native model provider changed. Read its choices again.')
    const before = retained?.revision === request.expectedRevision && sameCatalog && cachedModel?.type === 'select'
      ? codexConfigurationSnapshot(scope, observed.model, cachedModel.choices) : await snapshot(context, connection)
    if (before.revision !== request.expectedRevision || !before.options.some(option => option.type === 'select' &&
        option.id === request.configId && option.choices.some(choice => choice.value === request.value))) throw refused('The original native model choices changed. Read them again.')
    const current = await connection.assertCurrent()
    if (current.model !== before.options.find(option => option.id === 'model')?.currentValue ||
        connection.configurationSource(current).sourceId !== before.observation?.sourceId) throw refused('The original native model or provider changed before dispatch. Read it again.')
    context.signal.throwIfAborted()
    if (!connection.isConnected()) throw unavailable()
    dispatched = true
    try { await connection.request('thread/settings/update', { threadId: nativeSessionId, model: request.value }, { requestId: request.requestId }) }
    catch (error) {
      // Only a native explicit whole-request refusal proves no setting was applied.
      if (error instanceof JSONRPCErrorException && [-32600, -32602].includes(error.code)) throw refused('The native actor refused this model selection.')
      throw error
    }
    // The native response is {}, not a model acknowledgement. Confirm the original thread's value.
    const after = await connection.assertCurrent()
    if (after.model !== request.value || after.modelProvider !== current.modelProvider) throw unavailable()
    const model = before.options.find(option => option.id === 'model')
    return await orderedSnapshot(context, connection, after, model?.type === 'select' ? model.choices : [], true)
  } catch (error) {
    if (!dispatched) throw refused(error instanceof Error ? error.message : 'The original native model could not be qualified before dispatch.')
    throw error
  } finally { connection?.dispose() }
}
