import { access, lstat, mkdir, readFile, readdir, readlink, realpath, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inspectPackageClosure, materializePackageClosure } from '../../../scripts/package-dependencies.mjs'

const hostEntry = 'node_modules/@agentmux/host/dist/index.js'
const cliEntry = 'node_modules/@agentmux/host/node_modules/@agentmux/core/dist/agentmux.js'
const selectedNode = path => { if (!isAbsolute(path) || /[\0\r\n]/u.test(path)) throw new Error('Portable Host launchers require an explicit absolute Node executable.') }

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
  selectedNode(nodePath)
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
  const bin = join(directory, 'bin')
  await mkdir(bin, { recursive: true })
  for (const [name, entry] of [['agentmux-host', hostEntry], ['amux', cliEntry]]) {
    await writeFile(join(bin, name), '#!/bin/sh\nartifact_root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)\nexec ' +
      quote(nodePath) + ' "$artifact_root/' + entry + '" "$@"\n', { mode: 0o755, flag: 'wx' })
  }
}

/** Offline artifact assembly only. Does not install, launch or replace any Host. */
export async function assemblePortableHost(directory, nodePath, packageRoot = resolve(import.meta.dirname, '..')) {
  selectedNode(nodePath)
  const inventory = await inspectPortableHost(packageRoot)
  const { stdout } = await promisify(execFile)(nodePath, ['--print', 'JSON.stringify({node:process.versions.node,platform:process.platform,arch:process.arch})'])
  const runtime = JSON.parse(stdout)
  if (Number(runtime.node.split('.')[0]) < inventory.minimumNodeMajor) throw new Error('The portable Host requires the selected Node 24 or newer.')
  const packages = await materializePackageClosure(inventory, directory)
  await writePortableHostLaunchers(directory, nodePath)
  const host = join(directory, 'node_modules', '@agentmux', 'host')
  const core = join(host, 'node_modules', '@agentmux', 'core')
  // The original Core verifier checks its complete Native contract and restores
  // only the verified executable bits in this new artifact.
  await promisify(execFile)(nodePath, [join(core, 'bin', 'install-ctxmux.mjs')])
  await access(join(host, 'resources', 'bin', 'agentmux-workspace-move'))
  const files = []
  const visit = async directoryPath => {
    for (const entry of (await readdir(directoryPath)).sort()) {
      const path = join(directoryPath, entry), info = await lstat(path), name = relative(directory, path).split(sep).join('/')
      if (info.isDirectory()) await visit(path)
      else if (info.isSymbolicLink()) {
        const target = await readlink(path), actual = relative(directory, await realpath(path))
        if (isAbsolute(target) || actual === '..' || actual.startsWith('..' + sep) || isAbsolute(actual)) throw new Error('The portable Host has a dependency link outside its artifact.')
        files.push({ path: name, target })
      } else if (info.isFile()) files.push({ path: name, sha256: createHash('sha256').update(await readFile(path)).digest('hex'), mode: info.mode & 0o777 })
      else throw new Error('The portable Host contains an unsupported artifact entry.')
    }
  }
  await visit(directory)
  const result = { schema: 'agentmux.portable-host-artifact.v1', minimumNodeMajor: inventory.minimumNodeMajor,
    runtime, entries: inventory.entries, packages, files, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') }
  await writeFile(join(directory, 'portable-host.json'), JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  return result
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [operation, destination, nodePath] = process.argv.slice(2)
  if (operation === 'inventory' && destination && !nodePath) {
    const inventory = await inspectPortableHost()
    await writeFile(destination, JSON.stringify(inventory, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    console.log(JSON.stringify({ inventory: destination, packages: inventory.packages.length, minimumNodeMajor: inventory.minimumNodeMajor }))
  } else if (operation === 'launchers' && destination && nodePath) await writePortableHostLaunchers(destination, nodePath)
  else if (operation === 'assemble' && destination && nodePath) {
    const artifact = await assemblePortableHost(destination, nodePath)
    console.log(JSON.stringify({ directory: destination, digest: artifact.digest, runtime: artifact.runtime, packages: artifact.packages.length }))
  } else throw new Error('Use inventory <output>, launchers <directory> <absolute-node>, or assemble <new-directory> <absolute-node>. These commands do not install or deploy a Host.')
}
