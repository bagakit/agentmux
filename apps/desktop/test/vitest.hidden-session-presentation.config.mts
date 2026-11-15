import { defineConfig } from 'vitest/config'
import base from './vitest.mote-context.config.mts'

const inverses = {
  'parent-refresh': ['/components/SessionPane.tsx', 'const PaneAgentComposer = memo(AgentSessionComposer)',
    'const PaneAgentComposer = AgentSessionComposer'],
  'status-clock': ['/components/AgentSessionComposer.tsx', 'processState, state: status.state,',
    'processState, state: status.state, observedAt: status.observedAt,']
} as const
const inverse = process.env.AGENTMUX_COMPOSER_PRESENTATION_INVERSE as keyof typeof inverses | undefined
if (inverse && !inverses[inverse]) throw new Error(`Unknown Composer presentation inverse ${inverse}`)

export default defineConfig({
  ...base,
  plugins: [...(base.plugins ?? []), {
    name: 'composer-presentation-inverse',
    enforce: 'pre',
    transform(code, id) {
      if (!inverse) return
      const [suffix, before, after] = inverses[inverse]
      if (!id.endsWith(suffix)) return
      if (code.split(before).length !== 2) throw new Error(`Expected one Composer presentation boundary for ${inverse}`)
      return { code: code.replace(before, after), map: null }
    }
  }],
  test: { ...base.test, include: [
    'apps/desktop/test/hidden-session-presentation.test.tsx',
    'apps/desktop/test/agent-session-composer.test.tsx',
    'apps/desktop/test/composer-send-while-request-pending.test.ts'
  ], passWithNoTests: false }
})
