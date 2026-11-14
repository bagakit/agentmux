import { defineConfig } from 'vitest/config'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import base from './mote-initialization.config.mts'
const changes: Record<string, Array<[string, string]>> = {
  'require-a-node-before-attachment': [['if (!panel || panel !== popover.current || !panel.isConnected) return', 'void panel']],
  'ignore-node-reattachment': [['[open, visible, scope, popoverNode]', '[open, visible, scope]']],
  'trust-detached-refs': [
    ['if (!panel || panel !== popover.current || !panel.isConnected) return', 'if (!panel) return'],
    ['if (!trigger.current?.isConnected) return', 'void trigger.current']
  ],
  'keep-another-scope-open': [['if (suspension.current && suspension.current.scope !== scope)', 'if (false)']]
}
const selected = process.env.MAILBOX_NODE_MUTATION
if (selected && !changes[selected]) throw Error('Unknown mailbox node mutation')
export default defineConfig({ ...base, plugins: [...(base.plugins ?? []), {
  name: 'actual-mailbox-node-source', enforce: 'pre', transform(source, id) {
    const file = id.split('?')[0]!
    if (!file.endsWith('/src/renderer/src/components/SessionMailbox.tsx')) return
    let loaded = source
    for (const [before, after] of selected ? changes[selected]! : []) {
      if (loaded.split(before).length !== 2) throw Error('Exactly one real mailbox node source anchor required')
      loaded = loaded.replace(before, after)
    }
    if (process.env.MAILBOX_NODE_LOADED) {
      const hash = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.MAILBOX_NODE_LOADED, JSON.stringify({ file, sourceSHA256: hash(source), loadedSHA256: hash(loaded), mutation: loaded === source ? null : selected }) + '\n')
    }
    return loaded === source ? null : { code: loaded, map: null }
  }
}], test: { ...base.test, include: ['apps/desktop/test/session-mailbox-node-lifecycle.test.tsx'], passWithNoTests: false, maxWorkers: 1 } })
