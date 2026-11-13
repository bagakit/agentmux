---
summary: "Host/Executor configuration, resource preferences and maintenance"
roles: "Authorized configuration operators"
when: "Discover or explicitly modify current user configuration"
---

# settings

<!-- amux:content -->
The original configuration owner holds settings, Host routes, saved Executors and
resource revisions. Inspect the exact current owner and supported fields before changing
them. A saved route/template is not a connected Host, running Agent or human approval.

Read amux settings --help to select the exact configuration domain, then the matching leaf
help for its fields, authority, revision and save receipt. Discovering settings saves nothing.

## Host home directory

settings hosts home --host HOST reads that exact configured Host's current homeDirectory.
The path comes from its original Core; a local path, SSH user name or display label is
not a remote home source. This read does not start Native, scan Sessions or register a
project. An unavailable Host remains unavailable; keep its original work and retry the
same read when its connection returns. Do not substitute the caller's home.

In Desktop Space, select a device name to open its home workface without manually
creating a project. The disclosure arrow still expands/collapses that device's folders;
the adjacent + opens another directory. Existing registered home directories reuse the
original workface. Opening does not start an Agent or change another Session's cwd.
For explicit CLI registration, use the returned path unchanged with the existing
settings workspaces register input {hostId,path,name?}. A directory is not required to
be a Git repository. Registration, navigation and Agent creation have separate receipts.

## Tailcat transport

Settings → Remote → Hosts → Connection holds the original Host's transport selection:
SSH (the default), SSH with Tailcat backup, or Tailcat only. A remote Host keeps its existing
id, kind=ssh record, SSH fields and Runtime binding. transport selects the carrier;
tailcat holds {address, keyFile}. Turning Tailcat off leaves the original SSH route intact.
settings hosts ls/test/update and settings resource configuration use the same strict Host
codec. Read each leaf's --help for the exact input and expected-value save contract.

Install AgentMux and the official Tailcat CLI on both machines. AgentMux must already be
running on the receiving machine. Prepare persistent identities with Tailcat's own CLI:
  tailcat genkey --client --key=agentmux-client
  tailcat genkey --key=agentmux-server --fixed-region
The first prints the client public key; the second prints a secret address. Do not replace
existing keys or publish the address. Saved server keys must include a PSK and fixed relay.
On the receiving Mac, select This Mac → Connection, enter the saved server key and the
client public key in Allowed clients, enable Allow Tailcat connections, then Save hosts.
Refresh status to read the original listener. Copy its private address to the sending
Host's Tailcat field and select its saved client key. Save and Test that exact Host.
Missing CLI, invalid saved key or listener failure is visible; a listening receipt does not
prove a client connected. Disabling only stops this listener and retains existing work.
settings hosts inspect --host local reads the same listener state. Configuration changes
still require the original user's settings authority; Agent possession of a key is not
settings authority. Tailcat does not install a remote Core or expand the Linux SSH upgrade.

## Current remote communication

settings hosts inspect --host HOST also reports the observing service's original
Host Runtime RPC carrier, when available. It is not the saved preference or the
remote listener's state. SSH-first with Tailcat backup can currently use SSH or
Tailcat; a candidate route is not current until adopted. A closed channel's last
confirmed transport is retained as history, never relabeled currently connected.
An unopened or unavailable observation remains unknown. The carrier fact does not
prove Agent health or a measured Tailcat direct/relay path.

In Desktop, hover or focus the exact device/Host identity for current communication,
confirmation time and saved preference. This reads existing transient state and
does not connect, probe, scan Sessions or start a polling loop. The device title's
~ marks its home action, not a guessed path. Home failures stay local to that action
with a compact retry; original workfaces and healthy capabilities remain usable.
A recognized older remote Core owner protocol requires an explicit Core update,
not a fallback to an older contract, Session replacement or automatic operation replay.
Private Tailcat addresses, key paths and raw process errors are never connection labels.

## Review a remote Core update

In Desktop **Settings → Remote → Hosts → Connection**, the Core maintenance
section compares the current deployment with the candidate bundled in this App.
It is not an online latest-version check. Package versions, source commits,
deployment digests, Core owner API protocol and required Native Runtime protocol
are different facts. Missing current facts remain unknown; protocol numbers and
commit hashes do not stand in for a package version.

Read `settings hosts upgrade-check --help` for the exact input. The check reads
the exact supplied or saved Host and its original maintenance owner without
upgrading it. Applying an update still requires that exact target to be saved. Its current
observation and bundled candidate are separate from any historical operation.
If the current candidate cannot be assembled, `candidate` is `null` and
`candidateUnavailable` explains the local failure; current deployment and any
original operation remain independently observable. Inspect the original
operation by its existing ID rather than treating its candidate as the current one.
Only a qualified ready result includes the pinned expected facts for an upgrade.
In Desktop, review the exact target and maintenance effect, then explicitly confirm
that same candidate. Cancelling review does not upgrade. A changed candidate or
target must be checked and reviewed again, not silently substituted after confirmation.

Upgrade and reconnect require the original transport-approved user/device, without
a managed Agent caller; command parameters cannot supply that identity. Read-only
checks and original result inspection retain their diagnostic scope.

Read `settings hosts upgrade --help` before an explicitly authorized update. Keep
the original input, expected and operationId. A lost or unknown receipt does not
mean the operation did not happen. Use `settings hosts upgrade-inspect` with that
original operationId to inspect its result; this query does not adopt a new
connection configuration or repeat deployment. Historical operations retain their
original candidate digest; an old receipt without version metadata stays unknown
rather than borrowing this App's current candidate.

A completed deployment and this client's connection adoption are separate results.
For a completed original operation, `settings hosts upgrade-reconnect` explicitly
adopts its verified remote command and checks that exact saved Host, retaining
the original operationId. It does not run the upgrade again. A pending or failed
connection check leaves the completed deployment fact intact and provides the
original retry path. All maintenance keeps the existing Runtime, Native process,
Session and Run preservation contract.

This path supports an already installed Linux x64 headless Core that meets the
maintenance owner's exact qualification. It does not install AgentMux on another
Mac, start an absent service, authorize a new target or upgrade healthy work when
merely opening settings. Tailcat replaces a carrier; it does not extend that
maintenance qualification.

## Local readable protocol reference

Documentation → amux Protocols shows this app version's formats and original wire
examples using the shared message cards. The following list comes from this local CLI's
same Core definitions; it does not describe the connected Runtime or an older installation.
Reading a declaration does not authenticate its author, execute hints or grant permissions.

[Current protocol-catalog](../../dist/amux-protocol-definition.js "amux:generated protocol-catalog")
