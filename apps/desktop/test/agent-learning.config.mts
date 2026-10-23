import config from '../../host/test/agent-learning.config.mts'

// The Desktop gate consumes only its review/IPC chain and adjacent takeover surface.
// Native App process proof is explicit; no native model run is collected implicitly.
export default { ...config, test: { ...config.test, include: [
  'apps/host/test/agent-learning-ui.test.tsx',
  'apps/desktop/test/session-takeover.test.tsx'
] } }
