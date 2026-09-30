# dsh Command Execution -> Entry Desktop Rust Layer

Source: packages/shell, subprocess, sandbox, ptc-runtime, guard, spill, fs/fs-sandbox

## Core patterns
1. REQUEST/SPEC SPLIT - caller-facing request (partial) vs resolved spec (all explicit).
   One resolve() owns defaults + caps. Tools never construct specs directly.
2. LAYERING: tool layer (validation/approval/rendering) -> executor seam (ctx.shell,
   owns defaulting/deadlines/first-cause) -> subprocess seam (stdio, bounded collection,
   spill, managed termination) -> sandbox seam (argv wrapping, per-call policy).
3. SANDBOX: modes read-only|workspace-write|danger-full-access; policy PER CALL never
   fixed on provider; wraps exact argv (never shell string); returns enforcement
   full|partial + denial signatures; FAILS CLOSED (runner failure outranks denial;
   silent unconfined passthrough forbidden).
4. APPROVAL PIPELINE: pre-execute (hooks, permission) -> approval prompt (absent=deny)
   -> monotonic guards (deny/abstain, order protected) -> execute (fused deadline)
   -> fs intent gates -> post-execute -> normalize errors to isError -> result.
5. OUTPUT SPILL: capped in-memory TAIL (64KB) + spill file (private 0700 dir, O_EXCL,
   0600, random name, whole-stream cap); report {text, truncated, spill_path} always.
6. JOBS: every call registers with ctx.jobs even foreground; foreground timeout
   PROMOTES to background job (promoteOnTimeout) instead of killing; one fused
   deadline; first-cause: timed_out / aborted mutually exclusive.
7. DEFENSIVE: orthogonal outcome fields (timedOut+exit0 possible); dispose reaches
   quiescence (kill then AWAIT exit); scrub credential env (*KEY*/*SECRET*/*TOKEN*);
   unlink symlink-shaped paths, never rm through them; managed ENTRY_* env namespace.

## Entry Desktop actions (priority order)
1. ExecRequest/ExecSpec with single resolve() in Rust
2. Landlock/seccomp wrapper (landlock crate), fail-closed, per-call policy
3. Path containment: add dev/ino identity (unix) + case-insensitive compare (win)
   to lexical check; lstat/unlink link-shaped paths before deletion
4. Replace unbounded String output with tail cap + spill file
5. Fuse cancel+timeout, first-cause fields
6. Job promotion on foreground timeout; quiescent teardown
7. Stage the pipeline as distinct hooks; ENTRY_* managed env namespace
