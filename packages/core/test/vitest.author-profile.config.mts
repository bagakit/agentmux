import { defineConfig } from 'vitest/config'
import original from './vitest.input-image.config.mts'
import { relative } from 'node:path'
import { appendFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
const changes: Record<string, [string, string, string]> = {
  'drop-profile': ['apps/host/src/public-author-profile.ts', 'return result.name || result.avatar ? parsePreparedAuthorProfile(result) : undefined', 'return undefined'],
  'freeze-media-failure': ['packages/connectors/src/publication-store.ts', "IN ('confirmed','dispatching')", "IN ('confirmed','dispatching','unknown')"]
}
export default defineConfig({ ...original, cacheDir: '.cache/author-profile', plugins: [...(original.plugins ?? []), {
  name: 'qualified-author-profile', enforce: 'pre', transform(code, id) {
    const path = relative(original.root!, id.split('?')[0]!), sourceSHA = createHash('sha256').update(code).digest('hex')
    const mutation = process.env.AGENTMUX_TEST_PROFILE_MUTATION, change = mutation && changes[mutation]
    if (mutation && !change) throw Error('Unknown profile mutation')
    if (change && path === change[0]) {
      if (code.split(change[1]).length !== 2) throw Error('Profile mutation anchor must be unique')
      code = code.replace(change[1], change[2])
      if (mutation === 'freeze-media-failure') {
        const anchor = "previous.avatarUploads!.at(-1)!.state === 'confirmed' || inFlight?.(previous.operationId, previous.avatarUploads!.length)"
        if (code.split(anchor).length !== 2) throw Error('Original cache eligibility anchor must be unique')
        code = code.replace(anchor, "previous.avatarUploads!.at(-1)!.state !== 'dispatching' || inFlight?.(previous.operationId, previous.avatarUploads!.length)")
      }
    }
    if (process.env.AGENTMUX_TEST_PROFILE_LOADED && /^(packages|apps)\//u.test(path)) appendFileSync(process.env.AGENTMUX_TEST_PROFILE_LOADED,
      JSON.stringify({ path, sourceSHA, loadedSHA: createHash('sha256').update(code).digest('hex'), transformed: change && path === change[0] }) + '\n')
    return change && path === change[0] ? { code, map: null } : undefined
  }
}], test: { ...original.test, include: process.env.AGENTMUX_TEST_PROFILE_CARDS === '1' ? ['packages/connectors/test/feishu-role-card.test.ts','packages/connectors/test/feishu-publication.test.ts'] : process.env.AGENTMUX_TEST_PROFILE_HOST === '1' ? ['apps/host/test/author-profile-publication-consumer.test.ts'] : process.env.AGENTMUX_TEST_PROFILE_APP === '1'
  ? ['apps/desktop/test/agent-explicit-steer.test.tsx'] : ['packages/core/test/author-profile-consumer.test.ts'], passWithNoTests: false } })
