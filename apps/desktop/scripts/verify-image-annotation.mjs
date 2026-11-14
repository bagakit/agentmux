import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'

const args = process.argv.slice(2)
let slice, mutations = false
for (let index = 0; index < args.length; index++) {
  if (args[index] === '--slice') { assert.equal(slice, undefined, 'Choose one verification slice'); slice = args[++index] }
  else if (args[index] === '--mutations') mutations = true
  else throw new Error('Unsupported image annotation proof option: ' + args[index])
}
assert.ok(['boundary', 'editing', 'documents', 'text-preservation', 'enhancements', 'modeless', 'capture', 'snapping', 'pointing', 'objects', 'adjustments'].includes(slice), 'Use --slice boundary|editing|documents|text-preservation|enhancements|modeless|capture|snapping|pointing|objects|adjustments')
const adapter = 'apps/desktop/src/renderer/src/components/browser-screenshot/ScreenshotEditor.tsx'
const component = 'apps/desktop/src/renderer/src/components/image-annotation/'
const host = 'apps/desktop/src/renderer/src/components/browser-screenshot/'
const modeless = 'apps/desktop/test/image-annotation-modeless.test.tsx'
const capture = 'apps/desktop/test/image-annotation-capture.test.tsx'
const overlayHost = 'apps/desktop/src/renderer/screenshot-editor/CaptureSurfaceView.tsx', overlay = 'apps/desktop/test/capture-surface-view.test.tsx'
const windowHost = 'apps/desktop/src/renderer/screenshot-editor/SystemScreenshotEditorView.tsx', windowView = 'apps/desktop/test/system-screenshot-editor-view.test.tsx'
const pointing = 'apps/desktop/test/image-annotation-pointing-marks.test.ts'
const snapping = 'apps/desktop/test/image-annotation-snapping.test.ts'
const pointingTools = 'apps/desktop/test/image-annotation-pointing-tools.test.tsx'
const objects = 'apps/desktop/test/image-annotation-objects.test.ts'
const objectsEditor = 'apps/desktop/test/image-annotation-objects-editor.test.tsx'
const windowShortcuts = 'apps/desktop/test/image-annotation-window-shortcuts.test.tsx'
const adjustments = 'apps/desktop/test/image-annotation-adjustments.test.ts'
const wandTools = 'apps/desktop/test/image-annotation-wand-tools.test.tsx'
const editor = component + 'ImageAnnotationEditor.tsx'
const specifications = {
  adjustments: {
    tests: [adjustments, wandTools, 'apps/desktop/test/image-annotation-magic-wand.test.ts'],
    mutations: [{ label: 'adjust-not-first', source: component + 'drawing-model.ts',
      find: "  if (shape.kind === 'adjust') return -1", replace: "  if (shape.kind === 'adjust') return 0", test: adjustments,
      consumer: 'paints adjustments first, then marks, masks, magnifiers and spotlights', failure: /expected \[ 3, 2, 1, \+0, \+0 \] to deeply equal \[ 3, 2, 1, \+0, -1 \]/ },
    { label: 'outline-not-moved', source: component + 'drawing-model.ts',
      find: '      return { ...shape, ...mapOutline(shape, move), from: move(shape.from), to: move(shape.to) }', replace: '      return { ...shape, from: move(shape.from), to: move(shape.to) }', test: adjustments,
      consumer: 'moves and scales a wand outline with its region', failure: /the rings move with the region/ },
    { label: 'outline-not-scaled', source: component + 'drawing-model.ts',
      find: '  const outline = (outlined: Outlined) => mapOutline(outlined, point => scalePoint(point, scale))', replace: '  const outline = (_outlined: Outlined) => ({})', test: adjustments,
      consumer: 'moves and scales a wand outline with its region', failure: /the rings scale with the region/ },
    { label: 'outline-truncated', source: component + 'document.ts',
      find: "  if (value.length > OUTLINE_LIMITS.rings) invalid('The region outline has too many rings.')", replace: '  value = value.slice(0, OUTLINE_LIMITS.rings)', test: adjustments,
      consumer: 'rejects outlines that are open, non-finite, outside their region or over the limits', failure: /the document is refused/ },
    { label: 'outline-region-unchecked', source: component + 'document.ts',
      find: "extent.from.x < region.x || extent.from.y < region.y || extent.to.x > region.x + region.width || extent.to.y > region.y + region.height)", replace: 'false)', test: adjustments,
      consumer: 'rejects outlines that are open, non-finite, outside their region or over the limits', failure: /the document is refused/ },
    { label: 'adjust-range-unchecked', source: component + 'document.ts',
      find: "factor = (field: unknown) => inRange(field, ADJUST_FACTOR_RANGE, 'The adjustment is out of range.')", replace: 'factor = (field: unknown) => finite(field)', test: adjustments,
      consumer: 'rejects adjust marks out of range or with missing or extra fields', failure: /the document is refused/ },
    { label: 'wand-samples-marks', source: editor,
      find: '    context.drawImage(base, 0, 0, image.width, image.height)\n    return sourcePixelsRef.current', replace: '    context.drawImage(committedLayerRef.current!, 0, 0, image.width, image.height)\n    return sourcePixelsRef.current', test: wandTools,
      consumer: 'selects the connected region of the original pixels under a click, never the marked result', failure: /the click selects block A of the original under the existing cover/ },
    { label: 'wand-tolerance-ignored', source: editor,
      find: '    const picked = magicWandRegion(pixels, at, wandTolerance)', replace: '    const picked = magicWandRegion(pixels, at, DEFAULT_MAGIC_WAND_TOLERANCE)', test: wandTools,
      consumer: 'grows the region with the tolerance slider, from a default of 20', failure: /at 25 block B joins/ },
    { label: 'wand-shift-replaces', source: editor,
      find: '    const region = add && wand ? unionMagicWandRegions(wand.region, picked) : picked', replace: '    const region = picked', test: wandTools,
      consumer: 'adds a Shift-clicked region to the current one and replaces it on a plain click', failure: /to match object/ },
    { label: 'wand-conversion-unoutlined', source: editor,
      find: '    const shape = withOutline(base, wand.outline)\n', replace: '    const shape = base\n', test: wandTools,
      consumer: 'turns the region into each mask and the spotlight as one Undo step', failure: /^AssertionError: Cover/m },
    { label: 'wand-pixels-reread', source: editor,
      find: '    if (sourcePixelsRef.current) return sourcePixelsRef.current\n', replace: '', test: wandTools,
      consumer: 'reads the original pixels once per image, not on each click or pointer move', failure: /one readback serves every click/ },
    { label: 'ants-ignore-reduced-motion', source: editor,
      find: 'timer = reduced.matches || document.hidden ? 0 :', replace: 'timer = document.hidden ? 0 :', test: wandTools,
      consumer: 'marches the ants only while a region shows and keeps them still under reduced motion', failure: /reduced motion runs no timer/ },
    { label: 'ants-run-at-rest', source: editor,
      find: '    if (!active || !wand) return\n    const reduced', replace: '    if (!active) return\n    const reduced', test: wandTools,
      consumer: 'marches the ants only while a region shows and keeps them still under reduced motion', failure: /no region, no timer/ },
    { label: 'capture-wand-all-actions', source: editor,
      find: "  const regionActions = REGION_ACTIONS.filter(([kind]) => !capture || kind === 'region-highlight' || CAPTURE_TOOLS.some(item => item.id === kind))", replace: '  const regionActions = REGION_ACTIONS', test: wandTools,
      consumer: 'offers the wand in a capture selection with its lightweight actions only', failure: /'Cover'/ },
    { label: 'adjust-each-change-new-mark', source: editor,
      find: '    if (adjustment) { edit(doc => replaceShape(doc, { ...adjustment, [property]: value })); return }\n', replace: '', test: wandTools,
      consumer: 'adjusts the whole image with four sliders, each change one Undo step', failure: /one mark for the whole image/ },
    { label: 'adjust-region-unoutlined', source: editor,
      find: '    const shape = adjusting.outline ? withOutline(created, adjusting.outline) : created', replace: '    const shape = created', test: wandTools,
      consumer: 'adjusts the current wand region through its outline', failure: /the adjustment keeps the region outline/ },
    { label: 'outline-rects-nonzero', source: component + 'drawing-model.ts',
      find: '    for (let index = 0; index + 1 < xs.length; index += 2) if (xs[index + 1]! > xs[index]!) rects.push({ x: xs[index]!, y: top, width: xs[index + 1]! - xs[index]!, height })',
      replace: '    if (xs.length > 1) rects.push({ x: xs[0]!, y: top, width: xs.at(-1)! - xs[0]!, height })', test: adjustments,
      consumer: "covers an outline's even-odd fill exactly with rects, holes and notches left out", failure: /pixel 25,25/ },
    { label: 'outline-slant-accepted', source: component + 'document.ts',
      find: "  if (!isAxisAlignedOutline(rings)) invalid('Each region outline edge must be horizontal or vertical.')\n", replace: '', test: adjustments,
      consumer: 'rejects outlines that are open, non-finite, outside their region or over the limits', failure: /the document is refused/ },
    { label: 'adjusted-base-per-view', source: component + 'canvas-render.ts',
      find: "  if (cached && cached.source === source && cached.width === width && cached.height === height && cached.adjustments.length === adjustments.length &&",
      replace: "  if (cached && false && cached.source === source && cached.width === width && cached.height === height && cached.adjustments.length === adjustments.length &&", test: adjustments,
      consumer: 'reuses the adjusted image across pan and zoom and repaints it when a parameter changes', failure: /pan, zoom and other marks reuse the adjusted image/ },
    { label: 'adjusted-base-stale', source: component + 'canvas-render.ts',
      find: '    cached.adjustments.every((shape, index) => shape === adjustments[index])) return cached.canvas', replace: '    true) return cached.canvas', test: adjustments,
      consumer: 'reuses the adjusted image across pan and zoom and repaints it when a parameter changes', failure: /a changed parameter repaints it/ },
    { label: 'adjust-list-hidden', source: editor,
      find: '        {regionAdjusts.length ? <div className="image-annotation-editor__mode" role="group" aria-label="Adjustment">', replace: '        {false ? <div className="image-annotation-editor__mode" role="group" aria-label="Adjustment">', test: wandTools,
      consumer: 'lists existing adjustments to edit or remove one after the wand selection is gone, each change one Undo step', failure: /the adjustments are listed/ },
    { label: 'adjust-pick-ignored', source: editor,
      find: '            onClick={() => setAdjusting(adjustTarget(shape))}>', replace: '            onClick={() => undefined}>', test: wandTools,
      consumer: 'lists existing adjustments to edit or remove one after the wand selection is gone, each change one Undo step', failure: /picking the region edits the region/ },
    { label: 'adjust-remove-unwired', source: editor,
      find: '    edit(doc => removeShapes(doc, new Set([adjustment.id]))); setAdjusting(wholeImageTarget(adjustment.id))', replace: '    setAdjusting(wholeImageTarget(adjustment.id))', test: wandTools,
      consumer: 'lists existing adjustments to edit or remove one after the wand selection is gone, each change one Undo step', failure: /Remove deletes the region adjustment/ },
    { label: 'adjusted-region-unoutlined', source: editor,
      find: "  const outlined = wand?.outline ?? (currentAdjustment && 'outline' in currentAdjustment ? currentAdjustment.outline : adjusting?.outline) ?? null", replace: '  const outlined = wand?.outline ?? null', test: wandTools,
      consumer: 'keeps the adjusted region outlined after a tool change drops the wand selection', failure: /the region it adjusts still shows its outline/ },
    { label: 'region-highlight-entry-unwired', source: editor,
      find: ": kind === 'region-highlight' ? { id, kind, color, from, to }", replace: ": kind === 'region-highlight' ? { id, kind: 'cover', color, from, to }", test: wandTools,
      consumer: 'turns the picked color region into a highlight and removes it with one Undo', failure: /Highlight commits the exact picked range/ },
    { label: 'capture-region-highlight-hidden', source: editor,
      find: "!capture || kind === 'region-highlight' || CAPTURE_TOOLS.some(item => item.id === kind)", replace: "!capture || CAPTURE_TOOLS.some(item => item.id === kind)", test: wandTools,
      consumer: 'offers the wand in a capture selection with its lightweight actions only', failure: /'Highlight'/ },
    { label: 'region-highlight-is-mask', source: component + 'drawing-model.ts',
      find: "return shape.kind === 'pixelate' || shape.kind === 'pixelate-brush' || shape.kind === 'cover' || shape.kind === 'blur'", replace: "return shape.kind === 'region-highlight' || shape.kind === 'pixelate' || shape.kind === 'pixelate-brush' || shape.kind === 'cover' || shape.kind === 'blur'", test: adjustments,
      consumer: 'keeps a region highlight editable through original, move and scale without hiding notes', failure: /highlighting is not redaction/ },
    { label: 'region-highlight-original-is-cover', source: component + 'document.ts',
      find: "return { ...common, kind, from, to, ...outline(base.outline, from, to) }\n  }\n  if (kind === 'adjust')", replace: "return { ...common, kind: 'cover', from, to, ...outline(base.outline, from, to) }\n  }\n  if (kind === 'adjust')", test: adjustments,
      consumer: 'keeps a region highlight editable through original, move and scale without hiding notes', failure: /the original keeps the region highlight and its geometry/ },
    { label: 'adjusted-region-stale-after-move', source: editor,
      find: "  const outlined = wand?.outline ?? (currentAdjustment && 'outline' in currentAdjustment ? currentAdjustment.outline : adjusting?.outline) ?? null", replace: '  const outlined = wand?.outline ?? adjusting?.outline ?? null', test: wandTools,
      consumer: 'draws the current adjustment range after Select All and an arrow move', failure: /the open adjustment outlines its moved range/ }]

  },
  objects: {
    tests: [objects, objectsEditor, windowShortcuts],
    mutations: [
      { label: "marquee-unwired", source: component + 'ImageAnnotationEditor.tsx',
        find: "else if (marquee) { if (!click) setSelectedIds(new Set([...marquee.base, ...marqueeHits(documentState, normalizeRect(marquee.start, marquee.at))])) }", replace: "else if (marquee) { void click }", test: objectsEditor,
        consumer: "a marquee from empty canvas selects the unlocked marks it touches; a click there clears the selection", failure: /the marquee caught a and b/ },
      { label: "marquee-takes-locked", source: component + 'selection-geometry.ts',
        find: "    if (shape.locked) return false\n", replace: "\n", test: objects,
        consumer: "locks marks out of hit testing and marquee selection and unlocks them again", failure: /to deeply equal \[ 'b', 'c', 'd' \]/ },
      { label: "shift-click-replaces", source: component + 'ImageAnnotationEditor.tsx',
        find: "if (shape && !handle && event.shiftKey) { setSelectedIds(toggled(groupIds, shape.id)); schedulePaint(); return }", replace: "if (shape && !handle && event.shiftKey) { selectOnly(shape.id); schedulePaint(); return }", test: objectsEditor,
        consumer: "Shift-click adds a mark to the selection and Shift-click again removes it", failure: /Shift-click adds b to a/ },
      { label: "group-drag-moves-one", source: component + 'ImageAnnotationEditor.tsx',
        find: "if (group) group.moved = moveShapes(group.base, group.ids, at.x - group.start.x, at.y - group.start.y)", replace: "if (group) group.moved = moveShapes(group.base, new Set([group.pressed]), at.x - group.start.x, at.y - group.start.y)", test: objectsEditor,
        consumer: "dragging one selected mark moves the whole group as one Undo step", failure: /both members move by the drag/ },
      { label: "group-drag-per-step-undo", source: component + 'ImageAnnotationEditor.tsx',
        find: "    if (group) { if (click) selectOnly(group.pressed); else editShapes(group.moved) }", replace: "    if (group) { if (click) selectOnly(group.pressed); else for (const shape of group.moved) if (group.ids.has(shape.id)) edit(doc => replaceShape(doc, shape)) }", test: objectsEditor,
        consumer: "dragging one selected mark moves the whole group as one Undo step", failure: /one Undo restores the whole group move/ },
      { label: "delete-removes-one", source: component + 'ImageAnnotationEditor.tsx',
        find: "function removeSelected() { if (groupIds.size) { edit(doc => removeShapes(doc, groupIds)); selectOnly(null) } }", replace: "function removeSelected() { if (groupIds.size) { edit(doc => removeShapes(doc, new Set([...groupIds].slice(-1)))); selectOnly(null) } }", test: objectsEditor,
        consumer: "Delete removes every selected mark and arrows nudge them all", failure: /Delete removes the group/ },
      { label: "nudge-moves-one", source: component + 'ImageAnnotationEditor.tsx',
        find: "editShapes(moveShapes(documentState.shapes, groupIds, dx, dy))", replace: "editShapes(moveShapes(documentState.shapes, new Set([...groupIds].slice(0, 1)), dx, dy))", test: objectsEditor,
        consumer: "Delete removes every selected mark and arrows nudge them all", failure: /Shift-arrow nudges each selected mark by ten/ },
      { label: "align-unwired", source: component + 'ImageAnnotationEditor.tsx',
        find: "onClick={() => editShapes(alignShapes(documentState.shapes, groupIds, id, measureText))}", replace: "onClick={() => void id}", test: objectsEditor,
        consumer: "align and distribute in the property row act on the group as one Undo step", failure: /align top uses the group bounds/ },
      { label: "align-against-first-mark", source: component + 'drawing-model.ts',
        find: "  if (!group || members.length < 2) return shapes", replace: "  if (!group || members.length < 2) return shapes\n  Object.assign(group, shapeBounds(members.at(-1)!, textWidth))", test: objectsEditor,
        consumer: "align and distribute in the property row act on the group as one Undo step", failure: /align top uses the group bounds/ },
      { label: "distribute-offered-for-two", source: component + 'ImageAnnotationEditor.tsx',
        find: "{selectedShapes.length > 2 ? DISTRIBUTIONS.map(", replace: "{selectedShapes.length > 1 ? DISTRIBUTIONS.map(", test: objectsEditor,
        consumer: "align and distribute in the property row act on the group as one Undo step", failure: /two marks cannot distribute/ },
      { label: "front-is-forward", source: component + 'ImageAnnotationEditor.tsx',
        find: "if (bracket) return event.shiftKey ? bracket === 'forward' ? 'front' : 'back' : bracket", replace: "if (bracket) return bracket", test: objectsEditor,
        consumer: "stacking shortcuts reorder only the marks, and a mask never moves under a mark", failure: /Shift forward brings a to the front of the marks/ },
      { label: "hit-takes-locked", source: component + 'drawing-model.ts',
        find: "    if (shape.locked) continue\n    if (shape.kind === 'pen' || shape.kind === 'highlight' || shape.kind === 'pixelate-brush') {", replace: "    if (shape.kind === 'pen' || shape.kind === 'highlight' || shape.kind === 'pixelate-brush') {", test: objectsEditor,
        consumer: "locking keeps a mark out of hit, erase, marquee and moves until it is unlocked", failure: /a drag on a locked mark does not move it/ },
      { label: "select-all-takes-locked", source: component + 'ImageAnnotationEditor.tsx',
        find: "if (command === 'select-all') setSelectedIds(new Set(screenshotOutputShapes(shapes, documentState.crop).filter(shape => !shape.locked).map(shape => shape.id)))", replace: "if (command === 'select-all') setSelectedIds(new Set(screenshotOutputShapes(shapes, documentState.crop).map(shape => shape.id)))", test: objectsEditor,
        consumer: "locking keeps a mark out of hit, erase, marquee and moves until it is unlocked", failure: /undoing the lock does not add a mark Select All skipped/ },
      { label: "select-all-takes-hidden", source: component + 'ImageAnnotationEditor.tsx',
        find: "setSelectedIds(new Set(screenshotOutputShapes(shapes, documentState.crop).filter(", replace: "setSelectedIds(new Set(shapes.filter(", test: objectsEditor,
        consumer: "Select All takes the marks it shows: never a note hidden under a mask", failure: /not the hidden note/ },
      { label: "locked-counts-as-selected", source: component + 'ImageAnnotationEditor.tsx',
        find: "const selectedShapes = documentState.shapes.filter(shape => selectedIds.has(shape.id) && !shape.locked)", replace: "const selectedShapes = documentState.shapes.filter(shape => selectedIds.has(shape.id))", test: objectsEditor,
        consumer: "a mark Redo locks while selected is inert, and comes back unselected once unlocked", failure: /a mark Redo locks drops out of the selection/ },
      { label: "lock-shortcut-unwired", source: component + 'ImageAnnotationEditor.tsx',
        find: "else if (command === 'lock') { if (groupIds.size) { editShapes(setShapesLocked(shapes, groupIds, true)); selectOnly(null) } }", replace: "else if (command === 'lock') void groupIds", test: objectsEditor,
        consumer: "locking keeps a mark out of hit, erase, marquee and moves until it is unlocked", failure: /Command-L locks the selected mark/ },
      { label: "lock-keeps-selection", source: component + 'ImageAnnotationEditor.tsx',
        find: "else if (command === 'lock') { if (groupIds.size) { editShapes(setShapesLocked(shapes, groupIds, true)); selectOnly(null) } }", replace: "else if (command === 'lock') { if (groupIds.size) editShapes(setShapesLocked(shapes, groupIds, true)) }", test: objectsEditor,
        consumer: "locking keeps a mark out of hit, erase, marquee and moves until it is unlocked", failure: /undoing the lock brings the mark back unselected/ },
      { label: "lock-shortcut-toggles", source: component + 'ImageAnnotationEditor.tsx',
        find: "else if (command === 'lock') { if (groupIds.size) { editShapes(setShapesLocked(shapes, groupIds, true)); selectOnly(null) } }", replace: "else if (command === 'lock') { editShapes(groupIds.size ? setShapesLocked(shapes, groupIds, true) : setShapesLocked(shapes, new Set(shapes.map(shape => shape.id)), false)); selectOnly(null) }", test: objectsEditor,
        consumer: "locking keeps a mark out of hit, erase, marquee and moves until it is unlocked", failure: /Command-L with nothing selected leaves the lock alone/ },
      { label: "lock-badge-never-shown", source: component + 'ImageAnnotationEditor.tsx',
        find: "    else if (hasLocked && !locked) setLockHover(lockedMarkAt(documentState.shapes, point(event), 4 / viewRef.current.scale, measureText)?.id ?? null)", replace: "    else if (hasLocked && !locked) setLockHover(null)", test: objectsEditor,
        consumer: "locking keeps a mark out of hit, erase, marquee and moves until it is unlocked", failure: /real Unlock annotation control/ },
      { label: "unlock-all-unwired", source: component + 'ImageAnnotationEditor.tsx',
        find: "onClick={() => unlockShapes(new Set(documentState.shapes.filter(shape => shape.locked).map(shape => shape.id)))}", replace: "onClick={() => undefined}", test: objectsEditor,
        consumer: "locking keeps a mark out of hit, erase, marquee and moves until it is unlocked", failure: /Unlock all clears every lock/ },
      { label: "unlock-keeps-stale-selection", source: component + 'ImageAnnotationEditor.tsx',
        find: "    setSelectedIds(current => [...current].some(id => ids.has(id)) ? new Set([...current].filter(id => !ids.has(id))) : current)\n", replace: "", test: objectsEditor,
        consumer: "a mark Redo locks while selected is inert, and comes back unselected once unlocked", failure: /the unlocked mark is not selected again/ },
      { label: "lock-badge-unlocks-all", source: component + 'ImageAnnotationEditor.tsx',
        find: "onClick={() => { unlockShapes(new Set([lockBadge.id])); setLockHover(null) }}", replace: "onClick={() => { unlockShapes(new Set(documentState.shapes.map(shape => shape.id))); setLockHover(null) }}", test: objectsEditor,
        consumer: "locking keeps a mark out of hit, erase, marquee and moves until it is unlocked", failure: /the lock badge unlocks only its mark/ },
      { label: "duplicate-keeps-ids", source: component + 'drawing-model.ts',
        find: "const moved = { ...moveShape(source, offset.x, offset.y), id: mintId() }", replace: "const moved = { ...moveShape(source, offset.x, offset.y), id: source.id }", test: objectsEditor,
        consumer: "duplicate and session paste give fresh ids and next note numbers without touching the system clipboard", failure: /every copy has its own id/ },
      { label: "duplicate-keeps-note-number", source: component + 'drawing-model.ts',
        find: "    return moved.kind === 'note' ? { ...moved, number: number++ } : moved", replace: "    return moved", test: objectsEditor,
        consumer: "duplicate and session paste give fresh ids and next note numbers without touching the system clipboard", failure: /the copied note takes the next number/ },
      { label: "mark-copy-is-screenshot-copy", source: component + 'ImageAnnotationEditor.tsx',
        find: "if (event.shiftKey) return key === 'c' ? 'copy' : key === 'v' ? 'paste' : null", replace: "if (event.shiftKey) return key === 'v' ? 'paste' : null", test: objectsEditor,
        consumer: "duplicate and session paste give fresh ids and next note numbers without touching the system clipboard", failure: /pasted marks have fresh ids/ },
      { label: "restyle-first-only", source: component + 'ImageAnnotationEditor.tsx',
        find: "editShapes(restyleShapes(documentState.shapes, groupIds, shape => applies(shape) && (shape as unknown as Record<string, unknown>)[property] !== next", replace: "editShapes(restyleShapes(documentState.shapes, new Set([...groupIds].slice(0, 1)), shape => applies(shape) && (shape as unknown as Record<string, unknown>)[property] !== next", test: objectsEditor,
        consumer: "color and width apply to every selected mark that has them, as one Undo step", failure: /every selected mark takes the color/ },
      { label: "reopen-drops-lock", source: component + 'document.ts',
        find: "const common = { id, color, ...(base.locked ? { locked: true as const } : {}) }", replace: "const common = { id, color }", test: objectsEditor,
        consumer: "a reopened document keeps a locked mark locked in the editor and in its output", failure: /the reopened locked mark is not selectable/ },
      { label: "editor-chords-unclaimed", source: component + 'ImageAnnotationEditor.tsx',
        find: "return claimSurfaceChords(root, event => objectCommandFor(event) !== null)", replace: "return claimSurfaceChords(root, () => false)", test: windowShortcuts,
        consumer: "a focused editor keeps its object chords and the workbench commands do not run", failure: /Command-D reaches no workbench command/ },
      { label: "object-shortcuts-window-only", source: component + 'ImageAnnotationEditor.tsx',
        find: "const object = objectCommandFor(event)", replace: "const object = capture ? null : objectCommandFor(event)", test: objectsEditor,
        consumer: "a capture keeps the object shortcuts and adds no object buttons to its bar", failure: /Command-A then Command-D duplicates every mark in a capture/ }]
  },
  pointing: {
    tests: [pointing, pointingTools, 'apps/desktop/test/image-annotation-enhancements.test.ts', 'apps/desktop/test/image-annotation-geometry.test.ts'],
    mutations: [{ label: 'blur-not-a-mask', source: component + 'drawing-model.ts',
      find: "return shape.kind === 'pixelate' || shape.kind === 'pixelate-brush' || shape.kind === 'cover' || shape.kind === 'blur'",
      replace: "return shape.kind === 'pixelate' || shape.kind === 'pixelate-brush' || shape.kind === 'cover'", test: pointing,
      consumer: 'treats blur as a redaction mask that hides the notes under it from processed output and context', failure: /blur must join the redaction family/ },
    { label: 'spotlight-before-masks', source: component + 'drawing-model.ts',
      find: "  return shape.kind === 'callout' ? 2 : shape.kind === 'spotlight' ? 3 : 0", replace: "  return shape.kind === 'callout' ? 2 : 0", test: pointing,
      consumer: 'orders output as marks, masks, callouts, then spotlights while keeping order within each layer', failure: /spotlights paint after every other mark/ },
    { label: 'callout-samples-before-masks', source: component + 'drawing-model.ts',
      find: "  return shape.kind === 'callout' ? 2 : shape.kind === 'spotlight' ? 3 : 0", replace: "  return shape.kind === 'spotlight' ? 3 : 0", test: pointing,
      consumer: 'orders output as marks, masks, callouts, then spotlights while keeping order within each layer', failure: /callouts sample only processed mask pixels/ },
    { label: 'remove-keeps-number-gaps', source: component + 'drawing-model.ts',
      find: '  return shapes.length === doc.shapes.length ? doc : setShapes(doc, renumberNotes(shapes))',
      replace: '  return shapes.length === doc.shapes.length ? doc : setShapes(doc, shapes)', test: pointing,
      consumer: 'renumbers notes to 1..n after removal and restores the earlier numbers with one Undo', failure: /removing note 2 of 3 must leave 1, 2/ },
    { label: 'parser-accepts-any-zoom', source: component + 'document.ts',
      find: "zoom: inRange(base.zoom, CALLOUT_ZOOM_RANGE, 'The callout zoom is out of range.')", replace: 'zoom: positive(base.zoom)', test: pointing,
      consumer: 'rejects pointing marks with out-of-range strength, extra fields or missing geometry', failure: /callout zoom below 1\.5 must be rejected/ },
    { label: 'blur-tool-missing', source: component + 'AnnotationToolbar.tsx',
      find: "tools: ['crop', 'wand', 'pixelate', 'cover', 'blur', 'erase']", replace: "tools: ['crop', 'wand', 'pixelate', 'cover', 'erase']", test: pointingTools,
      consumer: 'offers blur, spotlight and magnifier as toolbar tools with their own letter shortcuts', failure: /real Blur control/ },
    { label: 'pointing-click-commits', source: component + 'ImageAnnotationEditor.tsx',
      find: "'cover', 'blur', 'spotlight', 'callout'])", replace: "'cover'])", test: pointingTools,
      consumer: 'draws each pointing tool as its own kind and commits nothing for a click without travel', failure: /a click with no drag commits no zero-size mark/ },
    { label: 'callout-bubble-fixed-while-drawing', source: component + 'ImageAnnotationEditor.tsx',
      find: 'currentGestureRef.current = createCalloutShape(shape.id, shape.color, shape.from, at, shape.zoom, undefined, bubblePlacement())', replace: 'shape.to = at', test: pointingTools,
      consumer: 'keeps the magnifier bubble beside its source while drawing, then drags only the bubble after release', failure: /the bubble follows the source as it grows/ },
    { label: 'callout-bubble-drags-whole-mark', source: component + 'ImageAnnotationEditor.tsx',
      find: "const bubble = !handle && shape?.kind === 'callout' && rectContains(calloutBubble(shape), at)", replace: 'const bubble = false', test: pointingTools,
      consumer: 'keeps the magnifier bubble beside its source while drawing, then drags only the bubble after release', failure: /dragging inside the bubble moves only the bubble/ },
    { label: 'strength-ignores-selection', source: component + 'ImageAnnotationEditor.tsx',
      find: '    editShapes(restyled)', replace: '    void restyled', test: pointingTools,
      consumer: 'changes a selected pointing mark through its strength control as one Undo step, else sets the next one', failure: /the selected mark takes the new strength/ },
    { label: 'renumber-unwired', source: component + 'ImageAnnotationEditor.tsx',
      find: 'onRenumber={() => { commitNote(); edit(doc => setShapes(doc, renumberNotes(doc.shapes))) }}', replace: 'onRenumber={() => { commitNote() }}', test: pointingTools,
      consumer: 'renumbers a gapped original to 1..n with one action and restores it with one Undo', failure: /explicit renumbering makes the numbers continuous/ },
    { label: 'capture-callout-missing', source: component + 'CaptureToolbar.tsx',
      find: "'pixelate', 'blur', 'text', 'note', 'callout'] as const", replace: "'pixelate', 'blur', 'text', 'note'] as const", test: pointingTools,
      consumer: 'offers blur and the magnifier on the light capture toolbar and keeps spotlight in the window editor', failure: /carries blur and the magnifier/ },
    { label: 'new-note-max-plus-one', source: component + 'ImageAnnotationEditor.tsx',
      find: 'number: nextNoteNumber(documentState.shapes)', replace: 'number: Math.max(0, ...notes.map(note => note.number)) + 1', test: pointingTools,
      consumer: 'numbers a new note after every existing note when a saved original repeats a number', failure: /a new note takes the number after all existing notes/ },
    { label: 'blur-strength-in-screen-pixels', source: component + 'ImageAnnotationEditor.tsx',
      find: '[strength.property]: value } as ScreenshotShape', replace: '[strength.property]: value / viewRef.current.scale } as ScreenshotShape', test: pointingTools,
      consumer: 'keeps a selected blur strength in image pixels within the model range when the fitted view is not one to one', failure: /the strongest blur stays at the model maximum/ },
    { label: 'callout-bubble-ignores-bounds', source: component + 'drawing-model.ts',
      find: 'at: at ?? calloutPlacement(source, source.width * scale, source.height * scale, placement)', replace: 'at: at ?? { x: source.x + source.width + CALLOUT_GAP, y: source.y }', test: pointing,
      consumer: 'places a default bubble inside the image or selection: right, else left, else below or above, else clamped', failure: /flips left when the right side has no room/ },
    { label: 'callout-clamp-ignores-overlap', source: component + 'drawing-model.ts',
      find: 'return candidates.map(clamped).reduce((best, next) => cover(next) < cover(best) ? next : best)', replace: 'return kept', test: pointing,
      consumer: 'clamps a bubble that fits nowhere to the place covering least of its source, ties going right, left, below, above', failure: /the left clamp clears a source near the right/ },
    { label: 'callout-gap-in-image-pixels', source: component + 'ImageAnnotationEditor.tsx',
      find: 'gap: CALLOUT_GAP / viewRef.current.scale', replace: 'gap: CALLOUT_GAP', test: pointingTools,
      consumer: 'keeps a magnifier bubble the same screen distance from its source when the view is not one to one', failure: /twenty screen points are forty image pixels/ },
    { label: 'callout-leader-stub-drawn', source: component + 'drawing-renderer.ts',
      find: '* transform.a >= CALLOUT_LEADER_MIN', replace: '* transform.a >= 0', test: pointing,
      consumer: 'draws the leader only when it is long enough to read and never a stub between touching frames', failure: /a 3 point gap draws no leader/ }]
  },
  capture: {
    tests: [capture, overlay, windowView, modeless, 'apps/desktop/test/image-annotation-editing.test.tsx'],
    mutations: [{ label: 'notch-bar-above-ignores-band', source: component + 'capture-geometry.ts',
      find: "    : above - CAPTURE_PROPERTIES_REACH >= frame.top + CAPTURE_BAR_INSET ? 'above' : 'inside'", replace: "    : above - CAPTURE_PROPERTIES_REACH >= CAPTURE_BAR_INSET ? 'above' : 'inside'", test: capture,
      consumer: 'keeps the hint, toolbar, size chip and loupe below a camera housing while the selection still reaches the top edge', failure: /the housing takes the room above/ },
    { label: 'notch-bar-clamp-ignores-band', source: component + 'capture-geometry.ts',
      find: '    top: clamp(top, frame.top + CAPTURE_BAR_INSET,', replace: '    top: clamp(top, CAPTURE_BAR_INSET,', test: capture,
      consumer: 'keeps the hint, toolbar, size chip and loupe below a camera housing while the selection still reaches the top edge', failure: /a bar pushed inside a short top selection stays below the band/ },
    { label: 'notch-chip-above-ignores-band', source: component + 'capture-geometry.ts',
      find: "&& above >= frame.top ? above : inside }", replace: "&& above >= 0 ? above : inside }", test: capture,
      consumer: 'keeps the hint, toolbar, size chip and loupe below a camera housing while the selection still reaches the top edge', failure: /a chip that would sit in the band moves inside the selection/ },
    { label: 'notch-chip-inside-ignores-band', source: component + 'capture-geometry.ts',
      find: '  const inside = Math.max(selection.y + SIZE_CHIP_GAP, frame.top)', replace: '  const inside = selection.y + SIZE_CHIP_GAP', test: capture,
      consumer: 'keeps the hint, toolbar, size chip and loupe below a camera housing while the selection still reaches the top edge', failure: /a selection at the top edge keeps its chip below the band/ },
    { label: 'notch-loupe-above-ignores-band', source: component + 'capture-geometry.ts',
      find: 'box.left >= 0 && box.top >= frame.top && box.left', replace: 'box.left >= 0 && box.top >= 0 && box.left', test: capture,
      consumer: 'keeps the hint, toolbar, size chip and loupe below a camera housing while the selection still reaches the top edge', failure: /a loupe above the pointer that would reach into the band is not chosen/ },
    { label: 'notch-loupe-below-ignores-band', source: component + 'capture-geometry.ts',
      find: 'below = Math.max(at.y + LOUPE_OFFSET, frame.top)', replace: 'below = at.y + LOUPE_OFFSET', test: capture,
      consumer: 'keeps the hint, toolbar, size chip and loupe below a camera housing while the selection still reaches the top edge', failure: /at the top-right corner the loupe opens below the band and left of the pointer/ },
    { label: 'notch-hint-unplaced', source: component + 'ImageAnnotationEditor.tsx',
      find: "...(safeTop ? { '--capture-safe-top': safeTop + 'px' } : {})", replace: '', test: capture,
      consumer: 'keeps the hint, toolbar, size chip and loupe below a camera housing while the selection still reaches the top edge', failure: /the hint is placed below the band through one variable/ },
    { label: 'notch-band-unread', source: component + 'ImageAnnotationEditor.tsx',
      find: '    const frame = { width: size.width, height: size.height, top: safeTop }', replace: '    const frame = { width: size.width, height: size.height, top: 0 }', test: capture,
      consumer: 'keeps the hint, toolbar, size chip and loupe below a camera housing in the mounted overlay', failure: /the mounted size chip stays below the band/ },
    { label: 'notch-band-not-forwarded', source: overlayHost,
      find: ' safeTop={input.safeTop}', replace: '', test: capture,
      consumer: 'keeps the hint, toolbar, size chip and loupe below a camera housing in the mounted overlay', failure: /the overlay forwards its display's band/ },
    { label: 'window-handed-marks-kept', source: windowHost,
      find: 'initialStateKept: input.initialState.shapes.length === 0,', replace: '', test: windowView,
      consumer: 'marks moved here with Command E are unkept, so Retake confirms before it drops them', failure: /Retake waits for the in-place confirmation/ },
    { label: 'capture-remembered-selection-hides-windows', source: component + 'ImageAnnotationEditor.tsx',
      find: 'lightWindow(!crop || suggested && !rectContains(crop, spot) ? windowAt(spot) : null)', replace: 'lightWindow(crop ? null : windowAt(spot))', test: capture,
      consumer: 'outside an untouched remembered selection a window still lights and a click selects it', failure: /the front window lights outside the untouched remembered selection/ },
    { label: 'capture-remembered-selection-blocks-window-click', source: component + 'ImageAnnotationEditor.tsx',
      find: '&& (!crop.original || untouched) ? windowAt(crop.start)', replace: '&& !crop.original ? windowAt(crop.start)', test: capture,
      consumer: 'outside an untouched remembered selection a window still lights and a click selects it', failure: /a click outside the untouched remembered selection selects the window/ },
    { label: 'capture-expand-external-link', source: component + 'CaptureToolbar.tsx',
      find: "ExpandIcon = icon('layout.expand')", replace: "ExpandIcon = icon('action.open-external')", test: capture,
      consumer: 'draws every capture control with its own glyph, and Expand editor with the expand glyph rather than an external link', failure: /expanding stays in the editor/ },
    { label: 'capture-no-crop-delivery-allowed', source: component + 'ImageAnnotationEditor.tsx',
      find: '    if (capture && !documentState.crop) return\n', replace: '', test: capture,
      consumer: 'delivers only a selection: Enter and Command C do nothing before one exists', failure: /no selection means no delivery/ },
    { label: 'capture-toolbar-visible-while-dragging', source: component + 'ImageAnnotationEditor.tsx',
      find: 'documentState.crop !== null && gesture === null', replace: 'documentState.crop !== null', test: capture,
      consumer: 'hides the toolbar while the selection is dragged and shows it at rest', failure: /toolbar is hidden while the selection moves/ },
    { label: 'capture-mark-button-expands', source: component + 'CaptureToolbar.tsx',
      find: "onClick={() => onTool(tool === item.id ? 'select' : item.id)}", replace: "onClick={() => { onTool(tool === item.id ? 'select' : item.id); onExpand() }}", test: capture,
      consumer: 'a mark button only changes the current tool, and pressing it again returns to the selection tool', failure: /mark button opens no other editor/ },
    { label: 'capture-toolbar-gap-wrong', source: component + 'capture-geometry.ts',
      find: 'CAPTURE_BAR_GAP = 8', replace: 'CAPTURE_BAR_GAP = 6', test: capture,
      consumer: 'places the toolbar below the selection, else above, else inside, clamped to the frame', failure: /keeps the bar 8 below/ },
    { label: 'capture-right-click-with-marks-clears', source: component + 'ImageAnnotationEditor.tsx',
      find: 'else if (!documentState.shapes.length && !rectContains(crop, point(event)))', replace: 'else if (!rectContains(crop, point(event)))', test: capture,
      consumer: 'right-click outside the selection clears it without marks, keeps it with marks, and cancels without a selection', failure: /keeps a selection that has marks/ },
    { label: 'capture-view-fitted', source: component + 'ImageAnnotationEditor.tsx',
      find: 'const fitView = () => capture ? { scale: 1 / pixelRatio, x: 0, y: 0 } : fitImageView(', replace: 'const fitView = () => fitImageView(', test: capture,
      consumer: 'shows the whole frozen display at a fixed one-to-one pixel scale without zoom, pan or window chrome', failure: /keeps one image pixel per screen pixel/ },
    { label: 'capture-dim-inside-selection', source: component + 'ImageAnnotationEditor.tsx',
      find: "    if (!crop) { context.fillRect(0, 0, image.width, image.height); return paintLitWindow(context, unit, time) }\n", replace: '    context.fillRect(0, 0, image.width, image.height)\n    if (!crop) return paintLitWindow(context, unit, time)\n', test: capture,
      consumer: 'drags a selection that becomes the crop and dims the frozen frame outside it', failure: /covers exactly the four bands outside the selection/ },
    { label: 'capture-expand-without-marks', source: component + 'ImageAnnotationEditor.tsx',
      find: 'onExpand?.({ shapes: currentShapes(), crop: documentState.crop, tool })', replace: 'onExpand?.({ shapes: [], crop: documentState.crop, tool })', test: capture,
      consumer: 'Command S, Command P and Command E act directly on the processed selection', failure: /hands marks, selection and tool to the window editor/ },
    { label: 'capture-loupe-at-rest', source: component + 'ImageAnnotationEditor.tsx',
      find: 'setHover(cropRef.current || !crop ? { at, sample: sampleLoupe(at) } : null)', replace: 'setHover({ at, sample: sampleLoupe(at) })', test: capture,
      consumer: 'shows the loupe before a selection and while adjusting it, hides it at rest, and copies the sampled color on C', failure: /moves at rest read no frozen pixels/ },
    { label: 'capture-double-click-delivery-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: "else if (capture && !shape && tool === 'select' && crop && rectContains(crop, at)) complete()", replace: 'else void crop', test: capture,
      consumer: 'double-click inside the selection with the selection tool is the primary delivery', failure: /double-click inside delivers the selection/ },
    { label: 'capture-locked-still-selects', source: component + 'ImageAnnotationEditor.tsx',
      find: 'if (!active || locked || (event.button', replace: 'if (!active || (event.button', test: capture,
      consumer: 'a locked display keeps its dimmed frozen frame and Cancel but makes no selection, loupe or color copy', failure: /locked display makes no selection/ },
    { label: 'capture-locked-still-samples', source: component + 'ImageAnnotationEditor.tsx',
      find: "    if (locked) return\n    const at = localPoint(event)", replace: '    const at = localPoint(event)', test: capture,
      consumer: 'a locked display keeps its dimmed frozen frame and Cancel but makes no selection, loupe or color copy', failure: /locked display shows no loupe/ },
    { label: 'capture-lock-keeps-earlier-selection', source: component + 'ImageAnnotationEditor.tsx',
      find: 'resetGesture(); selectOnly(null); setHover(null); setDocumentState(createScreenshotDocument()); schedulePaint()', replace: 'resetGesture(); selectOnly(null); setHover(null); schedulePaint()', test: capture,
      consumer: 'a lock that arrives after a selection or during its drag drops it', failure: /selection made before the lock is dropped/ },
    { label: 'capture-selection-not-claimed', source: component + 'ImageAnnotationEditor.tsx',
      find: "edit(doc => setCrop(doc, box)); if (crop.mode === 'create') onSelect?.()", replace: 'edit(doc => setCrop(doc, box))', test: capture,
      consumer: 'claims the selection once a drag makes one, and not for a click, move or resize', failure: /a drag claims the selection/ },
    { label: 'capture-move-claims-again', source: component + 'ImageAnnotationEditor.tsx',
      find: "edit(doc => setCrop(doc, box)); if (crop.mode === 'create') onSelect?.()", replace: 'edit(doc => setCrop(doc, box)); onSelect?.()', test: capture,
      consumer: 'claims the selection once a drag makes one, and not for a click, move or resize', failure: /moving or resizing claims nothing more/ },
    { label: 'capture-create-click-threshold-dead', source: component + 'ImageAnnotationEditor.tsx',
      find: "if (mode === 'create') downRef.current = { at: localPoint(event), deselected: false }", replace: 'void mode', test: capture,
      consumer: 'a click that barely moves keeps the selection, and shows it while pressed', failure: /trackpad jitter keeps the selection/ },
    { label: 'capture-hint-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: '{hint ? <CaptureHint text={hint} onCancel={requestClose} /> : null}', replace: '{void hint}', test: capture,
      consumer: 'shows a one-line hint with Cancel before a selection and hides it once one exists', failure: /hint names the gestures and keys/ },
    { label: 'capture-escape-keeps-moved-selection', source: component + 'capture-geometry.ts',
      find: 'return gesture ? cropGestureRect(gesture, bounds) ?? gesture.original : kept', replace: 'return gesture ? cropGestureRect(gesture, bounds) : kept', test: capture,
      consumer: 'a click that barely moves keeps the selection, and shows it while pressed', failure: /press without travel still shows the kept selection/ },
    { label: 'capture-reset-keeps-selection-gesture', source: component + 'ImageAnnotationEditor.tsx',
      find: 'currentGestureRef.current = null; transformRef.current = null; cropRef.current = null; eraseRef.current = null', replace: 'currentGestureRef.current = null; transformRef.current = null; eraseRef.current = null', test: capture,
      consumer: 'Escape or lost pointer capture during a move restores the selection, and Command Z undoes a move', failure: /Escape during a move restores the selection/ },
    { label: 'capture-undo-keeps-selection', source: component + 'ImageAnnotationEditor.tsx',
      find: 'const undo = useCallback(() => { resetGesture(); edit(undoShape); schedulePaint() }', replace: 'const undo = useCallback(() => { resetGesture(); edit(doc => doc.crop ? doc : undoShape(doc)); schedulePaint() }', test: capture,
      consumer: 'Escape or lost pointer capture during a move restores the selection, and Command Z undoes a move', failure: /Command Z restores the selection before the move/ },
    { label: 'capture-chip-under-toolbar', source: component + 'capture-geometry.ts',
      find: "top: barSide !== 'above' && above >= frame.top ? above : inside", replace: 'top: above >= frame.top ? above : inside', test: capture,
      consumer: 'keeps the size chip off the toolbar side and leaves room for the property popover', failure: /chip moves inside when the bar takes the side above/ },
    { label: 'capture-popover-room-ignored', source: component + 'capture-geometry.ts',
      find: 'below + CAPTURE_BAR_HEIGHT + CAPTURE_PROPERTIES_REACH <= frame.height - CAPTURE_BAR_INSET', replace: 'below + CAPTURE_BAR_HEIGHT <= frame.height - CAPTURE_BAR_INSET', test: capture,
      consumer: 'keeps the size chip off the toolbar side and leaves room for the property popover', failure: /flips above when the popover has no room below/ },
    { label: 'capture-measure-every-render', source: component + 'ImageAnnotationEditor.tsx',
      find: '}, [capture, barShown, sizeText, label, busy, busyLabel, confirmingDiscard])', replace: '})', test: capture,
      consumer: 'moving a selection forces no layout of the toolbar or size chip', failure: /pointer moves that keep the size measure nothing/ },
    // A remembered selection opens at rest, claims only once acted on, and its host claims before an unchanged output.
    { label: 'capture-remembered-claims-on-open', source: component + 'ImageAnnotationEditor.tsx',
      find: '    if (!start || documentState === start) return\n', replace: '    if (!start) return\n', test: capture,
      consumer: 'opens on a remembered selection at rest, claims it only once acted on, and delivers it only on Enter', failure: /opening on it delivers, claims and cancels nothing/ },
    { label: 'capture-remembered-never-claimed', source: component + 'ImageAnnotationEditor.tsx',
      find: '    if (documentState.crop) claimSelection?.()\n', replace: '', test: capture,
      consumer: 'opens on a remembered selection at rest, claims it only once acted on, and delivers it only on Enter', failure: /moving the remembered selection claims it once/ },
    { label: 'capture-remembered-cleared-claims', source: component + 'ImageAnnotationEditor.tsx',
      find: '    if (documentState.crop) claimSelection?.()\n', replace: '    claimSelection?.()\n', test: capture,
      consumer: 'opens on a remembered selection at rest, claims it only once acted on, and delivers it only on Enter', failure: /clearing the remembered selection claims nothing/ },
    { label: 'capture-remembered-redraw-claims-twice', source: component + 'ImageAnnotationEditor.tsx',
      find: '  const onSelect = () => { opening.current = null; claimSelection?.() }', replace: '  const onSelect = () => { claimSelection?.() }', test: capture,
      consumer: 'opens on a remembered selection at rest, claims it only once acted on, and delivers it only on Enter', failure: /re-drawn over the remembered one claims once/ },
    { label: 'capture-remembered-not-opened', source: overlayHost,
      find: "{...(input.initialCrop ? { initialState: { shapes: [], crop: input.initialCrop } } : {})} ", replace: '', test: overlay,
      consumer: 'a remembered selection claims the capture only when the person outputs it, then delivers that selection', failure: /opens on the remembered selection at rest/ },
    { label: 'capture-remembered-output-unclaimed', source: overlayHost,
      find: '      if (!await claim()) return false\n', replace: '', test: overlay,
      consumer: 'a remembered selection claims the capture only when the person outputs it, then delivers that selection', failure: /Save PNG claims the selection before its output/ },
    { label: 'capture-remembered-lost-claim-delivers', source: overlayHost,
      find: '      if (!await claim()) return false\n', replace: '      await claim()\n', test: overlay,
      consumer: 'a remembered selection whose claim another display won outputs nothing and locks this display', failure: /a lost claim delivers nothing/ },
    { label: 'capture-remembered-expand-unclaimed', source: overlayHost,
      find: 'void claim().then(owned => owned ? api.expand(input.requestId, background, handoff) : undefined)', replace: 'void api.expand(input.requestId, background, handoff)', test: overlay,
      consumer: 'a remembered selection whose claim another display won outputs nothing and locks this display', failure: /Command E claims before the marks move/ },
    { label: 'capture-claim-asked-per-output', source: overlayHost,
      find: '    claimed.current ??= api.select(', replace: '    claimed.current = api.select(', test: overlay,
      consumer: 'a remembered selection claims the capture only when the person outputs it, then delivers that selection', failure: /one answer serves every later output/ }]
  },
  snapping: {
    tests: [snapping, capture],
    mutations: [{ label: 'snap-threshold-ignored', source: component + 'snapping.ts',
      find: 'if (gap <= threshold && gap < best)', replace: 'if (gap < best)', test: snapping,
      consumer: 'snaps within 6 screen points and leaves anything farther exactly where it is', failure: /a point 12 px from the left edge lands on it|a point 13 px away stays put/ },
    { label: 'snap-distance-wrong', source: component + 'snapping.ts',
      find: 'export const SNAP_DISTANCE = 6', replace: 'export const SNAP_DISTANCE = 8', test: capture,
      consumer: 'snaps a new selection to window edges within 6 points and not beyond, with guides only while it engages', failure: /beyond 6 points no guide shows/ },
    { label: 'snap-mark-centre-omitted', source: component + 'snapping.ts',
      find: 'x.push(rect.x, rect.x + rect.width / 2, rect.x + rect.width)', replace: 'x.push(rect.x, rect.x + rect.width)', test: snapping,
      consumer: 'offers marks their edges and centre, and windows and the selection their edges only', failure: /every candidate line in image pixels/ },
    { label: 'snap-resize-moves-every-edge', source: component + 'snapping.ts',
      find: "return { x: handle.includes('w') ? [rect.x] : handle.includes('e') ? [right] : [], y: handle.includes('n') ? [rect.y] : handle.includes('s') ? [bottom] : [] }",
      replace: 'return { x: [rect.x, right], y: [rect.y, bottom] }', test: snapping,
      consumer: 'snaps a resized rect only by the edges its handle moves', failure: /an east handle moves only the right edge/ },
    { label: 'snap-gesture-unsnapped', source: component + 'ImageAnnotationEditor.tsx',
      find: '    if (capture && !unsnapped) at = snapPoint(at, constrained)\n', replace: '', test: capture,
      consumer: 'snaps a new selection to window edges within 6 points and not beyond, with guides only while it engages', failure: /one vertical guide runs across the frame/ },
    { label: 'snap-command-ignored', source: component + 'ImageAnnotationEditor.tsx',
      find: '    if (capture && !unsnapped) at = snapPoint(at, constrained)\n', replace: '    if (capture) at = snapPoint(at, constrained)\n', test: capture,
      consumer: 'snaps a moved selection and drawn and moved marks, and holding Command suspends it', failure: /with Command held a drawn mark follows the pointer exactly/ },
    { label: 'snap-drawn-mark-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: '    else if (drawn && REGION_KINDS.has(drawn.kind)) features = end\n', replace: '', test: capture,
      consumer: 'snaps a moved selection and drawn and moved marks, and holding Command suspends it', failure: /a drawn region mark lands on the selection edge/ },
    { label: 'snap-moved-mark-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: '      features = transform.handle ? end : rectFeatures(offset(box, transform.start), null)', replace: '      features = transform.handle ? end : null', test: capture,
      consumer: 'snaps a moved selection and drawn and moved marks, and holding Command suspends it', failure: /a moved mark lands on another mark edge/ },
    { label: 'snap-resize-offers-every-edge', source: component + 'ImageAnnotationEditor.tsx',
      find: "rectFeatures(offset(crop.original, crop.start), crop.mode === 'move' ? null : crop.mode)", replace: 'rectFeatures(offset(crop.original, crop.start), null)', test: capture,
      consumer: 'a resized selection snaps only its moving edge, and a dragged mark handle snaps its corner', failure: /a resize far from any line leaves its moving edge on the pointer/ },
    { label: 'snap-mark-handle-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: '      features = transform.handle ? end : rectFeatures(offset(box, transform.start), null)', replace: '      features = transform.handle ? null : rectFeatures(offset(box, transform.start), null)', test: capture,
      consumer: 'a resized selection snaps only its moving edge, and a dragged mark handle snaps its corner', failure: /a dragged mark handle lands on the window corner/ },
    { label: 'snap-view-scale-ignored', source: component + 'ImageAnnotationEditor.tsx',
      find: 'SNAP_DISTANCE / viewRef.current.scale', replace: 'SNAP_DISTANCE', test: capture,
      consumer: 'snaps a new selection to window edges within 6 points and not beyond, with guides only while it engages', failure: /one vertical guide runs across the frame|the corner landed on the front window corner/ },
    { label: 'snap-guides-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: '    if (snapped.guides.x.length || snapped.guides.y.length) guidesRef.current = snapped.guides\n', replace: '', test: capture,
      consumer: 'snaps a new selection to window edges within 6 points and not beyond, with guides only while it engages', failure: /one vertical guide runs across the frame/ },
    { label: 'snap-guides-kept-after-release', source: component + 'ImageAnnotationEditor.tsx',
      find: 'lastErasePoint.current = null; panRef.current = null; downRef.current = null; guidesRef.current = null;', replace: 'lastErasePoint.current = null; panRef.current = null; downRef.current = null;', test: capture,
      consumer: 'snaps a new selection to window edges within 6 points and not beyond, with guides only while it engages', failure: /the guides disappear on release/ },
    { label: 'window-hit-backmost', source: component + 'ImageAnnotationEditor.tsx',
      find: '  function windowAt(at: ScreenshotPoint): NormalizedRect | null { return windows.find(window => rectContains(window, at)) ?? null }',
      replace: '  function windowAt(at: ScreenshotPoint): NormalizedRect | null { return windows.findLast(window => rectContains(window, at)) ?? null }', test: capture,
      consumer: 'lights the topmost window under the pointer before a selection, fading in over 90 ms', failure: /the front window lights first where both contain the pointer/ },
    { label: 'window-click-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: "const target = crop.mode === 'create' && click && !down.dragged && (!crop.original || untouched) ? windowAt(crop.start) : null", replace: 'const target = null as NormalizedRect | null', test: capture,
      consumer: 'a click without travel selects the window under it, clipped to the frame, and claims it', failure: /a window click claims the selection/ },
    { label: 'window-click-after-drag', source: component + 'ImageAnnotationEditor.tsx',
      find: "crop.mode === 'create' && click && !down.dragged && (!crop.original || untouched)", replace: "crop.mode === 'create' && click && (!crop.original || untouched)", test: capture,
      consumer: 'a press that drags away and comes back to its start selects no window', failure: /a press that became a drag selects nothing on its way back/ },
    { label: 'window-hint-omits-click', source: component + 'ImageAnnotationEditor.tsx',
      find: "${windows.length ? 'Click a window or drag' : 'Drag'} to select", replace: 'Drag to select', test: capture,
      consumer: 'the hint names the window click only when the frame has windows to click', failure: /with windows the hint names the click that selects one/ },
    { label: 'window-click-unclipped', source: component + 'ImageAnnotationEditor.tsx',
      find: 'const box = target ? intersectRect(target, originalBounds) : cropGestureRect(crop, originalBounds)', replace: 'const box = target ?? cropGestureRect(crop, originalBounds)', test: capture,
      consumer: 'a click without travel selects the window under it, clipped to the frame, and claims it', failure: /the back window is clipped to the frame/ },
    { label: 'window-hover-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: '    lightWindow(!crop || suggested && !rectContains(crop, spot) ? windowAt(spot) : null)\n', replace: '', test: capture,
      consumer: 'lights the topmost window under the pointer before a selection, fading in over 90 ms', failure: /the front window lights first where both contain the pointer/ },
    { label: 'window-hover-repaints-every-move', source: component + 'ImageAnnotationEditor.tsx',
      find: '    if (rect === (litWindowRef.current?.rect ?? null)) return\n', replace: '', test: capture,
      consumer: 'lights the topmost window under the pointer before a selection, fading in over 90 ms', failure: /moves that light no other window repaint nothing/ },
    { label: 'window-fade-ignores-reduced-motion', source: component + 'ImageAnnotationEditor.tsx',
      find: "since: ownerWindow.matchMedia('(prefers-reduced-motion: reduce)').matches ? -Infinity : null", replace: 'since: null', test: capture,
      consumer: 'lights the topmost window under the pointer before a selection, fading in over 90 ms', failure: /reduced motion shows the highlight whole/ },
    { label: 'window-fade-never-finishes', source: component + 'ImageAnnotationEditor.tsx',
      find: '        if (fading) schedulePaint()\n', replace: '', test: capture,
      consumer: 'lights the topmost window under the pointer before a selection, fading in over 90 ms', failure: /the fade asks for its next frame/ },
    { label: 'window-fade-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: '    context.globalAlpha = 1 - (1 - progress) ** 2\n', replace: '', test: capture,
      consumer: 'lights the topmost window under the pointer before a selection, fading in over 90 ms', failure: /its first frame begins the fade/ },
    { label: 'window-leave-keeps-highlight', source: component + 'ImageAnnotationEditor.tsx',
      find: 'if (capture) { setHover(null); lightWindow(null) }', replace: 'if (capture) setHover(null);', test: capture,
      consumer: 'lights the topmost window under the pointer before a selection, fading in over 90 ms', failure: /leaving the frame clears the highlight/ },
    { label: 'overlay-windows-unwired', source: 'apps/desktop/src/renderer/screenshot-editor/CaptureSurfaceView.tsx',
      find: ' windows={input.windows}', replace: '', test: capture,
      consumer: 'the capture overlay hands its frozen windows to the editor, so a click there selects one', failure: /a click on a frozen window claims the selection/ }]
  },
  modeless: {
    tests: [modeless, 'apps/desktop/test/image-annotation-editing.test.tsx'],
    mutations: [{ label: 'hit-first-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: "if (tool !== 'erase' && tool !== 'crop') {", replace: "if (tool === 'select') {", test: modeless,
      consumer: 'a drawing tool moves the existing mark it presses instead of drawing over it', failure: /must not add a rectangle/ },
    { label: 'auto-select-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: 'edit(doc => commitShape(doc, shape)); selectOnly(shape.id)', replace: 'edit(doc => commitShape(doc, shape))', test: modeless,
      consumer: 'a new rectangle stays selected so Color recolors it without switching to Select', failure: /actual new rectangle is selected/ },
    { label: 'click-threshold-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: 'const click = down !== null && Math.hypot(up.x - down.at.x, up.y - down.at.y) < CLICK_DISTANCE', replace: 'const click = false', test: modeless,
      consumer: 'a click without travel adds no region mark and no Undo entry', failure: /actual stray click creates no rectangle/ },
    { label: 'escape-closes-at-once', source: component + 'ImageAnnotationEditor.tsx',
      find: "if (textDraftRef.current) finishText('', true)", replace: 'if (true) onCancel()', test: modeless,
      consumer: 'Escape peels selection and tool before asking to discard unkept marks', failure: /first Escape clears the selection/ },
    { label: 'kept-output-confirmation-ignored', source: component + 'ImageAnnotationEditor.tsx',
      find: 'if (confirmed === true) { setExported(kept); setDiscarding(false) }', replace: 'void confirmed', test: modeless,
      consumer: 'an output the host confirms as kept lets Escape close without asking', failure: /actual confirmed output needs no discard bar/ }]
  },
  enhancements: {
    tests: ['apps/desktop/test/image-annotation-enhancements.test.ts', 'apps/desktop/test/image-annotation-editing.test.tsx',
      'apps/desktop/test/image-annotation-compact-toolbar.test.tsx', 'apps/desktop/test/annotation-toolbar-focus.test.tsx'],
    mutations: [{ label: 'brush-note-filter-omitted', source: component + 'drawing-model.ts',
      find: "return shape.kind === 'pixelate' || shape.kind === 'pixelate-brush' || shape.kind === 'cover'",
      replace: "return shape.kind === 'pixelate' || shape.kind === 'cover'",
      test: 'apps/desktop/test/image-annotation-enhancements.test.ts',
      consumer: 'filters only notes touched by the actual brush corridor from processed Agent context and retains editable originals', failure: /actual brush filtering must omit/ },
    { label: 'gesture-constraint-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: '? constrainedEndpoint(shape.kind, shape.from, at) : at', replace: '? at : at',
      test: 'apps/desktop/test/image-annotation-editing.test.tsx',
      consumer: 'applies Shift constraints through real pointer gestures and releases them without changing the image scale', failure: /actual Shift rectangle must be equal-sided/ },
    { label: 'multiline-newline-intercepted', source: component + 'ImageAnnotationEditor.tsx',
      find: "event.key === 'Enter' && (event.metaKey || event.ctrlKey)", replace: "event.key === 'Enter'",
      test: 'apps/desktop/test/image-annotation-editing.test.tsx',
      consumer: 'keeps Enter for multiline input and commits exact custom-colored text only on modifier Enter', failure: /ordinary Enter must remain a native newline/ },
    { label: 'save-png-callback-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: "'save-png': onSavePng,", replace: "'save-png': undefined,",
      test: 'apps/desktop/test/image-annotation-editing.test.tsx',
      consumer: 'draws one brush mask in original pixels and undoes the whole gesture while all output actions consume the same edited snapshot', failure: /called at least once/ },
    { label: 'compact-tool-selection-omitted', source: component + 'AnnotationToolbar.tsx',
      find: 'onSelect={() => onTool(item.id)}', replace: 'onSelect={() => {}}',
      test: 'apps/desktop/test/image-annotation-compact-toolbar.test.tsx',
      consumer: 'the compact radio menu selects the actual editor tool and exposes its checked state', failure: /actual menu selection reaches/ },
    { label: 'compact-escape-dismissal-blocked', source: component + 'AnnotationToolbar.tsx',
      find: 'onEscapeKeyDown={event => { if (isImeOwnedKeyboardEvent(event)) event.preventDefault(); else event.stopPropagation() }}', replace: 'onEscapeKeyDown={event => event.preventDefault()}',
      test: 'apps/desktop/test/image-annotation-compact-toolbar.test.tsx',
      consumer: 'Escape dismisses the compact markup popup before a later Canvas Escape cancels editing', failure: /first Escape dismisses only/ },
    { label: 'compact-host-active-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: '<AnnotationToolbar active={active}', replace: '<AnnotationToolbar active={true}',
      test: 'apps/desktop/test/image-annotation-compact-toolbar.test.tsx',
      consumer: 'hiding the actual editor closes its tool portal and preserves another workface focus', failure: /inactive editor must close/ },
    { label: 'compact-hidden-focus-restoration', source: component + 'AnnotationToolbar.tsx',
      find: 'onCloseAutoFocus={event => { if (!active) event.preventDefault() }}', replace: 'onCloseAutoFocus={() => {}}',
      test: 'apps/desktop/test/image-annotation-compact-toolbar.test.tsx',
      consumer: 'hiding the actual editor closes its tool portal and preserves another workface focus', failure: /late menu cleanup cannot steal/ },
    { label: 'compact-hidden-open-state-retained', source: component + 'AnnotationToolbar.tsx',
      find: 'useEffect(() => { if (!active) setOpen(false) }, [active])', replace: 'useEffect(() => {}, [active])',
      test: 'apps/desktop/test/image-annotation-compact-toolbar.test.tsx',
      consumer: 'hiding the actual editor closes its tool portal and preserves another workface focus', failure: /showing the retained image does not reopen/ },
    { label: 'compact-busy-pan-disabled', source: component + 'AnnotationToolbar.tsx',
      find: "disabled={busy && item.id !== 'pan'} onSelect", replace: 'disabled={busy} onSelect',
      test: 'apps/desktop/test/image-annotation-compact-toolbar.test.tsx',
      consumer: 'the busy compact menu keeps only Pan selectable and pans without adding an edit', failure: /actual busy Pan stays available/ }]
  },
  'text-preservation': {
    tests: ['apps/desktop/test/image-annotation-text-preservation.test.tsx'],
    mutations: [{ label: 'text-commit-truncated', source: component + 'ImageAnnotationEditor.tsx',
      find: 'const text = value', replace: 'const text = value.trim().slice(0, 500)',
      test: 'apps/desktop/test/image-annotation-text-preservation.test.tsx',
      consumer: 'keeps explicit long text and note edits complete and Undoable without character caps', failure: /explicit text edit remains exact/ },
    { label: 'selected-note-output-truncated', source: component + 'ImageAnnotationEditor.tsx',
      find: 'let shapes = selectedNote ? documentState.shapes.map(shape => shape.id === selectedNote.id ? { ...selectedNote, note: noteDraft } : shape) : documentState.shapes',
      replace: 'let shapes = selectedNote ? documentState.shapes.map(shape => shape.id === selectedNote.id ? { ...selectedNote, note: noteDraft.trim().slice(0, 1000) } : shape) : documentState.shapes',
      test: 'apps/desktop/test/image-annotation-text-preservation.test.tsx',
      consumer: 'preserves the selected original note through real file save and context output', failure: /selected original note output remains exact/ }]
  },
  boundary: {
    tests: ['workface.test.tsx', 'native-overlay.test.tsx', 'toolbar.test.tsx', 'model.test.ts', 'compose.test.ts', 'context.test.ts']
      .map(name => 'apps/desktop/test/browser-screenshot-' + name),
    mutations: [{ label: 'adapter-cancel-omitted', source: adapter,
      find: 'function cancel() { operation.current += 1; props.onCancel() }', replace: 'function cancel() { operation.current += 1 }',
      test: 'apps/desktop/test/browser-screenshot-workface.test.tsx',
      consumer: 'Cancel exits the real editor and restores the same Browser bounds', failure: /null|Screenshot editor|image-annotation-editor/i }]
  },
  editing: {
    tests: [...['geometry.test.ts', 'view.test.ts', 'editing.test.tsx'].map(name => 'apps/desktop/test/image-annotation-' + name), 'apps/desktop/test/browser-screenshot-workface.test.tsx'],
    mutations: [{ label: 'selected-corner-resize-omitted', source: component + 'selection-geometry.ts',
      find: 'const from = { ...original.from }, to = { ...original.to }', replace: 'return original; const from = { ...original.from }, to = { ...original.to }',
      test: 'apps/desktop/test/image-annotation-editing.test.tsx', consumer: 'resizes an existing rectangle and arrow endpoint through real handles and preserves their IDs through Undo', failure: /actual selected corner must resize/ },
    { label: 'wheel-anchor-omitted', source: component + 'view.ts',
      find: 'return { scale, x: anchor.x - point.x * scale, y: anchor.y - point.y * scale }', replace: 'return { scale, x: view.x, y: view.y }',
      test: 'apps/desktop/test/image-annotation-editing.test.tsx', consumer: 'anchors wheel zoom, pans with Space, and completes drawing in original pixels without changing export dimensions', failure: /actual wheel zoom must preserve/ },
    { label: 'existing-text-replacement-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: 'else if (text !== draft.shape.text) edit(doc => replaceShape(doc, { ...draft.shape, text }))', replace: 'else if (text !== draft.shape.text) { /* private mutation omits the existing object edit */ }',
      test: 'apps/desktop/test/image-annotation-editing.test.tsx', consumer: 'edits existing text by button and double click, cancels without replacing it, then commits one object and undoes it', failure: /actual existing text must be replaced/ },
    { label: 'paint-frame-coalescing-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: 'if (paintFrame.current) return', replace: 'if (false) return',
      test: 'apps/desktop/test/browser-screenshot-workface.test.tsx', consumer: 'coalesces continuous drawing on one frame while Copy consumes all samples and the final endpoint exactly once', failure: /actual continuous samples must share/ },
    { label: 'committed-layer-cache-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: 'if (!previous || previous.document !== state.documentState || previous.view !== currentView || previous.size !== state.size ||',
      replace: 'if (true || !previous || previous.document !== state.documentState || previous.view !== currentView || previous.size !== state.size ||',
      test: 'apps/desktop/test/browser-screenshot-workface.test.tsx', consumer: 'coalesces continuous drawing on one frame while Copy consumes all samples and the final endpoint exactly once', failure: /actual unchanged document must reuse/ },
    { label: 'edge-text-ui-clamping-omitted', source: component + 'ImageAnnotationEditor.tsx',
      find: 'left: Math.max(0, Math.min(size.width - width, view.x + at.x * scale))',
      replace: 'left: view.x + at.x * scale',
      test: 'apps/desktop/test/image-annotation-editing.test.tsx', consumer: 'keeps an existing edge text editor inside the viewport at actual size and high zoom without changing its image coordinates or font', failure: /actual input width stays within/ }]
  },
  documents: {
    tests: ['apps/desktop/test/image-annotation-documents.test.ts', 'apps/desktop/test/image-annotation-file-dialog.test.tsx', 'apps/desktop/test/image-annotation-host.test.tsx', 'apps/desktop/test/image-annotation-file-menu.test.tsx'],
    mutations: [{ label: 'document-shapes-discarded', source: component + 'document.ts',
      find: 'const shapes = object.shapes.map(shape), ids = new Set(shapes.map(item => item.id))', replace: 'const shapes: ScreenshotShape[] = [], ids = new Set(shapes.map(item => item.id))',
      test: 'apps/desktop/test/image-annotation-documents.test.ts', consumer: 'round trips every shape, exact pixels, IDs, crop and historical metadata without serializing runtime identity or Undo', failure: /pen|shapes/ },
    { label: 'owner-file-write-omitted', source: host + 'document-files.ts',
      find: 'return await files.write(input.workspaceId, { path: input.path, content, expectedRevision: input.expectedRevision })', replace: "return { status: 'written', revision: 'private-unapplied-write' }",
      test: 'apps/desktop/test/image-annotation-documents.test.ts', consumer: 'writes and reopens through the actual WorkspaceFiles owner, retaining revision conflicts and the original file', failure: /called 1 times|called.*once|Number of calls|0 times/i },
    { label: 'modal-duplicate-submit-guard-omitted', source: host + 'AnnotationFileDialog.tsx',
      find: 'closed.current || pending.current || !submittedPath.length', replace: 'closed.current || !submittedPath.length',
      test: 'apps/desktop/test/image-annotation-file-dialog.test.tsx', consumer: 'submits the exact whitespace-bearing path once despite rapid repeated submit events', failure: /once|1|2/i },
    { label: 'hidden-host-operation-invalidation-omitted', source: adapter,
      find: 'if (props.active === false) operation.current += 1', replace: 'if (false) operation.current += 1',
      test: 'apps/desktop/test/image-annotation-host.test.tsx', consumer: 'invalidates a pending full image decode when its Pane is hidden and preserves the original editor after showing it', failure: /same|expected|to be/i },
    { label: 'saved-editor-navigation-ownership-omitted', source: 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
      find: "onOriginalOpened={() => setScreenshot(current => current ? { kind: 'open', key: current.key } : null)}", replace: 'onOriginalOpened={() => {}}',
      test: 'apps/desktop/test/image-annotation-host.test.tsx', consumer: 'keeps a reopened file editor and its historical source across background Browser navigation', failure: /null/ }]
  }
}
const specification = specifications[slice], tests = specification.tests
const owningConfig = 'apps/desktop/test/vitest.image-annotation.config.mts'
const require = createRequire(resolve('package.json'))
const cli = require.resolve('vitest/vitest.mjs')
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const work = await mkdtemp(join(tmpdir(), 'agentmux-image-annotation-'))
const out = resolve('.local/browser-image-annotation/' + slice)
await mkdir(out, { recursive: true }); await rm(join(out, 'receipt.json'), { force: true })
const directories = [component, host].map(directory => directory.replace(/\/$/, ''))
const inputs = [...tests, ...(slice === 'documents' ? [component + 'document.ts', component + 'drawing-model.ts', component + 'types.ts', host + 'document-files.ts',
  adapter, component + 'ImageAnnotationEditor.tsx', component + 'AnnotationNotes.tsx', component + 'AnnotationToolbar.tsx', component + 'AnnotationOriginalMenu.tsx', component + 'view.ts', component + 'selection-geometry.ts', component + 'image-annotation.css',
  'apps/desktop/src/renderer/src/components/BrowserPane.tsx', host + 'context.ts', component + 'compose.ts',
  host + 'AnnotationFileDialog.tsx', 'apps/desktop/src/renderer/src/components/WindowOverlayHost.tsx', 'apps/desktop/test/helpers/client-ui-render.tsx',
  'apps/desktop/src/main/workspace-files.ts', 'apps/host/native/workspace-move.c', 'apps/desktop/scripts/build-workspace-move-helper.mjs',
  'apps/desktop/src/shared/contracts.ts', 'apps/host/src/workspace-file-bytes.ts'] : [adapter, 'apps/desktop/src/renderer/src/components/BrowserPane.tsx',
  'apps/desktop/src/renderer/src/styles/browser.css', 'apps/desktop/test/helpers/client-ui-render.tsx']),
  'apps/desktop/scripts/verify-image-annotation.mjs', owningConfig, 'packages/client-ui/scripts/radix-overlay-aliases.ts',
  'apps/desktop/electron.vite.config.ts', 'vitest.config.ts', 'vitest.dist-freshness.ts']
for (const mutation of specification.mutations) if (!inputs.includes(mutation.source)) inputs.push(mutation.source)
for (const directory of directories) for (const name of await readdir(directory)) {
  const file = directory + '/' + name
  if (/\.(?:tsx?|css)$/.test(name) && !inputs.includes(file)) inputs.push(file)
}
const sourceInputs = Object.fromEntries(await Promise.all(inputs.map(async path => [path, sha(await readFile(path))])))
const source = Object.fromEntries(await Promise.all(specification.mutations.map(async mutation => [mutation.source, await readFile(mutation.source, 'utf8')])))
const evidence = { slice, passed: false, sourceInputs, cases: [] }
function child(argv) {
  return new Promise((done, reject) => {
    const processChild = spawn(process.execPath, [cli, ...argv], { cwd: process.cwd(), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', expired = false, escalation
    processChild.stdout.on('data', data => { output += data }); processChild.stderr.on('data', data => { output += data })
    const timer = setTimeout(() => { expired = true; processChild.kill('SIGTERM'); escalation = setTimeout(() => processChild.kill('SIGKILL'), 1000) }, 45000)
    processChild.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
    processChild.once('exit', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation)
      expired ? reject(new Error('The exact private Vitest child timed out and exited')) : done({ code, signal, output })
    })
  })
}
async function run(label, mutation) {
  const report = join(work, label + '.json'), config = join(work, label + '.config.mjs')
  const mutant = join(work, label + '.tsx'), loaded = join(work, label + '.loaded.json')
  let mutationSource
  if (mutation) {
    const original = source[mutation.source]
    assert.equal(original.split(mutation.find).length - 1, 1, 'The exact source mutation must be unique: ' + label)
    mutationSource = original.replace(mutation.find, mutation.replace)
    await writeFile(mutant, mutationSource)
    await writeFile(config, `import base from ${JSON.stringify(pathToFileURL(resolve(owningConfig)).href)};
import { readFileSync, writeFileSync } from 'node:fs'; import { createHash } from 'node:crypto';
export default {...base,plugins:[...(base.plugins??[]),{name:'private-original-annotation-mutation',enforce:'pre',load(id){
 if(id.split('?')[0]!==${JSON.stringify(resolve(mutation.source))})return;
 const code=readFileSync(${JSON.stringify(mutant)},'utf8');
 writeFileSync(${JSON.stringify(loaded)},JSON.stringify({source:${JSON.stringify(mutation.source)},sha256:createHash('sha256').update(code).digest('hex')}));
 return {code,map:null};}}]};`)
  }
  const selected = mutation ? [mutation.test] : tests
  const result = await child(['run', ...selected, '--config', mutation ? config : owningConfig, ...(mutation ? ['-t', mutation.consumer] : []),
    '--maxWorkers=1', '--reporter=json', '--outputFile', report])
  const raw = JSON.parse(await readFile(report, 'utf8').catch(error => {
    throw new Error('The owning test produced no fresh result: ' + result.output.replaceAll(process.cwd(), '<repository>'), { cause: error })
  }))
  const assertions = raw.testResults.flatMap(suite => suite.assertionResults)
  if (mutation) {
    const consumed = JSON.parse(await readFile(loaded, 'utf8'))
    assert.deepEqual(consumed, { source: mutation.source, sha256: sha(mutationSource) }, 'The original owner loads the exact private mutation')
    const cases = assertions.filter(row => row.title === mutation.consumer)
    assert.equal(cases.length, 1, 'The actual annotation consumer is unique and nonempty')
    assert.equal(result.code, 1); assert.equal(cases[0].status, 'failed')
    assert.match(cases[0].failureMessages.join('\n'), mutation.failure, 'The loaded mutant fails at its actual consumer')
    evidence.cases.push({ label, result: 'RED', consumer: mutation.consumer, mutation: { source: mutation.source, sha256: sha(mutationSource) } })
  } else {
    assert.equal(result.code, 0, result.output.replaceAll(process.cwd(), '<repository>'))
    assert.ok(assertions.length > 0, 'The real mounted/model suites are nonempty')
    assert.deepEqual(assertions.map(row => row.status), assertions.map(() => 'passed'))
    const observed = raw.testResults.map(suite => relative(process.cwd(), suite.name))
    assert.deepEqual([...observed].sort(), [...tests].sort(), 'Each requested original suite executes')
    evidence.cases.push({ label, result: 'GREEN', tests: assertions.length, suites: observed,
      consumers: assertions.map(row => row.fullName) })
  }
  console.log(slice + ' ' + label + ': ' + (mutation ? 'expected RED' : 'GREEN'))
}
try {
  if (slice === 'documents') {
    const built = await new Promise((done, reject) => {
      const child = spawn(process.execPath, ['apps/desktop/scripts/build-workspace-move-helper.mjs'], { cwd: process.cwd(), stdio: 'inherit' })
      let expired = false, escalation
      const timer = setTimeout(() => { expired = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 1000) }, 20000)
      child.once('error', error => { clearTimeout(timer); clearTimeout(escalation); reject(error) })
      child.once('exit', code => { clearTimeout(timer); clearTimeout(escalation); expired ? reject(new Error('The exact private helper build child timed out and exited')) : done(code) })
    })
    assert.equal(built, 0, 'The actual WorkspaceFiles helper builds before physical file proof')
    evidence.nativeHelper = { source: 'apps/host/native/workspace-move.c', sha256: sha(await readFile('apps/desktop/resources/bin/agentmux-workspace-move')) }
  }
  await run('source')
  if (mutations) { for (const mutation of specification.mutations) await run(mutation.label, mutation); await run('restored-source') }
  if (slice === 'editing' || slice === 'enhancements' || slice === 'pointing') {
    const result = await new Promise((done, reject) => {
      const child = spawn(process.execPath, ['apps/desktop/scripts/verify-browser-screenshot-model.mjs', ...(mutations ? ['--mutations'] : [])], { cwd: process.cwd(), env: process.env, stdio: 'inherit' })
      // Each finite native case owns its timeout and cleanup. A shared total
      // cannot shrink the available time as the actual mutation set grows.
      child.once('error', reject)
      child.once('exit', done)
    })
    assert.equal(result, 0, 'The actual Electron Canvas proof completes with its own source mutations')
    const path = '.local/browser-screenshot-workface/model-proof/receipt.json', bytes = await readFile(path), receipt = JSON.parse(bytes)
    assert.equal(receipt.passed, true); assert.ok(receipt.cases.length > 0)
    evidence.nativeCanvas = { receipt: path, sha256: sha(bytes), ...receipt }
  }
  for (const [path, digest] of Object.entries(sourceInputs)) assert.equal(sha(await readFile(path)), digest, 'Proof input changed: ' + path)
  evidence.passed = true
  await writeFile(join(out, 'receipt.json'), JSON.stringify(evidence, null, 2))
} finally { await rm(work, { recursive: true, force: true }) }
