import { useState, useEffect } from "react";
import {
  sessionInfo,
  signOut,
  modelCatalog,
  type SessionInfo,
  type CatalogModel,
} from "./auth";
import { LoginScreen } from "./LoginScreen";
import { Workspace } from "./Workspace";

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionLoaded, setSessionLoaded] = useState(false);
  const [models, setModels] = useState<CatalogModel[]>([]);
  const [selectedModel, setSelectedModel] = useState("");

  useEffect(() => {
    sessionInfo()
      .then((s) => {
        setSession(s);
        setSessionLoaded(true);
        if (s.signedIn) {
          modelCatalog()
            .then((m) => {
              setModels(m);
              if (m.length > 0) setSelectedModel((cur) => cur || m[0].id);
            })
            .catch(() => setModels([]));
        }
      })
      .catch(() => setSessionLoaded(true));
  }, []);

  // NOTE: all hooks above early returns (Lesson 52).
  if (!sessionLoaded) {
    return <div className="boot">Loading…</div>;
  }
  if (!session || !session.signedIn) {
    return (
      <LoginScreen
        onSignedIn={() => {
          sessionInfo().then((s) => {
            setSession(s);
            if (s.signedIn) {
              modelCatalog()
                .then((m) => {
                  setModels(m);
                  if (m.length > 0) setSelectedModel(m[0].id);
                })
                .catch(() => setModels([]));
            }
          });
        }}
      />
    );
  }

  // The signed-in surface is the full DSH-style conversation workspace.
  return (
    <Workspace
      username={session.username ?? ""}
      plan={session.plan ?? "free"}
      balance={
        session.creditBalanceCents != null
          ? `$${(session.creditBalanceCents / 100).toFixed(2)}`
          : "—"
      }
      model={selectedModel ?? ""}
      models={models}
      onModel={setSelectedModel}
      onSignOut={async () => {
        await signOut();
        setSession(null);
      }}
    />
  );
}
