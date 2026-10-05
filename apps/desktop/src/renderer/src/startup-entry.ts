import { beginWorkbenchBootstrap } from './lib/renderer-startup-capture'

// This entry must not statically import the application graph: its first import error is an input.
beginWorkbenchBootstrap({
  host: window,
  attemptId: new URLSearchParams(window.location.search).get('renderer-update'),
  load: () => import('./main'),
  report: failure => window.agentmux?.ui.recordStartupFailure(failure) ?? Promise.resolve(false)
})
