import { registerHooks } from 'node:module'
import { existsSync, readFileSync, appendFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
const root = resolve(import.meta.dirname, '../../..')
const manifest = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports
const observed = /^(?:packages\/core\/src\/(?:mobile-web(?:-codec)?|client-incident|public-rpc-service|public-rpc-server|rpc-native-codec|spatial-state|space-control-parser)\.ts|apps\/host\/src\/(?:host|mobile-assets(?:-owner)?)\.ts|apps\/desktop\/src\/main\/(?:desktop-host|runtime-controller|client-incident-archive|mobile-web-report-owner)\.ts|apps\/desktop\/src\/shared\/space-addresses\.ts)$/u
const mutants = {
  'main-route': ['packages/core/src/public-rpc-service.ts', "if (this.ports.callOriginalCore) return parseMobileAssetsResult(method, await this.ports.callOriginalCore(target.hostId, 'app.mobile.assets.activate'", "if (false) return parseMobileAssetsResult(method, await this.ports.callOriginalCore(target.hostId, 'app.mobile.assets.activate'"],
  'manifest-hash': ['apps/host/src/mobile-assets.ts', "mobileDigest(bytes) !== file.digest", 'false'],
  'report-forward': ['packages/core/src/public-rpc-service.ts', "await this.ports.forwardControl('app.mobile.report', input, context)", 'undefined'],
  'report-producer': ['apps/desktop/src/main/mobile-web-report-owner.ts', 'devicePrincipalId, documentId: input.documentId, buildId:', "devicePrincipalId: 'wrong-original-device', documentId: input.documentId, buildId:"]
}
const mutant = process.env.MOBILE_WEB_TEST_MUTANT
if (mutant && !Object.hasOwn(mutants, mutant)) throw Error('Unknown mobile Web mutation')
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'electron') return { url: 'data:text/javascript,export const app={getAppMetrics:()=>[]};export const nativeImage={};export const clipboard={};export const shell={};export const Menu={};export const webContents={};', shortCircuit: true }
    let file
    if (specifier === '@agentmux/core') file = resolve(root, 'packages/core/src/index.ts')
    else if (specifier === '@agentmux/connectors') file = resolve(root, 'packages/connectors/src/index.ts')
    else if (specifier.startsWith('@agentmux/host/')) {
      const entry = JSON.parse(readFileSync(resolve(root, 'apps/host/package.json'), 'utf8')).exports['./' + specifier.slice('@agentmux/host/'.length)]?.import
      if (entry?.startsWith('./dist/')) file = resolve(root, 'apps/host/src', entry.slice(7).replace(/\.js$/u, '.ts'))
    }
    else if (specifier.startsWith('@agentmux/client-ui/')) {
      const entries = JSON.parse(readFileSync(resolve(root, 'packages/client-ui/package.json'), 'utf8')).exports
      const key = './' + specifier.slice('@agentmux/client-ui/'.length)
      const entry = entries[key]?.types ?? entries['./*']?.types.replace('*', key.slice(2))
      if (entry?.startsWith('./src/')) file = resolve(root, 'packages/client-ui', entry)
    }
    else if (specifier.startsWith('@agentmux/core/')) {
      const entry = manifest['./' + specifier.slice('@agentmux/core/'.length)]?.import
      if (entry?.startsWith('./dist/')) file = resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
    } else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const candidate = resolve(dirname(fileURLToPath(context.parentURL)), specifier)
      if (candidate.endsWith('.js') && !existsSync(candidate) && existsSync(candidate.slice(0, -3) + '.ts')) file = candidate.slice(0, -3) + '.ts'
      else if (!existsSync(candidate) && existsSync(candidate + '.ts')) file = candidate + '.ts'
    }
    return file ? next(pathToFileURL(file).href, context) : next(specifier, context)
  },
  load(url, context, next) {
    const result = next(url, context)
    if (!url.startsWith('file:')) return result
    const path = relative(root, fileURLToPath(url))
    if (!observed.test(path)) return result
    const original = String(result.source); let source = original
    if (mutant && mutants[mutant][0] === path) {
      const [, anchor, replacement] = mutants[mutant]
      if (source.split(anchor).length !== 2) throw Error('Mobile Web mutant must match exactly one loaded owner: ' + mutant)
      source = source.replace(anchor, replacement)
    }
    const hash = value => createHash('sha256').update(value).digest('hex')
    const receipt = { path, pid: process.pid, originalSHA256: hash(original), loadedSHA256: hash(source), ...(source === original ? {} : { mutant }) }
    const report = process.env.MOBILE_WEB_TEST_LOADED
    if (report) source = "import { appendFileSync as __mobileLoaded } from 'node:fs'; __mobileLoaded(" + JSON.stringify(report) + ', ' + JSON.stringify(JSON.stringify(receipt) + '\n') + ');\n' + source
    return { ...result, source }
  }
})
