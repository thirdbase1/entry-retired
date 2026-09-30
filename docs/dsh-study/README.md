# DeepSeek Harness (dsh) Study — Port Map for Entry Desktop

Source: github.com/deepseek-ai/deepseek-harness (MIT), cloned at ~/dsh-study.
The donor architecture for Entry's Phases 4-7. Full briefs in this directory.

## The four briefs
1. plugin-architecture.md — Cordis plugin system, capability seams, layered config
2. execution-layer.md — request/spec split, sandbox seams, tool pipeline, spill
3. session-persistence.md — append-only JSONL log, ignorable flag, compaction
4. desktop-host-client.md — dumb shell/host split, MCP, credentials, jobs

## Non-negotiable dsh rules we adopt
- Everything is a plugin; core owns only fiber/loader/events
- Model-visible <=> logged (derive history from the log, never store separately)
- Request/spec split on every execution seam; single resolve() owns defaults
- Policy carried per call (sandbox/approval), never fixed on the provider
- Fail closed: runner failure outranks denial; unanswerable approval = deny
- Bounded output + spill files (0700, tail in memory, full stream on disk)
- First-cause classification: timed_out / aborted mutually exclusive
- ignorable:true forward-compat; refuse unknown non-ignorable events
- OS keychain credentials — our differentiator over dsh's yaml store
