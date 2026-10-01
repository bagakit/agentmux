import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'
const repository = resolve(import.meta.dirname, '../../../../..')
export const sourceAliases = [
  { find: "@agentmux/core/continuous-progress-scheduler", replacement: resolve(repository, "packages/core/src/continuous-progress-scheduler.ts") },
  { find: "@agentmux/core/workbench-layout-preset", replacement: resolve(repository, "packages/core/src/workbench-layout-preset.ts") },
  { find: "@agentmux/core/agent-interaction-state", replacement: resolve(repository, "packages/core/src/agent-interaction-state.ts") },
  { find: "@agentmux/core/agent-outbound-message", replacement: resolve(repository, "packages/core/src/agent-outbound-message.ts") },
  { find: "@agentmux/core/session-user-messages", replacement: resolve(repository, "packages/core/src/session-user-messages.ts") },
  { find: "@agentmux/core/terminal-continuation", replacement: resolve(repository, "packages/core/src/terminal-continuation.ts") },
  { find: "@agentmux/core/agent-message-render", replacement: resolve(repository, "packages/core/src/agent-message-render.ts") },
  { find: "@agentmux/core/agent-prompt-budget", replacement: resolve(repository, "packages/core/src/agent-prompt-budget.ts") },
  { find: "@agentmux/core/continuous-progress", replacement: resolve(repository, "packages/core/src/continuous-progress.ts") },
  { find: "@agentmux/core/agent-session-id", replacement: resolve(repository, "packages/core/src/agent-session-id.ts") },
  { find: "@agentmux/core/prompt-condition", replacement: resolve(repository, "packages/core/src/agent-prompt-condition.ts") },
  { find: "@agentmux/core/bracketed-paste", replacement: resolve(repository, "packages/core/src/bracketed-paste.ts") },
  { find: "@agentmux/core/launch-option", replacement: resolve(repository, "packages/core/src/agent-launch-option.ts") },
  { find: "@agentmux/core/agent-status", replacement: resolve(repository, "packages/core/src/agent-status-freshness.ts") },
  { find: "@agentmux/core/provider-id", replacement: resolve(repository, "packages/core/src/agent-provider-id.ts") },
  { find: "@agentmux/core/run-status", replacement: resolve(repository, "packages/core/src/agent-run-status.ts") },
  { find: "@agentmux/core/risk-tier", replacement: resolve(repository, "packages/core/src/risk-tier.ts") },
  { find: "@agentmux/core/timeline", replacement: resolve(repository, "packages/core/src/session-timeline.ts") },
  { find: "@agentmux/core/runtime", replacement: resolve(repository, "packages/core/src/runtime.ts") },
  { find: "@agentmux/core/control", replacement: resolve(repository, "packages/core/src/control.ts") },
  { find: "@agentmux/demand/store", replacement: resolve(repository, "packages/demand/src/demand-store.ts") },
  { find: "@agentmux/demand/types", replacement: resolve(repository, "packages/demand/src/demand-types.ts") },
  { find: "@agentmux/demand/goals", replacement: resolve(repository, "packages/demand/src/goals.ts") },
  { find: "@agentmux/demand/cli", replacement: resolve(repository, "packages/demand/src/cli.ts") },
  { find: "@agentmux/demand", replacement: resolve(repository, "packages/demand/src/index.ts") },
  { find: "@agentmux/layout", replacement: resolve(repository, "packages/layout/src/index.ts") },
  { find: "@agentmux/core", replacement: resolve(repository, "packages/core/src/index.ts") }
]
export default defineConfig({
 root: repository, resolve: { alias: sourceAliases }, define: { __AGENTMUX_WEB_PREVIEW__: 'true' },
 test: { include: ['apps/desktop/test/bookmark*.test.ts', 'apps/desktop/test/browser-toolbar.test.tsx', 'apps/desktop/test/workbench-persistence.test.ts'],
 setupFiles: [resolve(repository, 'vitest.setup.ts')], passWithNoTests: false, maxWorkers: 1, fileParallelism: false, testTimeout: 20000 },
 cacheDir: resolve(repository, '.tmp/bookmark-maintenance/cache')
})
