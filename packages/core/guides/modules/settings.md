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

## Local readable protocol reference

Documentation → amux Protocols shows this app version's formats and original wire
examples using the shared message cards. The following list comes from this local CLI's
same Core definitions; it does not describe the connected Runtime or an older installation.
Reading a declaration does not authenticate its author, execute hints or grant permissions.

[Current protocol-catalog](../../dist/amux-protocol-definition.js "amux:generated protocol-catalog")
