import { registerHooks } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { credentialSource, credentialSources } from './credential-source.mjs'
const root = resolve(import.meta.dirname, '../../..')
registerHooks({
  resolve(specifier, context, next) {
    if (process.env.AGENTMUX_CREDENTIAL_COMPILED_ONLY) return next(specifier, context)
    let file
    if (specifier === '@agentmux/core') file = resolve(root, 'packages/core/src/index.ts')
    else if (specifier === '@agentmux/connectors') file = resolve(root, 'packages/connectors/src/index.ts')
    else if (specifier.startsWith('@agentmux/core/')) {
      const entry = JSON.parse(readFileSync(resolve(root, 'packages/core/package.json'), 'utf8')).exports['./' + specifier.slice('@agentmux/core/'.length)]?.import
      if (entry?.startsWith('./dist/')) file = resolve(root, 'packages/core/src', entry.slice(7).replace(/\.js$/u, '.ts'))
    } else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
      const candidate = resolve(dirname(fileURLToPath(context.parentURL)), specifier)
      if (candidate.endsWith('.js') && !existsSync(candidate) && existsSync(candidate.slice(0, -3) + '.ts')) file = candidate.slice(0, -3) + '.ts'
    }
    return file ? next(pathToFileURL(file).href, context) : next(specifier, context)
  },
  load(url, context, next) {
    const result = next(url, context)
    if (!url.startsWith('file:')) return result
    const path = fileURLToPath(url)
    let loaded
    if (process.env.AGENTMUX_CREDENTIAL_COMPILED_ONLY) {
      const source = path.replace('/packages/core/dist/', '/packages/core/src/').replace(/\.js$/u, '.ts')
      if (path.includes('/packages/core/dist/') && credentialSources.some(file => resolve(root, file) === source)) {
        const contents = String(result.source), hash = createHash('sha256').update(contents).digest('hex')
        loaded = { contents, receipt: { path: path.slice(root.length + 1), consumer: 'compiled-cli', pid: process.pid, originalSHA: hash, servedSHA: hash } }
      }
    } else loaded = credentialSource(root, path, result.source && String(result.source), 'node')
    if (!loaded) return result
    const trace = process.env.AGENTMUX_CREDENTIAL_SOURCE_REPORT
    const witness = trace ? "import { appendFileSync as __credentialLoad } from 'node:fs'; __credentialLoad(" + JSON.stringify(trace) + ', ' + JSON.stringify(JSON.stringify(loaded.receipt) + '\n') + ');\n' : ''
    const shebang = loaded.contents.startsWith('#!') ? loaded.contents.indexOf('\n') + 1 : 0
    return { ...result, source: loaded.contents.slice(0, shebang) + witness + loaded.contents.slice(shebang) }
  }
})
