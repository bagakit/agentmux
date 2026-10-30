import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { inspectRuntimeApplicationPayload, hashRuntimePayload } from './runtime-application-payload.mjs'
import { inspectElectronApplication, hashElectronArtifact } from './electron-application.mjs'
import { applicationBranding } from './macos-application-brand.mjs'

export async function hashTree(root, paths) {
  const hash = createHash('sha256')
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
      if (error.code === 'ENOTDIR') return null
      throw error
    })
    if (entries) {
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) await visit(join(path, entry.name))
    } else {
      hash.update(relative(root, path)); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0')
    }
  }
  for (const path of paths) await visit(join(root, path))
  return hash.digest('hex')
}

/** Native compatibility concerns only the artifact this host can load. */
export async function hashRuntimeArtifact(root, runtimeRelative) {
  return await hashTree(root, [join(runtimeRelative, `${process.platform}-${process.arch}`)])
}

export async function payloadUpdateIdentity(root) {
  const payload = await inspectRuntimeApplicationPayload(root), electron = await inspectElectronApplication(root)
  const compatibility = {
    runtime: await hashRuntimePayload(payload),
    electron: { version: electron.version, artifact: await hashElectronArtifact(electron.artifactRoot) },
    brand: process.platform === 'darwin' ? applicationBranding(payload.packageIdentity.compatibility.appVersion) : null
  }
  return {
    shell: createHash('sha256').update(JSON.stringify(compatibility)).digest('hex'),
    ctxmux: await hashRuntimeArtifact(root, 'packages/core/vendor/ctxmux')
  }
}
