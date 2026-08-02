import type {
  AgentWorkbenchSurface,
  TerminalWorkbenchSurface,
  WorkbenchSurface
} from './workbench-tabs'

// The single source of truth for "what kinds of surface can live in a Workbench Region".
//
// Before this module, ~5 consumers each hand-copied their own list of surface kinds — a switch here,
// an `x.kind === 'agent' || x.kind === 'terminal'` there, a `!== 'file' && !== 'browser'` somewhere
// else. Nothing tied them together, so a 6th kind added to `WorkbenchSurface` compiled clean while
// every one of those hand-copied lists silently did the wrong thing for the new kind (a pane leaked,
// or was dropped across restart, or vanished from a menu). This module gives them one list, one
// exhaustiveness primitive, and one derived classifier, so a new kind lights up at compile time.

/**
 * Every `WorkbenchSurface['kind']`, once. Iterate this (never a hand-written list) when a test or a
 * consumer needs to walk all kinds.
 *
 * The two type-level assignments below are the real guarantee: they fail to compile if this tuple
 * drifts from the union in either direction (a kind added to `WorkbenchSurface` but not here, or a
 * stale entry here that the union no longer has). A plain array would let the tuple rot silently.
 */
export const WORKBENCH_SURFACE_KINDS = [
  'agent',
  'terminal',
  'file',
  'launcher',
  'browser'
] as const

type SurfaceKind = WorkbenchSurface['kind']

// Two-way exactness. Each conditional is `true` only when its containment holds and `never`
// otherwise, and `never` is not assignable to a `true` slot — so a break in either direction is a
// compile error that names which half failed. `void` keeps the proof from reading as dead.
const _kindListIsExactlyTheUnion: [
  SurfaceKind extends (typeof WORKBENCH_SURFACE_KINDS)[number] ? true : never,
  (typeof WORKBENCH_SURFACE_KINDS)[number] extends SurfaceKind ? true : never
] = [true, true]
void _kindListIsExactlyTheUnion

/**
 * The exhaustiveness backstop for any consumer that switches on `surface.kind`.
 *
 * `tsconfig` here runs `strict` but NOT `noImplicitReturns`, so a `switch (surface.kind)` that
 * forgets a case does not fail on its own — tsc just widens the function's return type to include
 * `undefined` and stays green (see the sibling proof in `workbench-tab-marks.ts`'s `markLabel`). Put
 * a `default: return assertUnreachableSurface(surface)` at the end of every such switch: with all
 * kinds handled, `surface` is `never` there and this compiles; the day a kind is added, `surface` is
 * that kind (not `never`), the call fails to type-check, and the omission cannot ship. The throw is
 * only the runtime backstop — the compile error at the call site is the guard.
 */
export function assertUnreachableSurface(surface: never): never {
  throw new Error(`Unhandled workbench surface kind: ${JSON.stringify(surface)}`)
}

/**
 * Whether a surface carries a live Session (an Agent or Terminal run) rather than being a pure
 * presentation surface. This is the SSOT for the `kind === 'agent' || kind === 'terminal'` test that
 * five consumers used to inline: session-teardown, on-screen visibility, cross-worktree move, the
 * move-view menu, and persisted-tab projection. Centralising it means a 6th, session-bearing kind is
 * declared once — in the switch below — instead of being silently excluded by each of those call
 * sites at once.
 *
 * The `switch` (not a `Record<…, boolean>`) is deliberate: it is exhaustiveness-checked by
 * `assertUnreachableSurface`, and — unlike a boolean map indexed by `surface.kind` — TypeScript can
 * see that the `true` branch is reached only for agent/terminal, which is what makes the returned
 * type predicate sound. A map would let a stray `file: true` narrow a file surface to a session and
 * compile.
 */
export function isSessionSurface(
  surface: WorkbenchSurface
): surface is AgentWorkbenchSurface | TerminalWorkbenchSurface {
  switch (surface.kind) {
    case 'agent':
    case 'terminal':
      return true
    case 'file':
    case 'launcher':
    case 'browser':
      return false
    default:
      return assertUnreachableSurface(surface)
  }
}
