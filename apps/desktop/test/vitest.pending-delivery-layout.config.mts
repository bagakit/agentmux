import base from '../scripts/fixtures/conversation-latest-auto/vitest.owning.config.mts'
import { defineConfig } from 'vitest/config'
import { relative } from 'node:path'
export default defineConfig({ ...base, cacheDir: '.cache/pending-delivery-layout',
  plugins: [...base.plugins!, { name: 'pending-layout-owner-mutation', enforce: 'pre', transform(code, id) {
    const file = relative(base.root!, id.split('?')[0]!)
    const mutation = process.env.AGENTMUX_PENDING_MUTATION
    if (!mutation) return
    const changes: Record<string, [string, string, string]> = {
      'drop-terminal-port': ['apps/desktop/src/renderer/src/lib/pending-delivery-layout.ts', 'let top = terminal ? readTerminalInputOverlapTop(terminal, popup) : undefined', 'let top: number | undefined = undefined'],
      'drop-interaction-anchor': ['apps/desktop/src/renderer/src/components/SessionPane.tsx', 'surfaceRef={interactionRef}', 'surfaceRef={undefined}'],
      'hidden-observation': ['apps/desktop/src/renderer/src/lib/pending-delivery-layout.ts', 'mutation.disconnect(); stopTerminal()', 'mutation.disconnect()'],
      'drop-composer-layout': ['apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx', 'pendingLayout={pendingLayout}', 'pendingLayout={undefined}']
    }
    const change = changes[mutation]
    if (!change) throw Error('Unknown pending layout mutation: ' + mutation)
    if (file !== change[0]) return
    if (code.split(change[1]).length !== 2) throw Error('Non-unique pending layout mutation: ' + mutation)
    return { code: code.replace(change[1], change[2]), map: null }
  } }],
  test: { ...base.test, environment: 'happy-dom',
    include: ['apps/desktop/test/semantic-icon-optimization-consumers.test.tsx', 'apps/desktop/test/pending-delivery-owner-wiring.test.tsx', 'apps/desktop/test/composer-pending-interaction-geometry.test.tsx', 'apps/desktop/test/composer-pending-layout-cost.test.tsx',
      'apps/desktop/test/composer-pending-delivery.integration.test.tsx', 'apps/desktop/test/terminal-view-control-observation.test.ts'] }
})
