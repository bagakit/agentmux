import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const PACKAGE_IDENTITY_FILENAME = 'package-identity.json'

export function createPackageIdentity({ sourceCommit, sourceTree, appVersion, platform, arch }) {
  const fields = { sourceCommit, sourceTree, appVersion, platform, arch }
  for (const [field, value] of Object.entries(fields)) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`Package identity field ${field} must be a non-empty string.`)
    }
  }
  return Object.freeze({
    schema: 'agentmux.package-identity.v1',
    sourceCommit,
    sourceTree,
    appVersion,
    platform,
    arch
  })
}

export function packageIdentityPath(appPath) {
  return join(appPath, 'Contents', 'Resources', 'app', PACKAGE_IDENTITY_FILENAME)
}

export function canonicalInstallPath(homeDirectory) {
  return join(homeDirectory, 'Applications', 'AgentMux.app')
}

/**
 * Every path at which macOS or the local development tooling can expose an
 * AgentMux bundle.  This is deliberately a finite list: a random `.app` is
 * not a supported installation source, but these known copies are the ones
 * that can make LaunchServices appear to have "lost" a feature.
 */
export function knownApplicationPaths({
  homeDirectory = homedir(),
  repositoryRoot = null,
  systemApplicationsRoot = '/Applications'
} = {}) {
  const paths = [
    { id: 'canonical-user', path: canonicalInstallPath(homeDirectory) },
    { id: 'system-applications', path: join(systemApplicationsRoot, 'AgentMux.app') }
  ]
  if (repositoryRoot) {
    paths.push(
      { id: 'release-candidate', path: join(repositoryRoot, 'apps', 'desktop', 'release', 'mac', 'AgentMux.app') },
      { id: 'development-cache', path: join(repositoryRoot, 'apps', 'desktop', 'node_modules', '.cache', 'agentmux-electron', 'AgentMux.app') }
    )
  }
  return paths
}

export async function readPackageIdentity(appPath) {
  const identity = JSON.parse(await readFile(packageIdentityPath(appPath), 'utf8'))
  return createPackageIdentity(identity)
}

export function assertPackageIdentity(actual, expected) {
  const expectedIdentity = createPackageIdentity(expected)
  for (const field of ['schema', 'sourceCommit', 'sourceTree', 'appVersion', 'platform', 'arch']) {
    if (actual[field] !== expectedIdentity[field]) {
      throw new Error(
        `Package identity mismatch for ${field}: expected ${expectedIdentity[field]}, got ${actual[field] ?? 'missing'}.`
      )
    }
  }
}
