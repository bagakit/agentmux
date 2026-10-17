import { verifyRendererSourceMutations } from './lib/verify-renderer-source-mutations.mjs'

const launcher = 'apps/desktop/src/renderer/src/components/NewTabSurface.tsx'
const surface = 'apps/desktop/src/renderer/src/components/SurfaceState.tsx'
const mote = 'apps/desktop/src/renderer/src/components/LauncherMoteAction.tsx'
const secondary = 'apps/desktop/src/renderer/src/components/LauncherSecondarySurfaces.tsx'

// These mounted consumers edit the real rich input, submit through the original launch owner,
// queue through the original Mote input owner and exercise each retained utility action.
// The runner proves the modified source was loaded, then restores GREEN in a private copy.
await verifyRendererSourceMutations({
  name: 'space-launcher',
  tests: ['apps/desktop/test/space-launcher-interaction.test.tsx'],
  sources: [launcher, surface, mote, secondary,
    'apps/desktop/test/helpers/composer-dom-fixture.tsx',
    'apps/desktop/test/helpers/client-ui-render.tsx',
    'apps/desktop/test/helpers/agent-information-root.tsx',
    'apps/desktop/scripts/lib/fixture-values.mjs',
    'apps/desktop/browser-extension/protocol.js'],
  mutations: [
    { label: 'shared-body-disconnected', file: surface,
      before: '{body != null ? <div className="surface-state__body">{body}</div> : null}',
      after: '{false ? <div className="surface-state__body">{body}</div> : null}' },
    { label: 'interactive-form-announced-as-status', file: surface,
      before: 'return <div {...element} className=',
      after: 'return <div {...element} role="status" className=' },
    { label: 'prompt-writer-disconnected', file: launcher,
      before: 'value={prompt} onValueChange={setPrompt}',
      after: 'value={prompt} onValueChange={() => {}}' },
    { label: 'original-launch-target-lost', file: launcher,
      before: '        target,\n        launchOptionSelection,',
      after: '        undefined,\n        launchOptionSelection,' },
    { label: 'provider-options-lost', file: launcher,
      before: '        target,\n        launchOptionSelection,',
      after: '        target,\n        {},' },
    { label: 'empty-mote-request-submitted', file: mote,
      before: 'if (!hasDraft || submitted) { requestPmoTeamsTopicFloatingOpen(',
      after: 'if (submitted) { requestPmoTeamsTopicFloatingOpen(' },
    { label: 'mote-action-purpose-hidden', file: mote,
      before: "hasDraft ? 'Create with Mote' : 'Open Mote'",
      after: "'Create with Mote'" },
    { label: 'healthy-terminal-extra-status', file: secondary,
      before: "kind === 'terminal' && expanded && !warmSession ? <small>",
      after: "kind === 'terminal' && expanded ? <small>" }
  ]
})
