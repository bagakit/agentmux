import { createHash } from 'node:crypto'
import { chmod, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import contract from '../dist/ctxmux-artifact-contract.json' with { type: 'json' }

const root = fileURLToPath(new URL('../vendor/ctxmux/', import.meta.url))
for (const [platform, manifestSha256] of Object.entries(contract.manifests)) {
  const directory = join(root, platform)
  const manifestBytes = await readFile(join(directory, 'manifest.json'))
  if (createHash('sha256').update(manifestBytes).digest('hex') !== manifestSha256) {
    throw new Error(`CtxMux installation manifest failed verification: ${platform}`)
  }
  const manifest = JSON.parse(manifestBytes.toString())
  if (manifest.binaries.length !== 2) throw new Error('CtxMux installation is missing native binaries.')
  for (const binary of manifest.binaries) {
    if (!['ctxmux', 'ctxmuxd'].includes(binary.name) || binary.path !== `bin/${binary.name}` || binary.mode !== '0755') {
      throw new Error('CtxMux installation manifest contains an invalid native executable.')
    }
    const path = join(directory, binary.path)
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size !== binary.bytes ||
      createHash('sha256').update(await readFile(path)).digest('hex') !== binary.sha256) {
      throw new Error(`CtxMux installation binary failed verification: ${platform}/${binary.name}`)
    }
    // npm normalizes ordinary packed files to 0644. Platform dispatchers are its bin entries;
    // restore only the verified native executables that those dispatchers invoke.
    await chmod(path, 0o755)
  }
}
