import { afterEach, describe, expect, it, vi } from 'vitest'
import { createCipheriv, pbkdf2Sync } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const mockState = vi.hoisted(() => ({
  homePath: '',
  keychainPassword: 'test-password',
  execFileSync: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: (name: string) => name === 'home' ? mockState.homePath : tmpdir() }
}))

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  mockState.execFileSync.mockImplementation(() => `${mockState.keychainPassword}\n`)
  return { ...actual, execFileSync: mockState.execFileSync }
})

import {
  detectBrowserProfileImportSources,
  planBrowserProfileImport,
  type BrowserProfileImportSource
} from '../src/main/browser-profile-import-source.js'

const roots: string[] = []
const originalPlatform = process.platform
const CHROMIUM_EPOCH_OFFSET = 11_644_473_600n

type CookieRow = {
  hostKey: string
  name: string
  value?: string
  encryptedValue?: Buffer
  path?: string
  expiresUtc?: bigint
  secure?: number
  httpOnly?: number
  sameSite?: number
  topFrameSiteKey?: string | null
  hasCrossSiteAncestor?: number | null
}

afterEach(async () => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  mockState.execFileSync.mockClear()
  mockState.keychainPassword = 'test-password'
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })))
})

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform })
}

async function homeFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agentmux-browser-import-source-'))
  roots.push(root)
  mockState.homePath = root
  setPlatform('darwin')
  return root
}

function chromeRoot(home: string): string {
  return join(home, 'Library', 'Application Support', 'Google', 'Chrome')
}

function chromeCookiesPath(home: string, profileDirectory = 'Default'): string {
  return join(chromeRoot(home), profileDirectory, 'Network', 'Cookies')
}

async function writeLocalState(
  home: string,
  profiles: Record<string, { name: string }> = { Default: { name: 'Personal' } }
): Promise<void> {
  const root = chromeRoot(home)
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'Local State'), JSON.stringify({ profile: { info_cache: profiles } }))
}

function createCookieDatabase(
  path: string,
  options: { includePartitionColumns?: boolean; omitSameSite?: boolean; wal?: boolean } = {}
): DatabaseSync {
  const database = new DatabaseSync(path)
  if (options.wal) {
    database.exec('PRAGMA journal_mode = WAL')
    database.exec('PRAGMA wal_autocheckpoint = 0')
  }
  database.exec(`CREATE TABLE cookies (
    host_key TEXT NOT NULL,
    name TEXT NOT NULL,
    value TEXT NOT NULL,
    encrypted_value BLOB NOT NULL,
    path TEXT NOT NULL,
    expires_utc INTEGER NOT NULL,
    is_secure INTEGER NOT NULL,
    is_httponly INTEGER NOT NULL
    ${options.omitSameSite ? '' : ', samesite INTEGER NOT NULL'}
    ${options.includePartitionColumns ? ', top_frame_site_key TEXT, has_cross_site_ancestor INTEGER' : ''}
  )`)
  return database
}

function insertCookie(
  database: DatabaseSync,
  row: CookieRow,
  options: { includePartitionColumns?: boolean } = {}
): void {
  const columns = [
    'host_key',
    'name',
    'value',
    'encrypted_value',
    'path',
    'expires_utc',
    'is_secure',
    'is_httponly',
    'samesite',
    ...(options.includePartitionColumns ? ['top_frame_site_key', 'has_cross_site_ancestor'] : [])
  ]
  database.prepare(
    `INSERT INTO cookies (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  ).run(
    row.hostKey,
    row.name,
    row.value ?? '',
    row.encryptedValue ?? Buffer.alloc(0),
    row.path ?? '/',
    row.expiresUtc ?? 0n,
    row.secure ?? 0,
    row.httpOnly ?? 0,
    row.sameSite ?? 0,
    ...(options.includePartitionColumns
      ? [row.topFrameSiteKey ?? '', row.hasCrossSiteAncestor ?? 0]
      : [])
  )
}

async function detectedChromeSource(
  rows: CookieRow[],
  options: { includePartitionColumns?: boolean; wal?: boolean } = {}
): Promise<{ source: BrowserProfileImportSource; database: DatabaseSync | null; home: string }> {
  const home = await homeFixture()
  await writeLocalState(home)
  const path = chromeCookiesPath(home)
  await mkdir(dirname(path), { recursive: true })
  const database = createCookieDatabase(path, options)
  for (const row of rows) insertCookie(database, row, options)
  if (!options.wal) database.close()
  const source = detectBrowserProfileImportSources()[0]
  if (!source) throw new Error('Expected Chrome source fixture to be detected')
  return { source, database: options.wal ? database : null, home }
}

function chromiumExpiration(unixSeconds: number): bigint {
  return (BigInt(unixSeconds) + CHROMIUM_EPOCH_OFFSET) * 1_000_000n
}

function encryptV10(value: string, password = mockState.keychainPassword): Buffer {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const cipher = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
  return Buffer.concat([Buffer.from('v10'), cipher.update(Buffer.from(value, 'ascii')), cipher.final()])
}

describe('Browser Profile Chromium import sources', () => {
  it('reports no source capability on an unverified platform', async () => {
    await homeFixture()
    setPlatform('linux')

    expect(detectBrowserProfileImportSources()).toEqual([])
  })

  it('requires valid Local State metadata and never guesses a Default Profile', async () => {
    const home = await homeFixture()
    const cookiesPath = chromeCookiesPath(home)
    await mkdir(dirname(cookiesPath), { recursive: true })
    createCookieDatabase(cookiesPath).close()

    expect(detectBrowserProfileImportSources()).toEqual([])

    await mkdir(chromeRoot(home), { recursive: true })
    await writeFile(join(chromeRoot(home), 'Local State'), '{')
    expect(detectBrowserProfileImportSources()).toEqual([])
  })

  it('detects only actual SQLite Profiles named by Local State and rejects unsafe or escaping paths', async () => {
    const home = await homeFixture()
    await writeLocalState(home, {
      'Profile 1': { name: 'Work' },
      '../escape': { name: 'Escape' },
      'Profile 2': { name: 'Symlink' }
    })
    const validPath = chromeCookiesPath(home, 'Profile 1')
    await mkdir(dirname(validPath), { recursive: true })
    createCookieDatabase(validPath).close()
    const outsideRoot = join(home, 'outside')
    await mkdir(outsideRoot, { recursive: true })
    const outsideCookies = join(outsideRoot, 'Cookies')
    createCookieDatabase(outsideCookies).close()
    await mkdir(join(chromeRoot(home), 'Profile 2', 'Network'), { recursive: true })
    await symlink(outsideCookies, chromeCookiesPath(home, 'Profile 2'))

    const detected = detectBrowserProfileImportSources()

    expect(detected).toHaveLength(1)
    expect(detected[0]).toMatchObject({
      kind: 'chromium',
      browserId: 'chrome',
      browserLabel: 'Google Chrome',
      profileDirectory: 'Profile 1',
      profileLabel: 'Work',
      cookiesPath: expect.stringMatching(/Profile 1\/Network\/Cookies$/),
      fileIdentity: { device: expect.any(String), inode: expect.any(String) }
    })
  })

  it('copies a live SQLite WAL and produces a complete CHIPS-preserving family-atomic plan', async () => {
    const nowSeconds = 1_700_000_000
    const { source, database } = await detectedChromeSource([
      { hostKey: '.example.net', name: 'plain', value: 'one' },
      {
        hostKey: '.partitioned.test',
        name: '__Secure-chip',
        value: 'two',
        secure: 1,
        httpOnly: 1,
        sameSite: 1,
        topFrameSiteKey: 'https://top.example',
        hasCrossSiteAncestor: 1
      },
      {
        hostKey: '.bad.family.co.uk',
        name: 'bad-partition',
        value: 'three',
        secure: 1,
        topFrameSiteKey: 'https://top.example/path',
        hasCrossSiteAncestor: 0
      },
      { hostKey: '.good.family.co.uk', name: 'family-sibling', value: 'four' },
      { hostKey: '.appbound.test', name: 'v20', encryptedValue: Buffer.from('v20opaque') },
      {
        hostKey: '.expired.test',
        name: 'expired',
        value: 'old',
        expiresUtc: chromiumExpiration(nowSeconds - 1)
      },
      { hostKey: '.invalid.test', name: 'bad name', value: 'invalid' },
      { hostKey: '.google.com', name: 'SID', value: 'source-bound' }
    ], { includePartitionColumns: true, wal: true })

    try {
      const plan = planBrowserProfileImport(source, { now: nowSeconds * 1000 })

      expect(plan).toMatchObject({
        browserLabel: 'Google Chrome',
        profileLabel: 'Personal',
        totalCookies: 8,
        importedCookies: 2,
        skippedCookies: 6,
        skippedByReason: {
          expired: 1,
          'invalid-cookie': 1,
          'app-bound-encryption': 1,
          undecryptable: 0,
          'non-transplantable': 1,
          'partition-unreadable': 1,
          'partition-family-unreadable': 1
        }
      })
      expect(plan.totalCookies).toBe(plan.importedCookies + plan.skippedCookies)
      expect(plan.plannedBytes).toBeGreaterThan(0)
      expect(plan.cookies).toContainEqual({
        url: 'https://partitioned.test/',
        name: '__Secure-chip',
        value: 'two',
        domain: '.partitioned.test',
        path: '/',
        secure: true,
        httpOnly: true,
        sameSite: 'None',
        partitionKey: {
          topLevelSite: 'https://top.example',
          hasCrossSiteAncestor: true
        }
      })
      expect(plan.cookies.map((cookie) => cookie.name)).toEqual(['plain', '__Secure-chip'])
    } finally {
      database?.close()
    }
  })

  it('uses PSL registrable families for private suffixes and keeps IP families exact', async () => {
    const { source } = await detectedChromeSource([
      {
        hostKey: 'bad.user.github.io',
        name: 'github-bad',
        value: 'one',
        topFrameSiteKey: 'opaque',
        hasCrossSiteAncestor: 0
      },
      { hostKey: 'good.user.github.io', name: 'github-sibling', value: 'two' },
      {
        hostKey: '127.0.0.1',
        name: 'ip-bad',
        value: 'three',
        topFrameSiteKey: 'opaque',
        hasCrossSiteAncestor: 0
      },
      { hostKey: '127.0.0.2', name: 'other-ip', value: 'four' },
      { hostKey: 'co.uk', name: 'public-suffix', value: 'five' }
    ], { includePartitionColumns: true })

    const plan = planBrowserProfileImport(source)

    expect(plan.cookies.map((cookie) => cookie.name)).toEqual(['other-ip'])
    expect(plan.skippedByReason['partition-unreadable']).toBe(2)
    expect(plan.skippedByReason['partition-family-unreadable']).toBe(1)
    expect(plan.skippedByReason['invalid-cookie']).toBe(1)
  })

  it('decrypts Darwin v10 AES-128-CBC cookies through the source browser Keychain identity', async () => {
    const { source } = await detectedChromeSource([
      { hostKey: '.encrypted.test', name: 'session', encryptedValue: encryptV10('secret') }
    ])

    const plan = planBrowserProfileImport(source)

    expect(mockState.execFileSync).toHaveBeenCalledWith(
      'security',
      ['find-generic-password', '-s', 'Chrome Safe Storage', '-a', 'Chrome', '-w'],
      expect.objectContaining({ timeout: 30_000 })
    )
    expect(plan.cookies).toContainEqual(expect.objectContaining({
      name: 'session',
      value: 'secret'
    }))
    expect(plan.skippedByReason.undecryptable).toBe(0)
  })

  it('counts a denied or wrong Keychain value as undecryptable without exposing ciphertext', async () => {
    const { source } = await detectedChromeSource([
      { hostKey: '.encrypted.test', name: 'session', encryptedValue: encryptV10('secret') }
    ])
    mockState.execFileSync.mockImplementationOnce(() => 'wrong-password\n')

    const plan = planBrowserProfileImport(source)

    expect(plan.cookies).toEqual([])
    expect(plan).toMatchObject({ totalCookies: 1, importedCookies: 0, skippedCookies: 1 })
    expect(plan.skippedByReason.undecryptable).toBe(1)
    expect(JSON.stringify(plan)).not.toContain('v10')
  })

  it('rejects a replaced source identity before snapshot or Keychain access', async () => {
    const { source, home } = await detectedChromeSource([
      { hostKey: '.example.test', name: 'session', value: 'one' }
    ])
    const path = chromeCookiesPath(home)
    await rename(path, `${path}.old`)
    createCookieDatabase(path).close()

    expect(() => planBrowserProfileImport(source)).toThrow('source changed after detection')
    expect(mockState.execFileSync).not.toHaveBeenCalled()
  })

  it('rejects a current but unsupported SQLite schema instead of guessing columns', async () => {
    const home = await homeFixture()
    await writeLocalState(home)
    const path = chromeCookiesPath(home)
    await mkdir(dirname(path), { recursive: true })
    createCookieDatabase(path, { omitSameSite: true }).close()
    const source = detectBrowserProfileImportSources()[0]!

    expect(() => planBrowserProfileImport(source)).toThrow(
      'Chromium cookies schema is missing required columns: samesite'
    )
  })

  it('rejects count and byte limits as whole-plan failures without returning a prefix', async () => {
    const { source } = await detectedChromeSource([
      { hostKey: '.one.test', name: 'first', value: 'one' },
      { hostKey: '.two.test', name: 'second', value: 'two' }
    ])

    expect(() => planBrowserProfileImport(source, { limits: { maxCookies: 1 } })).toThrow(
      'contains 2 cookies; limit is 1'
    )
    expect(() => planBrowserProfileImport(source, { limits: { maxPlanBytes: 1 } })).toThrow(
      'no partial plan was produced'
    )
  })

  it('always removes its private snapshot after successful planning', async () => {
    const { source } = await detectedChromeSource([
      { hostKey: '.example.test', name: 'session', value: 'one' }
    ])
    const tempRoot = await mkdtemp(join(tmpdir(), 'agentmux-browser-import-snapshots-'))
    roots.push(tempRoot)

    planBrowserProfileImport(source, { tempRoot })

    expect(await readFile(source.cookiesPath)).not.toHaveLength(0)
    expect(await import('node:fs/promises').then(({ readdir }) => readdir(tempRoot))).toEqual([])
  })
})
