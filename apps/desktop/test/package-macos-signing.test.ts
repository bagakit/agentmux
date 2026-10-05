import { fixturePath as _hygiene_fixturePath } from "../scripts/lib/fixture-values.mjs"
import { readFile, access } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { preflightMacosSigning, signMacosApplication, verifyMacosSigning } from '../scripts/macos-signing.mjs'

const identity = 'A'.repeat(40), teamId = 'TESTTEAM01', app = _hygiene_fixturePath("candidate/AgentMux.app")
const plan = { kind: 'certificate', identity, teamId }
const env = { AGENTMUX_MACOS_SIGN_IDENTITY: identity }
const inventory = `  1) ${identity} "Developer ID Application: Test Signing (${teamId})"\n     1 valid identities found\n`
const metadata = `Identifier=dev.agentmux.desktop\nAuthority=Developer ID Application: Test Signing (${teamId})\nTeamIdentifier=${teamId}\n`
const requirement = `designated => identifier "dev.agentmux.desktop" and anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */ and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */ and certificate leaf[subject.OU] = "${teamId}"`
function runner(meta = metadata, dr = requirement) {
  return vi.fn(async (_command: string, args: string[]) => ({ stdout: '', stderr: args.includes('--requirements') ? dr : args.includes('--display') ? meta : '' }))
}

it('rejects an absent stable identity before any native command', async () => {
  const run = vi.fn()
  await expect(preflightMacosSigning({ argv: [], env: {}, run, loadLocal: async () => null })).rejects.toThrow(/certificate SHA1.*existing App.*healthy Runs/i)
  expect(run).not.toHaveBeenCalled()
})
it.each(['-', 'Developer ID Application: Partial name', 'B'.repeat(39)])('does not interpret %s as a stable certificate selector', async (value) => {
  const run = vi.fn()
  await expect(preflightMacosSigning({ argv: [], env: { AGENTMUX_MACOS_SIGN_IDENTITY: value }, run })).rejects.toThrow(/exact certificate SHA1/)
  expect(run).not.toHaveBeenCalled()
})
it('checks the exact valid certificate fingerprint and records its team', async () => {
  const run = vi.fn(async () => ({ stdout: inventory, stderr: '' }))
  expect(await preflightMacosSigning({ argv: [], env: { AGENTMUX_MACOS_SIGN_IDENTITY: identity.toLowerCase() }, run })).toEqual(plan)
  expect(run).toHaveBeenCalledExactlyOnceWith('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])
})
it.each(['0 valid identities found', inventory.replace(identity, 'B'.repeat(40)), inventory.replace('Developer ID Application:', 'Apple Development:'), inventory + inventory])('refuses unavailable, wrong, development or ambiguous identities', async (stdout) => {
  const run = vi.fn(async () => ({ stdout, stderr: '' }))
  await expect(preflightMacosSigning({ argv: [], env, run })).rejects.toThrow(/not uniquely available and valid/)
  expect(run).toHaveBeenCalledTimes(1)
})
it('keeps an unavailable signing readout unknown instead of downgrading to ad hoc', async () => {
  await expect(preflightMacosSigning({ argv: [], env, run: vi.fn(async () => { throw new Error('Keychain unavailable') }) })).rejects.toThrow(/could not confirm.*Keychain unavailable.*existing App/i)
})
it('allows explicit development ad hoc without looking for a certificate', async () => {
  const run = vi.fn()
  expect(await preflightMacosSigning({ argv: ['--ad-hoc'], env: {}, run })).toEqual({ kind: 'ad-hoc' })
  expect(run).not.toHaveBeenCalled()
  await expect(preflightMacosSigning({ argv: ['--ad-hoc'], env, run })).rejects.toThrow(/cannot be requested together/)
})
it('refuses ad hoc canonical installation before any build or identity operation', async () => {
  const run = vi.fn(), loadLocal = vi.fn()
  await expect(preflightMacosSigning({ argv: ['--ad-hoc', '--install'], env: {}, run, loadLocal })).rejects.toThrow(/cannot install.*privacy authorization identity/)
  expect(run).not.toHaveBeenCalled()
  expect(loadLocal).not.toHaveBeenCalled()
})
const localPlan = { kind: 'certificate', profile: 'local', identity }
it('reuses the explicitly saved exact local identity under native codesigning policy', async () => {
  const loadLocal = vi.fn(async () => localPlan)
  const run = vi.fn(async () => ({ stdout: `1) ${identity} "AgentMux Local UUID"\n`, stderr: '' }))
  expect(await preflightMacosSigning({ argv: [], env: {}, run, loadLocal })).toEqual(localPlan)
  expect(run).toHaveBeenCalledExactlyOnceWith('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'])
  await expect(preflightMacosSigning({ argv: [], env: {}, loadLocal, run: vi.fn(async () => ({ stdout: `1) ${'B'.repeat(40)} "AgentMux Local UUID"`, stderr: '' })) })).rejects.toThrow(/not uniquely available and valid/)
})
it('does not replace an unreadable or missing original local Keychain identity', async () => {
  const run = vi.fn()
  await expect(preflightMacosSigning({ argv: [], env: {}, run, loadLocal: async () => { throw new Error('record damaged') } })).rejects.toThrow(/record damaged.*never regenerates/)
  expect(run).not.toHaveBeenCalled()
  await expect(preflightMacosSigning({ argv: [], env: {}, loadLocal: async () => localPlan, run: vi.fn(async () => ({ stdout: '0 valid identities found', stderr: '' })) })).rejects.toThrow(/not uniquely available.*Restore the original/)
})
it('uses local codeSign qualification without broadening trust to satisfy the signer basic policy', async () => {
  const signer = vi.fn(async options => {
    expect(options.identity).toBe(identity)
    expect(options.identityValidation).toBe(false)
    expect(options.strictVerify).toBe(true)
    expect(options.optionsForFile(app).timestamp).toBe('none')
    expect(options.optionsForFile(app)).not.toHaveProperty('requirements')
  })
  await signMacosApplication(app, localPlan, { signer })
  const dr = `designated => identifier "dev.agentmux.desktop" and anchor H"${identity.toLowerCase()}"`
  const run = runner('Identifier=dev.agentmux.desktop\nAuthority=AgentMux Local UUID\nTeamIdentifier=not set', dr)
  expect(await verifyMacosSigning(app, localPlan, { run })).toMatchObject({ profile: 'local', identity, designatedRequirement: dr, authorizationContinuity: 'unverified' })
  expect(run.mock.calls[0][1]).toContain(`=identifier "dev.agentmux.desktop" and certificate leaf = H"${identity}"`)
  await expect(verifyMacosSigning(app, localPlan, { run: runner('Identifier=dev.agentmux.desktop', dr.replace(identity.toLowerCase(), 'b'.repeat(40))) })).rejects.toThrow(/original certificate anchor/)
})
it.each([undefined, { kind: 'unknown' }, { kind: 'certificate', identity: '-', teamId }])('rejects an invalid plan before it can silently become development signing', async (invalid) => {
  const signer = vi.fn(), run = vi.fn()
  await expect(signMacosApplication(app, invalid, { signer })).rejects.toThrow(/plan is invalid/)
  await expect(verifyMacosSigning(app, invalid, { run })).rejects.toThrow(/plan is invalid/)
  expect(signer).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})
it('uses the maintained signer with default certificate DR and no new runtime/device entitlements', async () => {
  const run = runner(), signer = vi.fn(async (options) => {
    expect(options.identity).toBe(identity)
    expect(options.identityValidation).toBe(true)
    expect(options.strictVerify).toBe(true)
    expect(options.platform).toBe('darwin')
    expect(options.preAutoEntitlements).toBe(false)
    expect(options.preEmbedProvisioningProfile).toBe(false)
    const perFile = options.optionsForFile(_hygiene_fixturePath("candidate/AgentMux Helper (Renderer).app"))
    expect(perFile.hardenedRuntime).toBe(false)
    expect(Object.keys(perFile).sort()).toEqual(['entitlements', 'hardenedRuntime'])
    const xml = await readFile(perFile.entitlements, 'utf8')
    expect(xml).toContain('<dict/>')
    expect(xml).not.toMatch(/<key>|requirements|camera|microphone/)
  })
  await signMacosApplication(app, plan, { signer })
  const receipt = await verifyMacosSigning(app, plan, { run })
  expect(signer).toHaveBeenCalledTimes(1)
  expect(receipt).toEqual({ kind: 'certificate', teamId, designatedRequirement: requirement, authorizationContinuity: 'unverified', notarized: false })
  expect(run.mock.calls[0]).toEqual(['/usr/bin/codesign', ['--verify', '--deep', '--strict', '--verbose=2', '--test-requirement', `=identifier "dev.agentmux.desktop" and anchor apple generic and certificate leaf[subject.OU] = "${teamId}"`, app]])
  const file = signer.mock.calls[0][0].optionsForFile(app).entitlements
  await expect(access(file)).rejects.toThrow()
})
it('a signing failure never starts verification or silently retries another identity', async () => {
  const run = runner(), signer = vi.fn(async () => { throw new Error('Signing unavailable') })
  await expect(signMacosApplication(app, plan, { signer })).rejects.toThrow('Signing unavailable')
  expect(signer).toHaveBeenCalledTimes(1)
  expect(run).not.toHaveBeenCalled()
})
it('the explicit ad hoc mode stays identifiable and declares continuity unknown', async () => {
  const run = runner('Identifier=dev.agentmux.desktop\nSignature=adhoc\nTeamIdentifier=not set')
  const signer = vi.fn(async options => {
    expect(options.identity).toBe('-')
    expect(options.identityValidation).toBe(false)
    expect(options.optionsForFile(app).timestamp).toBe('none')
  })
  await signMacosApplication(app, { kind: 'ad-hoc' }, { signer })
  expect(await verifyMacosSigning(app, { kind: 'ad-hoc' }, { run })).toEqual({ kind: 'ad-hoc', authorizationContinuity: 'unverified', notarized: false })
})
it('a failed native signature validation cannot become qualified metadata', async () => {
  const run = vi.fn(async () => { throw new Error('Signature invalid') })
  await expect(verifyMacosSigning(app, plan, { run })).rejects.toThrow('Signature invalid')
  expect(run).toHaveBeenCalledTimes(1)
})
it.each([metadata.replace('dev.agentmux.desktop', 'dev.other.app'), metadata.replace(teamId, 'OTHERTEAM1').replace(`TeamIdentifier=${teamId}`, 'TeamIdentifier=OTHERTEAM1'), metadata + '\nSignature=adhoc', metadata.replace('Authority=Developer ID Application:', 'Authority=Self-signed:')])('refuses an unexpected bundle, team or non-certificate signature', async (meta) => {
  await expect(verifyMacosSigning(app, plan, { run: runner(meta) })).rejects.toThrow(/unexpected|did not confirm/)
})
it.each(['', 'designated => cdhash H012345', 'designated => identifier "dev.agentmux.desktop"', 'designated => ( identifier "dev.agentmux.desktop" )'])('never qualifies absent, hash-bound or explicitly identifier-only requirements', async (dr) => {
  await expect(verifyMacosSigning(app, plan, { run: runner(metadata, dr) })).rejects.toThrow(/requirement.*could not be confirmed/)
})
it.each([`designated => anchor apple generic and identifier "dev.agentmux.desktop" and certificate leaf[subject.OU] = "${teamId}"`, `designated => identifier "dev.agentmux.desktop" and anchor apple generic and (certificate leaf[subject.OU] = "${teamId}" or certificate leaf[sha256] = H012345)`])('defers valid DR syntax and certificate alternatives to OS qualification', async (dr) => {
  const run = runner(metadata, dr)
  expect((await verifyMacosSigning(app, plan, { run })).designatedRequirement).toBe(dr)
  expect(run.mock.calls[0][1]).toContain('--test-requirement')
})
it('an OS certificate/anchor/team requirement failure is retained and cannot reach output qualification', async () => {
  const run = vi.fn(async (_command, args) => {
    expect(args).toContain('--test-requirement')
    throw new Error('Code failed to satisfy specified code requirement')
  })
  await expect(verifyMacosSigning(app, plan, { run })).rejects.toThrow(/failed to satisfy/)
  expect(run).toHaveBeenCalledTimes(1)
})
