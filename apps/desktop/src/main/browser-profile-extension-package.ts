import { createHash, createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto'
import { createReadStream, appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { cp, lstat, mkdir, open, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join } from 'node:path'
import { Unzip, UnzipInflate } from 'fflate'
import type { BrowserProfileExtensionPermissions, BrowserProfileExtensionSource } from '@agentmux/core/control'

/** Owned immutable bytes; none of the extension's code runs while preparing its review. */
export type PreparedExtensionPackage = { directory: string; sha256: string; key: string; name: string; version: string;
  permissions: BrowserProfileExtensionPermissions; source: BrowserProfileExtensionSource }
export class BrowserProfileExtensionPackageError extends Error {}
const invalid = (message: string): never => { throw new BrowserProfileExtensionPackageError(message) }
async function hashFile(path: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex') }
export async function hashExtensionDirectory(root: string): Promise<string> {
  const hash = createHash('sha256')
  const visit = async (path: string, prefix: string): Promise<void> => {
    const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))
    for (const entry of entries) {
      const relative = prefix + entry.name, full = join(path, entry.name), stat = await lstat(full)
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) invalid('Extension packages must contain ordinary files and directories, without symbolic links.')
      if (stat.isDirectory()) { hash.update(`directory:${relative}\0`); await visit(full, relative + '/') }
      else { hash.update(`file:${relative}\0${stat.size}\0`); hash.update(await hashFile(full)); hash.update('\0') }
    }
  }
  await visit(root, ''); return hash.digest('hex')
}
const publicUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  try { const url = new URL(value); if (!['http:', 'https:'].includes(url.protocol)) return undefined; url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.href } catch { return undefined }
}
const words = (value: unknown): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || /[\u0000-\u001f\u007f]/.test(item))) return invalid('The extension permission declaration is invalid.')
  return [...new Set(value as string[])].sort()
}
export function extensionPermissions(manifest: Record<string, unknown>): BrowserProfileExtensionPermissions {
  const scripts = manifest.content_scripts
  if (scripts !== undefined && (!Array.isArray(scripts) || scripts.some(script => !script || typeof script !== 'object'))) invalid('The extension content-script declaration is invalid.')
  const contentScripts = (scripts as Record<string, unknown>[] | undefined ?? []).flatMap((script, index) => [
    ...words(script.matches).map(value => `${index + 1}:match:${value}`), ...words(script.exclude_matches).map(value => `${index + 1}:exclude:${value}`),
    ...words(script.include_globs).map(value => `${index + 1}:include-glob:${value}`), ...words(script.exclude_globs).map(value => `${index + 1}:exclude-glob:${value}`),
    `${index + 1}:frames:${script.all_frames === true ? 'all' : 'top'}`, `${index + 1}:about-blank:${script.match_about_blank === true}`, `${index + 1}:origin-fallback:${script.match_origin_as_fallback === true}`])
  return { api: words(manifest.permissions), hosts: words(manifest.host_permissions), contentScripts,
    optional: [...words(manifest.optional_permissions), ...words(manifest.optional_host_permissions)], fileAccess: false }
}
/** Length-delimited CRX protobuf fields. The host parses the package format; Core never does. */
function fields(bytes: Buffer): [number, Buffer][] {
  let offset = 0
  const number = (): number => { let value = 0, scale = 1; for (let i = 0; i < 8; i++) { const next = bytes[offset++]; if (next === undefined) return invalid('The CRX header is incomplete.'); value += (next & 127) * scale; if (next < 128) return value; scale *= 128 } return invalid('The CRX header integer is invalid.') }
  const result: [number, Buffer][] = []
  while (offset < bytes.length) {
    const tag = number(), field = Math.floor(tag / 8), wire = tag % 8
    if (wire === 0) { number(); continue }
    if (wire === 1 || wire === 5) { offset += wire === 1 ? 8 : 4; if (offset > bytes.length) invalid('The CRX header is incomplete.'); continue }
    if (wire !== 2 || field === 0) return invalid('The CRX header format is invalid.')
    const length = number(); if (offset + length > bytes.length) return invalid('The CRX header is incomplete.')
    result.push([field, bytes.subarray(offset, offset + length)]); offset += length
  }
  return result
}
async function archive(path: string): Promise<{ offset: number; key?: string; verified: boolean }> {
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat(), initial = Buffer.alloc(16), { bytesRead } = await handle.read(initial, 0, 16, 0)
    if (bytesRead < 4) return invalid('The extension archive is incomplete.')
    if (initial.readUInt32LE(0) !== 0x34327243) return { offset: 0, verified: false }
    const version = initial.readUInt32LE(4)
    let offset: number, key: Buffer | undefined, signatures: { key: Buffer; signature: Buffer; algorithm: string }[], prefix = Buffer.alloc(0)
    if (version === 2) {
      const keySize = initial.readUInt32LE(8), signatureSize = initial.readUInt32LE(12); offset = 16 + keySize + signatureSize
      if (offset > stat.size || keySize + signatureSize > process.availableMemory() / 4) return invalid('The CRX header is incomplete or too large to inspect with current memory.')
      const header = Buffer.alloc(keySize + signatureSize); await handle.read(header, 0, header.length, 16); key = header.subarray(0, keySize)
      signatures = [{ key, signature: header.subarray(keySize), algorithm: 'sha1' }]
    } else if (version === 3) {
      const size = initial.readUInt32LE(8); offset = 12 + size
      if (offset > stat.size || size > process.availableMemory() / 4) return invalid('The CRX header is incomplete or too large to inspect with current memory.')
      const header = Buffer.alloc(size); await handle.read(header, 0, size, 12); const parsed = fields(header), signed = parsed.find(([tag]) => tag === 10000)?.[1]
      if (!signed) return invalid('The CRX package has no signed identity.')
      const identity = fields(signed).find(([tag]) => tag === 1)?.[1]
      signatures = parsed.filter(([tag]) => tag === 2 || tag === 3).map(([, proof]) => {
        const data = fields(proof), publicKey = data.find(([tag]) => tag === 1)?.[1], signature = data.find(([tag]) => tag === 2)?.[1]
        if (!publicKey || !signature) return invalid('The CRX signature proof is incomplete.')
        if (identity?.length === 16 && createHash('sha256').update(publicKey).digest().subarray(0, 16).equals(identity)) key = publicKey
        return { key: publicKey, signature, algorithm: 'sha256' }
      })
      const length = Buffer.alloc(4); length.writeUInt32LE(signed.length); prefix = Buffer.concat([Buffer.from('CRX3 SignedData\0'), length, signed])
    } else return invalid('This CRX package version is not supported by the host package reader.')
    if (!key || !signatures.length) return invalid('The CRX package is missing its developer identity proof.')
    const verifiers = signatures.map(proof => { const verify = createVerify(proof.algorithm); verify.update(prefix); return verify })
    for await (const chunk of createReadStream(path, { start: offset })) for (const verify of verifiers) verify.update(chunk)
    if (verifiers.some((verify, index) => !verify.verify(createPublicKey({ key: signatures[index]!.key, format: 'der', type: 'spki' }), signatures[index]!.signature))) return invalid('The CRX signature does not match the package. No extension was loaded.')
    return { offset, key: key.toString('base64'), verified: true }
  } finally { await handle.close() }
}
async function extract(path: string, destination: string, offset: number): Promise<void> {
  const seen = new Set<string>(); let failure: unknown, openFiles = 0
  const unzip = new Unzip(file => {
    const name = file.name, parts = name.split('/').filter(Boolean), canonical = name.normalize('NFC').toLowerCase()
    if (!parts.length || isAbsolute(name) || name.includes('\\') || name.includes('\0') || /^[a-z]:/i.test(name) || parts.some(part => part === '.' || part === '..') || seen.has(canonical)) {
      failure = new BrowserProfileExtensionPackageError('The extension archive has an unsafe or repeated file name. Nothing was installed.'); return
    }
    seen.add(canonical); const target = join(destination, ...parts)
    if (name.endsWith('/')) { mkdirSync(target, { recursive: true }); file.ondata = () => {}; file.start(); return }
    mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, Buffer.alloc(0), { flag: 'wx' }); openFiles++
    file.ondata = (error, data, final) => { if (error) { failure = error; return } if (!failure) appendFileSync(target, data); if (final) openFiles-- }
    file.start()
  })
  unzip.register(UnzipInflate)
  for await (const chunk of createReadStream(path, { start: offset })) { if (failure) throw failure; unzip.push(new Uint8Array(chunk as Buffer)) }
  unzip.push(new Uint8Array(), true)
  if (failure) throw failure
  if (openFiles || !seen.size) invalid('The extension archive is incomplete or empty.')
}
export async function prepareExtensionPackage(sourcePath: string, staging: string, previousKey?: string): Promise<PreparedExtensionPackage> {
  await mkdir(staging, { recursive: false })
  const stats = await lstat(sourcePath); if (stats.isSymbolicLink()) invalid('Choose an ordinary extension directory or package, without a symbolic link.')
  let source: BrowserProfileExtensionSource = { kind: 'directory', label: basename(sourcePath), signature: 'not-verified' }, packagedKey: string | undefined
  try {
    if (stats.isDirectory()) { await hashExtensionDirectory(sourcePath); await cp(sourcePath, staging, { recursive: true, force: false, errorOnExist: false, dereference: false }) }
    else if (stats.isFile()) {
      const info = await archive(sourcePath); source = { ...source, kind: info.offset ? 'crx' : 'zip', signature: info.verified ? 'package-verified' : 'not-verified' }; packagedKey = info.key
      await extract(sourcePath, staging, info.offset)
    } else invalid('Choose an ordinary extension directory, ZIP or CRX package.')
    let directory = staging
    try { await lstat(join(directory, 'manifest.json')) } catch {
      const children = await readdir(staging, { withFileTypes: true }), folders = children.filter(entry => entry.isDirectory())
      if (folders.length !== 1) invalid('Choose the unpacked extension root containing manifest.json, or a package with one extension root.')
      directory = join(staging, folders[0]!.name)
    }
    const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')) as Record<string, unknown>
    if (typeof manifest.name !== 'string' || !manifest.name || typeof manifest.version !== 'string' || !manifest.version || ![2, 3].includes(manifest.manifest_version as number)) invalid('The extension manifest needs a name, version and supported manifest version.')
    if (manifest.key !== undefined && typeof manifest.key !== 'string') invalid('The extension manifest identity key is invalid.')
    const canonicalKey = (value: string): string => createPublicKey({ key: Buffer.from(value, 'base64'), format: 'der', type: 'spki' }).export({ type: 'spki', format: 'der' }).toString('base64')
    const manifestKey = typeof manifest.key === 'string' ? canonicalKey(manifest.key) : undefined
    const suppliedKey = manifestKey ?? packagedKey
    if (previousKey && suppliedKey && suppliedKey !== previousKey) invalid('This package has a different extension identity. Keep the original extension and install the new identity separately.')
    if (packagedKey && manifestKey && packagedKey !== manifestKey) invalid('The manifest and signed CRX developer identities disagree.')
    const key = suppliedKey ?? previousKey ?? generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
    createPublicKey({ key: Buffer.from(key, 'base64'), format: 'der', type: 'spki' })
    manifest.key = key; await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    const homepage = publicUrl(manifest.homepage_url), updateUrl = publicUrl(manifest.update_url)
    source = { ...source, ...(homepage ? { homepage } : {}), ...(updateUrl ? { updateUrl } : {}) }
    let name = manifest.name as string
    const localized = /^__MSG_([A-Za-z0-9_]+)__$/.exec(name)
    if (localized && typeof manifest.default_locale === 'string' && /^[A-Za-z0-9_-]+$/.test(manifest.default_locale)) {
      try { const messages = JSON.parse(await readFile(join(directory, '_locales', manifest.default_locale, 'messages.json'), 'utf8')); const message = messages[localized[1]!]?.message; if (typeof message === 'string' && message) name = message } catch { /* Native loading still owns manifest locale support. */ }
    }
    const permissions = extensionPermissions(manifest), sha256 = await hashExtensionDirectory(directory)
    return { directory, sha256, key, name, version: manifest.version as string, permissions, source }
  } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
}
