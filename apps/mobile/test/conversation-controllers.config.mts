import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import base from '../vitest.config'
import owning from '../../desktop/scripts/fixtures/mote-navigation-footer/vitest.owning.config.mts'
import { assertWorkspaceDistBuiltFromCurrentSource, staleDistComplaint } from '../../../vitest.dist-freshness'

const repository = resolve(import.meta.dirname, '../../..')
const mutant = process.env.AGENTMUX_MOBILE_CONTROLLER_MUTANT
  ? JSON.parse(process.env.AGENTMUX_MOBILE_CONTROLLER_MUTANT) as { file: string; before: string; after: string } : undefined
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
export default {
  ...base,
  root: resolve(repository, 'apps/mobile'),
  resolve: { ...base.resolve, ...owning.resolve, alias: [
    { find: /^@agentmux\/identity\/runtime-source$/, replacement: resolve(repository, 'packages/identity/dist/runtime-source.js') },
    ...(owning.resolve!.alias as Array<{ find: string | RegExp; replacement: string }>)
  ] },
  plugins: [...base.plugins!, { name: 'mobile-controller-qualified-identity', async configResolved() {
    const complaint = await staleDistComplaint(resolve(repository, 'packages/identity'), 'dist/runtime-source.js')
    if (complaint) throw new Error(complaint)
    await assertWorkspaceDistBuiltFromCurrentSource(repository)
  } }, { name: 'mobile-controller-source-proof', enforce: 'pre' as const, transform(code: string, id: string) {
    const file = relative(repository, id.split('?')[0]!), proof = process.env.AGENTMUX_MOBILE_CONTROLLER_PROOF
    if (proof && /^(apps\/mobile\/src\/|packages\/)/.test(file)) {
      appendFileSync(proof, JSON.stringify({ file, sha256: sha(code) }) + '\n')
    }
    if (file === mutant?.file) {
      if (code.split(mutant.before).length !== 2) throw new Error('One exact implementation block is required')
      const changed = code.replace(mutant.before, mutant.after)
      if (proof) appendFileSync(proof, JSON.stringify({ file, mutation: true, before: sha(code), after: sha(changed) }) + '\n')
      return changed
    }
  } }],
  test: { ...base.test, include: ['test/manual-input-receipt.test.tsx', 'test/concurrent-drafts.test.tsx',
    'test/conversation-protocol-consumer.test.tsx', 'test/mobile-input-history.test.tsx', 'test/mobile-send-capability.test.tsx', 'test/conversation-surface.test.tsx'], passWithNoTests: false, maxWorkers: 1 }
}
