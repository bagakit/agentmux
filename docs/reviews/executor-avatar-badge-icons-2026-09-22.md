# Executor avatar badge icons — 2026-09-22

## User-reported defect

The upper-left Executor badge currently accepts arbitrary text and is visually separate from the Provider mark. The result is noisy and its contour does not read as one enamel-like identity mark.

## Contract

The upper-left mark is selected from a fixed icon catalog. Arbitrary text never enters the durable config or DOM. The selected icon and Provider mark are rendered as one combined alpha shape; one outside contour is generated around that combined shape.

## Evidence

- Production surface: `apps/desktop/src/renderer/src/components/AgentAvatar.tsx`
- Executor settings: `apps/desktop/src/renderer/src/components/settings/AppearanceSettingsPane.tsx`
- Config contract: `apps/desktop/src/shared/contracts.ts`, `apps/desktop/src/main/config-store.ts`
- Verification: `apps/desktop/test/agent-avatar-badge-icons.test.tsx`
