import type { Context } from "hono";
import { appLogger } from "../logging.js";
import { sanitizeClientLogData } from "./request-payloads.js";

interface ClientLogPayload {
  event?: unknown;
  data?: unknown;
}

const CLIENT_LOG_EVENTS = new Set<string>([
  "app.load.done",
  "app.load.error",
  "app.load.start",
  "bookmark.add",
  "bookmark.delete",
  "react.profiler.commit",
  "route.change",
  "search.done",
  "search.error",
  "search.start",
  "session.markdown_copy.done",
  "session.markdown_copy.error",
  "session.open.cancel",
  "session.open.done",
  "session.open.error",
  "session.open.start",
]);

export async function handlePostClientLog(c: Context) {
  const payload = (await c.req.json().catch(() => null)) as ClientLogPayload | null;
  const rawEvent = payload?.event;

  if (typeof rawEvent !== "string") {
    return c.json({ ok: false }, 400);
  }

  const event = rawEvent.trim();
  if (!CLIENT_LOG_EVENTS.has(event)) return c.json({ ok: false }, 400);

  appLogger.info(`client.${event}`, sanitizeClientLogData(payload?.data));
  return c.json({ ok: true });
}
