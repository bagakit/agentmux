import { constants } from 'node:fs'
import { lstat, mkdir, open, readFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { AgentMuxError } from './errors.js'
import { durableWriteFile } from './durable-write.js'
import { confirmRecoveryDirectory, hashRecoveryFile, recoveryDigest, type AgentMuxStorageRecovery, type RecoveryRestoreMember, type RecoverySource, type RecoveryInputSelector } from './storage-recovery.js'
import { mintObjectId } from './object-id.js'

export type RecoverySelector = { sourceId: string; memberId: string }
export type RestorePreflight = { operationId: string; generationId: string; manifestHash: string; selectors?: RecoverySelector[]; inputs?: RecoveryInputSelector[] }
export type RestoreObservation = {
  operationId: string; generationId: string; manifestHash: string
  state: 'prepared' | 'applying' | 'complete' | 'unavailable' | 'unknown'
  items: Array<RecoverySelector & { state: 'missing' | 'same' | 'retained-current' | 'unavailable' | 'restored' | 'unknown'; code?: string }>
}
type Item = RestoreObservation['items'][number] & { member: RecoveryRestoreMember; baseline: string | null; input?: RecoveryInputSelector; resultHash?: string; requiresInputCut?: boolean; publicationAttempted?: true; inputCutConfirmed?: true }
type Operation = Omit<RestoreObservation, 'items'> & { schema: 'agentmux.restore-operation.v1'; namespace: string; requestHash: string; inputCutSourceSHA256: string; items: Item[] }
function invalid(message: string): never { throw new AgentMuxError(message, 'STORAGE_RECOVERY_INVALID') }
const absent = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT'
const code = (error: unknown) => /^[A-Z0-9_-]{1,100}$/u.test(String((error as NodeJS.ErrnoException)?.code)) ? String((error as NodeJS.ErrnoException).code) : 'RECOVERY_RESTORE_UNKNOWN'
const digest = async (path: string) => { try { return (await hashRecoveryFile(path)).sha256 } catch (error) { if (absent(error)) return null; throw error } }
const observation = (op: Operation): RestoreObservation => ({ operationId: op.operationId, generationId: op.generationId, manifestHash: op.manifestHash, state: op.state,
  items: op.items.map(({ sourceId, memberId, state, code }) => ({ sourceId, memberId, state, ...(code ? { code } : {}) })) })

/** One durable maintenance operation, composed with original owners. No Runtime connection or input dispatch. */
export class StorageRestoreOperations {
  constructor(private readonly recovery: AgentMuxStorageRecovery, private readonly source: (id: string) => RecoverySource | undefined) {}
  private path(id: string): string {
    if (!/^[A-Za-z0-9_-]{1,100}$/u.test(id)) invalid('An exact original recovery operation is required.')
    return join(this.recovery.directory, 'restore-operations', id, 'operation.json')
  }
  private async load(id: string): Promise<Operation> {
    const path = this.path(id), attrs = await lstat(path)
    if (!attrs.isFile() || (attrs.mode & 0o077) !== 0) invalid('The recovery operation is not a protected original file.')
    const op = JSON.parse(await readFile(path, 'utf8')) as Operation
    if (op.schema !== 'agentmux.restore-operation.v1' || op.namespace !== this.recovery.namespace || op.operationId !== id || !Array.isArray(op.items)) invalid('The recovery operation belongs to another owner.')
    // An earlier durable write may have applied but lost its file/directory ACK.
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await file.sync() } finally { await file.close() }
    const parent = await open(dirname(path), 'r'); try { await parent.sync() } finally { await parent.close() }
    await confirmRecoveryDirectory(dirname(path))
    return op
  }
  private async save(op: Operation): Promise<void> {
    const path = this.path(op.operationId)
    await mkdir(dirname(path), { recursive: true, mode: 0o700 })
    await confirmRecoveryDirectory(dirname(path))
    await durableWriteFile(path, JSON.stringify(op) + '\n', { mode: 0o600, requireDirectorySync: true })
  }
  async inspect(operationId: string): Promise<RestoreObservation> { return observation(await this.load(operationId)) }
  async preflight(request: RestorePreflight): Promise<RestoreObservation> {
    this.path(request.operationId)
    const requestHash = recoveryDigest(JSON.stringify(request))
    try { const old = await this.load(request.operationId); if (old.requestHash !== requestHash) invalid('This operation ID already selects a different recovery source.'); return observation(old) }
    catch (error) { if (!absent(error)) throw error }
    const selected = request.selectors || request.inputs ? new Set([...(request.selectors ?? []).map(item => JSON.stringify([item.sourceId, item.memberId])), ...(request.inputs ? [JSON.stringify(['core.sessions', 'database'])] : [])]) : undefined
    const { manifest, hash } = await this.recovery.readManifest(request.generationId, true, selected)
    if (hash !== request.manifestHash) invalid('The selected recovery generation changed.')
    const keys = request.selectors && new Set(request.selectors.map(item => JSON.stringify([item.sourceId, item.memberId])))
    if (keys && (keys.size !== request.selectors!.length || !keys.size)) invalid('Recovery selectors must be exact and unique.')
    const items: Item[] = []
    for (const source of manifest.sources) for (const member of source.members) {
      if (request.inputs && !request.selectors) continue
      const key = JSON.stringify([source.id, member.id]); if (keys && !keys.delete(key)) continue
      const baseline = await digest(member.target), actor = this.source(source.id)
      const { bytes: _bytes, ...sourceMember } = member
      items.push({ sourceId: source.id, memberId: member.id, baseline, state: baseline === member.sha256 ? 'same' : baseline !== null ? 'retained-current' : actor?.restoreMissing ? 'missing' : 'unavailable',
        ...(!actor?.restoreMissing && baseline === null ? { code: 'RECOVERY_ORIGINAL_OWNER_UNAVAILABLE' } : {}),
        member: { ...sourceMember, file: this.recovery.blobPath(member.sha256), operationId: request.operationId, originalSHA256: member.sha256 } })
    }
    if (keys?.size) invalid('A selected original recovery member is unavailable.')
    if (request.inputs) {
      const actor = this.source('core.sessions'), member = manifest.sources.find(source => source.id === 'core.sessions')?.members.find(member => member.id === 'database')
      if (!actor?.previewInput || !member || member.kind !== 'session-database' || !request.inputs.length) invalid('The original input evidence owner is unavailable.')
      const unique = new Set<string>()
      for (const input of request.inputs) {
        const memberId = JSON.stringify(['input', input.agentSessionId, input.runId, input.submissionId])
        if (unique.has(memberId)) invalid('Original input selectors must be unique.'); unique.add(memberId)
        const file = this.recovery.blobPath(member.sha256), preview = await actor.previewInput(file, input)
        const { bytes: _bytes, ...sourceMember } = member
        items.push({ sourceId: 'core.sessions', memberId, input, baseline: preview.baselineHash, resultHash: preview.resultHash, state: 'missing',
          member: { ...sourceMember, file, operationId: request.operationId } })
      }
    }
    if (!items.length) invalid('A selected original recovery member is unavailable.')
    const op: Operation = { schema: 'agentmux.restore-operation.v1', namespace: this.recovery.namespace, requestHash, operationId: request.operationId,
      generationId: request.generationId, manifestHash: hash, inputCutSourceSHA256: manifest.sources.find(source => source.id === 'core.sessions')?.members.find(member => member.id === 'database')?.sha256 ?? hash, state: 'prepared', items }
    for (const sourceId of new Set(items.filter(item => item.state === 'missing' && !item.input).map(item => item.sourceId))) {
      const actor = this.source(sourceId)!, selected = items.filter(item => item.sourceId === sourceId && item.state === 'missing' && !item.input)
      if (!actor.prepareRestore) {
        // Opaque files are inert only when their original owner explicitly offers restoreMissing.
        if (actor.requiresInputCut) for (const item of selected) { item.state = 'unavailable'; item.code = 'RECOVERY_ORIGINAL_PREPARATION_UNAVAILABLE' }
        continue
      }
      const directory = join(dirname(this.path(request.operationId)), 'prepared', recoveryDigest(sourceId) + '-' + mintObjectId())
      await mkdir(dirname(directory), { recursive: true, mode: 0o700 })
      const result = await actor.prepareRestore(selected.map(item => item.member), directory, {
        inputCutSourceSHA256: op.inputCutSourceSHA256,
        original: async id => {
          const member = manifest.sources.find(source => source.id === sourceId)?.members.find(member => member.id === id)
          if (!member) return null
          if ((await this.recovery.readManifest(request.generationId, true, new Set([JSON.stringify([sourceId, id])]))).hash !== hash) invalid('The original source changed during preparation.')
          const { bytes: _bytes, ...base } = member
          return { ...base, file: this.recovery.blobPath(member.sha256), operationId: request.operationId, originalSHA256: member.sha256 }
        }
      })
      if (result.state === 'unavailable') {
        for (const item of selected) {
          const reasons = result.selectors.filter(value => value.memberId === undefined || value.memberId === item.member.id).map(value => value.reason)
          item.state = 'unavailable'; item.code = [...new Set(reasons)].join(',') || (result.selectors.length ? 'RECOVERY_SOURCE_COHORT_UNAVAILABLE' : 'RECOVERY_RESTORE_UNAVAILABLE')
        }
        continue
      }
      if (result.members.length !== selected.length) invalid('The original owner prepared a different recovery selection.')
      for (const item of selected) {
        const member = result.members.find(value => value.id === item.member.id)
        if (!member || member.target !== item.member.target || member.kind !== item.member.kind || member.operationId !== request.operationId || relative(directory, member.file).startsWith('..')) invalid('The original owner prepared another target.')
        if ((await hashRecoveryFile(member.file)).sha256 !== member.sha256) invalid('The prepared original owner material changed.')
        item.member = { ...member, originalSHA256: item.member.originalSHA256 ?? item.member.sha256 }
        if (actor.requiresInputCut && result.metadata?.inertArchives !== true) {
          item.requiresInputCut = true
          if (!this.recovery.inputCuts) { item.state = 'unavailable'; item.code = 'RECOVERY_INPUT_CUT_OWNER_UNAVAILABLE' }
        }
      }
      // The original owner orders its own cohort (for example a ledger before
      // its confirmation member); Core does not infer protocols from filenames.
      const ordered = result.members.map(member => selected.find(item => item.member.id === member.id)!)
      const at = items.indexOf(selected[0]!)
      for (const item of selected) items.splice(items.indexOf(item), 1)
      items.splice(at, 0, ...ordered)
    }
    if (items.some(item => item.state === 'unavailable')) op.state = 'unavailable'
    await this.save(op)
    return observation(op)
  }
  async apply(operationId: string): Promise<RestoreObservation> {
    const op = await this.load(operationId)
    // The durable receipt is an original outcome, not a new request to publish
    // an old snapshot again after later edits, retirement or deletion.
    if (op.state === 'complete') return observation(op)
    const actionable = op.items.filter(item => !['retained-current', 'unavailable'].includes(item.state) && !(item.state === 'same' && item.baseline !== null))
    if (op.state === 'unavailable' && !actionable.length) return observation(op)
    if ((await this.recovery.readManifest(op.generationId, true, new Set(actionable.map(item => JSON.stringify([item.sourceId, item.member.id]))))).hash !== op.manifestHash) invalid('The admitted original generation changed after preflight.')
    op.state = 'applying'; await this.save(op)
    for (const item of op.items) {
      if (item.state === 'retained-current' || item.state === 'unavailable') continue
      // Existing equal content was only observed during preflight; no original
      // control file is republished or given a restored-input qualification.
      if (item.state === 'same' && item.baseline !== null) continue
      const actor = this.source(item.sourceId)
      if (!actor || (item.input ? !actor.restoreInput : !actor.restoreMissing)) { item.state = 'unavailable'; item.code = 'RECOVERY_ORIGINAL_OWNER_UNAVAILABLE'; continue }
      try {
        // Verify the prepared source on every retry; old pending intent holds are part of these bytes.
        if ((await hashRecoveryFile(item.member.file)).sha256 !== item.member.sha256) invalid('The prepared restore source changed.')
        if (item.input) {
          item.state = 'unknown'; await this.save(op)
          await actor!.restoreInput!(item.member.file, item.input, item.baseline!, item.resultHash!)
          item.state = 'restored'; delete item.code; await this.save(op); continue
        }
        const current = await digest(item.member.target)
        if (item.publicationAttempted && current === null) {
          item.state = 'unknown'; item.code = 'RECOVERY_PUBLICATION_UNCONFIRMED'; op.state = 'unknown'; await this.save(op); return observation(op)
        }
        if (current !== null && current !== item.member.sha256) {
          if (item.publicationAttempted) {
            // Only the original owner may recognize a legitimately extended
            // journal. A different object alone cannot settle a lost ACK.
            const result = await actor!.restoreMissing!(item.member)
            if (result !== 'conflict') { item.state = 'restored'; delete item.code; await this.save(op); continue }
            item.state = 'unknown'; item.code = 'RECOVERY_TARGET_CHANGED'; op.state = 'unknown'; await this.save(op); return observation(op)
          }
          item.state = 'retained-current'; item.code = 'RECOVERY_TARGET_CHANGED'; continue
        }
        if (item.requiresInputCut && !item.inputCutConfirmed) {
          if (!this.recovery.inputCuts || !/^[a-f0-9]{64}$/u.test(op.inputCutSourceSHA256)) throw new AgentMuxError('The original input cut owner is unavailable. No file was published.', 'RECOVERY_INPUT_CUT_OWNER_UNAVAILABLE')
          const cut = await this.recovery.inputCuts.admit({ operationId, sourceSHA256: op.inputCutSourceSHA256 })
          if (cut.state !== 'admitted') throw new AgentMuxError('The original input cut has unresolved owners. Inspect this same recovery operation.', 'RECOVERY_INPUT_CUT_UNAVAILABLE')
          item.inputCutConfirmed = true
        }
        item.state = 'unknown'; item.publicationAttempted = true; await this.save(op)
        const result = await actor!.restoreMissing!(item.member)
        item.state = result === 'conflict' ? 'retained-current' : result === 'same' ? 'same' : 'restored'
        delete item.code
        await this.save(op)
      } catch (error) { item.state = 'unknown'; item.code = code(error); op.state = 'unknown'; await this.save(op).catch(() => {}); return observation(op) }
    }
    op.state = op.items.some(item => item.state === 'unavailable') ? 'unavailable' : 'complete'
    await this.save(op); return observation(op)
  }
}
