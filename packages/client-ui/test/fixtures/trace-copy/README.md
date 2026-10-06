# Conversation detail copy scene

Run `node packages/client-ui/scripts/capture-content-actions.mjs trace-copy` from the repository root. The scene uses the actual conversation message, reasoning/tool details, Markdown code block, shared Clipboard control and Tiptap draft with Desktop theme tokens. The isolated Chromium driver activates controls with trusted keyboard input, checks exact original strings, pending/error/retry/source isolation, fold and focus preservation, and integrated image removal/undo. Four original images cover light/dark and wide/narrow surfaces; additional frames show pending and retry feedback.

The controlled host returns explicit Clipboard receipts without writing the system clipboard. The generated image and references contain no user files. Source and image hashes plus process cleanup are recorded locally; capture alone does not approve aesthetics or prove an installed Host.
