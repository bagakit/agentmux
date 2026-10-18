# note editing

<!-- amux:content -->
## Edit an authorized Note
1. Find the original with amux notebook ls or notebook resolve, then read
   amux notebook inspect --note NOTE_ID --content. Keep its exact Note identity, resource,
   saved Markdown and revision. A name is not an identity; unavailable is not an empty Note.
2. Read relationships only when needed with amux notebook graph --note NOTE_ID.
   Use notebook graph --help to choose a Notebook or all-catalog scope. Check coverage and
   per-file revisions: partial results do not prove missing links. A shared include points
   to one independent Markdown file; edit that exact original to change all its uses.
3. Read amux file --skill, then file read --help and file write --help. Read the original
   file and keep its complete returned resource and revision. Save edited Markdown through
   file write; for concurrent Note edits, retain the exact base body and original operation ID
   as described by that leaf help. Preserve stable IDs and later unsaved drafts. No page
   needs to be open or Space activated. First-use sharing uses file share --help.
4. Confirm the body write, canonical content/revision, attribution and history separately;
   sharing also has separate source, shared-file and destination outcomes. After unknown,
   keep the original request, operation/event IDs and drafts. Inspect that same file/history,
   file share inspect or notebook inspect --operation-id as appropriate; never automatically
   resend a write or infer its earlier receipt from matching current content.

Saved Note frontmatter uses schema: agentmux.note.md.v1 and a stable note-id. Each saved
blockId is carried by its original Markdown anchor; preserve these identities when editing.
Follow your own Note with notebook apply --revision CATALOG_REVISION --operation-id OP_ID
--change-json '{"kind":"follow","noteId":"NOTE_ID"}'; use unfollow to cancel yourself.
The authenticated caller is the follower; this is saved interest, not online presence.

Diagram source stays in fenced code blocks with language mermaid, drawio, dot/gv or
plantuml/puml; drawio content is its original XML. Inline math uses $expression$ and display
math uses $$ delimiter lines. Escape literal dollars or use inline/fenced code. Preserve
formula source and anchors when editing; render failures do not invalidate saved source.
Previews are client projections and are not stored SVG/HTML or graphical-editing receipts.

Images use ![alternative text](relative/path "title"); attachments use ordinary Markdown links.
Relative resources belong to the original Note file directory, including shared and Graph views.
Read file import --help to create binary attachments through the original Files owner before
referencing the returned resource; Agent-session upload is a different attachment destination.
Use GFM tables and - [ ] / - [x] task items. Preserve saved cell/item annotations and anchors.
HTML and SVG code fences offer explicit static previews. These previews do not run scripts
or fetch external resources. Unsupported bounded regions retain readable original source in a
note-raw fence with html or markdown metadata. Preserve that source and its outside block anchor;
preview cleaning never rewrites it. Read docs/specs/note-markdown.md for the canonical grammar.

Read the matching leaf --help for arguments and receipt fields; amux notebook --help expands
the original content, link, follow and history contracts.
