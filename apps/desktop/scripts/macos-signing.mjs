import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { sign } from '@electron/osx-sign'
import { readLocalSigningIdentity } from './macos-local-signing.mjs'

const exec = promisify(execFile)
const recovery = 'Set AGENTMUX_MACOS_SIGN_IDENTITY to an available Developer ID Application certificate SHA1, or run node apps/desktop/scripts/macos-local-signing.mjs --setup once and --trust to authenticate local code-signing trust. Restore the original Keychain identity if it is missing; packaging never regenerates it. --ad-hoc is only for an uninstalled development candidate. The existing App and healthy Runs are kept.'
const reject = message => { throw new Error(`${message} ${recovery}`) }
const runNative = (command, args) => exec(command, args, { encoding: 'utf8', timeout: 30_000, maxBuffer: 1_048_576 })
function requireSigningPlan(plan) {
  if (plan?.kind === 'ad-hoc') return
  if (plan?.kind === 'certificate' && /^[A-F0-9]{40}$/.test(plan.identity) &&
    (plan.profile === 'local' || (plan.profile === undefined && /^[A-Z0-9]{10}$/.test(plan.teamId)))) return
  reject('The macOS signing plan is invalid.')
}

/** This delivery request owns signing qualification, never installed App or Run liveness. */
export async function preflightMacosSigning({ argv = process.argv.slice(2), env = process.env, run = runNative, loadLocal = readLocalSigningIdentity } = {}) {
  const configured = (env.AGENTMUX_MACOS_SIGN_IDENTITY ?? '').trim().toUpperCase()
  if (argv.includes('--ad-hoc')) {
    if (argv.includes('--install')) reject('Ad hoc signing cannot install the canonical App: each build changes its privacy authorization identity.')
    if (configured) reject('Certificate signing and --ad-hoc cannot be requested together.')
    return Object.freeze({ kind: 'ad-hoc' })
  }
  let local
  if (!configured) {
    try { local = await loadLocal() } catch (error) { reject(`Could not read the saved local signing identity: ${error.message}`) }
  }
  const fingerprint = configured || local?.identity || ''
  if (!/^[A-F0-9]{40}$/.test(fingerprint)) reject('Stable macOS delivery requires an exact certificate SHA1.')
  let inventory
  try { inventory = await run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning']) }
  catch (error) { reject(`Could not confirm the configured signing identity: ${error instanceof Error ? error.message : String(error)}`) }
  const identities = [...inventory.stdout.matchAll(/^\s*\d+\)\s+([A-F0-9]{40})\s+"([^"\n]+)"\s*$/gmi)]
  const selected = identities.filter(match => match[1].toUpperCase() === fingerprint)
  if (selected.length !== 1) reject('The configured signing identity is not uniquely available and valid for codesigning.')
  if (local) { requireSigningPlan(local); return Object.freeze({ kind: 'certificate', profile: 'local', identity: fingerprint }) }
  const team = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/.exec(selected[0][2])
  if (!team) reject('The configured Developer ID Application identity is not uniquely available and valid.')
  return Object.freeze({ kind: 'certificate', identity: fingerprint, teamId: team[1] })
}

/** Verification uses the real signed output. It neither replaces nor weakens requirements. */
export async function verifyMacosSigning(appPath, plan, { run = runNative, bundleId = 'dev.agentmux.desktop' } = {}) {
  requireSigningPlan(plan)
  const verification = ['--verify', '--deep', '--strict', '--verbose=2']
  if (plan.kind === 'certificate') verification.push('--test-requirement',
    plan.profile === 'local' ? `=identifier "${bundleId}" and certificate leaf = H"${plan.identity}"` :
      `=identifier "${bundleId}" and anchor apple generic and certificate leaf[subject.OU] = "${plan.teamId}"`)
  await run('/usr/bin/codesign', [...verification, appPath])
  const metadataResult = await run('/usr/bin/codesign', ['--display', '--verbose=4', appPath])
  const metadata = `${metadataResult.stdout ?? ''}\n${metadataResult.stderr ?? ''}`
  if (!metadata.split('\n').includes(`Identifier=${bundleId}`)) reject('The signed candidate has an unexpected bundle identity.')
  const adhoc = /^Signature=adhoc$/m.test(metadata)
  if (plan.kind === 'ad-hoc') {
    if (!adhoc) reject('The development candidate did not report the requested ad hoc signature.')
    return Object.freeze({ kind: 'ad-hoc', authorizationContinuity: 'unverified', notarized: false })
  }
  if (adhoc || (plan.profile !== 'local' && (!/^Authority=Developer ID Application:/m.test(metadata) || !metadata.split('\n').includes(`TeamIdentifier=${plan.teamId}`)))) {
    reject('The signed candidate did not confirm the configured certificate-backed team identity.')
  }
  const result = await run('/usr/bin/codesign', ['--display', '--requirements', '-', appPath])
  const requirement = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split('\n').find(line => line.startsWith('designated => '))
  if (!requirement || /\bcdhash\b/i.test(requirement) ||
    /^designated\s*=>\s*\(*\s*identifier\s+"[^"\n]+"\s*\)*\s*$/.test(requirement)) {
    reject('The candidate default designated requirement could not be confirmed as certificate-backed.')
  }
  if (plan.profile === 'local' && !requirement.includes(`anchor H"${plan.identity.toLowerCase()}"`) && !requirement.includes(`anchor H"${plan.identity}"`)) {
    reject('The local candidate default requirement did not pin its original certificate anchor.')
  }
  return Object.freeze({ kind: 'certificate', ...(plan.profile === 'local' ? { profile: 'local', identity: plan.identity } : { teamId: plan.teamId }), designatedRequirement: requirement, authorizationContinuity: 'unverified', notarized: false })
}

/** Electron's maintained signer owns inside-out traversal; local runtime mode stays unchanged. */
export async function signMacosApplication(appPath, plan, { signer = sign } = {}) {
  requireSigningPlan(plan)
  // Core's manifest pins these already signed Runtime binaries byte for byte.
  const pinnedRuntimeBinaries = new Set(['ctxmux', 'ctxmuxd'].map(name => resolve(appPath,
    'Contents', 'Resources', 'app', 'node_modules', '@agentmux', 'core', 'vendor', 'ctxmux', 'darwin-arm64', 'bin', name)))
  const temporary = await mkdtemp(join(tmpdir(), 'agentmux-signing-'))
  try {
    const entitlements = join(temporary, 'empty-entitlements.plist')
    await writeFile(entitlements, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict/></plist>\n')
    await signer({ app: appPath, platform: 'darwin', identity: plan.kind === 'certificate' ? plan.identity : '-',
      ignore: file => pinnedRuntimeBinaries.has(resolve(file)),
      // osx-sign checks X.509 basic policy; our native preflight checks code-signing policy.
      identityValidation: plan.kind === 'certificate' && plan.profile !== 'local', strictVerify: true, preAutoEntitlements: false,
      preEmbedProvisioningProfile: false, optionsForFile: () => ({ hardenedRuntime: false, entitlements,
        ...(plan.kind === 'ad-hoc' || plan.profile === 'local' ? { timestamp: 'none' } : {}) }) })
  } finally { await rm(temporary, { recursive: true, force: true }) }
}
