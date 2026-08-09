# Verification Evidence

## Automated Checks
- Command: `pnpm check`
- Result: Typecheck, 321 active tests, the packed Core consumer test, and the production Desktop build passed. Two opt-in integration tests remained skipped by design.
- Command: `pnpm package:mac:install`
- Result: The development macOS app packaged and installed successfully.

## Manual Checks
- Step: Reload the installed Desktop Renderer and run `agentmux launch --agent claude --prompt "等待用户指令。" --placement split-right --relative-to self` as an existing managed Codex caller.
- Outcome: The public CLI returned a successful launch receipt. The existing View kept the same Tab and gained a second Region on the right with the configured Claude Agent. No `signal?.addEventListener` error appeared.

## Residual Risks
- None noted.
