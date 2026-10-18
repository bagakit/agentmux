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

## Local readable protocol reference

Settings → Message Tool → amux Protocols shows this app version's formats and original wire
examples using the shared message cards. The following list comes from this local CLI's
same Core definitions; it does not describe the connected Runtime or an older installation.
Reading a declaration does not authenticate its author, execute hints or grant permissions.

[Current protocol-catalog](../../dist/amux-protocol-definition.js "amux:generated protocol-catalog")
