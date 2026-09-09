import { useEffect, useRef } from "react";
import type { StoredEvent } from "../api";
import { clock } from "../lib/format";
import { describeEvent, eventTag } from "../lib/timeline";

/** Append-only log with live-tail auto-scroll. */
export const RawEventsView = ({ events }: { events: StoredEvent[] }) => {
  const bottomRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [events.length]);

  if (events.length === 0) return <p className="empty">no events yet</p>;
  return (
    <div className="raw">
      {events.map((stored) => (
        <div key={stored.event_seq} className="event">
          <span className="seq">#{stored.event_seq}</span>
          <span className={`kind ${stored.event.kind}`}>
            {eventTag(stored.event)}
          </span>
          <span className="detail">{describeEvent(stored.event)}</span>
          <span className="meta">{clock(stored.event.occurred_at)}</span>
        </div>
      ))}
      <div ref={bottomRef} />
    </div>
  );
};
