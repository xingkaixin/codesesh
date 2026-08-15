import type { SessionDetail } from "@codesesh/core";

const SESSION_DETAIL_STREAM_BATCH_CHARS = 64 * 1024;

export function createSessionDetailJsonResponse(
  data: Omit<SessionDetail, "messages">,
  messages: Iterable<string>,
): Response {
  const encoder = new TextEncoder();
  const headerJson = JSON.stringify(data);
  const headerPrefix =
    headerJson === "{}" ? '{"messages":[' : `${headerJson.slice(0, -1)},"messages":[`;
  const iterator = messages[Symbol.iterator]();
  let wroteHeader = false;
  let wroteMessage = false;

  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!wroteHeader) {
          controller.enqueue(encoder.encode(headerPrefix));
          wroteHeader = true;
          return;
        }

        const batch: string[] = [];
        let batchLength = 0;
        let next: IteratorResult<string>;
        try {
          next = iterator.next();
          while (!next.done) {
            const prefix = wroteMessage ? "," : "";
            batch.push(prefix, next.value);
            batchLength += prefix.length + next.value.length;
            wroteMessage = true;
            if (batchLength >= SESSION_DETAIL_STREAM_BATCH_CHARS) break;
            next = iterator.next();
          }
        } catch (error) {
          try {
            iterator.return?.();
          } catch {}
          controller.error(error);
          return;
        }

        if (next.done) {
          batch.push("]}");
          controller.enqueue(encoder.encode(batch.join("")));
          controller.close();
          return;
        }

        controller.enqueue(encoder.encode(batch.join("")));
      },
      cancel() {
        iterator.return?.();
      },
    }),
    { headers: { "Content-Type": "application/json; charset=UTF-8" } },
  );
}
