import { execFile } from 'node:child_process'
import { createPrivateKey, X509Certificate } from 'node:crypto'
import { chmod, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { AgentMuxError } from '@agentmux/core'
import { readPrivateTls, requirePrivateHostAddress } from './private-tls.js'

const exec = promisify(execFile)
const names = ['issuer.key', 'issuer.pem', 'root.cer', 'server.key', 'server.pem'] as const

export interface PrivateCertificateMaterial {
  readonly directory: string
  readonly keyPath: string
  readonly certificatePath: string
  readonly rootCertificatePath: string
  readonly issuerFingerprint: string
  readonly certificateFingerprint: string
  /** File preparation never proves that a phone's OS trusts the issuer. */
  readonly systemTrust: 'unconfirmed'
}

function invalid(message: string): AgentMuxError {
  return new AgentMuxError(`${message} Original certificate files are retained; restore their original issuer instead of replacing it silently.`, 'INVALID_CONTROL_REQUEST')
}

async function inspect(directory: string, host: string): Promise<PrivateCertificateMaterial> {
  try { return await readMaterial(directory, host) }
  catch (error) {
    if (error instanceof AgentMuxError) throw error
    throw invalid('Private Host certificate material is incomplete or cannot be read.')
  }
}

async function readMaterial(directory: string, host: string): Promise<PrivateCertificateMaterial> {
  const info = await lstat(directory)
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) throw invalid('Certificate storage must be a private directory (0700).')
  for (const name of names) {
    const file = await lstat(join(directory, name))
    if (!file.isFile() || (file.mode & 0o077) !== 0) throw invalid('Certificate material must be private regular files (0600).')
  }
  const [issuerBytes, issuerKey, rootBytes, leafBytes] = await Promise.all([
    readFile(join(directory, 'issuer.pem')), readFile(join(directory, 'issuer.key')),
    readFile(join(directory, 'root.cer')), readFile(join(directory, 'server.pem'))
  ])
  const issuer = new X509Certificate(issuerBytes), leaf = new X509Certificate(leafBytes)
  if (!issuer.ca || (issuer.keyUsage && !issuer.keyUsage.includes('1.3.6.1.5.5.7.3.1'))
    || !issuer.checkIssued(issuer) || !issuer.verify(issuer.publicKey)
    || !issuer.checkPrivateKey(createPrivateKey(issuerKey))
    || Date.now() < Date.parse(issuer.validFrom) || Date.now() >= Date.parse(issuer.validTo)
    || !issuer.raw.equals(rootBytes) || !leaf.checkIssued(issuer) || !leaf.verify(issuer.publicKey)) {
    throw invalid('The original private issuer, root export and server certificate do not match or are no longer valid.')
  }
  const keyPath = join(directory, 'server.key'), certificatePath = join(directory, 'server.pem')
  const tls = await readPrivateTls({ host, port: 443, keyPath, certificatePath })
  return { directory, keyPath, certificatePath, rootCertificatePath: join(directory, 'root.cer'),
    issuerFingerprint: issuer.fingerprint256, certificateFingerprint: tls.certificateFingerprint,
    systemTrust: 'unconfirmed' }
}

/** Prepare an explicit private Host's files only. Never install trust or start a listener. */
export async function preparePrivateCertificates(path: string, host: string): Promise<PrivateCertificateMaterial> {
  requirePrivateHostAddress(host)
  const directory = resolve(path)
  // Existing material is authoritative, including a partial or broken initialization.
  try { await lstat(directory) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    await mkdir(dirname(directory), { recursive: true, mode: 0o700 })
    // Exclusive reservation prevents two initializers from publishing different issuers.
    // An interrupted initialization remains visible and authoritative on the next attempt.
    try { await mkdir(directory, { mode: 0o700 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      return await inspect(directory, host)
    }
    const staging = directory
    try {
      for (const name of names) await writeFile(join(staging, name), '', { mode: 0o600, flag: 'wx' })
      const rootConfig = join(staging, 'issuer.cnf'), leafConfig = join(staging, 'server.cnf')
      await writeFile(rootConfig, '[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=root\n[dn]\nCN=AgentMux private Host issuer\n[root]\nbasicConstraints=critical,CA:true\nkeyUsage=critical,keyCertSign,cRLSign\nsubjectKeyIdentifier=hash\n', { mode: 0o600 })
      await writeFile(leafConfig, `[req]\nprompt=no\ndistinguished_name=dn\n[dn]\nCN=AgentMux private Host\n[server]\nbasicConstraints=critical,CA:false\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=serverAuth\nsubjectKeyIdentifier=hash\nauthorityKeyIdentifier=keyid,issuer\nsubjectAltName=IP:${host}\n`, { mode: 0o600 })
      const openssl = async (...args: string[]) => {
        try { await exec('/usr/bin/openssl', args, { cwd: staging, timeout: 15_000, maxBuffer: 128 * 1024 }) }
        catch { throw invalid('The system certificate tool could not prepare the private Host certificate.') }
      }
      await openssl('genrsa', '-out', 'issuer.key', '2048')
      await openssl('req', '-new', '-x509', '-sha256', '-days', '3650', '-key', 'issuer.key', '-out', 'issuer.pem', '-config', rootConfig)
      await openssl('genrsa', '-out', 'server.key', '2048')
      await openssl('req', '-new', '-sha256', '-key', 'server.key', '-out', 'server.csr', '-config', leafConfig)
      await openssl('x509', '-req', '-sha256', '-days', '90', '-in', 'server.csr', '-CA', 'issuer.pem', '-CAkey', 'issuer.key', '-CAcreateserial', '-out', 'server.pem', '-extfile', leafConfig, '-extensions', 'server')
      await openssl('x509', '-in', 'issuer.pem', '-outform', 'DER', '-out', 'root.cer')
      for (const name of names) await chmod(join(staging, name), 0o600)
      for (const name of ['issuer.cnf', 'server.cnf', 'server.csr', 'issuer.srl']) await rm(join(staging, name))
      await inspect(staging, host)
    } catch (error) {
      // Keep every generated key, including partial material. A retry must not replace identity.
      if (error instanceof AgentMuxError) throw error
      throw invalid('Private Host certificate preparation did not complete.')
    }
  }
  return await inspect(directory, host)
}
