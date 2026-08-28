# Topic Tab icon overlap review

Status: approved by the user's spacing feedback on 2026-09-24.

Observed result: the compact Tab icons are readable, but their equal gaps make the rail look like a row of unrelated controls. The existing Agent presence stack already communicates a dense set of identities through controlled overlap.

Decision: reuse the same light overlap rhythm for adjacent Tab icon slots. Each Tab remains an independent hover/focus target in document order; the active, hovered, or focused item rises above its neighbors and remains fully legible. No data, Tab order, or Region projection changes.

Acceptance proof: focused component/source tests cover overlap spacing, per-Tab stacking and focus order; a block mutation must make the focused contract red; typecheck and production caller check remain green.
