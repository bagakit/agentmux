import type { AgentMuxSpaceCatalog } from '@agentmux/core/control'
import { parseFileReadResult, parseFileWriteResult, parseFileCreateResult, type AgentMuxRpcFilesOwner } from '@agentmux/core/files'
import type { ConnectionEnrollmentCallContext, ConnectionPort } from '@agentmux/core/connections'
import { moteConnectionBaseline, parseMotePreferencesReadResult, parseMotePreferencesSaveParams, parseMotePreferencesSaveResult,
  sameMoteConnectionValues, type MoteConnectionPreferencesReadInput, type MoteConnectionPreferencesReadResult,
  type MoteConnectionPreferencesSaveParams, type MoteConnectionPreferencesSaveResult } from '@agentmux/core/mote-preferences'
import { homeZoneId } from './mote-model.js'
import { SCRATCH_WORKSPACE_ID } from './mote-topic-model.js'
import { MOTE_QUICK_MODE_PATH, parseMoteConnectionMode, serializeMoteConnectionMode } from './mote-quick-mode.js'

const message = (error: unknown) => error instanceof Error ? error.message : String(error)
const resourceFields = ['hostId', 'workspaceId', 'workspacePath', 'zoneId', 'zonePath', 'path', 'logicalDirectory'] as const

export type MoteConnectionPreferencesPorts = {
  files: AgentMuxRpcFilesOwner
  catalog(): Promise<AgentMuxSpaceCatalog | null>
  connections(): ReturnType<ConnectionPort['list']>
}
/** Framework-free connection preferences over the original Files owner. */
export class MoteConnectionPreferences {
  constructor(private readonly ports: MoteConnectionPreferencesPorts) {}

  private async original(input: MoteConnectionPreferencesReadInput): Promise<void> {
    const catalog = await this.ports.catalog(), matches = catalog?.spaces.filter(space => space.spaceId === input.target.spaceId)
    const mote = matches?.length === 1 ? matches[0] : null
    const zones = catalog?.zones.filter(zone => zone.zoneId === input.target.zoneId), zone = zones?.length === 1 ? zones[0] : null
    if (!mote || mote.kind !== 'mote' || !zone || zone.kind !== 'home' || input.target.zoneId !== homeZoneId(mote.spaceId) ||
      input.target.expectedResource.workspaceId !== SCRATCH_WORKSPACE_ID || mote.hostId !== input.target.expectedResource.hostId ||
      !catalog?.bindings.some(binding => binding.spaceId === mote.spaceId && binding.zoneId === zone.zoneId)) {
      throw new Error('The exact original Mote home is unconfirmed. Its files and conversations are kept; refresh this Mote before saving.')
    }
  }

  async read(input: MoteConnectionPreferencesReadInput): Promise<MoteConnectionPreferencesReadResult> {
    const base: MoteConnectionPreferencesReadInput = { kind: 'connection', target: input.target }
    let source: MoteConnectionPreferencesReadResult['source'] = null
    try {
      await this.original(input)
      source = parseFileReadResult(await this.ports.files.read({ ...input.target, path: MOTE_QUICK_MODE_PATH }), { ...input.target, path: MOTE_QUICK_MODE_PATH })
      if (!source.resource || source.result.status !== 'read' && source.result.status !== 'deleted') throw new Error('The original MOTE.md could not be read. Keep its reference and inspect the file.')
      const parsed = source.result.status === 'deleted' ? { status: 'valid' as const, values: { connection: null } } : parseMoteConnectionMode(source.result.document.content)
      if (parsed.status !== 'valid') throw new Error(parsed.message)
      return parseMotePreferencesReadResult({ ...base, status: 'ready', source, values: parsed.values, issue: null }, base)
    } catch (error) {
      return parseMotePreferencesReadResult({ ...base, status: 'unconfirmed', source, values: null, issue: message(error) }, base)
    }
  }

  async save(raw: MoteConnectionPreferencesSaveParams, context?: ConnectionEnrollmentCallContext): Promise<MoteConnectionPreferencesSaveResult> {
    const input = parseMotePreferencesSaveParams(raw)
    let dispatched = false
    const result = (status: MoteConnectionPreferencesSaveResult['status'], source: MoteConnectionPreferencesSaveResult['source'], detail: string | null) =>
      parseMotePreferencesSaveResult({ kind: input.kind, target: input.target, operationId: input.operationId, status, source, message: detail }, input)
    try {
      const current = moteConnectionBaseline(await this.read(input)), baseline = input.baseline
      if (!current || resourceFields.some(key => current.resource[key] !== baseline.resource[key]) ||
        current.document?.revision !== baseline.document?.revision || current.document?.content !== baseline.document?.content ||
        !sameMoteConnectionValues(current.values, baseline.values)) throw new Error('The original MOTE.md changed or is unconfirmed. Read its current revision before choosing another save.')
      if (input.values.connection) {
        const ref = input.values.connection, records = (await this.ports.connections()).connections.filter(record => record.config.connectionId === ref.connectionId)
        if (records.length !== 1 || records[0]!.config.application.domain !== ref.application.domain || records[0]!.config.application.appId !== ref.application.appId)
          throw new Error('This exact robot is unavailable in the original Connection service. Keep the reference or choose another saved robot.')
      }
      if (current.document && sameMoteConnectionValues(current.values, input.values)) return result('unchanged', current, null)
      const content = serializeMoteConnectionMode(current.document?.content ?? '', input.values)
      await this.original(input)
      const base = { ...input.target, path: MOTE_QUICK_MODE_PATH, expectedResource: current.resource, content }
      // After dispatch, an exception is an observation gap, never a no-write assertion.
      context?.signal?.throwIfAborted(); await context?.assertCurrent?.(); context?.signal?.throwIfAborted()
      dispatched = true
      const saved = current.document
        ? await this.ports.files.write({ ...base, expectedRevision: current.document.revision }, context ? { actor: context.actor } : undefined).then(receipt => parseFileWriteResult(receipt, { ...base, expectedRevision: current.document!.revision }))
        : await this.ports.files.create({ ...base, expectedRevision: null }, context ? { actor: context.actor } : undefined).then(receipt => parseFileCreateResult(receipt, { ...base, expectedRevision: null }))
      if (saved.result.status === 'written') {
        const actual = saved.result.content ?? content, parsed = parseMoteConnectionMode(actual)
        if (!saved.resource || parsed.status !== 'valid' || !sameMoteConnectionValues(parsed.values, input.values)) throw new Error('The original writer result could not be confirmed. Read the current file; keep this save request.')
        return result('saved', { resource: saved.resource, document: { path: saved.resource.path, content: actual, revision: saved.result.revision }, values: parsed.values }, null)
      }
      if (saved.result.status === 'conflict') return result('refused-before-write', null, 'The original MOTE.md changed before this save. Your request is kept; read the current file before deciding another save.')
      return result(saved.result.status === 'unknown' ? 'unconfirmed' : 'refused-before-write', null, saved.result.message)
    } catch (error) { return result(dispatched ? 'unconfirmed' : 'refused-before-write', null, message(error)) }
  }

}
