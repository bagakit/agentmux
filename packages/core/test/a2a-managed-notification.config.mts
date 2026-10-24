import { defineConfig } from 'vitest/config'
import { relative, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { appendFileSync } from 'node:fs'
import sourceOwnerConfig from './a2a-resumed-inbox.config.mts'
import { transformManagedNotificationSource } from './fixtures/a2a-managed-notification/mutations.mjs'

const root = resolve(import.meta.dirname, '../../..')

export default defineConfig({ ...sourceOwnerConfig,
  plugins: [{ name: 'managed-notification-source', enforce: 'pre', transform(source, id) {
    const path = relative(root, id.split('?')[0]!)
    if (!path.startsWith('packages/') || !path.endsWith('.ts')) return
    const code = transformManagedNotificationSource(source, path, process.env.AGENTMUX_MANAGED_NOTIFICATION_MUTATION)
    const hash = (text: string) => createHash('sha256').update(text).digest('hex')
    if (process.env.AGENTMUX_MANAGED_NOTIFICATION_LOADED) appendFileSync(process.env.AGENTMUX_MANAGED_NOTIFICATION_LOADED,
      JSON.stringify({ path, originalSHA256: hash(source), sha256: hash(code), ...(source === code ? {} : { mutation: process.env.AGENTMUX_MANAGED_NOTIFICATION_MUTATION }) }) + '\n')
    if (code !== source) return { code, map: null }
  } }, ...(sourceOwnerConfig.plugins ?? [])],
  test: { ...sourceOwnerConfig.test,
  include: ['packages/core/test/a2a-managed-notification.test.ts'], passWithNoTests: false } })
