# Composer paste selection

Status: approved. Authority: user requested the paste overwrite fix and delegated this bounded work to a subagent.

Scope: plain-text paste, screenshot paste/capture and file-reference insertion in Agent and Launcher composers. Only the true selection may be replaced; pending async attachment work must preserve intervening edits. Use the existing maintained editor transaction and selection mapping. No Mailbox, Avatar or primary-button changes.

One vertical task owns the shared editor insertion, real consumers, behavior/mutation tests and browser paste proof.

## Findings and delivery

Plain-text handlePaste called onValueChange(text), replacing the complete controlled draft. Image save, screen capture and file-picker handlers separately appended references to the draft tail, bypassing the editor selection.

The shared insertion owner now uses ProseMirror document slices and selection bookmarks. Text uses the current selection; async tools capture the selection before reading/saving/picking and map it through subsequent editor transactions. The pending listener is removed in finally on success, cancellation or failure. Completing an attachment keeps a newer caret elsewhere in the document and avoids stealing focus from another control. References retain appropriate separators. Editor initialization restores a draft without adding that restoration to undo history.

Agent and Launcher consume the same insertion API. The existing local feedback owner still controls errors and retries; a retry begins a new insertion at the user's then-current selection. AgentComposer only passes the insertion ref and revised image callback type through to InlineComposer; primary controls were untouched.

## Verification

- 121 tests pass across nine Composer and scan-guard files, including nine new behavior cases. Production desktop typecheck passes. The broad existing test-typecheck still reports unrelated fixture diagnostics (including pre-existing unknown-boundary assertions); no new paste-test or insertion-source diagnostic.
- Nine mutants are killed: overwrite full draft; ignore range; omit bookmark mapping; use the later caret instead of original mapped anchor; insert closed block paragraphs; put restored draft in undo; discard additional files; delete selected text on empty clipboard; omit reference separator.
- Native clipboard paste in Ego Browser over the real InlineComposer source produced `alpha new omega` at a middle caret and `alpha ONE\nTWOomega` replacing only the selected word. During an unresolved attachment, native keyboard input added `new `; completing the picker produced `new alpha @a.ts @b.ts omega`. Screenshot inspected. The temporary preview page/server and TaskSpace were removed/closed.
- Real Agent/Launcher DOM tests exercise native paste events, image byte persistence, selected capture, multi-file picker completion, intervening edits, caret preservation, cancellation, failures/retry, and undo.
- Zero-caller check: InlineComposer imports and calls both insertion functions; AgentComposer forwards insertionRef; AgentSessionComposer and NewTabSurface invoke the ref for attachments and capture. The shared helper has actual product consumers outside its defining file.

Learning: controlled draft replacement is a synchronization operation, not a paste operation. Selection and async position mapping belong to the maintained editor; host tools should supply their result, not reconstruct the entire draft.
