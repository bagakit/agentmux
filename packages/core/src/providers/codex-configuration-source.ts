import { createHash } from 'node:crypto'
import type { AgentConfigurationChoice, AgentConfigurationSnapshot, AgentConfigurationObservedSnapshot } from '../agent-configuration.js'

export type CodexConfigurationIdentity = {
  actorId: string; lifecycleOperationId: string; nativeSessionId: string; nativeRuntimeSessionId: string; modelProvider: string
}
export type CodexConfigurationCurrent = Pick<CodexConfigurationIdentity, 'nativeSessionId' | 'nativeRuntimeSessionId' | 'modelProvider'> & { model: string }
export type CodexConfigurationPacket = {
  nativeSessionId: string; nativeRuntimeSessionId: string; modelProvider: string
  sourceId: string; sequence: number; observedAt: number
} & ({ state: 'confirmed'; model: string } | { state: 'unconfirmed'; code: string; message: string })

export const codexConfigurationText = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && !/[\0\r\n]/u.test(value)

/** Catalog provenance and semantic revisions share the original native object, not a socket generation. */
export function codexConfigurationSourceId(value: CodexConfigurationIdentity): string {
  return createHash('sha256').update(JSON.stringify([value.actorId, value.lifecycleOperationId,
    value.nativeSessionId, value.nativeRuntimeSessionId, value.modelProvider])).digest('base64url')
}

type ConfigurationSource = Pick<CodexConfigurationPacket, 'nativeSessionId' | 'sourceId' | 'observedAt'> & { sequence?: number }
export function codexConfigurationSnapshot(source: ConfigurationSource & { sequence: number }, model: string, choices: AgentConfigurationChoice[]): AgentConfigurationObservedSnapshot
export function codexConfigurationSnapshot(source: ConfigurationSource, model: string, choices: AgentConfigurationChoice[]): AgentConfigurationSnapshot
export function codexConfigurationSnapshot(source: ConfigurationSource,
  model: string, choices: AgentConfigurationChoice[]): AgentConfigurationSnapshot {
  // Names, descriptions and display order cannot invalidate an otherwise identical selection.
  const revision = createHash('sha256').update(JSON.stringify([source.sourceId, model,
    choices.map(choice => choice.value).sort()])).digest('base64url')
  return { revision, options: [{ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: model, choices }],
    observation: { nativeSessionId: source.nativeSessionId, sourceId: source.sourceId, observedAt: source.observedAt,
      ...(source.sequence === undefined ? {} : { sequence: source.sequence }), state: 'confirmed',
      ...(choices.length ? {} : { issue: { code: 'AGENT_NATIVE_CONFIGURATION_CATALOG_UNAVAILABLE',
        message: 'The original native model is confirmed; model choices are not available for this source. Read its choices to select another model.' } }) } }
}

export function parseCodexConfigurationPacket(value: unknown): CodexConfigurationPacket | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const p = value as Record<string, unknown>
  if (!['nativeSessionId', 'nativeRuntimeSessionId', 'modelProvider', 'sourceId'].every(key => codexConfigurationText(p[key])) ||
      !Number.isSafeInteger(p.sequence) || Number(p.sequence) < 1 || !Number.isSafeInteger(p.observedAt) || Number(p.observedAt) < 0) return
  const source = { nativeSessionId: p.nativeSessionId as string, nativeRuntimeSessionId: p.nativeRuntimeSessionId as string,
    modelProvider: p.modelProvider as string, sourceId: p.sourceId as string, sequence: p.sequence as number, observedAt: p.observedAt as number }
  if (p.state === 'confirmed' && codexConfigurationText(p.model)) return { ...source, state: 'confirmed', model: p.model }
  if (p.state === 'unconfirmed' && codexConfigurationText(p.code) && codexConfigurationText(p.message)) return { ...source, state: 'unconfirmed', code: p.code, message: p.message }
}

/** One original native read in flight. Invalidation is not itself a current-value snapshot. */
export function createCodexConfigurationSource(context: {
  actorId: string; lifecycleOperationId: string
  read(): Promise<CodexConfigurationCurrent>
  publish(packet: CodexConfigurationPacket): void
}) {
  let demand = 0, sequence = 0, pending: Promise<CodexConfigurationPacket> | undefined, latest: CodexConfigurationPacket | undefined
  const unavailable = (code = 'AGENT_NATIVE_CONFIGURATION_UNAVAILABLE'): void => {
    ++demand // A prior in-flight result cannot cross this observation boundary.
    if (!latest || latest.state === 'unconfirmed' && latest.code === code) return
    const { nativeSessionId, nativeRuntimeSessionId, modelProvider, sourceId } = latest
    latest = { state: 'unconfirmed', nativeSessionId, nativeRuntimeSessionId, modelProvider, sourceId,
      sequence: ++sequence, observedAt: Date.now(), code,
      message: 'The original native configuration stream is unconfirmed. Retained facts keep their original time; existing input and settings remain available.' }
    context.publish(latest)
  }
  const read = (): Promise<CodexConfigurationPacket> => {
    ++demand
    if (pending) return pending
    const work = (async () => {
      for (;;) {
        const requested = demand, current = await context.read()
        if (requested !== demand) continue
        if (![current.nativeSessionId, current.nativeRuntimeSessionId, current.modelProvider, current.model].every(codexConfigurationText))
          throw new Error('The original native configuration read did not confirm its identity and model.')
        latest = { ...current, state: 'confirmed', sourceId: codexConfigurationSourceId({ ...context, ...current }),
          sequence: ++sequence, observedAt: Date.now() }
        context.publish(latest)
        return latest
      }
    })().catch(error => { unavailable(); throw error }).finally(() => { if (pending === work) pending = undefined })
    pending = work
    return work
  }
  return { read, unavailable, invalidate(): void { void read().catch(() => {}) } }
}
