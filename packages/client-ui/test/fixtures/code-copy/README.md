# Code-copy interaction scene

The scene mounts the production ConversationMessage → AgentMarkdown → MarkdownCodeBlock path, the real highlighting worker, the shared theme and styles. It also mounts document Markdown, an inert read-only preview and diagram source.

The clipboard adapter records exact text and exposes controlled pending, success and failure receipts. It never reads or writes the system clipboard. These receipts prove component interaction, not the installed Host clipboard implementation. No user Session, Run or application data is accessed.

The probe uses trusted keyboard activation at normal and narrow widths in both themes, confirms exact copied content, rejects duplicate pending activations, verifies retained focus through success and failure, retries, and captures the actual feedback. It checks that code scrolling remains local, long language labels do not widen the page and document language chrome is not duplicated.

Behavior and presentation are owned by `docs/design/behavior/conversation-input.md` and `docs/design/presentation/conversation-input.md`. Capture output is local evidence; capture success alone does not approve aesthetics. Every final full frame requires independent visual review. The private Electron profile and compiled output are removed after the probe process exits.
