# command-safety

<!-- amux:content -->
IDs and TEXT are literal data; use --flag=value for option-looking values.
RPC ids correlate transport; --operation-id identifies the original business action.
Retain original requests/IDs after partial or unknown results; never automatically replay a write.
After an unknown result inspect that operation first; repeat a write with the same ID only where its
help or module guide says that is safe. A new ID starts a new operation.
Reader cancellation only detaches that reader. Observation failure does not end a healthy Agent.
For remote endpoint/Host routing read amux system endpoint --help.
Leading --source-host ID selects one bound SSH target from the local Unix configuration owner;
it is distinct from a command's Source-local --host. --endpoint and --source-host are exclusive.
