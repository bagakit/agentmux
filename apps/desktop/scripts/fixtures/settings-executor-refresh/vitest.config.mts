import { mergeConfig } from 'vitest/config'
import config from '../../../../../vitest.config'

// Keep the production compiled imports, dist freshness and repository setup intact.
export default mergeConfig(config, { test: { include: [
  'packages/core/test/control-settings-executor-refresh.test.ts',
  'apps/desktop/test/settings-executor-refresh-control.test.ts',
  'apps/desktop/test/settings-executor-refresh-input.test.tsx',
  'packages/core/test/client-executor-availability.test.ts',
  'packages/core/test/doctor.test.ts',
  'packages/core/test/doctor-unverifiable-vs-missing.test.ts',
  'packages/core/test/doctor-hook-installation.test.ts',
  'packages/core/test/agentmux-cli-doctor.test.ts',
  'apps/desktop/test/runtime-controller.test.ts',
  'apps/desktop/test/agent-settings-pane.test.tsx',
  'packages/core/test/control-host.test.ts',
  'packages/core/test/agentmux-cli-help.test.ts'
] } })
