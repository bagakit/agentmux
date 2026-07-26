import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertPackageIdentity,
  canonicalInstallPath,
  createPackageIdentity,
  packageIdentityPath,
  readPackageIdentity
} from '../scripts/package-identity.mjs'

const expected = {
  sourceCommit: 'f7651856b19949d82055c7fb9cf388164763c872',
  sourceTree: '344f40583e7eb82c97a1d9cc94e5bac7e5d811ba',
  appVersion: '0.1.0',
  platform: 'darwin',
  arch: 'arm64'
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('package identity', () => {
  it('creates and reads a complete identity from the bundle', async () => {
    const identity = createPackageIdentity(expected)
    expect(identity).toEqual({ schema: 'agentmux.package-identity.v1', ...expected })

    const root = await mkdtemp(join(tmpdir(), 'agentmux-package-identity-'))
    temporaryRoots.push(root)
    const appPath = join(root, 'AgentMux.app')
    const identityPath = packageIdentityPath(appPath)
    await mkdir(join(appPath, 'Contents', 'Resources', 'app'), { recursive: true })
    await writeFile(identityPath, `${JSON.stringify(identity)}\n`)
    expect(await readPackageIdentity(appPath)).toEqual(identity)
    expect(await readFile(identityPath, 'utf8')).toContain('sourceCommit')
  })

  it('rejects incomplete and mismatched identities', () => {
    expect(() => createPackageIdentity({ ...expected, sourceTree: '' })).toThrow(/sourceTree/)
    const actual = createPackageIdentity(expected)
    expect(() => assertPackageIdentity(actual, { ...expected, sourceCommit: 'old' })).toThrow(/sourceCommit/)
    expect(() => assertPackageIdentity(actual, expected)).not.toThrow()
  })

  it('uses one canonical user installation path', () => {
    expect(canonicalInstallPath('/Users/alice')).toBe('/Users/alice/Applications/AgentMux.app')
  })
})
