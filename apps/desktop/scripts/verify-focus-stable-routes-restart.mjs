// One bounded mode of the original private Runtime/workface producer.
// It owns the only creation, normal-quit, restart and cleanup implementation.
if (process.env.AGENTMUX_FOCUS_STABLE_ROUTES_RESTART_OUTPUT) {
  process.env.AGENTMUX_FOCUS_NAME_WIDTH_RESTART_OUTPUT = process.env.AGENTMUX_FOCUS_STABLE_ROUTES_RESTART_OUTPUT
}
process.argv.push('--project-routes-join')
await import('./verify-focus-timeline-name-width-restart.mjs')
