import { createHash } from 'node:crypto'
import { request } from 'node:https'
import { getHeapStatistics } from 'node:v8'
import { open, readFile, rm, statfs } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { DOMParser } from '@xmldom/xmldom'
import { parseBrowserProfileExtensionInputSource, type BrowserProfileExtensionInputSource } from '@agentmux/core/control'
import { BrowserProfileExtensionPackageError, prepareExtensionPackage, type PreparedExtensionPackage } from './browser-profile-extension-package.js'

type OnlineSource = Exclude<BrowserProfileExtensionInputSource, { kind: 'local' }>
type Candidate = { url: string; version: string; format: 'chromium-xml' | 'webextensions-json'; hash?: { algorithm: 'sha256' | 'sha512'; value: string } }
const invalid = (message: string): never => { throw new BrowserProfileExtensionPackageError(message) }
const address = (value: string, base?: string): string => {
  let url: URL
  try { url = new URL(value, base) } catch { return invalid('The extension source contains an invalid package address.') }
  const parsed = parseBrowserProfileExtensionInputSource({ kind: 'package-url', url: url.href })
  return parsed.kind === 'local' ? invalid('The package address must be HTTPS.') : parsed.url
}
/** Chrome's host-supported numeric version subset, not a replacement WebExtensions version format. */
function version(value: unknown): number[] {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(value)) return invalid('This host requires a numeric extension version with one to four components.')
  const parts = value.split('.').map(Number)
  if (parts.some(part => part > 65535) || parts.every(part => part === 0)) return invalid('The extension candidate version is outside the host-supported version range.')
  return [...parts, ...Array(4 - parts.length).fill(0)]
}
function latest(candidates: Candidate[]): Candidate {
  if (!candidates.length) return invalid('The update manifest has no package for the exact add-on ID.')
  const compared = candidates.map(candidate => ({ candidate, parts: version(candidate.version) })).sort((a, b) => {
    for (let i = 0; i < 4; i++) if (a.parts[i] !== b.parts[i]) return b.parts[i]! - a.parts[i]!
    return 0
  })
  if (compared.length > 1 && compared[0]!.parts.every((part, i) => part === compared[1]!.parts[i])) return invalid('The update manifest has ambiguous packages for the same version.')
  return compared[0]!.candidate
}
/** Parse existing Chromium XML and WebExtensions JSON formats. Neither document grants consent. */
export function extensionManifestCandidate(bytes: Buffer, base: string, addonId: string): Candidate {
  const text = bytes.toString('utf8').trim()
  if (text.startsWith('<')) {
    try {
      const document = new DOMParser({ onError: () => { throw Error('Invalid XML') } }).parseFromString(text, 'text/xml')
      const root = document.documentElement, namespace = 'http://www.google.com/update2/response'
      if (document.doctype || root?.localName !== 'gupdate' || root.namespaceURI !== namespace || root.getAttribute('protocol') !== '2.0') throw Error('Unsupported XML')
      const apps = Array.from(root.getElementsByTagNameNS(namespace, 'app')).filter(app => app.parentNode === root && app.getAttribute('appid') === addonId)
      if (apps.length !== 1) throw Error('Unconfirmed identity')
      const checks = Array.from(apps[0]!.getElementsByTagNameNS(namespace, 'updatecheck')).filter(check => check.parentNode === apps[0])
      if (checks.length !== 1 || !checks[0]!.getAttribute('codebase') || !checks[0]!.getAttribute('version')) throw Error('No candidate')
      return latest([{ url: address(checks[0]!.getAttribute('codebase')!, base), version: checks[0]!.getAttribute('version')!, format: 'chromium-xml' }])
    } catch { return invalid('The Chromium update manifest does not provide one valid package for the exact add-on ID.') }
  }
  let parsed: any
  try { parsed = JSON.parse(text) } catch { return invalid('The WebExtensions update manifest is invalid JSON.') }
  if (!parsed || typeof parsed !== 'object' || !parsed.addons || !Object.hasOwn(parsed.addons, addonId) || !Array.isArray(parsed.addons[addonId]?.updates)) return invalid('The WebExtensions update manifest has no exact add-on ID and update list.')
  return latest(parsed.addons[addonId].updates.map((entry: any): Candidate => {
    if (!entry || typeof entry.update_link !== 'string' || typeof entry.version !== 'string') return invalid('The update manifest candidate needs a package address and version.')
    let hash: Candidate['hash']
    if (entry.update_hash !== undefined) {
      const match = typeof entry.update_hash === 'string' ? /^(sha256|sha512):([a-fA-F0-9]+)$/.exec(entry.update_hash) : null
      if (!match || match[2]!.length !== (match[1] === 'sha256' ? 64 : 128)) return invalid('The update manifest package hash is unsupported or malformed.')
      hash = { algorithm: match[1] as 'sha256' | 'sha512', value: match[2]!.toLowerCase() }
    }
    return { url: address(entry.update_link, base), version: entry.version, format: 'webextensions-json', ...(hash ? { hash } : {}) }
  }))
}
/** Node HTTPS has no Chromium Session or cookie jar. Ignore Set-Cookie and never copy site headers. */
async function response(url: string, visited = new Set<string>()): Promise<{ body: import('node:http').IncomingMessage; url: string }> {
  url = address(url)
  // The standard Fetch redirect budget bounds one acquisition; a loop is not a new operation.
  if (visited.has(url) || visited.size >= 20) return invalid('The extension source has a redirect loop or too many redirects.')
  visited.add(url)
  const body = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
    const pending = request(url, { method: 'GET', headers: { accept: '*/*', 'accept-encoding': 'identity' } }, resolve)
    // An idle socket ends only this read, not a growing download or any Profile/Browser.
    pending.setTimeout(30_000, () => pending.destroy(Error('Extension source stopped responding')))
    pending.once('error', () => reject(new BrowserProfileExtensionPackageError('The HTTPS extension source could not be acquired. Original packages and pages remain.')))
    pending.end()
  })
  if ([301, 302, 303, 307, 308].includes(body.statusCode ?? 0)) {
    const location = body.headers.location; body.destroy()
    if (!location) return invalid('The extension source redirect has no package address.')
    return response(address(location, url), visited)
  }
  if (body.statusCode !== 200) { body.destroy(); return invalid(`The extension source returned HTTP ${body.statusCode ?? 'unknown'}. Nothing was installed.`) }
  return { body, url }
}
async function manifest(url: string): Promise<{ bytes: Buffer; url: string }> {
  const result = await response(url), chunks: Buffer[] = []
  // XML/JSON trees amplify source bytes in memory. Reserve room for the parser and the healthy App.
  const available = process.availableMemory(), heap = getHeapStatistics()
  const budget = Math.max(1, Math.floor(Math.min(available > 0 ? available : Infinity, heap.heap_size_limit - heap.used_heap_size) / 16)); let size = 0
  try {
    if (Number(result.body.headers['content-length']) > budget) return invalid('The update manifest exceeds this process’s available parsing memory. No package was installed.')
    for await (const chunk of result.body) {
      size += chunk.length
      if (size > budget) return invalid('The update manifest exceeds this process’s available parsing memory. No package was installed.')
      chunks.push(Buffer.from(chunk))
    }
    return { bytes: Buffer.concat(chunks), url: result.url }
  } finally { result.body.destroy() }
}
async function download(url: string, path: string): Promise<{ sha256: string; sha512: string; url: string }> {
  const result = await response(url); let file: Awaited<ReturnType<typeof open>> | undefined
  const sha256 = createHash('sha256'), sha512 = createHash('sha512')
  try {
    file = await open(path, 'wx', 0o600)
    const disk = await statfs(dirname(path)), declared = Number(result.body.headers['content-length'])
    if (Number.isFinite(declared) && declared > disk.bavail * disk.bsize) return invalid('The package exceeds the available staging disk space. Original extensions remain.')
    // Stream the package to owned disk; package size does not become one in-memory buffer.
    for await (const chunk of result.body) { await file.writeFile(chunk); sha256.update(chunk); sha512.update(chunk) }
    return { sha256: sha256.digest('hex'), sha512: sha512.digest('hex'), url: result.url }
  } finally { result.body.destroy(); await file?.close() }
}
export async function prepareOnlineExtension(source: OnlineSource, staging: string, previousKey?: string): Promise<PreparedExtensionPackage> {
  source = parseBrowserProfileExtensionInputSource(source) as OnlineSource
  const snapshot = staging + '.download'; let candidate: Candidate | undefined, manifestSha256: string | undefined
  try {
    if (source.kind === 'update-manifest') {
      const read = await manifest(source.url); manifestSha256 = createHash('sha256').update(read.bytes).digest('hex')
      candidate = extensionManifestCandidate(read.bytes, read.url, source.addonId)
    }
    const acquired = await download(candidate?.url ?? source.url, snapshot)
    if (candidate?.hash && acquired[candidate.hash.algorithm] !== candidate.hash.value) return invalid('The downloaded package does not match the update manifest hash. Nothing was installed.')
    const pkg = await prepareExtensionPackage(snapshot, staging, previousKey)
    try {
      if (candidate) {
        if (pkg.version !== candidate.version) return invalid('The package version differs from the exact update manifest candidate. Nothing was installed.')
        const nativeId = createHash('sha256').update(Buffer.from(pkg.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)))
        const definition = JSON.parse(await readFile(join(pkg.directory, 'manifest.json'), 'utf8'))
        const declaredId = definition.browser_specific_settings?.gecko?.id ?? definition.applications?.gecko?.id
        const expected = candidate.format === 'chromium-xml' ? nativeId : declaredId ?? nativeId
        if (source.kind !== 'update-manifest' || source.addonId !== expected || candidate.format === 'chromium-xml' && pkg.source.signature !== 'package-verified') return invalid('The downloaded package identity does not match the manifest add-on. Original extensions remain.')
      }
      pkg.source = { ...pkg.source, retrieval: { kind: source.kind, origin: new URL(acquired.url).origin, packageSha256: acquired.sha256,
        ...(manifestSha256 ? { manifestSha256 } : {}), ...(candidate ? { format: candidate.format } : {}) } }
      return pkg
    } catch (error) { await rm(staging, { recursive: true, force: true }); throw error }
  } finally { await rm(snapshot, { force: true }) }
}
