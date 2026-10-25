import { execFileSync } from 'node:child_process'
import { X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, it, vi } from 'vitest'
import { assertSenderTrusted, senderTrust } from '../src/main/ipc-sender-trust.js'
import { BrowserCertificateDecision } from '../src/main/browser-certificates.js'
import { parseBrowserTarget } from '../../../packages/core/src/control-browser-targets.js'

const root = mkdtempSync(join(tmpdir(), 'amx-certificate-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=Private certificate test', '-days', '1',
  '-keyout', join(root, 'key.pem'), '-out', join(root, 'cert.pem')], { stdio: 'pipe' })
const certificate = readFileSync(join(root, 'cert.pem'), 'utf8')
function fixture() {
  let current = true
  const complete = vi.fn()
  const decision = new BrowserCertificateDecision({ url: 'https://example.invalid/original', error: 'net::ERR_CERT_AUTHORITY_INVALID', certificate, navigationId: 'original-document' }, () => current, complete)
  return { decision, complete, replace: () => { current = false }, answer: (allow = true) => ({ ...decision.request, allow }) }
}
it('uses the original PEM SHA256 rather than trusting a display fingerprint', () => {
  const f = fixture(), expected = new X509Certificate(certificate)
  expect(f.decision.request).toMatchObject({ fingerprint: expected.fingerprint256, subject: expected.subject, issuer: expected.issuer, scope: 'profile-connections' })
})
it('rejects mismatched answers without settling another request, then answers exactly once', () => {
  const f = fixture()
  for (const field of ['requestId', 'navigationId', 'fingerprint']) {
    expect(() => f.decision.answer({ ...f.answer(), [field]: 'foreign' })).toThrow('no longer matches')
    expect(f.complete).not.toHaveBeenCalled()
  }
  expect(() => f.decision.answer({ ...f.answer(), allow: 'true' } as never)).toThrow('no longer matches')
  f.decision.answer(f.answer(false)); f.decision.settle(true)
  expect(f.complete).toHaveBeenCalledExactlyOnceWith(false)
  expect(() => f.decision.answer(f.answer())).toThrow('no longer matches')
})
it('owner changes cannot turn a pending callback into authorization', () => {
  const f = fixture(); f.replace()
  expect(() => f.decision.answer(f.answer())).toThrow('no longer matches')
  expect(f.complete).not.toHaveBeenCalled()
  f.decision.settle(true); f.decision.settle(false)
  expect(f.complete).toHaveBeenCalledExactlyOnceWith(false)
})
it('public discovery validates certificate identity and scope without adding an answer operation', () => {
  const request = fixture().decision.request
  const target = { id: 'original', workspaceId: 'workspace', source: 'embedded', status: 'ready', capabilities: [],
    url: request.url, title: '', navigationId: request.navigationId, certificateRequest: request }
  expect(parseBrowserTarget(target).certificateRequest).toEqual(request)
  for (const certificateRequest of [{ ...request, fingerprint: 'display-name' }, { ...request, navigationId: 'foreign' },
    { ...request, scope: 'single-page' }, { ...request, allow: true }, { ...request, url: 'http://example.invalid/' }]) {
    expect(() => parseBrowserTarget({ ...target, certificateRequest })).toThrow()
  }
  expect(() => parseBrowserTarget({ ...target, source: 'external' })).toThrow()
})

it('accepts certificate answers only from the original trusted App sender', () => {
  const original = {}, page = {}
  expect(senderTrust('browser:answerCertificate', original, original).trusted).toBe(true)
  expect(() => assertSenderTrusted(senderTrust('browser:answerCertificate', page, original))).toThrow('Untrusted')
})
