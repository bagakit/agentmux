import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { X509Certificate, randomUUID, randomBytes, generateKeyPairSync } from 'node:crypto'
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const exec = promisify(execFile)
const runNative = (command, args) => exec(command, args, { encoding: 'utf8', timeout: args[0] === 'add-trusted-cert' ? 120_000 : 30_000, maxBuffer: 1_048_576 })
export const localSigningDirectory = (home = homedir()) => join(home, '.agentmux', 'signing')

/** Public configuration only. The private key lives in this user's Keychain. */
export async function readLocalSigningIdentity({ home = homedir() } = {}) {
  const directory = localSigningDirectory(home)
  let contents
  try { contents = await readFile(join(directory, 'identity.json'), 'utf8') }
  catch (error) { if (error.code === 'ENOENT') return null; throw error }
  const record = JSON.parse(contents)
  const certificate = new X509Certificate(await readFile(join(directory, 'certificate.pem')))
  const identity = certificate.fingerprint.replaceAll(':', '').toUpperCase()
  if (record.schema !== 'agentmux.macos-local-signing.v1' || record.identity !== identity ||
    certificate.ca || certificate.subject !== certificate.issuer ||
    !certificate.verify(certificate.publicKey) || !certificate.keyUsage?.includes('1.3.6.1.5.5.7.3.3')) {
    throw new Error('The saved local signing identity is inconsistent. Restore its original public record and Keychain identity; it will not be replaced automatically.')
  }
  return Object.freeze({ kind: 'certificate', profile: 'local', identity })
}

const exists = async path => { try { await access(path); return true } catch (error) { if (error.code === 'ENOENT') return false; throw error } }
async function importedIdentity(identity, run) {
  // Include untrusted identities: importing and trusting are separate person-owned steps.
  const inventory = await run('/usr/bin/security', ['find-identity', '-p', 'codesigning'])
  return [...inventory.stdout.matchAll(/^\s*\d+\)\s+([A-F0-9]{40})\s+"[^"\n]+"/gmi)].some(match => match[1].toUpperCase() === identity)
}

/** An explicit one-time setup; an interrupted import resumes the same private identity. */
export async function setupLocalSigningIdentity({ home = homedir(), run = runNative } = {}) {
  const directory = localSigningDirectory(home), pending = join(directory, 'pending')
  const existing = await readLocalSigningIdentity({ home })
  if (existing && await importedIdentity(existing.identity, run)) {
    await rm(pending, { recursive: true, force: true })
    return existing
  }
  if (existing && !await exists(join(pending, 'key.pem'))) {
    throw new Error('The original local signing private key is missing from the Keychain and pending setup. Restore the original identity; it will not be regenerated.')
  }
  await mkdir(join(home, '.agentmux'), { recursive: true, mode: 0o700 })
  if (!existing && !await exists(directory)) {
    await mkdir(directory, { mode: 0o700 })
    await mkdir(pending, { mode: 0o700 })
    const pair = generateKeyPairSync('rsa', { modulusLength: 3072, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
    await writeFile(join(pending, 'key.pem'), pair.privateKey, { mode: 0o600, flag: 'wx' })
    await writeFile(join(pending, 'openssl.cnf'), `[req]\nprompt = no\ndistinguished_name = subject\nx509_extensions = signing\n[subject]\nCN = AgentMux Local ${randomUUID()}\n[signing]\nbasicConstraints = critical,CA:false\nkeyUsage = critical,digitalSignature\nextendedKeyUsage = critical,codeSigning\n`, { mode: 0o600, flag: 'wx' })
  }
  const key = join(pending, 'key.pem'), certificate = join(pending, 'certificate.pem'), archive = join(pending, 'identity.p12')
  if (!await exists(key) || !await exists(join(pending, 'openssl.cnf'))) throw new Error('Local signing setup is incomplete. Its original private identity is preserved when available; review the pending directory instead of replacing it.')
  if (!existing) {
    if (!await exists(certificate)) await run('/usr/bin/openssl', ['req', '-new', '-x509', '-key', key, '-sha256', '-days', '3650', '-config', join(pending, 'openssl.cnf'), '-out', certificate])
    const pem = await readFile(certificate)
    const identity = new X509Certificate(pem).fingerprint.replaceAll(':', '').toUpperCase()
    if (!await exists(join(directory, 'certificate.pem'))) await writeFile(join(directory, 'certificate.pem'), pem, { mode: 0o600, flag: 'wx' })
    await writeFile(join(directory, 'identity.json'), JSON.stringify({ schema: 'agentmux.macos-local-signing.v1', identity }, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
  }
  const selected = await readLocalSigningIdentity({ home })
  const passwordPath = join(pending, 'archive-password')
  if (!await exists(passwordPath)) await writeFile(passwordPath, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' })
  const password = await readFile(passwordPath, 'utf8')
  // macOS and LibreSSL disagree on empty PKCS#12 passwords. Keep a nonempty transport
  // password beside the protected pending key; never put it in OpenSSL arguments or errors.
  await run('/usr/bin/openssl', ['pkcs12', '-export', '-inkey', key, '-in', join(directory, 'certificate.pem'), '-out', archive, '-passout', `file:${passwordPath}`])
  try {
    await run('/usr/bin/security', ['import', archive, '-k', join(home, 'Library', 'Keychains', 'login.keychain-db'), '-f', 'pkcs12', '-P', password, '-T', '/usr/bin/codesign'])
  } catch (error) {
    const detail = String(error.stderr || error.message).replaceAll(password, '[redacted]')
    throw new Error(`Local identity import failed: ${detail.trim()} Pending setup is retained; rerun --setup to resume the same identity.`)
  }
  if (!await importedIdentity(selected.identity, run)) throw new Error('Import did not confirm the exact private Keychain identity. Pending setup is retained; rerun --setup to resume this identity.')
  await rm(pending, { recursive: true, force: true })
  return selected
}

/** macOS asks the person to authenticate; trust is limited to this certificate's codeSign policy. */
export async function trustLocalSigningIdentity({ home = homedir(), run = runNative } = {}) {
  const identity = await readLocalSigningIdentity({ home })
  if (!identity) throw new Error('Run macos-local-signing.mjs --setup first. No identity was created or trusted.')
  await run('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', join(localSigningDirectory(home), 'certificate.pem')])
  return identity
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.platform !== 'darwin') throw new Error('Local macOS signing setup requires macOS.')
  const mode = process.argv[2]
  if (!['--setup', '--trust'].includes(mode) || process.argv.length !== 3) throw new Error('Use --setup once, then --trust to review the macOS authentication request.')
  const identity = mode === '--setup' ? await setupLocalSigningIdentity() : await trustLocalSigningIdentity()
  console.log(`Local signing certificate SHA1=${identity.identity}. ${mode === '--setup' ? 'The exact private identity was confirmed in your login Keychain and pending private files were removed. Run this command with --trust to authenticate code-signing-only trust; existing identities are never regenerated.' : 'Code-signing trust request completed; packaging will independently validate the identity. Pending setup, if any, must finish with --setup.'}`)
}
