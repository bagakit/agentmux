import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type { ContinuousProgressTaskSource } from '@agentmux/core'

const execute = promisify(execFile)
export function validateContinuousProgressTaskSource(value: unknown): asserts value is ContinuousProgressTaskSource {
  if (!value || typeof value !== 'object') throw new Error('Choose an exact task source root, Feature ID and public script.')
  const source = value as ContinuousProgressTaskSource
  if (!['root', 'ownerId', 'readerPath'].every(key => typeof source[key as keyof ContinuousProgressTaskSource] === 'string' && source[key as keyof ContinuousProgressTaskSource].trim()) ||
      !isAbsolute(source.root) || !isAbsolute(source.readerPath)) throw new Error('Task source root and public script must be explicit absolute paths; Feature ID must be nonempty.')
}

/** Read one explicit public owner receipt. The Tracker validates canonical state and computes its frontier. */
export async function readContinuousProgressTaskSource(source: ContinuousProgressTaskSource, signal: AbortSignal): Promise<{ action: 'continue' | 'pause' | 'stop'; reason: string }> {
  validateContinuousProgressTaskSource(source)
  const { stdout } = await execute('/bin/bash', [source.readerPath, 'get-owner-receipt', '--root', source.root, '--feature', source.ownerId, '--json'],
    { signal, timeout: 10_000, maxBuffer: 256 * 1024, encoding: 'utf8', cwd: source.root })
  const receipt: unknown = JSON.parse(stdout)
  if (!receipt || typeof receipt !== 'object') throw new Error('Task source returned an invalid owner receipt.')
  const value = receipt as Record<string, unknown>
  const states = ['proposal', 'ready', 'in_progress', 'blocked', 'replanning', 'done', 'archived', 'discarded', 'transferred']
  if (value.schema !== 'bagakit.execution-owner-receipt.v2' || value.owner_kind !== 'feature_tracker' || value.owner_id !== source.ownerId ||
      typeof value.semantic_revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.semantic_revision) ||
      !states.includes(value.lifecycle_status as string) || !['continue', 'blocked', 'complete', 'superseded', 'unavailable'].includes(value.continuation as string) ||
      !Array.isArray(value.active_item_ids) || !value.active_item_ids.every(id => typeof id === 'string' && id.length > 0) ||
      !Array.isArray(value.blockers) || !value.blockers.every(blocker => blocker && typeof blocker === 'object' && typeof blocker.class === 'string' && typeof blocker.reason === 'string') ||
      !(value.replacement_ref === null || typeof value.replacement_ref === 'string')) throw new Error('Task source identity, version or lifecycle is unconfirmed.')
  const prefix = `Feature ${source.ownerId}: `
  if (value.lifecycle_status === 'archived' && value.continuation === 'complete') return { action: 'stop', reason: prefix + 'business complete (archived).' }
  if (value.lifecycle_status === 'done' || value.blockers.some(blocker => blocker.class === 'closeout_required')) return { action: 'pause', reason: prefix + 'tasks are done; Feature closeout is still required.' }
  if (value.lifecycle_status === 'discarded' || value.lifecycle_status === 'transferred') return { action: 'stop', reason: prefix + `${value.lifecycle_status}; not business success.${value.replacement_ref ? ` Replacement: ${value.replacement_ref}` : ''}` }
  if (value.continuation === 'continue' && ['ready', 'in_progress'].includes(value.lifecycle_status as string)) {
    return { action: 'continue', reason: prefix + `${value.lifecycle_status}; source checked.` }
  }
  if (value.continuation === 'blocked') return { action: 'pause', reason: prefix + value.blockers.map(blocker => `${blocker.class}: ${blocker.reason}`).join('; ') }
  throw new Error('Task source lifecycle is unconfirmed; manual input remains available.')
}
