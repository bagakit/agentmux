import { defineConfig } from 'vitest/config'
import { resolve, relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import shared from '../focus-card-identity/vitest.owning.config.mts'
const root = resolve(import.meta.dirname, '../../../../..')
export default defineConfig({ ...shared, cacheDir: resolve(root, '.tmp/agent-information-card/card-cache'),
  plugins: [...shared.plugins ?? [], { name: 'actual-shared-agent-information-card', enforce: 'pre', transform(code, id) {
    const path = relative(root, id.split('?')[0]!), mutation = process.env.AGENT_INFORMATION_MUTATION
    const changes = {
      details: ['AgentInformationPreview.tsx', '<AgentInformationDetails context={context} goalLinks={goalLinks} />', '<span />'],
      workspace: ['WorkspaceAgentRow.tsx', '{preview.preview}', '{null}'],
      host: ['AgentCommunicationRelations.tsx', 'page.hostId !== subject.hostId || ', '']
    } as const
    let served = code
    if (mutation) {
      const entry = changes[mutation as keyof typeof changes]
      if (!entry) throw Error('Unknown card mutation')
      if (path.endsWith('/' + entry[0])) {
        if (code.split(entry[1]).length !== 2) throw Error('One original card consumer required')
        served = code.replace(entry[1], entry[2])
      }
    }
    if (process.env.AGENT_INFORMATION_LOADED && path.startsWith('apps/desktop/src/renderer/src/')) appendFileSync(process.env.AGENT_INFORMATION_LOADED,
      JSON.stringify({ path, sourceSha256: createHash('sha256').update(code).digest('hex'), servedSha256: createHash('sha256').update(served).digest('hex'), mutated: code !== served }) + '\n')
    return served !== code ? { code: served, map: null } : undefined
  } }],
  test: { ...shared.test, include: ['apps/desktop/test/agent-information-card.test.tsx'], passWithNoTests: false, maxWorkers: 1, fileParallelism: false }
})
