import base from './toolkit-tui-ui.config.mts'
import { resolve } from 'node:path'

const mutation = process.env.AGENTMUX_TUI_UI_MUTATION
export default { ...base,
  resolve: { ...base.resolve, alias: [
    { find: /^@agentmux\/connectors$/, replacement: resolve(import.meta.dirname, '../../../packages/connectors/src/index.ts') },
    ...base.resolve.alias
  ] },
  test: { ...base.test,
  include: ['apps/desktop/test/terminal-initial-observation-recovery.test.tsx', 'apps/desktop/test/toolkit-tui-ui.test.tsx'],
  testNamePattern: mutation === 'check-lifetime' ? 'retires a pending Check status'
    : mutation === 'check-target' ? 'does not redirect a pending Check status'
    : mutation === 'observation-refresh' ? 'Toolkit Check status reconnects'
    : 'Toolkit Check status|TUI toolkit product presentation',
  passWithNoTests: false
} }
