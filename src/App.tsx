import { useState, useEffect, useCallback } from "react";
import {
  nativeStatus,
  bash,
  readFile,
  commandApprovalRequired,
  workspaceInfo,
  onProcessOutput,
  type WorkspaceInfo,
  type BashResult,
  type ReadResult,
} from "./native";

interface OutputLine {
  stream: "stdout" | "stderr";
  text: string;
}

export function App() {
  const [status, setStatus] = useState("Native core ready");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<OutputLine[]>([]);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [command, setCommand] = useState("git status --short");
  const [result, setResult] = useState<BashResult | null>(null);
  const [readPath, setReadPath] = useState("README.md");
  const [readOut, setReadOut] = useState<ReadResult | null>(null);
  const [chip, setChip] = useState<"ok" | "fail" | null>(null);
  const [chipText, setChipText] = useState("");

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onProcessOutput((stream, text) => {
      setLines((prev) => [...prev.slice(-500), { stream, text }]);
    }).then((off) => {
      unlisten = off;
    });
    return () => unlisten?.();
  }, []);

  const checkNativeCore = useCallback(async () => {
    setBusy(true);
    try {
      setStatus(await nativeStatus());
    } catch {
      setStatus("Native command unavailable");
    } finally {
      setBusy(false);
    }
  }, []);

  const detectWorkspace = useCallback(async () => {
    try {
      setWorkspace(await workspaceInfo("."));
    } catch {
      setWorkspace(null);
    }
  }, []);

  const execute = useCallback(async () => {
    setLines([]);
    setResult(null);
    setBusy(true);
    try {
      if (await commandApprovalRequired(command)) {
        setStatus("Refused: command matches a dangerous pattern (runtime approval gate)");
        return;
      }
      const r = await bash(command.trim());
      setResult(r);
      setChip(r.cancelled ? null : r.success ? "ok" : "fail");
      setChipText(
        r.cancelled
          ? "Cancelled"
          : `Exit ${r.exitCode ?? "?"} · ${r.durationMs}ms${r.truncated ? " · Truncated" : ""}`
      );
    } catch (err) {
      setStatus(`Refused or failed: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [command]);

  const doRead = useCallback(async () => {
    setReadOut(null);
    setBusy(true);
    try {
      setReadOut(await readFile(readPath.trim()));
      setStatus(`Read ${readPath}`);
    } catch (err) {
      setStatus(`Read refused: ${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, [readPath]);

  return (
    <main className="shell">
      <section className="hero">
        <span className="eyebrow">ENTRY DESKTOP / 0.3 · PHASE 1</span>
        <h1>Agent runtime, on your machine.</h1>
        <p>
          Upstream-compatible tool boundaries, native: workspace-contained bash
          with approval gating, ceilinged reads, streaming output, cancellation,
          and timeouts.
        </p>
        <button onClick={checkNativeCore} disabled={busy}>
          {busy ? "Working…" : "Check native core"}
        </button>
        <div className="status">
          {status}
          {chip && <span className={`chip ${chip}`}>{chipText}</span>}
        </div>
      </section>

      <section className="panel">
        <h2>Bash</h2>
        <div className="row">
          <input
            value={command}
            onChange={(e) => setCommand(e.target.value)}
            placeholder="command"
            aria-label="command"
            style={{ flex: 1 }}
          />
          <button onClick={execute} disabled={busy}>
            {busy ? "Running…" : "Run"}
          </button>
        </div>
        <pre className="output" aria-live="polite">
          {lines.length > 0 &&
            lines.map((l, i) => (
              <div key={i} className={l.stream === "stderr" ? "err" : "out"}>
                {l.text}
              </div>
            ))}
          {lines.length === 0 && result && (
            <>
              {result.stdout && <div className="out">{result.stdout}</div>}
              {result.stderr && <div className="err">{result.stderr}</div>}
            </>
          )}
          {lines.length === 0 && !result && "— no output yet —"}
        </pre>
      </section>

      <section className="panel">
        <h2>Read (ceilinged + boundary-wrapped)</h2>
        <div className="row">
          <input
            value={readPath}
            onChange={(e) => setReadPath(e.target.value)}
            placeholder="workspace-relative path"
            aria-label="file path"
            style={{ flex: 1 }}
          />
          <button onClick={doRead} disabled={busy}>
            Read
          </button>
        </div>
        {readOut && (
          <div className="ws">
            <div>
              lines {readOut.startLine}–{readOut.endLine} of {readOut.totalLines}
              {readOut.truncated && " · truncated"}
              {readOut.nextOffset !== null && ` · next offset: ${readOut.nextOffset}`}
            </div>
            <pre className="output">{readOut.content}</pre>
          </div>
        )}
      </section>

      <section className="panel">
        <h2>Workspace</h2>
        <button onClick={detectWorkspace}>Detect workspace</button>
        {workspace && (
          <ul className="ws">
            <li>root: {workspace.root}</li>
            <li>git repo: {workspace.isGitRepo ? "yes" : "no"}</li>
            {workspace.gitBranch && <li>branch: {workspace.gitBranch}</li>}
            <li>package.json: {workspace.hasPackageJson ? "yes" : "no"}</li>
            <li>Cargo.toml: {workspace.hasCargoToml ? "yes" : "no"}</li>
          </ul>
        )}
      </section>

      <section className="grid">
        <article>
          <strong>Rust core</strong>
          <span>Native process and OS boundary.</span>
        </article>
        <article>
          <strong>Local workspace</strong>
          <span>Direct filesystem and git access.</span>
        </article>
        <article>
          <strong>Agent harness</strong>
          <span>Plan → tools → observe → verify → respond.</span>
        </article>
      </section>
    </main>
  );
}
