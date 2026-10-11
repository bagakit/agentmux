# Shared overlay motion consumer

Run `node apps/desktop/scripts/verify-native-overlay-motion.mjs --mutations`.

The fixture mounts the maintained HoverDropdownMenu, RegionContextMenu and their
separate Portal submenu with production styles and the native-region collector.
The collected geometry passes through a sandboxed preload into the maintained
NativeOverlaySurfaces and its real capture/paint path above an original native page.

The first overlapping publication must contain every visible menu at its final
opaque geometry. Original keyboard selection and close remove the projection.
Hiding the native page releases the surface's motion marker; showing it restores
the projection. Disposal releases both. Unrelated terminal mutation and scrolling
must perform no overlay work, and the original native page value stays intact.

Three private compilation mutations independently remove the collector's motion
selection, restore the animated material, and test overlap before stabilizing the
geometry. The edge case holds the actual production animation at its first frame
using Web Animations: only its final box overlaps the native page by one pixel.
Each mutation must fail on a nonempty original menu's first capture; restored source must pass. Actual loaded source, compiled
inputs, child exit and exact private-scope cleanup are recorded per run.

The Electron window stays hidden and uses background CDP focus emulation. Its PNGs
show the original Renderer, not an OS window capture. This proves the DOM/native
capture mechanism; foreground visibility, trusted OS mouse input and the affected
workbench interaction require the separate native product acceptance.
