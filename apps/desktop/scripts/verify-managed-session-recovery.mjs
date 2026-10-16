// Reuse the production App/Main/Core continuity harness with a private managed actor.
process.env.AGENTMUX_MANAGED_SESSION_RECOVERY_PROOF = '1'
await import('./verify-session-continuity-product.mjs')
