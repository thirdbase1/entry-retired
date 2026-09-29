import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export function App() {
  const [status, setStatus] = useState("Native core ready");
  const [busy, setBusy] = useState(false);

  async function checkNativeCore() {
    setBusy(true);
    try {
      const value = await invoke<string>("native_status");
      setStatus(value);
    } catch {
      setStatus("Native command unavailable");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="hero">
        <span className="eyebrow">ENTRY DESKTOP / 0.1</span>
        <h1>Agent runtime, on your machine.</h1>
        <p>
          A native foundation for Entry: local workspaces, processes, terminals,
          MCP, approvals, and eventually the full agent harness.
        </p>
        <button onClick={checkNativeCore} disabled={busy}>
          {busy ? "Checking…" : "Check native core"}
        </button>
        <div className="status">{status}</div>
      </section>

      <section className="grid">
        <article>
          <strong>Rust core</strong>
          <span>Native process and OS boundary.</span>
        </article>
        <article>
          <strong>Local workspace</strong>
          <span>Designed for direct filesystem and git access.</span>
        </article>
        <article>
          <strong>Agent harness</strong>
          <span>Plan → tools → observe → verify → respond.</span>
        </article>
      </section>
    </main>
  );
}
