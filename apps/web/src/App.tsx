import { useEffect, useState } from "react";
import { useSessions } from "./hooks/useSessions";
import { clock } from "./lib/format";
import { SessionDetail } from "./views/SessionDetail";
import { SessionList } from "./views/SessionList";

export const App = () => {
  const feed = useSessions();
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Follow the newest session until the operator picks one.
  useEffect(() => {
    if (selectedId === null && feed.sessions.length > 0)
      setSelectedId(feed.sessions[0]!.session_id);
  }, [selectedId, feed.sessions]);

  const selected =
    feed.sessions.find((s) => s.session_id === selectedId) ?? null;

  return (
    <>
      <header>
        <h1>slopwatch</h1>
        <span className={`status ${feed.status}`}>
          {feed.status === "live"
            ? `live · ${feed.lastUpdated ? clock(feed.lastUpdated.toISOString()) : ""}`
            : feed.status === "down"
              ? `connection lost${feed.lastError ? ` · ${feed.lastError}` : ""}`
              : "connecting…"}
        </span>
      </header>
      <main>
        <aside>
          <SessionList
            sessions={feed.sessions}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        </aside>
        <section>
          {selected ? (
            <SessionDetail summary={selected} />
          ) : (
            <p className="empty">no sessions yet</p>
          )}
        </section>
      </main>
    </>
  );
};
