import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const owner = 'apps/desktop/src/renderer/src/components/TerminalMenuTools.tsx'
await verifyRendererSourceMutations({
  name: 'terminal-menu-density',
  owningConfig: 'apps/desktop/test/vitest.terminal-menu-density.config.mts',
  tests: ['apps/desktop/test/terminal-menu-density.test.tsx', 'apps/desktop/test/terminal-region-menu-consumer.test.tsx'],
  sources: ['vitest.config.ts', 'vitest.dist-freshness.ts', owner, 'apps/desktop/src/renderer/src/components/TerminalContextMenu.tsx',
    'apps/desktop/src/renderer/src/components/WorkbenchMenuSubmenu.tsx',
    'apps/desktop/src/renderer/src/lib/terminal-selection-mode.ts'],
  mutations: [
    { label: 'terminal-information-must-retain-complete-history-boundary', file: owner,
      before: '{props.historyBoundary ? <Menu.Label className="tab-context-menu__hint" role="note">{props.historyBoundary}</Menu.Label> : null}',
      after: '{null}' },
    { label: 'visible-output-copy-must-keep-original-buffer-callback', file: owner,
      before: "{ name: 'Copy visible output', label: 'Copy visible output', icon: <Copy size={16} />, onSelect: props.onCopyViewport }",
      after: "{ name: 'Copy visible output', label: 'Copy visible output', icon: <Copy size={16} />, onSelect: props.onCopy }" }
  ]
})
