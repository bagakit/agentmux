---
summary: "Read Skills available to an original Agent Session"
roles: "People and Agents choosing workspace Skills"
when: "Discover Skills before inserting a reference into an Agent prompt"
---

# skill

<!-- amux:content -->
Use `amux skill ls --host ID --session ID` to read the Skills declared by the
original Session's Provider. Obtain its complete Session ID and route Host from
`amux agent ls`; `local` means the Core service receiving this request.

Discovery uses the original Session's execution directory and the Provider's
declared project and user roots. The caller cannot substitute a directory.
The result preserves the route Host, source Host, Session, Provider, execution
directory and each original Skill path. Names are labels, not object identities.

This read does not execute a Skill, send a prompt or operate the Run. Inserting
a returned reference into a draft also does not send it. An unavailable Host,
Session or Provider is a failed read; preserve the draft and retry the original
target. An empty successful list means discovery found no Skills in those roots,
not that the Agent lost its input capability.
