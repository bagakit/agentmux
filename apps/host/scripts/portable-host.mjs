import { access, mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectPackageClosure } from '../../../scripts/package-dependencies.mjs'

const hostEntry = 'node_modules/@agentmux/host/dist/index.js'
const cliEntry = 'node_modules/@agentmux/host/node_modules/@agentmux/core/dist/agentmux.js'

export async function inspectPortableHost(packageRoot = resolve(import.meta.dirname, '..')) {
  const closure = await inspectPackageClosure(packageRoot), host = closure.packages[closure.root]
  if (host.name !== '@agentmux/host') throw new Error('The portable Host inventory requires its original Host package.')
  const coreId = host.dependencies.find(dependency => dependency.name === '@agentmux/core')?.packageId
  if (coreId == null) throw new Error('The portable Host requires its original Core dependency.')
  await access(join(host.sourceDirectory, 'dist/index.js'))
  await access(join(closure.packages[coreId].sourceDirectory, 'dist/agentmux.js'))
  return { schema: 'agentmux.portable-host-inventory.v1', minimumNodeMajor: 24,
    entries: { host: hostEntry, cli: cliEntry }, ...closure }
}

/** Uses the same nested dependency layout as the existing package materializer. */
export async function writePortableHostLaunchers(directory, nodePath) {
  if (!isAbsolute(nodePath) || /[\0\r\n]/u.test(nodePath)) throw new Error('Portable Host launchers require an explicit absolute Node executable.')
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const bin = join(directory, 'bin')
  await mkdir(bin, { recursive: true })
  for (const [name, entry] of [['agentmux-host', hostEntry], ['amux', cliEntry]]) {
    await writeFile(join(bin, name), '#!/bin/sh\nartifact_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec ' +
      quote(nodePath) + ' "$artifact_root/' + entry + '" "$@"\n', { mode: 0o755, flag: 'wx' })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, destination, nodePath] = process.argv.slice(2)
  if (operation === 'inventory' && destination && !nodePath) {
    const inventory = await inspectPortableHost()
    await writeFile(destination, JSON.stringify(inventory, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ inventory: destination, packages: inventory.packages.length, minimumNodeMajor: inventory.minimumNodeMajor }))
  } else if (operation === 'launchers' && destination && nodePath) await writePortableHostLaunchers(destination, nodePath)
  else throw new Error('Use inventory <output> or launchers <directory> <absolute-node>. Neither command installs or deploys packages.')
}
