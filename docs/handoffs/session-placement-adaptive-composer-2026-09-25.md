# Handoff: Session placement and adaptive Message Tools composer

## Task

Implement Feature `f-2be8fv5jc` (`session-placement-adaptive-composer`). The reviewed plan has two todo tasks:

- `T-001` — bind fork/resume-created tabs to the target Session surface.
- `T-002` — make the Message Tools input expand with its content.

The canonical task plan is in `.bagakit/feature-tracker/features/f-2be8fv5jc/tasks.json`.

## Context

The reported reproduction is: an Agent was forked from an earlier Agent. In the pre-fork Session, a new Tab was opened and a Session was resumed; the new Browser/surface appeared to the right of the original Agent. It may be caused by an ambient focus switch, but either explanation is wrong. A fork/resume/new-tab/browser action must follow the target Session's durable Workspace/Tab/Region ownership, never whichever Agent happens to be focused when placement runs.

The second issue is the Message Tools composer. When it starts as one line and the user types more content, the text is squeezed into a narrow centered strip. The editor must grow into a readable multiline surface while the surrounding controls keep stable hit areas.

## Relevant files

### Placement and Session ownership

- `apps/desktop/src/renderer/src/store.ts`
- `apps/desktop/src/renderer/src/lib/workbench-tabs.ts`
- `apps/desktop/src/renderer/src/components/WorkspaceWorkbench.tsx`

Trace every fork, resume, Browser-open and new-Tab entry point through the target Session identity. Confirm whether the current code chooses a Region from ambient focus or from a durable Tab/Region owner before changing it.

### Message Tools composer

- `apps/desktop/src/renderer/src/components/SessionPane.tsx`
- `apps/desktop/src/renderer/src/components/ComposerTextarea.tsx`
- `apps/desktop/src/renderer/src/components/AgentComposer.tsx`
- `apps/desktop/src/renderer/src/components/AgentSessionComposer.tsx`
- `apps/desktop/src/renderer/src/components/AgentComposerTools.tsx`
- `apps/desktop/src/renderer/src/styles/composer.css`

### Design and review source of truth

- `docs/design/agentmux-desktop-interaction.md`
- `docs/design/agentmux-surface-density.md`
- `docs/reviews/session-placement-and-message-composer-2026-09-25.json`

## Current state

- The two requirements are recorded in both design SSOT documents.
- Feature Tracker `f-2be8fv5jc` is `ready`; `T-001` and `T-002` are both `todo`.
- The task plan was repaired through the tracker after correcting the composer source references; its owner receipt is current.
- No implementation for these two tasks has been started. Do not infer completion from the earlier UI work.
- The preceding PMO floating-window work is committed as `7fbf5d20` (`refine: compact PMO floating workspace surface`). Its focused tests, typecheck and mutation check passed before packaging.
- A macOS package/install attempt for that PMO commit reached the renderer and helper checks but failed the source-tree immutability check because the design SSOT was edited while packaging was in progress. The canonical installed app therefore was not updated by that attempt. After implementation and final documentation changes are committed, rerun `pnpm package:mac:install` and verify the package identity, running app path and signature.

## Decisions

1. The target Session is the owner of placement. Resolve its Workspace, Tab, Region and insertion policy before creating a surface. Ambient focus is not a fallback.
2. If the target Session cannot be resolved, keep the failure visible and recoverable. Never attach the new surface to another Agent silently.
3. The composer uses a flexible center with stable side controls: one line initially, then a bounded 2–4 line editor, then internal scrolling. Text remains left aligned and can shrink back after deletion.
4. Preserve the existing durable Session/Run/Tab/Region facts and restart/recovery invariants. Do not add a second ownership store or a compatibility fallback.

## Acceptance and proof

### T-001

- Fork/resume/open-browser/new-tab flows resolve an explicit target Session owner before selecting a Region or insertion point.
- Changing the focused Agent between request and placement cannot redirect the new surface.
- Tests cover a forked Session, a stale/unresolved target and the existing same-Session path.

Required proof:

```sh
CI=true pnpm --filter @agentmux/desktop exec vitest run test --maxWorkers=1
pnpm --filter @agentmux/desktop typecheck
```

Also perform the required mutation test: deliberately route placement through the old ambient-focus path and confirm the focused test fails, then restore the implementation. Run the zero-caller check for the new owner API, excluding its defining file; a definition-only hit is not delivery.

### T-002

- The editor starts compact, expands when content wraps, caps at a readable multiline height, and scrolls internally only after that cap.
- Agent identity, tools, mailbox and send controls retain stable hit areas while the editor takes the remaining width.
- Text is left aligned and deleting content returns the editor to its compact height.

Use the focused composer tests if available, then run the same desktop test and typecheck commands above. Perform a mutation test against the height/overflow behavior and a zero-caller check for any new adaptive-composer helper.

## Handoff checklist

1. Read the two design sections and the approved review artifact before editing code.
2. Inspect the actual Session/Tab/Region creation paths; write a focused regression test before changing placement.
3. Implement both tasks without introducing a duplicate Session ownership model.
4. Run focused tests, mutation red/green, zero-caller checks, then the desktop test suite and typecheck.
5. Verify restart/recovery still retains the original Tab, Region, layout and Session mapping.
6. Commit implementation and documentation together, rerun macOS packaging/install only after the source tree is stable, and record the real installed artifact in the closeout evidence.
