# dsh Desktop Architecture -> Entry Desktop Tauri

Source: apps/desktop, apps/desktop-host, packages/host, client, mcp, credentials, settings, jobs

## Patterns
- DUMB SHELL / HOST SPLIT: shell = device nativity only (dialogs, tray, updates,
  shortcuts) over fixed preload API; ALL business state in Host process; typed
  versioned protocol (ready/fatal/shutdown/quit-inspection, PROTOCOL_VERSION const)
- UI STATE: Host -> transport -> React-free stores -> UI adapters -> React;
  views never see transport; business data in object layer never stores
- CREDENTIALS: reference-based seam (CredentialRef = branded env name);
  resolve per operation (hot rotation); describe() value-free, redacted on wire.
  dsh uses 0600 yaml file and CANNOT isolate secrets from agent - OS KEYCHAIN
  (keyring crate) is Entry's differentiator
- SETTINGS: projected forms over config patches with optimistic CAS + full
  validation + secret redaction (role:secret never rides a response)
- MCP: composed not hard-wired; one connection entry per server (stdio/HTTP,
  namespace mcp__<server>__<tool>, 60s timeout, reconnect backoff 500ms->30s,
  failOnStartupError=false); credentials via refs never inline
- JOBS: JobSpec registry, id <kind>-N, status machine, owner-scoped by
  authorization, ring output (256KB live/16KB settled), maxConcurrentJobsPerOwner,
  settlement announced on event stream (no polling)
- QUIT-INSPECTION: every quit path asks Host what would be interrupted
  (running subagents/jobs/queued messages), 2s deadline - build this FIRST

## Entry Desktop actions
1. backend.rs: start/stop/retry phases independent of windows; crash -> fatal dialog
2. Tauri commands = nativity only; business over HTTP/WS carrier
3. Keychain credentials via keyring crate behind resolve/describe seam
4. Quit-inspection gate in initial shell
5. Phase 5 MCP: composed entries, refs, backoff
