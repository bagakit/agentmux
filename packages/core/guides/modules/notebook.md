---
summary: "Notebook catalog, exact note links and graph operations"
roles: "Agents reading or editing notes"
when: "Resolve, inspect or modify an original Notebook/Note"
---

# notebook

<!-- amux:content -->
Use notebook storage inspect [--operation-id ID] to read the original directory operation,
phase, resource mappings and conversion issues. Inspection never resumes or converts.
notebook storage change --input FILE|- accepts exactly operationId, expectedDirectory and
directory. Keep the original request on a lost ACK; inspect that operation before deciding
whether to continue its original explicit change. Same-directory changes request original
Markdown conversion. A committed storage phase still requires the original Main resource
acknowledgement before the change call returns. Current directory alone does not prove a
lost acknowledgement. Existing settings set notes.directory uses this same owner; the storage
commands retain the complete safe operation projection without internal catalogs or backups.

The Notebook owner holds note/catalog identities and revisions; note bodies stay in
their real filesystem source. Markdown is the only saved body; graph indexes are derived.
Use the original Files writer for content and notebook apply for organization or your own
follow relationship. Authorship comes from the trusted caller, never body declarations.

[note editing](../shared/note-editing.md "amux:include")
