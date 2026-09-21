import { mergeConfig } from 'vitest/config'
import config from '../../../../../vitest.config'

// Preserve compiled Core imports and the repository's dist freshness/setup guards.
export default mergeConfig(config, { test: { include: [
  'packages/core/test/control-settings-write-wait.test.ts',
  'packages/core/test/control-host.test.ts',
  'packages/core/test/control-socket-lifetime.test.ts',
  'packages/core/test/agentmux-cli-help.test.ts',
  'apps/desktop/test/settings-write-wait.test.ts',
  'apps/desktop/test/control-ipc-bridge.test.ts',
  'apps/desktop/test/config-owner-interleaving.test.ts',
  'apps/desktop/test/settings-control.test.ts',
  'apps/desktop/test/settings-browser-control.test.ts',
  'apps/desktop/test/settings-resources-control.test.ts',
  'apps/desktop/test/settings-workspace-add-control.test.ts',
  'apps/desktop/test/runtime-config-transaction.test.ts'
] } })
