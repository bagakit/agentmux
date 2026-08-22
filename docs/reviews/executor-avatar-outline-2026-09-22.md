# Executor avatar outline review — 2026-09-22

## User-reported defect

Executor avatar tint currently floods the Provider mark. Hollow marks therefore read as a recolored image instead of a legible identity mark with a thin outer contour.

## Contract

The Provider mark remains the source graphic, including its transparent holes. A tint is synthesized from the alpha silhouette, expanded by 1px, and composited behind the source so only the outside contour is tinted. The implementation must not apply a flood directly over the source graphic.

## Evidence

- Production surface: `apps/desktop/src/renderer/src/components/AgentAvatar.tsx`
- Production style: `apps/desktop/src/renderer/src/styles/agent-avatar.css`
- Verification: `apps/desktop/test/agent-avatar-outline.test.tsx`
