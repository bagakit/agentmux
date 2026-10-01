import { afterAll, beforeAll, expect, it } from 'vitest'
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash, X509Certificate } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, get } from 'node:https'
import { preparePrivateCertificates } from '../src/private-certificates.js'
import { readPrivateTls } from '../src/private-tls.js'

let temporary: string
const execute = promisify(execFile)
beforeAll(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'agentmux-certificate-preparation-'))
  await execute(process.execPath, [join(import.meta.dirname, '../scripts/build.mjs')])
})
afterAll(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }) })
const names = ['issuer.key', 'issuer.pem', 'root.cer', 'server.key', 'server.pem']
async function materialHashes(directory: string) {
  return Object.fromEntries(await Promise.all(names.map(async name => [name, createHash('sha256').update(await readFile(join(directory, name))).digest('hex')])))
}

it('prepares a private CA and IP leaf, allowing actual trusted TLS while keeping OS trust unconfirmed', async () => {
  const material = await preparePrivateCertificates(join(temporary, 'trusted'), '127.0.0.1')
  expect(await readdir(material.directory)).toEqual(names)
  expect((await lstat(material.directory)).mode & 0o777).toBe(0o700)
  for (const name of names) expect((await lstat(join(material.directory, name))).mode & 0o777).toBe(0o600)
  const issuer = new X509Certificate(await readFile(material.rootCertificatePath))
  const leaf = new X509Certificate(await readFile(material.certificatePath))
  expect(issuer.ca).toBe(true)
  expect(leaf.verify(issuer.publicKey)).toBe(true)
  expect(leaf.checkIP('127.0.0.1')).toBe('127.0.0.1')
  expect(material.issuerFingerprint).toBe(issuer.fingerprint256)
  expect(material.systemTrust).toBe('unconfirmed')
  const identity = await readPrivateTls({ host: '127.0.0.1', port: 7443,
    keyPath: material.keyPath, certificatePath: material.certificatePath })
  const server = createServer(identity.tls, (_request, response) => response.end('private Host'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No bound TLS address')
    const read = (ca?: Buffer) => new Promise<string>((resolve, reject) => {
      const request = get({ hostname: '127.0.0.1', port: address.port, ca }, response => {
        const chunks: Buffer[] = []
        response.on('data', value => chunks.push(value))
        response.on('end', () => resolve(Buffer.concat(chunks).toString()))
      })
      request.on('error', reject)
    })
    expect(await read(await readFile(join(material.directory, 'issuer.pem')))).toBe('private Host')
    await expect(read()).rejects.toMatchObject({ code: 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' })
  } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  await expect(readPrivateTls({ host: '127.0.0.2', port: 7443,
    keyPath: material.keyPath, certificatePath: material.certificatePath })).rejects.toThrow('subject alternative names')
})

it('reuses the exact issuer and leaf bytes and refuses a different LAN address without replacing them', async () => {
  const directory = join(temporary, 'reused')
  const original = await preparePrivateCertificates(directory, '192.168.12.34'), before = await materialHashes(directory)
  expect(await preparePrivateCertificates(directory, '192.168.12.34')).toEqual(original)
  expect(await materialHashes(directory)).toEqual(before)
  await expect(preparePrivateCertificates(directory, '192.168.12.35')).rejects.toThrow('subject alternative names')
  expect(await materialHashes(directory)).toEqual(before)
})

it('retains partial, corrupt and permissive original material and gives a recovery action', async () => {
  const partial = join(temporary, 'partial')
  await mkdir(partial, { mode: 0o700 })
  await writeFile(join(partial, 'issuer.key'), 'original interrupted issuer', { mode: 0o600 })
  await expect(preparePrivateCertificates(partial, '127.0.0.1')).rejects.toThrow('restore their original issuer')
  expect(await readdir(partial)).toEqual(['issuer.key'])
  expect(await readFile(join(partial, 'issuer.key'), 'utf8')).toBe('original interrupted issuer')
  const corrupt = join(temporary, 'corrupt')
  await preparePrivateCertificates(corrupt, '127.0.0.1')
  await writeFile(join(corrupt, 'root.cer'), 'original corrupt export')
  const before = await materialHashes(corrupt)
  const failure = await preparePrivateCertificates(corrupt, '127.0.0.1').catch(error => error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure.message).toContain('restore their original issuer')
  expect(await materialHashes(corrupt)).toEqual(before)
  await chmod(join(corrupt, 'issuer.key'), 0o644)
  await expect(preparePrivateCertificates(corrupt, '127.0.0.1')).rejects.toThrow('private regular files')
  expect(await materialHashes(corrupt)).toEqual(before)
})

it('rejects a client-only original issuer even when its server leaf and signatures match, retaining all material', async () => {
  const directory = join(temporary, 'client-only-issuer')
  await preparePrivateCertificates(directory, '127.0.0.1')
  const config = join(temporary, 'client-only-issuer.cnf')
  await writeFile(config, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=root\n[dn]\nCN=AgentMux private Host issuer\n[root]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\nextendedKeyUsage=clientAuth\n', { mode: 0o600 })
  await execute('/usr/bin/openssl', ['req', '-new', '-x509', '-sha256', '-days', '2',
    '-key', join(directory, 'issuer.key'), '-out', join(directory, 'issuer.pem'), '-config', config])
  await execute('/usr/bin/openssl', ['x509', '-in', join(directory, 'issuer.pem'), '-outform', 'DER', '-out', join(directory, 'root.cer')])
  const issuer = new X509Certificate(await readFile(join(directory, 'issuer.pem')))
  const leaf = new X509Certificate(await readFile(join(directory, 'server.pem')))
  expect(issuer.keyUsage).toEqual(['1.3.6.1.5.5.7.3.2'])
  expect(leaf.checkIssued(issuer)).toBe(true)
  expect(leaf.verify(issuer.publicKey)).toBe(true)
  const before = await materialHashes(directory)
  const failure = await preparePrivateCertificates(directory, '127.0.0.1').catch(error => error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure.message).toContain('restore their original issuer')
  expect(await materialHashes(directory)).toEqual(before)
})

it('reserves one issuer under concurrent initialization without replacing partial bytes', async () => {
  const directory = join(temporary, 'concurrent')
  const results = await Promise.allSettled([
    preparePrivateCertificates(directory, '127.0.0.1'), preparePrivateCertificates(directory, '127.0.0.1')
  ])
  expect(results).toHaveLength(2)
  const completed = results.filter(result => result.status === 'fulfilled')
  expect(completed.length).toBeGreaterThan(0)
  expect(await readdir(directory)).toEqual(names)
  const before = await materialHashes(directory)
  const material = await preparePrivateCertificates(directory, '127.0.0.1')
  for (const result of completed) expect(result.value.issuerFingerprint).toBe(material.issuerFingerprint)
  expect(await materialHashes(directory)).toEqual(before)
})

it('rejects public or wildcard addresses before creating any material', async () => {
  const directory = join(temporary, 'public')
  const failure = await preparePrivateCertificates(directory, '8.8.8.8').catch(error => error)
  expect(failure).toBeInstanceOf(Error)
  expect(failure.message).toContain('explicit private IP')
  await expect(preparePrivateCertificates(directory, '0.0.0.0')).rejects.toThrow('explicit private IP')
  await expect(lstat(directory)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('the actual deployment preparation command consumes the helper and never claims a trusted phone', async () => {
  const directory = join(temporary, 'command')
  const command = join(import.meta.dirname, '../dist/prepare-private-access.js')
  const { stdout } = await execute(process.execPath, [command, '127.0.0.1', directory])
  const result = JSON.parse(stdout)
  expect(result.directory).toBe(directory)
  expect(result.systemTrust).toBe('unconfirmed')
  expect(result.nextStep).toContain('enable full SSL trust')
  expect(result.issuerFingerprint).toBe(new X509Certificate(await readFile(result.rootCertificatePath)).fingerprint256)
  expect(stdout).not.toContain('PRIVATE KEY')
  const before = await materialHashes(directory)
  const reused = await execute(process.execPath, [command, '127.0.0.1', directory])
  expect(JSON.parse(reused.stdout)).toEqual(result)
  expect(await materialHashes(directory)).toEqual(before)
  await expect(execute(process.execPath, [command, '8.8.8.8', directory])).rejects.toMatchObject({ code: 1 })
  expect(await materialHashes(directory)).toEqual(before)
})
