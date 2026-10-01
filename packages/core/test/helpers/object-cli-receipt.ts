import { expect } from 'vitest'

/** The public CLI presentation envelope; business bodies are validated by the RPC client. */
export function objectCliReceipt(value: unknown) {
  expect(value).toBeTypeOf('object')
  const body = value as { ok: boolean; operation: string | null; operationId?: string; result?: any; error?: any }
  expect(typeof body.ok).toBe('boolean')
  expect(body.operation === null || typeof body.operation === 'string').toBe(true)
  if (body.operationId !== undefined) expect(body.operationId.length).toBeGreaterThan(0)
  expect(Object.keys(body).sort()).toEqual([
    ...(body.ok ? ['ok', 'operation', 'result'] : ['error', 'ok', 'operation']),
    ...(body.operationId === undefined ? [] : ['operationId'])
  ].sort())
  return body
}
