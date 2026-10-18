import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { defineConfig } from 'vitest/config'
import original from '../../../vitest.config.ts'

const root = resolve(import.meta.dirname, '../../..')
const mutation = process.env.AGENTMUX_IDENTITY_LIBRARY_MUTATION
if (mutation && !['hide-setup', 'allow-incomplete-choice', 'delete-other-identity', 'observer-steals-confirmed-read'].includes(mutation)) throw Error('Unknown identity library mutation')
export default defineConfig({ ...original, root, cacheDir: resolve(root, '.cache/connection-identity-library'),
  plugins: [{ name: 'original-identity-consumer-mutations', enforce: 'pre', transform(source, id) {
    const file = relative(root, id.split('?')[0]!)
    if (!['apps/desktop/src/renderer/src/components/settings/ConnectionIdentityFacts.tsx', 'apps/desktop/src/renderer/src/components/MoteConnectionIdentity.tsx', 'apps/desktop/src/renderer/src/components/settings/ConnectionIdentityRemoval.tsx', 'apps/desktop/src/renderer/src/lib/use-mote-bot-setup.ts'].includes(file)) return
    let code = source, applied: string | null = null
    if (mutation === 'hide-setup' && file.endsWith('/ConnectionIdentityFacts.tsx')) {
      const anchor = '{connectionInitialSetupLabel(record)}'
      if (source.split(anchor).length !== 3) throw Error('Missing both actual identity setup consumers')
      code = source.replaceAll(anchor, '{connectionSummary(record)}'); applied = mutation
    }
    if (mutation === 'allow-incomplete-choice' && file.endsWith('/MoteConnectionIdentity.tsx')) {
      const anchor = 'disabled: !item.config.enabled || connectionNeedsInitialSetup(item)'
      if (source.split(anchor).length !== 2) throw Error('Missing actual Mote identity eligibility consumer')
      code = source.replace(anchor, 'disabled: !item.config.enabled'); applied = mutation
    }
    if (mutation === 'delete-other-identity' && file.endsWith('/ConnectionIdentityRemoval.tsx')) {
      const anchor = 'connectionId: request.scope.connectionId'
      if (source.split(anchor).length !== 2) throw Error('Missing actual identity removal target consumer')
      code = source.replace(anchor, 'connectionId: "unfinished-identity"'); applied = mutation
    }
    if (mutation === 'observer-steals-confirmed-read' && file.endsWith('/use-mote-bot-setup.ts')) {
      const anchor = 'const observation = enrollmentRead.current\n        const value = await api.connections.call'
      if (source.split(anchor).length !== 2) throw Error('Missing actual background enrollment observer')
      code = source.replace(anchor, 'const observation = ++enrollmentRead.current\n        const value = await api.connections.call'); applied = mutation
    }
    if (process.env.AGENTMUX_IDENTITY_LIBRARY_LOADED) {
      const sha = (value: string) => createHash('sha256').update(value).digest('hex')
      appendFileSync(process.env.AGENTMUX_IDENTITY_LIBRARY_LOADED, JSON.stringify({ file, originalSHA256: sha(source), sha256: sha(code), mutation: applied }) + '\n')
    }
    return code === source ? undefined : { code, map: null }
  } }], test: { ...original.test, include: ['apps/desktop/test/connection-identity-library.test.tsx', 'apps/desktop/test/connector-identity-cards.test.tsx'], fileParallelism: false, passWithNoTests: false, testTimeout: 20000 }
})
