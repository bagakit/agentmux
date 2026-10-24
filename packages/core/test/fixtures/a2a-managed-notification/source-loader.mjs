import * as owner from '../a2a-resumed-inbox/source-loader.mjs'
import { readFile } from 'node:fs/promises'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { transformManagedNotificationSource } from './mutations.mjs'

export const resolve = owner.resolve
export async function load(url, context, next) {
  const result = await owner.load(url, context, next)
  if (!url.startsWith('file:') || !url.endsWith('.ts')) return result
  const path = relative(resolvePath(import.meta.dirname, '../../../../..'), fileURLToPath(url))
  if (!path.startsWith('packages/') || path.includes('/node_modules/')) return result
  const source = await readFile(fileURLToPath(url), 'utf8')
  const code = transformManagedNotificationSource(source, path, process.env.AGENTMUX_MANAGED_NOTIFICATION_MUTATION)
  if (process.env.AGENTMUX_MANAGED_NOTIFICATION_CLI_LOADED) {
    const hash = text => createHash('sha256').update(text).digest('hex')
    appendFileSync(process.env.AGENTMUX_MANAGED_NOTIFICATION_CLI_LOADED, JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code),
      ...(code === source ? {} : { mutation: process.env.AGENTMUX_MANAGED_NOTIFICATION_MUTATION }) }) + '\n')
  }
  if (code === source) return result
  const { stripTypeScriptTypes } = await import('node:module')
  return { ...result, source: stripTypeScriptTypes(code, { mode: 'transform', sourceUrl: url }) }
}
