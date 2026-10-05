import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { X509Certificate } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, stat, access, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { readLocalSigningIdentity, setupLocalSigningIdentity, trustLocalSigningIdentity, localSigningDirectory } from '../scripts/macos-local-signing.mjs'

const exec = promisify(execFile)
const roots: string[] = []
async function home() { const path = await mkdtemp(join(tmpdir(), 'agentmux-local-signing-test-')); roots.push(path); return path }
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })
function runner(failImport = false) {
  let imported = ''
  return vi.fn(async (command: string, args: string[]) => {
    if (command === '/usr/bin/openssl') return await exec(command, args)
    if (args[0] === 'import') {
      expect(args).toContain('/usr/bin/codesign')
      expect(args).not.toContain('-A')
      expect((await stat(join(args[1], '..'))).mode & 0o777).toBe(0o700)
      if (failImport) throw new Error('Import rejected')
      imported = new X509Certificate(await readFile(join(args[1], '..', 'certificate.pem'))).fingerprint.replaceAll(':', '')
    }
    if (args[0] === 'find-identity') return { stdout: imported ? `1) ${imported} "AgentMux Local" (CSSMERR_TP_NOT_TRUSTED)\n1) ${imported} "AgentMux Local"\n` : '0 identities found', stderr: '' }
    return { stdout: '', stderr: '' }
  })
}
it('creates one persistent codeSigning certificate, restricts the import and deletes private temporary files', async () => {
  const directory = await home(), run = runner()
  const identity = await setupLocalSigningIdentity({ home: directory, run })
  expect(identity).toMatchObject({ kind: 'certificate', profile: 'local', identity: expect.stringMatching(/^[A-F0-9]{40}$/) })
  const stored = localSigningDirectory(directory)
  expect((await stat(stored)).mode & 0o777).toBe(0o700)
  expect(await readLocalSigningIdentity({ home: directory })).toEqual(identity)
  const record = JSON.parse(await readFile(join(stored, 'identity.json'), 'utf8'))
  expect(Object.keys(record).sort()).toEqual(['identity', 'schema'])
  expect(await readFile(join(stored, 'certificate.pem'), 'utf8')).not.toContain('PRIVATE KEY')
  const imported = run.mock.calls.find(([, args]) => args[0] === 'import')![1]
  expect(imported).toEqual(['import', expect.any(String), '-k', join(directory, 'Library', 'Keychains', 'login.keychain-db'), '-f', 'pkcs12', '-P', expect.stringMatching(/^[a-f0-9]{64}$/), '-T', '/usr/bin/codesign'])
  await expect(access(imported[1])).rejects.toThrow()
  expect(run.mock.calls.every(([, args]) => args[0] !== 'add-trusted-cert')).toBe(true)
  const previousCalls = run.mock.calls.length
  await expect(setupLocalSigningIdentity({ home: directory, run })).resolves.toEqual(identity)
  expect(run.mock.calls.slice(previousCalls)).toEqual([['/usr/bin/security', ['find-identity', '-p', 'codesigning']]])
})
it('retains the same protected private identity on a rejected import and resumes it on retry', async () => {
  const directory = await home(), run = runner(true)
  await expect(setupLocalSigningIdentity({ home: directory, run })).rejects.toThrow('Import rejected')
  const original = await readLocalSigningIdentity({ home: directory })
  const archive = run.mock.calls.find(([, args]) => args[0] === 'import')![1][1]
  await expect(access(archive)).resolves.toBeUndefined()
  expect((await stat(join(archive, '..', 'key.pem'))).mode & 0o777).toBe(0o600)
  const retry = runner()
  await expect(setupLocalSigningIdentity({ home: directory, run: retry })).resolves.toEqual(original)
  expect(retry.mock.calls.filter(([command]) => command === '/usr/bin/openssl').every(([, args]) => args[0] === 'pkcs12')).toBe(true)
  await expect(access(archive)).rejects.toThrow()
})
it('redacts transport passwords from native import errors while preserving recoverable setup', async () => {
  const directory = await home(), native = runner()
  let password = ''
  const run = vi.fn(async (command: string, args: string[]) => {
    if (args[0] === 'import') {
      password = args[args.indexOf('-P') + 1]
      throw new Error(`security import -P ${password}: rejected`)
    }
    return native(command, args)
  })
  const failure = await setupLocalSigningIdentity({ home: directory, run }).catch(error => error)
  expect(failure.message).toContain('[redacted]')
  expect(password).toMatch(/^[a-f0-9]{64}$/)
  expect(failure.message).not.toContain(password)
  expect(failure).not.toHaveProperty('cmd')
  await expect(access(join(localSigningDirectory(directory), 'pending', 'key.pem'))).resolves.toBeUndefined()
})
it('does not overwrite an interrupted setup directory or damaged public record', async () => {
  const directory = await home(), run = vi.fn()
  await mkdir(localSigningDirectory(directory), { recursive: true })
  await expect(setupLocalSigningIdentity({ home: directory, run })).rejects.toThrow(/setup is incomplete/)
  expect(run).not.toHaveBeenCalled()
  await rm(localSigningDirectory(directory), { recursive: true })
  await setupLocalSigningIdentity({ home: directory, run: runner() })
  await writeFile(join(localSigningDirectory(directory), 'identity.json'), JSON.stringify({ schema: 'agentmux.macos-local-signing.v1', identity: '0'.repeat(40) }))
  await expect(setupLocalSigningIdentity({ home: directory, run })).rejects.toThrow(/inconsistent.*not be replaced automatically/)
  expect(run).not.toHaveBeenCalled()
})
it('does not treat a public record as a present private Keychain identity or silently regenerate it', async () => {
  const directory = await home()
  await setupLocalSigningIdentity({ home: directory, run: runner() })
  const run = vi.fn(async () => ({ stdout: '0 identities found', stderr: '' }))
  await expect(setupLocalSigningIdentity({ home: directory, run })).rejects.toThrow(/private key is missing.*not be regenerated/)
  expect(run).toHaveBeenCalledExactlyOnceWith('/usr/bin/security', ['find-identity', '-p', 'codesigning'])
})
it('retains recoverable private setup until the exact imported identity is actually observed', async () => {
  const directory = await home(), native = runner()
  const run = vi.fn(async (command: string, args: string[]) => args[0] === 'find-identity' ? { stdout: '0 identities found', stderr: '' } : native(command, args))
  await expect(setupLocalSigningIdentity({ home: directory, run })).rejects.toThrow(/Pending setup is retained/)
  await expect(access(join(localSigningDirectory(directory), 'pending', 'key.pem'))).resolves.toBeUndefined()
})
it('requests only per-user codeSign trust through the explicit authenticated command', async () => {
  const directory = await home(), run = vi.fn(async () => ({ stdout: '', stderr: '' }))
  await expect(trustLocalSigningIdentity({ home: directory, run })).rejects.toThrow(/--setup first/)
  expect(run).not.toHaveBeenCalled()
  const identity = await setupLocalSigningIdentity({ home: directory, run: runner() })
  expect(await trustLocalSigningIdentity({ home: directory, run })).toEqual(identity)
  expect(run).toHaveBeenCalledExactlyOnceWith('/usr/bin/security', ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', join(localSigningDirectory(directory), 'certificate.pem')])
})
