# Note collaboration and recovery review

This private fixture mounts the original `FileSurfaceView`, Store, rich editor, source Monaco and workers. Its Host uses the original Note writer, workspace files, SQLite history and Core public file service. HTTP/SSE replace Electron transport. It does not exercise an installed application or a native Agent Run. Host title and graph capabilities that are absent from this fixture remain explicitly unavailable.

Use a fresh disposable directory under the short system temporary directory using the `amux-note-t5-*` prefix as `AGENTMUX_NOTE_FIXTURE_ROOT`, and run the existing `vite.config.mts` with the workspace's installed Vite after building the workspace dependencies. Never point it at user data. Keep the same directory when checking a real process restart. The fixture defaults to port 4209 and refuses an unrelated root.

The stage follows the available width, up to 1000 CSS pixels. `?appearance=light` or `?appearance=dark` supplies the corresponding input to the original theme runtime. `?resume=1` restores the exact renderer state previously flushed by `noteCollaboration.flush()` before the original Store initializes; without a flushed state, initialization follows its ordinary path. These options are fixture presentation and recovery inputs, not product APIs.

Review the [Note presentation contract](../../../../../docs/design/presentation/spaces-and-layout.md) and [independent visual review guide](../../../../../docs/guides/agent-visual-e2e-review.md). Exercise these scenes through the actual UI:

- Start clean, edit and save. Keep later input, then open History. Only selecting a saved version reads its body. Preview, full restore and activity undo use the original owner and preserve later drafts.
- Retain a draft, an unknown original save and a conversion backup; also overlap a real external edit. Check the one concise status, the distinct Versions and Drafts & recovery sections, the three original conflict sources and the explicit overwrite action.
- At wide, narrow and short Region sizes in both themes, open, expand, return and close the reader. Switch Source/Note/Graph, retain incomplete Source, and verify editor identity, selection, composition and undo. Only the review area expands; the editing tree is retained.
- Drop a write reply in the private transport, flush, stop only this fixture process and restart with the same data. Verify the original Note, Tab, Regions, layout, later input and operation. Checking the original event must not issue a replacement write.

Save full screenshots and exact loaded-source receipts locally. Capture is not aesthetic approval: an independent reviewer must actually open the final images, and any visual correction requires fresh captures. Close this fixture's browser/process and remove disposable data after preserving necessary evidence.
