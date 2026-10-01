import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, get } from 'node:https'
import { X509Certificate } from 'node:crypto'
import { readPrivateTls } from '../src/private-tls.js'

const execute = promisify(execFile)
let root: string, keyPath: string, certificatePath: string, otherKeyPath: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentmux-private-tls-'))
  for (const name of ['host', 'other', 'client-only', 'unrestricted']) {
    const config = join(root, `${name}.cnf`)
    const usage = name === 'unrestricted' ? '' : `extendedKeyUsage=${name === 'client-only' ? 'clientAuth' : 'serverAuth'}\n`
    await writeFile(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=AgentMux test Host\n[ext]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\n' + usage + 'subjectAltName=IP:127.0.0.1,IP:192.168.12.34,IP:fd12::1\n')
    await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
      '-config', config, '-keyout', join(root, `${name}.key`), '-out', join(root, `${name}.crt`)])
    await chmod(join(root, `${name}.key`), 0o600)
  }
  keyPath = join(root, 'host.key'); certificatePath = join(root, 'host.crt'); otherKeyPath = join(root, 'other.key')
})
afterAll(async () => { if (root) await rm(root, { recursive: true, force: true }) })

const config = (host = '192.168.12.34') => ({ host, port: 7443, keyPath, certificatePath })

describe('private TLS identity for the existing public transport', () => {
  it('validates the actual leaf/private key and IPv4/IPv6 SAN, retaining a public fingerprint', async () => {
    const identity = await readPrivateTls(config())
    const certificate = new X509Certificate(await readFile(certificatePath))
    expect(identity.origin).toBe('https://192.168.12.34:7443')
    expect(identity.certificateFingerprint).toBe(certificate.fingerprint256)
    expect(identity.expiresAt).toBe(Date.parse(certificate.validTo))
    expect((await readPrivateTls(config('fd12::1'))).origin).toBe('https://[fd12::1]:7443')
  })

  it('rejects public/wildcard bindings and a different private address without opening a listener', async () => {
    for (const host of ['0.0.0.0', '::', '203.0.113.24', '8.8.8.8', 'agentmux.local']) {
      await expect(readPrivateTls(config(host))).rejects.toThrow('explicit private IP')
    }
    await expect(readPrivateTls(config('192.168.12.35'))).rejects.toThrow('subject alternative names')
    await expect(readPrivateTls({ ...config(), port: 0 })).rejects.toThrow('port between')
  })

  it('rejects not-yet-valid/expired certificates and mismatched keys', async () => {
    const certificate = new X509Certificate(await readFile(certificatePath))
    await expect(readPrivateTls(config(), Date.parse(certificate.validFrom) - 1)).rejects.toThrow('not currently valid')
    await expect(readPrivateTls(config(), Date.parse(certificate.validTo))).rejects.toThrow('not currently valid')
    await expect(readPrivateTls({ ...config(), keyPath: otherKeyPath })).rejects.toThrow('does not match')
  })

  it('rejects a client-only EKU while permitting a certificate without an EKU restriction', async () => {
    await expect(readPrivateTls({ ...config(), keyPath: join(root, 'client-only.key'),
      certificatePath: join(root, 'client-only.crt') })).rejects.toThrow('server authentication')
    expect((await readPrivateTls({ ...config(), keyPath: join(root, 'unrestricted.key'),
      certificatePath: join(root, 'unrestricted.crt') })).origin).toBe('https://192.168.12.34:7443')
  })

  it('requires private key permissions while preserving the original file', async () => {
    const path = join(root, 'public-readable.key'), original = await readFile(keyPath)
    await writeFile(path, original, { mode: 0o644 })
    await expect(readPrivateTls({ ...config(), keyPath: path })).rejects.toThrow('mode 0600')
    expect(await readFile(path)).toEqual(original)
  })

  it('serves actual verified TLS and refuses an untrusted client without disabling certificate validation', async () => {
    const identity = await readPrivateTls(config('127.0.0.1'))
    const server = createServer(identity.tls, (_request, response) => response.end('original public transport'))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      expect(address).toBeTruthy()
      if (!address || typeof address === 'string') throw new Error('TCP address missing')
      const read = (trusted: boolean) => new Promise<string>((resolve, reject) => {
        const request = get({ hostname: '127.0.0.1', port: address.port,
          ...(trusted ? { ca: identity.tls.cert } : {}) }, response => {
          const chunks: Buffer[] = []
          response.on('data', value => chunks.push(value)); response.on('end', () => resolve(Buffer.concat(chunks).toString()))
        })
        request.on('error', reject)
      })
      expect(await read(true)).toBe('original public transport')
      await expect(read(false)).rejects.toMatchObject({ code: 'DEPTH_ZERO_SELF_SIGNED_CERT' })
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })
})
