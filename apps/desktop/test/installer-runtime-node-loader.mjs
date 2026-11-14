import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import childProcess from 'node:child_process'

// Actual production children inherit this preload. A hidden development-tool
// dependency must fail, even on the verifier's fully provisioned workstation.
for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync']) {
  const original = childProcess[method]
  const observe = command => {
    const entry = { pid: process.pid, method, command: String(command) }
    if (process.env.INSTALLER_NATIVE_CALLS) appendFileSync(process.env.INSTALLER_NATIVE_CALLS, JSON.stringify(entry) + '\n')
    if (/(?:^|\/)(?:python[\d.]*|cc|clang|swift|swiftc|xcrun|node)$/.test(String(command)) && command !== process.execPath) {
      throw Error('Undeclared installer runtime dependency: ' + command)
    }
  }
  childProcess[method] = function (command, ...arguments_) { observe(command); return original.call(this, command, ...arguments_) }
  const custom = Symbol.for('nodejs.util.promisify.custom')
  if (original[custom]) childProcess[method][custom] = function (command, ...arguments_) {
    observe(command); return original[custom].call(this, command, ...arguments_)
  }
}
syncBuiltinESMExports()
registerHooks({ load(url, context, next) {
  const result = next(url, context)
  if (!url.endsWith('/scripts/package-native-observation.mjs')) return result
  let source = String(result.source)
  const originalSHA256 = createHash('sha256').update(source).digest('hex')
  const mutant = process.env.INSTALLER_NATIVE_MUTANT
  const anchors = {
    'mode-from-argv': ["selected.length === 0 ? 'gui' : selected.length === 1 && selected[0] === '31' ? 'node' : 'unknown'", "'gui'"],
    'wrong-kernel-code': ["cdHash: digest.toString('hex'), valid: true", "cdHash: '00'.repeat(20), valid: true"],
    'skip-cf-release': ['release(value); cleanup.push({ owner, released: true })', "cleanup.push({ owner, released: owner !== 'static-code' })"]
  }
  if (mutant) {
    const change = anchors[mutant]
    if (!change || source.split(change[0]).length !== 2) throw Error('Select one exact native installer reader mutation.')
    source = source.replace(change[0], change[1])
  }
  const receipt = { file: fileURLToPath(url), pid: process.pid, originalSHA256,
    loadedSHA256: createHash('sha256').update(source).digest('hex'), mutant: mutant ?? null }
  if (process.env.INSTALLER_NATIVE_LOADED) appendFileSync(process.env.INSTALLER_NATIVE_LOADED, JSON.stringify(receipt) + '\n')
  return { ...result, source }
} })
