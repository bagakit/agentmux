---
summary: "Exact file resources, editor presentation, saves, uploads and builds"
roles: "Agents reading, editing or presenting files"
when: "Read/write a file or open its editor workface"
---

# file

<!-- amux:content -->
The file owner holds resource reads/writes, save/upload/build receipts and editor state.
Identify the original Host, Zone/workspace and literal path independently from the intended
display Tab/Region. file read/ls access resources; file open/view access presentation. Opening
does not save or overwrite a file. Inspect the original view and preserve unsaved user drafts.

Import ordinary attachment bytes with file import at an exactly read absent destination; use its
original resource, operation ID, byte length and SHA-256. This is separate from Session upload and
never writes a Note draft. After unknown, read that same target; current bytes do not prove a lost
operation receipt. Remote byte writes remain unsupported. Keep the source and never replay blindly.

Pin file write/create to the original resource and observed revision; retain the original result. A save
request is not a confirmed disk write. Partial results certify only their explicitly confirmed
stages; unknown stages remain unconfirmed. Upload
and build operations have their own retained identities and inspect/cancel paths. Inspect the
same upload/build after a lost reply instead of issuing a new logical operation. Formatting
and build output do not certify a user's acceptance. Wrong targets reject only that request;
unavailable resource reads never authorize removing a view, replacing content or stopping a Run.

For concurrent .note.md edits and save/conflict receipts, read amux file write --help.
For first reuse as a shared Markdown entity, read amux file share --help. Stage the source
and surviving include occurrence without creating a file on copy/paste. Explicit save uses
file.share for exclusive shared creation, original source replacement and destination save.
Keep each original operation and bytes after unknown; file share inspect reads the original
per-file history and current observations separately. A current matching file cannot certify
an earlier lost receipt. Never manufacture a second body/relationship store.
For removing saved shared include occurrences while preserving ordinary draft edits, use
amux file share undo --help; inspect {mode:"undo",request:ORIGINAL_UNDO_PARAMS} after unknown.
The original owner separately reports source restoration, retained shared files and deletion;
keep known partial stages and never retry an unconfirmed deletion. Known terminal partial
undo preserves the saved draft and permits further ordinary editing; unknown phases retain the
same original request. Combine new promotions and removed uses with undoReferenceIds in file.share.
For saved-version recovery or actor-batch undo, read amux file restore --help or amux file undo --help.
Only for Note links, attribution or history, read amux notebook --skill. Unknown edits never authorize automatic replay.

Before opening or moving an editor workface, read amux space --skill for placement and focus.
Use the exact file action's --help for its arguments, original revision and receipt contract.
