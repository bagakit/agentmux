# Browser image annotation verification

The behavior contract is [Browser page capture and markup](../../../../../docs/design/behavior/browser-workface.md#browser-页面截图与标记); layout and control language belong to [Browser presentation](../../../../../docs/design/presentation/browser-workface.md#browser-任务工具与证据的紧凑呈现). This fixture defines repeatable scenarios, not an installation or aesthetic approval receipt.

Run from the repository root after building the current workspace dependencies and native Workspace move helper:

```sh
node apps/desktop/scripts/verify-image-annotation.mjs --slice boundary --mutations
node apps/desktop/scripts/verify-image-annotation.mjs --slice editing --mutations
node apps/desktop/scripts/verify-image-annotation.mjs --slice documents --mutations
node apps/desktop/scripts/verify-browser-screenshot-workface.mjs --model --mutations
node apps/desktop/scripts/verify-browser-screenshot-workface.mjs --mutations --visual
```

The mounted tests exercise the production Browser adapter and editor, including continuous pointer samples, original-pixel coordinates, handles, existing text, templates, Undo, view navigation, image decode, file conflicts, unknown saves, late replies, focus and IME. The document tests use the actual WorkspaceFiles owner for disk round trips. Private source mutations must fail their named nonempty consumer assertions before the restored source passes.

The native fixture mounts the production BrowserPane, its image editor and shared Desktop styles in a private Electron profile. It uses the original Browser owner and two local page forms, trusted pointer/keyboard input, actual Canvas pixels and clipboard output. Store projection and IPC transport are fixture adapters; Browser capture and file operations remain with their real owners. Existing Core public SDK and CLI paths inspect the original page and consume the same editable file. No user profile, Agent, Session or Run is replaced by this fixture.

Exercise these flows:

1. Enter capture from the toolbar and More menu. Draw a long stroke, select/move it, resize a rectangle and arrow endpoint, edit existing text, change a note intent, locate its region, zoom and pan, then verify Undo and processed PNG/context.
2. Crop, pixelate and cover image areas. Verify opaque cover pixels and filtered note text in processed output, including ordinary live ink crossing existing masks. Original image coordinates stay unchanged by view navigation.
3. Use Original to save an editable file, leave the editor, then reopen through More without another capture. Read/update that file through the existing public file API and CLI, reopen it in the UI and continue editing. Historical or unknown source stays separate from the current page.
4. Cancel a pending copy or file dialog. Verify the original Browser and sibling retain their identities and drafts, the canvas receives the intended focus, and normal controls still own real pointer hits after menu/dialog handoff. Failed import, conflict or unconfirmed save retains the current edits and provides a reachable next action.
5. Hide the editor and verify no paint, key or resize work; return to the same document. Compare native pointer/paint/export counters for the same source image and stroke workload. Layer counts and measured CPU intervals do not by themselves establish FPS or input latency.

Visual capture covers normal, narrow and short workfaces in both light and dark themes, with note editing and tool parameters. Also capture selection handles, existing text editing, the Original menu, file dialogs and a reopened document. Review complete frames for canvas area, alignment, readable controls, focus, annotation correspondence and the editable-original explanation. A raw original contains the embedded source pixels and editable notes; processed PNG/context is the sharing surface.

Receipts bind the actual compiled inputs and image hashes under ignored local evidence directories. Preserve earlier images and review notes when correcting a candidate. Captures require an independent Agent to open the full images and explicitly judge the candidate deliverable under the [visual review contract](../../../../../docs/guides/agent-visual-e2e-review.md). Successful capture and green tests do not substitute for that judgment, nor does this private fixture prove activation in the user's installed application.
