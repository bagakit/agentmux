import base from './vitest.hook-environment.config.mts'
import { defineConfig } from 'vitest/config'
export default defineConfig({ ...base, test: { ...base.test, include: [
  'packages/core/test/agent-provider.test.ts',
  'packages/core/test/managed-hook-installer.test.ts',
  'packages/core/test/managed-hook-inspection.test.ts',
  'packages/core/test/hook-config-merge.test.ts',
  'packages/core/test/provider-managed-hook-contribution.test.ts',
  'packages/core/test/provider-hook-timeout-source.test.ts',
  'packages/core/test/provider-event-name-source.test.ts',
  'packages/core/test/hook-delivery-recovery.test.ts',
  'packages/core/test/agent-hook-command.test.ts',
  'packages/core/test/managed-hook-bridge.test.ts',
  'packages/core/test/launch-scoped-hook-environment.test.ts',
  'packages/core/test/doctor-hook-installation.test.ts',
  'packages/core/test/agentmux-cli-doctor.test.ts',
  'packages/core/test/providers/gemini.test.ts',
  'packages/core/test/providers/cursor.test.ts',
  'packages/core/test/providers/copilot.test.ts',
  'packages/core/test/providers/droid.test.ts',
  'packages/core/test/providers/hermes.test.ts',
  'packages/core/test/providers/pi.test.ts'
], testTimeout: 60000, hookTimeout: 30000 } })
