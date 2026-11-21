import { registerHooks } from 'node:module'
import { appendFileSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve, relative, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const candidate = process.env.AMX_INFORMATION_CANDIDATE
if (!candidate) throw new Error('An exact private Agent information candidate is required.')
const manifests = Object.fromEntries(['core', 'providers'].map(name => [name,
  JSON.parse(readFileSync(join(candidate, name, 'package.json'), 'utf8'))]))
const hash = value => createHash('sha256').update(value).digest('hex')
const edits = process.env.AMX_INFORMATION_COMPILED_EDIT ? JSON.parse(process.env.AMX_INFORMATION_COMPILED_EDIT) : null
registerHooks({
  resolve(specifier, context, next) {
    for (const [name, manifest] of Object.entries(manifests)) {
      const prefix = '@agentmux/' + name
      if (specifier !== prefix && !specifier.startsWith(prefix + '/')) continue
      const key = specifier === prefix ? '.' : '.' + specifier.slice(prefix.length)
      const entry = manifest.exports?.[key]?.import
      if (!entry?.startsWith('./dist/')) throw new Error('The candidate package does not export: ' + specifier)
      return { url: pathToFileURL(resolve(candidate, name, entry)).href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    const result = next(url, context)
    if (!url.startsWith('file:')) return result
    const path = relative(candidate, fileURLToPath(url))
    if (!/^(?:core|providers)\/dist\/.+\.js$/u.test(path)) return result
    const original = typeof result.source === 'string' ? result.source : Buffer.from(result.source).toString('utf8')
    let source = original
    if (edits?.path === path) {
      if (source.split(edits.before).length !== 2) throw new Error('The compiled mutation must have one exact anchor: ' + edits.mutation)
      source = source.replace(edits.before, edits.after)
    }
    if (process.env.AMX_INFORMATION_COMPILED_LOADED) appendFileSync(process.env.AMX_INFORMATION_COMPILED_LOADED,
      JSON.stringify({ path, originalSHA256: hash(original), sha256: hash(source),
        ...(original === source ? {} : { mutation: edits.mutation }) }) + '\n')
    return source === original ? result : { ...result, source }
  }
})
