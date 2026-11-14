---
summary: "Original storage backup generations and recovery coverage"
roles: "The original local Unix user"
when: "Capture or inspect admitted storage owners without starting Agents or replaying input"
---

# storage

<!-- amux:content -->
Use storage backup create to capture the sources already configured by the
original storage owner. Keep the returned generationId and inspect that exact
generation. Storage backup list reads the retained generations; storage recovery
status reports current capture state and coverage gaps.

These commands require the original local Unix user, with no managed Agent caller
or delegated route. They accept no filesystem path, backup body or replacement
identity. A missing owner is unavailable; another endpoint is not a substitute.

Each source retains its own revision and capture time. A generation is not an
atomic checkpoint across owners. Inspect gaps before relying on its coverage.
Capture and inspection do not restore files, start or stop Runs, grant input
authority, or resend business input. An unknown reply is an observation gap;
retain the original endpoint and any returned generation reference.

Storage source capture and source release form the private local owner bridge.
Storage source inspect observes its revision without creating an export. A source
consumer may use revision changes to request a new capture from that same owner.
Use one exact captureId to read or join that owner's export, then release only
that private export after it has been consumed. Exported file and target paths
are visible on this trusted local route; they are not accepted as input paths or
included in backup list/inspect metadata. Release never deletes original sources.

Use storage backup import --data FILE only as the original local user to admit
an offline original SQLite file by its exact sourcePath and sha256. The source
must be a protected regular file without live SQLite companions. Imported
coverage is explicit and does not claim a complete namespace backup.

Storage restore preflight --data FILE fixes operationId, generationId,
manifestHash and optional exact source/member selectors. Optional inputs select
agentSessionId, runId and submissionId from that admitted original database;
the caller never supplies an ACK or record body. The original input owner checks
the same frozen claim and preserves retirement and the current input slot.
Storage restore apply --operation ID and storage restore inspect --operation ID
continue that exact durable operation. Existing different files are retained;
unsafe old intentions are held by their original owner or explicitly unavailable.
Unknown replies require inspection or retry of the same operation, not a new ID.

If normal semantic startup cannot read its original identity or Session store,
agentmux-runtime recovery-serve --state-directory DIR --store FILE --socket FILE
[--generation ID] exposes this same storage owner without creating a Client,
identity or Session and without activating Native. It requires the original
semantic owner lease; a live owner must be used through its existing endpoint.
No surviving original identity or admitted generation means unknown, never a
fresh replacement namespace. This endpoint does not start, stop or resume Runs.

Historical creation/message source pins remain backup evidence, not current
permission grants. Restore preflight and final publication refuse these files
with RECOVERY_AUTHORITY_REAPPROVAL_REQUIRED. Select the exact identity members
independently if needed, then use the existing source-trust approval operation.
This refusal does not stop healthy Agents or discard retained original files.
