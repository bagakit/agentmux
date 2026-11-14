# Screenshot surface product proof

Run `node apps/desktop/scripts/verify-capture-surface.mjs` from the repository root.
The isolated Electron app consumes production CaptureSurface, preload, screenshot entry,
shared annotation editor, PNG composition and expanded window editor. Trusted CDP inputs
make selections, place Rectangle marks, complete outputs, cancel, press Tab to switch the already frozen background, exercise Undo/Redo, and press Command E.

The Native screen-pixel boundary returns two deliberately different frozen desktops and
virtual display geometries. A real visible host window begins at 65% opacity; the proof
asserts both exposures and every exit leave that exact value untouched with no production
opacity writes. Every real overlay reports content protection at its `showInactive` call.
Each delivered PNG is inspected for its crop and Rectangle pixels and retains the exact
background engine and capturedAt receipt. A held delivery is cancelled, then resolved while
the next capture opens; its late result must not supply that next selection. This fixture
never records the real desktop or writes the user clipboard. It does not prove physical
multi-monitor, TCC/signature, app installation, or actual OS capture cost.

The generated receipt binds every bundled input and records actual presented/shown timing.
Open all eight PNGs in its screenshot list for independent visual review: included/excluded
resting frames, marked frames, both window-hover geometries, the switched document after Undo/Redo, and the expanded editor with the original editable marks.
Collection alone does not mark aesthetic review passed. The independent review is kept with
the same candidate's local evidence, following docs/guides/agent-visual-e2e-review.md.
