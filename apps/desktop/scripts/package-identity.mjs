import { readFile } from 'node:fs/promises'
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
