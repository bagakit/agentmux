// The original private Native runner owns compilation, identities and cleanup.
process.env.AGENTMUX_CONTINUITY_INITIAL_WAIT_SURFACE = '1'
process.env.AGENTMUX_CONTINUITY_SUPERVISION_SURFACE = '1'
await import('./verify-session-continuity-product.mjs')
