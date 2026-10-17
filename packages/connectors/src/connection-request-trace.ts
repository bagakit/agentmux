import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { AgentMuxError } from '@agentmux/core'
import { parseConnectionRequestTrace, type ConnectionEnrollmentCallContext, type ConnectionRequestTraceSelector, type ConnectionRequestTrace } from '@agentmux/core/connections'

/** Read only existing journal facts. No Provider, private snapshot or secret port is involved. */
export function readConnectionRequestTrace(database: DatabaseSync, owner: 'enrollment' | 'setup', operationId: string, actor: ConnectionEnrollmentCallContext['actor'], selector: ConnectionRequestTraceSelector, knownOperation: boolean): ConnectionRequestTrace {
  const scope = createHash('sha256').update(JSON.stringify({ owner, operationId, actor })).digest('hex')
  const prefix = `request-trace:${scope}:`, after = selector.cursor === undefined ? 0 : Number(selector.cursor.slice(prefix.length))
  if (selector.cursor !== undefined && (!selector.cursor.startsWith(prefix) || !Number.isSafeInteger(after) || after < 1)) throw new AgentMuxError('This trace cursor belongs to another original request or actor.', 'INVALID_CONNECTION_REQUEST_TRACE')
  if (!knownOperation) return parseConnectionRequestTrace({ operationId, entries: [], next: null }, operationId, selector)
  const limit = selector.limit ?? 25
  const rows = owner === 'enrollment'
    ? database.prepare(`SELECT rowid AS sequence, attempt_id AS step_id, 'enrollment-request' AS kind,
        CASE kind WHEN 'begin' THEN 'initialize' WHEN 'poll' THEN 'authentication' ELSE kind END AS action,
        NULL AS subject, NULL AS effect, state AS request, NULL AS secure_storage
        FROM connection_enrollment_attempt WHERE operation_id=? AND rowid>? ORDER BY rowid LIMIT ?`).all(operationId, after, limit + 1)
    : database.prepare(`SELECT * FROM (
        SELECT 1 AS sequence, json_extract(record_json,'$.request.attemptId') AS step_id,
          'setup-initialize' AS kind,
          CASE WHEN json_extract(record_json,'$.source.kind')='enrollment' THEN 'enrollment-handoff' ELSE 'initialize' END AS action,
          NULL AS subject, NULL AS effect, json_extract(record_json,'$.request.state') AS request,
          json_extract(record_json,'$.secureStorage') AS secure_storage, NULL AS diagnostic_json
        FROM connection_setup_operation WHERE operation_id=? AND json_extract(record_json,'$.request.attemptId') IS NOT NULL
        UNION ALL
        SELECT cast(json_extract(input_json,'$.expectedRevision') AS INTEGER)+1 AS sequence, step_id,
          'setup-authentication' AS kind,
          CASE json_extract(input_json,'$.decision.value') WHEN 'confirm' THEN 'confirm-account' ELSE json_extract(input_json,'$.decision.value') END AS action,
          NULL AS subject, NULL AS effect, json_extract(record_json,'$.request') AS request,
          json_extract(record_json,'$.secureStorage') AS secure_storage, NULL AS diagnostic_json
        FROM connection_setup_auth_step WHERE operation_id=?
        UNION ALL
        SELECT cast(json_extract(record_json,'$.receipt.input.expectedRevision') AS INTEGER)+1 AS sequence, step_id,
          CASE WHEN json_extract(record_json,'$.effect') IS NULL THEN 'application-inspection' ELSE 'application-configuration' END AS kind,
          CASE WHEN json_extract(record_json,'$.effect') IS NOT NULL THEN 'configure-application'
            WHEN json_extract(record_json,'$.receipt.subject') IS NOT NULL THEN 'read-application' ELSE 'inspect-application' END AS action,
          json_extract(record_json,'$.receipt.subject') AS subject, json_extract(record_json,'$.effect') AS effect,
          json_extract(record_json,'$.receipt.request') AS request, json_extract(record_json,'$.receipt.secureStorage') AS secure_storage, json_extract(record_json,'$.receipt.diagnostic') AS diagnostic_json
        FROM connection_setup_inspection WHERE operation_id=?
      ) WHERE sequence>? ORDER BY sequence LIMIT ?`).all(operationId, operationId, operationId, after, limit + 1)
  const entries = rows.slice(0, limit).map(row => ({ sequence: row.sequence, stepId: row.step_id, kind: row.kind, action: row.action, subject: row.subject, effect: row.effect, request: row.request, secureStorage: row.secure_storage, network: null, ...(typeof row.diagnostic_json === 'string' ? { diagnostic: JSON.parse(row.diagnostic_json) } : {}) }))
  return parseConnectionRequestTrace({ operationId, entries, next: rows.length > limit ? prefix + entries.at(-1)!.sequence : null }, operationId, selector)
}
