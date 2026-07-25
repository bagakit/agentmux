/*
 * Portions adapted from Orca's browser cookie import implementation:
 * https://github.com/stablyai/orca/tree/4fd93ead1999dc34e13ac5915693ad8467a39a6e
 *
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { execFileSync } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import {
  closeSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync
} from 'node:fs'
import { isIP } from 'node:net'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { domainToASCII } from 'node:url'
import { app } from 'electron'
import { getDomain, parse as parseDomain } from 'tldts'

const SNAPSHOT_ATTEMPTS = 5
const LOCAL_STATE_MAX_BYTES = 4 * 1024 * 1024
const SOURCE_DATABASE_MAX_BYTES = 512 * 1024 * 1024
const DEFAULT_MAX_COOKIE_COUNT = 50_000
const DEFAULT_MAX_COOKIE_BYTES = 64 * 1024
const DEFAULT_MAX_PLAN_BYTES = 32 * 1024 * 1024
const PBKDF2_KEY_LENGTH = 16
const PBKDF2_SALT = 'saltysalt'
const MAC_PBKDF2_ITERATIONS = 1003
const CHROMIUM_EPOCH_OFFSET = 11_644_473_600n
const CHROMIUM_COOKIE_HMAC_LENGTH = 32

const REQUIRED_COOKIE_COLUMNS = [
  'host_key',
  'name',
  'value',
  'encrypted_value',
  'path',
  'expires_utc',
  'is_secure',
  'is_httponly',
  'samesite'
] as const
const PARTITION_SITE_COLUMN = 'top_frame_site_key'
const PARTITION_ANCESTOR_COLUMN = 'has_cross_site_ancestor'

const SKIP_REASONS = [
  'expired',
  'invalid-cookie',
  'app-bound-encryption',
  'undecryptable',
  'non-transplantable',
  'partition-unreadable',
  'partition-family-unreadable'
] as const

export type BrowserProfileCookieSkipReason = (typeof SKIP_REASONS)[number]

export type BrowserProfileImportSource = {
  kind: 'chromium'
  browserId: ChromiumBrowserId
  browserLabel: string
  profileDirectory: string
  profileLabel: string
  browserRoot: string
  cookiesPath: string
  fileIdentity: {
    device: string
    inode: string
  }
}

export type PlannedCdpCookieIdentity = {
  url: string
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  sameSite?: 'Strict' | 'Lax' | 'None'
  expires?: number
  partitionKey?: {
    topLevelSite: string
    hasCrossSiteAncestor: boolean
  }
}

export type BrowserProfileImportPlan = {
  browserLabel: string
  profileLabel: string
  cookies: PlannedCdpCookieIdentity[]
  totalCookies: number
  importedCookies: number
  skippedCookies: number
  plannedBytes: number
  skippedByReason: Record<BrowserProfileCookieSkipReason, number>
}

export type BrowserProfileImportPlanOptions = {
  now?: number
  tempRoot?: string
  limits?: {
    maxCookies?: number
    maxCookieBytes?: number
    maxPlanBytes?: number
  }
}

type ChromiumBrowserDefinition = {
  id: 'chrome' | 'edge' | 'arc' | 'brave' | 'comet' | 'helium'
  label: string
  macRoot: string
  keychainService: string
  keychainAccount: string
}

type ChromiumBrowserId = ChromiumBrowserDefinition['id']

const DARWIN_CHROMIUM_BROWSERS: readonly ChromiumBrowserDefinition[] = [
  {
    id: 'chrome',
    label: 'Google Chrome',
    macRoot: 'Google/Chrome',
    keychainService: 'Chrome Safe Storage',
    keychainAccount: 'Chrome'
  },
  {
    id: 'edge',
    label: 'Microsoft Edge',
    macRoot: 'Microsoft Edge',
    keychainService: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge'
  },
  {
    id: 'arc',
    label: 'Arc',
    macRoot: 'Arc/User Data',
    keychainService: 'Arc Safe Storage',
    keychainAccount: 'Arc'
  },
  {
    id: 'brave',
    label: 'Brave',
    macRoot: 'BraveSoftware/Brave-Browser',
    keychainService: 'Brave Safe Storage',
    keychainAccount: 'Brave'
  },
  {
    id: 'comet',
    label: 'Comet',
    macRoot: 'Comet',
    keychainService: 'Comet Safe Storage',
    keychainAccount: 'Comet'
  },
  {
    id: 'helium',
    label: 'Helium',
    macRoot: 'net.imput.helium',
    keychainService: 'Helium Storage Key',
    keychainAccount: 'Helium'
  }
]

type FileState = {
  device: bigint
  inode: bigint
  size: bigint
  modifiedAt: bigint
  changedAt: bigint
}

type SourcePartitionRead =
  | { status: 'unpartitioned' }
  | {
      status: 'partitioned'
      partitionKey: { topLevelSite: string; hasCrossSiteAncestor: boolean }
    }
  | { status: 'unreadable'; reason: string }

type Aes128KeySet = {
  v10?: Buffer
  v11?: Buffer
}

type ResolvedPlanLimits = {
  maxCookies: number
  maxCookieBytes: number
  maxPlanBytes: number
}

function isMissingFileError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT'
}

function readFileState(path: string): FileState | null {
  try {
    const stats = statSync(path, { bigint: true })
    return {
      device: stats.dev,
      inode: stats.ino,
      size: stats.size,
      modifiedAt: stats.mtimeNs,
      changedAt: stats.ctimeNs
    }
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw error
  }
}

function sameFileState(left: FileState | null, right: FileState | null): boolean {
  if (!left || !right) return left === right
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAt === right.modifiedAt &&
    left.changedAt === right.changedAt
  )
}

function isSafeProfileDirectory(directory: string): boolean {
  return (
    directory.length > 0 &&
    directory !== '.' &&
    !directory.includes('\0') &&
    !directory.includes('/') &&
    !directory.includes('\\') &&
    !directory.includes('..')
  )
}

function safeDisplayLabel(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const label = raw.trim()
  return label.length > 0 && label.length <= 128 ? label : null
}

function isPathInside(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate)
  return fromRoot === '' || (!fromRoot.startsWith('..') && !isAbsolute(fromRoot))
}

function isSqliteDatabase(path: string): boolean {
  let descriptor: number | null = null
  try {
    const stats = lstatSync(path)
    if (!stats.isFile() || stats.size < 16 || stats.size > SOURCE_DATABASE_MAX_BYTES) return false
    descriptor = openSync(path, 'r')
    const header = Buffer.alloc(16)
    return readSync(descriptor, header, 0, header.length, 0) === header.length &&
      header.equals(Buffer.from('SQLite format 3\0'))
  } catch {
    return false
  } finally {
    if (descriptor !== null) closeSync(descriptor)
  }
}

function profileDirectories(browserRoot: string): Array<{ directory: string; label: string }> {
  const localStatePath = join(browserRoot, 'Local State')
  try {
    const stats = lstatSync(localStatePath)
    if (!stats.isFile() || stats.size > LOCAL_STATE_MAX_BYTES) return []
    const parsed = JSON.parse(readFileSync(localStatePath, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return []
    const profile = (parsed as Record<string, unknown>).profile
    if (!profile || typeof profile !== 'object' || Array.isArray(profile)) return []
    const infoCache = (profile as Record<string, unknown>).info_cache
    if (!infoCache || typeof infoCache !== 'object' || Array.isArray(infoCache)) return []

    const discovered: Array<{ directory: string; label: string }> = []
    for (const [directory, info] of Object.entries(infoCache)) {
      if (!isSafeProfileDirectory(directory)) continue
      const label = info && typeof info === 'object' && !Array.isArray(info)
        ? safeDisplayLabel((info as Record<string, unknown>).name)
        : null
      if (!label) continue
      discovered.push({ directory, label })
    }
    return discovered
  } catch {
    return []
  }
}

function resolveCookiesPath(browserRoot: string, profileDirectory: string): string | null {
  if (!isSafeProfileDirectory(profileDirectory)) return null
  let canonicalRoot: string
  try {
    canonicalRoot = realpathSync(browserRoot)
  } catch {
    return null
  }
  for (const relativePath of [
    join(profileDirectory, 'Network', 'Cookies'),
    join(profileDirectory, 'Cookies')
  ]) {
    const candidate = join(browserRoot, relativePath)
    if (!existsSync(candidate)) continue
    try {
      const canonicalCandidate = realpathSync(candidate)
      if (!isPathInside(canonicalRoot, canonicalCandidate) || !isSqliteDatabase(candidate)) continue
      return canonicalCandidate
    } catch {
      continue
    }
  }
  return null
}

export function detectBrowserProfileImportSources(): BrowserProfileImportSource[] {
  // Only the Darwin Chromium roots below are verified. Other platforms expose no capability until
  // their source roots and encryption contracts receive equivalent production proof.
  if (process.platform !== 'darwin') return []
  const homePath = app.getPath('home')
  if (!homePath) return []

  const detected: BrowserProfileImportSource[] = []
  for (const browser of DARWIN_CHROMIUM_BROWSERS) {
    const configuredRoot = join(homePath, 'Library', 'Application Support', browser.macRoot)
    let browserRoot: string
    try {
      browserRoot = realpathSync(configuredRoot)
    } catch {
      continue
    }
    for (const profile of profileDirectories(browserRoot)) {
      const cookiesPath = resolveCookiesPath(browserRoot, profile.directory)
      if (!cookiesPath) continue
      const state = readFileState(cookiesPath)
      if (!state) continue
      detected.push({
        kind: 'chromium',
        browserId: browser.id,
        browserLabel: browser.label,
        profileDirectory: profile.directory,
        profileLabel: profile.label,
        browserRoot,
        cookiesPath,
        fileIdentity: { device: state.device.toString(), inode: state.inode.toString() }
      })
    }
  }
  return detected
}

function assertCurrentSource(source: BrowserProfileImportSource): ChromiumBrowserDefinition {
  const browser = DARWIN_CHROMIUM_BROWSERS.find((candidate) => candidate.id === source.browserId)
  if (!browser || source.kind !== 'chromium') throw new Error('Unknown Chromium Profile source')
  const current = detectBrowserProfileImportSources().find((candidate) => (
    candidate.browserId === source.browserId &&
    candidate.profileDirectory === source.profileDirectory &&
    candidate.cookiesPath === source.cookiesPath
  ))
  if (
    !current ||
    current.browserRoot !== source.browserRoot ||
    current.browserLabel !== source.browserLabel ||
    current.profileLabel !== source.profileLabel ||
    current.fileIdentity.device !== source.fileIdentity.device ||
    current.fileIdentity.inode !== source.fileIdentity.inode
  ) {
    throw new Error('Chromium Profile source changed after detection')
  }
  return browser
}

function removeAttemptFiles(databasePath: string): void {
  for (const suffix of ['', '-wal', '-shm'] as const) {
    try {
      unlinkSync(databasePath + suffix)
    } catch {
      // Best-effort between bounded attempts; the enclosing temp directory is always removed.
    }
  }
}

function copyStableSnapshotAttempt(
  sourcePath: string,
  databasePath: string,
  expectedIdentity: BrowserProfileImportSource['fileIdentity']
): boolean {
  const sourceWalPath = `${sourcePath}-wal`
  const databaseBefore = readFileState(sourcePath)
  const walBefore = readFileState(sourceWalPath)
  if (!databaseBefore) throw new Error('Chromium cookies database does not exist')
  if (
    databaseBefore.device.toString() !== expectedIdentity.device ||
    databaseBefore.inode.toString() !== expectedIdentity.inode
  ) {
    throw new Error('Chromium Profile source changed after detection')
  }
  if (databaseBefore.size + (walBefore?.size ?? 0n) > BigInt(SOURCE_DATABASE_MAX_BYTES)) {
    throw new Error('Chromium cookies database exceeds the import size limit')
  }

  removeAttemptFiles(databasePath)
  copyFileSync(sourcePath, databasePath)
  if (walBefore) {
    try {
      copyFileSync(sourceWalPath, `${databasePath}-wal`)
    } catch (error) {
      if (isMissingFileError(error)) return false
      throw error
    }
  }

  const databaseAfter = readFileState(sourcePath)
  const walAfter = readFileState(sourceWalPath)
  if (!sameFileState(databaseBefore, databaseAfter) || !sameFileState(walBefore, walAfter)) {
    return false
  }
  const copiedDatabase = readFileState(databasePath)
  const copiedWal = readFileState(`${databasePath}-wal`)
  return copiedDatabase?.size === databaseBefore.size &&
    (walBefore ? copiedWal?.size === walBefore.size : copiedWal === null)
}

function createStableSnapshot(
  sourcePath: string,
  expectedIdentity: BrowserProfileImportSource['fileIdentity'],
  tempRoot?: string
): {
  databasePath: string
  cleanup: () => void
} {
  const snapshotDirectory = mkdtempSync(join(tempRoot ?? tmpdir(), 'agentmux-browser-import-'))
  const databasePath = join(snapshotDirectory, 'Cookies')
  let keepSnapshot = false
  try {
    for (let attempt = 0; attempt < SNAPSHOT_ATTEMPTS; attempt += 1) {
      if (copyStableSnapshotAttempt(sourcePath, databasePath, expectedIdentity)) {
        keepSnapshot = true
        return {
          databasePath,
          cleanup: () => rmSync(snapshotDirectory, { recursive: true, force: true })
        }
      }
    }
    throw new Error('Chromium cookies database changed while creating a stable snapshot')
  } finally {
    if (!keepSnapshot) rmSync(snapshotDirectory, { recursive: true, force: true })
  }
}

function readIntegerFlag(raw: unknown): boolean | null {
  if (raw === 0 || raw === 0n) return false
  if (raw === 1 || raw === 1n) return true
  return null
}

function normalizePartitionSite(raw: string): string | null {
  try {
    const site = new URL(raw)
    if (
      (site.protocol !== 'http:' && site.protocol !== 'https:') ||
      !site.hostname ||
      site.username ||
      site.password ||
      site.port ||
      site.pathname !== '/' ||
      site.search ||
      site.hash
    ) {
      return null
    }
    return site.origin
  } catch {
    return null
  }
}

function readPartition(
  row: Record<string, unknown>,
  columns: ReadonlySet<string>
): SourcePartitionRead {
  if (!columns.has(PARTITION_SITE_COLUMN)) return { status: 'unpartitioned' }
  const rawSite = row[PARTITION_SITE_COLUMN]
  if (rawSite === '') return { status: 'unpartitioned' }
  if (typeof rawSite !== 'string') {
    return { status: 'unreadable', reason: 'partition site was not text' }
  }
  const topLevelSite = normalizePartitionSite(rawSite)
  if (!topLevelSite) {
    return { status: 'unreadable', reason: 'partition site was not a valid schemeful site' }
  }
  if (!columns.has(PARTITION_ANCESTOR_COLUMN)) {
    return { status: 'unreadable', reason: 'partition ancestor column was missing' }
  }
  const hasCrossSiteAncestor = readIntegerFlag(row[PARTITION_ANCESTOR_COLUMN])
  if (hasCrossSiteAncestor === null) {
    return { status: 'unreadable', reason: 'partition ancestor was not an integer flag' }
  }
  return { status: 'partitioned', partitionKey: { topLevelSite, hasCrossSiteAncestor } }
}

function normalizeCookieDomain(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const candidate = raw.trim().replace(/^\.+/, '')
  if (!candidate || /[/\\@?#%\s]/.test(candidate) || candidate.endsWith('.')) return null
  const ipVersion = isIP(candidate)
  const ascii = ipVersion === 6 ? candidate.toLowerCase() : domainToASCII(candidate).toLowerCase()
  if (!ascii || ascii.includes('..')) return null
  if (isIP(ascii) > 0 || ascii === 'localhost') return ascii
  const labels = ascii.split('.')
  if (labels.length < 2 || labels.some((label) => !label || label.length > 63 || !/^[a-z0-9-]+$/.test(label))) {
    return null
  }
  return ascii
}

function registrableCookieFamily(rawDomain: unknown): string | null {
  const domain = normalizeCookieDomain(rawDomain)
  if (!domain || isIP(domain) > 0 || domain === 'localhost') return domain
  const options = { allowPrivateDomains: true }
  const registrable = getDomain(domain, options)
  if (registrable) return registrable
  const parsed = parseDomain(domain, options)
  return parsed.isIcann || parsed.isPrivate ? null : domain
}

function isNonTransplantableDomain(rawDomain: unknown): boolean {
  const domain = normalizeCookieDomain(rawDomain)
  return domain === 'google.com' || domain?.endsWith('.google.com') === true
}

function chromiumTimestampToUnix(raw: unknown): number | null {
  if (raw === 0 || raw === 0n || raw === '0') return 0
  if (typeof raw !== 'bigint' && typeof raw !== 'number' && typeof raw !== 'string') return null
  try {
    const timestamp = typeof raw === 'bigint' ? raw : BigInt(raw)
    if (timestamp < 0n) return null
    const unix = timestamp / 1_000_000n - CHROMIUM_EPOCH_OFFSET
    if (unix <= 0n || unix > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(unix)
  } catch {
    return null
  }
}

function chromiumSameSite(raw: unknown): 'Strict' | 'Lax' | 'None' | null | false {
  const value = typeof raw === 'bigint' ? Number(raw) : raw
  if (value === 0) return null
  if (value === 1) return 'None'
  if (value === 2) return 'Lax'
  if (value === 3) return 'Strict'
  return false
}

function hasHmacPrefix(value: Buffer): boolean {
  if (value.length <= CHROMIUM_COOKIE_HMAC_LENGTH) return false
  let nonPrintable = 0
  for (let index = 0; index < CHROMIUM_COOKIE_HMAC_LENGTH; index += 1) {
    const byte = value[index]!
    if (byte < 0x20 || byte > 0x7e) nonPrintable += 1
  }
  return nonPrintable >= 8
}

function decryptAes128Cookie(encrypted: Buffer, keys: Aes128KeySet | null): Buffer | null {
  if (encrypted.length < 4 || !keys) return null
  const version = encrypted.subarray(0, 3).toString('ascii')
  const key = version === 'v10' || version === 'v11' ? keys[version] : undefined
  if (!key) return null
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    const decrypted = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()])
    return hasHmacPrefix(decrypted) ? decrypted.subarray(CHROMIUM_COOKIE_HMAC_LENGTH) : decrypted
  } catch {
    return null
  }
}

function resolveAes128Keys(browser: ChromiumBrowserDefinition): Aes128KeySet | null {
  if (process.platform !== 'darwin') return null
  try {
    const password = execFileSync(
      'security',
      ['find-generic-password', '-s', browser.keychainService, '-a', browser.keychainAccount, '-w'],
      { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
    if (!password) return null
    return {
      v10: pbkdf2Sync(password, PBKDF2_SALT, MAC_PBKDF2_ITERATIONS, PBKDF2_KEY_LENGTH, 'sha1')
    }
  } catch {
    return null
  }
}

function printableAscii(value: Buffer): boolean {
  for (const byte of value) {
    if (byte < 0x20 || byte > 0x7e) return false
  }
  return true
}

function cookieNameIsValid(value: unknown): value is string {
  return typeof value === 'string' && /^[!#$%&'*+\-.^_`|~\dA-Za-z]+$/.test(value)
}

function cookiePathIsValid(value: unknown): value is string {
  if (typeof value !== 'string' || !value.startsWith('/')) return false
  return printableAscii(Buffer.from(value, 'utf8'))
}

function buildCookieIdentity(
  row: Record<string, unknown>,
  partition: Exclude<SourcePartitionRead, { status: 'unreadable' }>,
  value: Buffer,
  nowSeconds: number
): { status: 'write'; identity: PlannedCdpCookieIdentity } | { status: 'skip'; reason: BrowserProfileCookieSkipReason } {
  const domain = normalizeCookieDomain(row.host_key)
  if (
    !domain ||
    registrableCookieFamily(domain) === null ||
    !cookieNameIsValid(row.name) ||
    !cookiePathIsValid(row.path)
  ) {
    return { status: 'skip', reason: 'invalid-cookie' }
  }
  const secure = readIntegerFlag(row.is_secure)
  const httpOnly = readIntegerFlag(row.is_httponly)
  const sameSite = chromiumSameSite(row.samesite)
  const expires = chromiumTimestampToUnix(row.expires_utc)
  if (secure === null || httpOnly === null || sameSite === false || expires === null) {
    return { status: 'skip', reason: 'invalid-cookie' }
  }
  if (expires > 0 && expires <= nowSeconds) return { status: 'skip', reason: 'expired' }
  if (!printableAscii(value)) return { status: 'skip', reason: 'invalid-cookie' }
  const sourceDomain = row.host_key as string
  const isDomainCookie = sourceDomain.startsWith('.')
  const isHostCookie = (row.name as string).startsWith('__Host-')
  if (
    (isHostCookie && (isDomainCookie || row.path !== '/' || !secure)) ||
    ((row.name as string).startsWith('__Secure-') && !secure) ||
    (sameSite === 'None' && !secure) ||
    (partition.status === 'partitioned' && !secure)
  ) {
    return { status: 'skip', reason: 'invalid-cookie' }
  }

  const urlHost = isIP(domain) === 6 ? `[${domain}]` : domain
  const identity: PlannedCdpCookieIdentity = {
    url: `${secure ? 'https' : 'http'}://${urlHost}/`,
    name: row.name as string,
    value: value.toString('latin1'),
    ...(isDomainCookie && !isHostCookie ? { domain: `.${domain}` } : {}),
    path: row.path as string,
    secure,
    httpOnly,
    ...(sameSite === null ? {} : { sameSite }),
    ...(expires === 0 ? {} : { expires }),
    ...(partition.status === 'partitioned' ? { partitionKey: partition.partitionKey } : {})
  }
  return { status: 'write', identity }
}

function validatedLimit(value: number | undefined, maximum: number, name: string): number {
  if (value === undefined) return maximum
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} must be a positive integer no greater than ${maximum}`)
  }
  return value
}

function resolvePlanLimits(options: BrowserProfileImportPlanOptions): ResolvedPlanLimits {
  return {
    maxCookies: validatedLimit(options.limits?.maxCookies, DEFAULT_MAX_COOKIE_COUNT, 'maxCookies'),
    maxCookieBytes: validatedLimit(
      options.limits?.maxCookieBytes,
      DEFAULT_MAX_COOKIE_BYTES,
      'maxCookieBytes'
    ),
    maxPlanBytes: validatedLimit(options.limits?.maxPlanBytes, DEFAULT_MAX_PLAN_BYTES, 'maxPlanBytes')
  }
}

function emptySkipCounts(): Record<BrowserProfileCookieSkipReason, number> {
  return Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0])) as Record<
    BrowserProfileCookieSkipReason,
    number
  >
}

function readCookieRows(databasePath: string, maxCookies: number): {
  columns: Set<string>
  rows: Record<string, unknown>[]
} {
  const database = new DatabaseSync(databasePath, { readOnly: true, readBigInts: true })
  try {
    const columnRows = database.prepare('PRAGMA table_info(cookies)').all() as Array<{ name?: unknown }>
    const columns = new Set(
      columnRows.flatMap((column) => typeof column.name === 'string' ? [column.name] : [])
    )
    if (columns.size !== columnRows.length) {
      throw new Error('Chromium cookies schema contained an invalid or duplicate column')
    }
    const missing = REQUIRED_COOKIE_COLUMNS.filter((column) => !columns.has(column))
    if (missing.length > 0) {
      throw new Error(`Chromium cookies schema is missing required columns: ${missing.join(', ')}`)
    }
    const countRow = database.prepare('SELECT COUNT(*) AS count FROM cookies').get() as
      | { count?: unknown }
      | undefined
    const rawCount = countRow?.count
    if (typeof rawCount !== 'bigint' && typeof rawCount !== 'number') {
      throw new Error('Chromium cookies table returned an invalid row count')
    }
    const count = Number(rawCount)
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error('Chromium cookies table returned an invalid row count')
    }
    if (count > maxCookies) {
      throw new Error(`Chromium Profile contains ${count} cookies; limit is ${maxCookies}`)
    }

    const selectedColumns = [
      ...REQUIRED_COOKIE_COLUMNS,
      ...(columns.has(PARTITION_SITE_COLUMN) ? [PARTITION_SITE_COLUMN] : []),
      ...(columns.has(PARTITION_ANCESTOR_COLUMN) ? [PARTITION_ANCESTOR_COLUMN] : [])
    ]
    const rows = database
      .prepare(`SELECT ${selectedColumns.join(', ')} FROM cookies ORDER BY rowid`)
      .all() as Record<string, unknown>[]
    if (rows.length !== count) throw new Error('Chromium cookies table changed while reading its snapshot')
    return { columns, rows }
  } finally {
    database.close()
  }
}

export function planBrowserProfileImport(
  source: BrowserProfileImportSource,
  options: BrowserProfileImportPlanOptions = {}
): BrowserProfileImportPlan {
  const browser = assertCurrentSource(source)
  const limits = resolvePlanLimits(options)
  const now = options.now ?? Date.now()
  if (!Number.isSafeInteger(now) || now < 0) throw new Error('Import clock must be a non-negative integer')
  const snapshot = createStableSnapshot(source.cookiesPath, source.fileIdentity, options.tempRoot)

  try {
    const { columns, rows } = readCookieRows(snapshot.databasePath, limits.maxCookies)
    const skippedByReason = emptySkipCounts()
    const partitions = rows.map((row) => readPartition(row, columns))
    const dispositions: Array<BrowserProfileCookieSkipReason | null> = rows.map((row) => (
      isNonTransplantableDomain(row.host_key) ? 'non-transplantable' : null
    ))
    const unreadableFamilies = new Set<string>()

    for (const [index, row] of rows.entries()) {
      if (dispositions[index] !== null || partitions[index]?.status !== 'unreadable') continue
      const family = registrableCookieFamily(row.host_key)
      if (family) unreadableFamilies.add(family)
    }
    for (const [index, row] of rows.entries()) {
      if (dispositions[index] !== null) continue
      const partition = partitions[index]
      if (partition?.status === 'unreadable') {
        dispositions[index] = 'partition-unreadable'
        continue
      }
      const family = registrableCookieFamily(row.host_key)
      if (family && unreadableFamilies.has(family)) {
        dispositions[index] = 'partition-family-unreadable'
      }
    }

    let keysResolved = false
    let keys: Aes128KeySet | null = null
    let plannedBytes = 0
    const cookies: PlannedCdpCookieIdentity[] = []

    for (const [index, row] of rows.entries()) {
      let reason = dispositions[index]
      const partition = partitions[index]
      if (!reason && partition && partition.status !== 'unreadable') {
        const encryptedRaw = row.encrypted_value
        const encrypted = encryptedRaw instanceof Uint8Array ? Buffer.from(encryptedRaw) : null
        let value: Buffer | null = null
        if (encrypted === null) {
          reason = 'invalid-cookie'
        } else if (encrypted.length > 0) {
          const version = encrypted.subarray(0, 3).toString('ascii')
          if (version === 'v20') {
            reason = 'app-bound-encryption'
          } else {
            if (!keysResolved) {
              keys = resolveAes128Keys(browser)
              keysResolved = true
            }
            value = decryptAes128Cookie(encrypted, keys)
            if (!value) reason = 'undecryptable'
          }
        } else if (typeof row.value === 'string') {
          value = Buffer.from(row.value, 'utf8')
        } else {
          reason = 'invalid-cookie'
        }

        if (!reason && value) {
          const planned = buildCookieIdentity(row, partition, value, Math.floor(now / 1000))
          if (planned.status === 'skip') {
            reason = planned.reason
          } else {
            const cookieBytes = Buffer.byteLength(JSON.stringify(planned.identity), 'utf8')
            if (cookieBytes > limits.maxCookieBytes) {
              reason = 'invalid-cookie'
            } else if (plannedBytes + cookieBytes > limits.maxPlanBytes) {
              throw new Error(
                `Chromium Profile cookie plan exceeds ${limits.maxPlanBytes} bytes; no partial plan was produced`
              )
            } else {
              cookies.push(planned.identity)
              plannedBytes += cookieBytes
            }
          }
        }
      }

      if (reason) skippedByReason[reason] += 1
    }

    const skippedCookies = Object.values(skippedByReason).reduce((sum, count) => sum + count, 0)
    if (rows.length !== cookies.length + skippedCookies) {
      throw new Error('Chromium Profile cookie plan did not account for every source row')
    }
    return {
      browserLabel: source.browserLabel,
      profileLabel: source.profileLabel,
      cookies,
      totalCookies: rows.length,
      importedCookies: cookies.length,
      skippedCookies,
      plannedBytes,
      skippedByReason
    }
  } finally {
    snapshot.cleanup()
  }
}
