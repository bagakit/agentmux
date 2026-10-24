import { expect, it } from 'vitest'
import { CONNECTION_API_LIMITS, connectionApiRequestDigest, parseConnectionApiParams, parseConnectionApiResult, parseConnectionApiRequest } from '../src/connection-api-codec.js'
import { parseConnectionParams, parseConnectionResult, CONNECTION_RPC_METHODS } from '../src/connections.js'
import { apiIdentity, apiInput, apiOperation } from './fixtures/connection-api.js'

it('registers strict generic native API methods and canonical full-intent digests including file bytes/metadata and exact selector', () => {
  for (const method of ['connection.api.identities', 'connection.api.request', 'connection.api.inspect'] as const) expect(CONNECTION_RPC_METHODS[method]).toBe('long')
  expect(parseConnectionParams('connection.api.request', apiInput)).toEqual(apiInput)
  const reordered = { ...apiInput, request: { ...apiInput.request, query: { enabled: true, page: 1 }, body: { a: [null, true, 1], z: 'Original text' } } }
  expect(connectionApiRequestDigest(reordered)).toBe(connectionApiRequestDigest(apiInput))
  expect(connectionApiRequestDigest({ ...apiInput, identity: { ...apiInput.identity, bindingRevision: 4 } })).not.toBe(connectionApiRequestDigest(apiInput))
  expect(connectionApiRequestDigest({ ...apiInput, request: { ...apiInput.request, files: [{ ...apiInput.request.files![0]!, name: 'other.png' }] } })).not.toBe(connectionApiRequestDigest(apiInput))
  expect(connectionApiRequestDigest({ ...apiInput, request: { ...apiInput.request, files: [{ ...apiInput.request.files![0]!, base64: Buffer.from('other').toString('base64') }] } })).not.toBe(connectionApiRequestDigest(apiInput))
  const anotherKey = { ...apiInput, operationId: 'different-key' }
  expect(connectionApiRequestDigest(anotherKey)).toBe(connectionApiRequestDigest(apiInput))
})

it('matches original operation, selector, method and full digest while allowing an honestly redacted safe result path', () => {
  const result = apiOperation()
  expect(parseConnectionResult('connection.api.request', result, apiInput)).toEqual(result)
  expect(parseConnectionApiResult('connection.api.request', { ...result, request: { ...result.request, path: '/v1/[redacted]' } }, apiInput)).toMatchObject({ request: { path: '/v1/[redacted]' } })
  expect(parseConnectionApiResult('connection.api.inspect', { operation: result }, { operationId: result.operationId })).toEqual({ operation: result })
  expect(parseConnectionApiResult('connection.api.inspect', { operation: null }, { operationId: 'old-original' })).toEqual({ operation: null })
  for (const bad of [ { ...result, operationId: 'foreign' }, { ...result, identity: { ...result.identity, bindingRevision: 4 } },
    { ...result, request: { ...result.request, method: 'DELETE' } }, { ...result, request: { ...result.request, digest: '0'.repeat(64) } } ]) {
    expect(() => parseConnectionApiResult('connection.api.request', bad, apiInput)).toThrow()
  }
  // HTTP200 is retained as a response, not promoted to business success.
  expect(result).toMatchObject({ state: 'responded', response: { status: 200, body: { value: { code: 17 } } } })
})

it('rejects getters, symbol fields, prototype objects, sparse arrays, cycles, nonfinite values, deep or oversized JSON without invoking them', () => {
  let called = 0
  const getter = Object.defineProperty({}, 'secret', { enumerable: true, get() { called++; return 'never read' } })
  const symbol = { [Symbol('hidden')]: 'hidden' }, inherited = Object.create({ inherited: true }), cycle: Record<string, unknown> = {}; cycle.self = cycle
  const arrayGetter = Object.defineProperty([], '0', { enumerable: true, get() { called++; return 'never' } })
  const tagged: unknown[] = []; Object.assign(tagged, { extra: 'not JSON array' })
  let deep: unknown = null; for (let i = 0; i < CONNECTION_API_LIMITS.jsonDepth + 2; i++) deep = [deep]
  for (const body of [getter, symbol, inherited, cycle, arrayGetter, tagged, new Array(2), NaN, Infinity, undefined, 1n, deep, JSON.parse('{"__proto__":{"x":1}}')]) {
    expect(() => parseConnectionApiRequest({ method: 'POST', path: '/business', body: [body] })).toThrow()
  }
  const toJSON = { toJSON() { called++; return {} } }
  expect(() => parseConnectionApiRequest({ method: 'POST', path: '/business', body: toJSON })).toThrow()
  expect(called).toBe(0)
  expect(() => parseConnectionApiRequest({ method: 'POST', path: '/business', body: 'x'.repeat(CONNECTION_API_LIMITS.bodyBytes - 2) })).not.toThrow()
  expect(() => parseConnectionApiRequest({ method: 'POST', path: '/business', body: 'x'.repeat(CONNECTION_API_LIMITS.bodyBytes) })).toThrow()
})

it('rejects arbitrary network/Host/SDK controls, malformed paths, nonprimitive query and noncanonical or oversized uploads', () => {
  for (const extra of [{ url: 'https://foreign.example' }, { headers: { Authorization: 'not accepted' } }, { timeout: 12 }, { sdk: {} }]) {
    expect(() => parseConnectionApiRequest({ ...apiInput.request, ...extra })).toThrow()
  }
  for (const path of ['https://foreign.example/api', '//foreign.example/api', '/a/../b', '/a/%2e%2e/b', '/a?token=x', '/a#fragment', '/a\\b', '/a%0Ab', '/invalid%', '/a//b', '/a/', '/', '/a%2Fb', '/a%3Fb', '/a%23b', '/a%25b', '/%E4%b8%AD', '/原文']) expect(() => parseConnectionApiRequest({ method: 'GET', path })).toThrow()
  expect(parseConnectionApiRequest({ method: 'GET', path: '/users/@me/%E4%B8%AD%20text' }).path).toBe('/users/@me/%E4%B8%AD%20text')
  for (const query of [{ value: {} }, { value: [] }, { value: null }, { value: Infinity }]) expect(() => parseConnectionApiRequest({ method: 'GET', path: '/business', query })).toThrow()
  const file = apiInput.request.files![0]!
  for (const bad of [{ ...file, path: '/private/host' }, { ...file, url: 'https://private' }, { ...file, name: '../host' },
    { ...file, base64: 'YQ' }, { ...file, base64: 'YR==' }, { ...file, base64: 'YQ==\n' }, { ...file, contentType: 'a/b\r\nheader:x' }]) {
    expect(() => parseConnectionApiRequest({ method: 'POST', path: '/business', files: [bad] })).toThrow()
  }
  expect(() => parseConnectionApiRequest({ method: 'POST', path: '/business', files: Array.from({ length: 9 }, () => file) })).toThrow()
  const maxFile = { ...file, base64: Buffer.alloc(CONNECTION_API_LIMITS.totalFileBytes).toString('base64') }
  expect(() => parseConnectionApiRequest({ method: 'POST', path: '/business', files: [maxFile] })).not.toThrow()
  expect(() => parseConnectionApiRequest({ method: 'POST', path: '/business', files: [maxFile, file] })).toThrow()
})

it('bounds original identity discovery and strict response unions and relationships', () => {
  expect(parseConnectionApiResult('connection.api.identities', { identities: [apiIdentity] }, { agentSessionId: apiIdentity.agentSessionId })).toEqual({ identities: [apiIdentity] })
  for (const identities of [[apiIdentity, apiIdentity], [{ ...apiIdentity, agentSessionId: 'foreign' }], [{ ...apiIdentity, credentialRef: 'not public' }]]) expect(() => parseConnectionApiResult('connection.api.identities', { identities }, { agentSessionId: apiIdentity.agentSessionId })).toThrow()
  expect(() => parseConnectionApiParams('connection.api.identities', { agentSessionId: 'original-agent', actor: { id: 'forged' } })).toThrow()
  const base = apiOperation()
  for (const response of [{ status: 99, body: { format: 'empty' }, redacted: false }, { status: 200, body: { format: 'empty', value: 'bad' }, redacted: false },
    { status: 200, body: { format: 'unavailable', reason: 'raw-error-text' }, redacted: true }, { status: 200, body: { format: 'json', value: 'x'.repeat(CONNECTION_API_LIMITS.responseBytes) }, redacted: false }]) {
    expect(() => parseConnectionApiResult('connection.api.request', { ...base, response }, apiInput)).toThrow()
  }
  expect(parseConnectionApiResult('connection.api.request', { ...base, response: { status: 204, body: { format: 'empty' }, redacted: false } }, apiInput)).toMatchObject({ state: 'responded' })
  expect(() => parseConnectionApiResult('connection.api.request', { ...base, state: 'unknown', code: 'EFFECT_UNCONFIRMED' }, apiInput)).toThrow()
})
