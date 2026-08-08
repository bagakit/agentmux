/**
 * The single risk vocabulary the three sealed control surfaces share — launch options, live permission
 * options, and posture modes all rank one choice's danger with these exact three values, and every
 * renderer surfaces them the same way: a restrained dot, never a stroke or fill. One identity in one
 * place — a launch choice, a permission row, and a posture mode that read as equally dangerous carry the
 * same token, so the ranking cannot drift between the three. The tuple is the SSOT: {@link RiskTier}
 * derives from it and a runtime validator (agent-session-store) reuses it to fail-close on foreign data,
 * so the type and the on-disk whitelist cannot fall out of step.
 *
 * The order is ascending danger (safe → caution → danger): a member's INDEX is its danger rank. This is
 * load-bearing for consumers that pick "the most dangerous tier present" (agent-roster's `rowRiskTier`
 * reads `RISK_TIERS.indexOf(...)` rather than hand-copying a reversed ladder) — reordering this tuple
 * reorders every such ranking on purpose, which is why the order lives here at the SSOT and nowhere else.
 *
 * Why this is its own node-free leaf (and not just a const in types.ts): the renderer needs the tuple as
 * a runtime VALUE (to rank), but the root barrel `@agentmux/core` re-exports Core's process/filesystem
 * runtime (process-runner pulls in `node:child_process`). Living here lets the Desktop renderer and Web
 * preview import the value through the `@agentmux/core/risk-tier` subpath without dragging Node into the
 * render process — the same reason `agent-provider-id.ts` is its own node-free leaf. This file
 * deliberately imports no `node:` builtins.
 */
export const RISK_TIERS = ['safe', 'caution', 'danger'] as const
export type RiskTier = (typeof RISK_TIERS)[number]
