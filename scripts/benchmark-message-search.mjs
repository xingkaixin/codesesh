/**
 * Measures the tradeoff between candidate-message scans and a trigram FTS5
 * prototype for the same 50-session × 2,000-message worst case.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";

const coreRequire = createRequire(new URL("../packages/core/package.json", import.meta.url));
const Database = coreRequire("better-sqlite3");

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > 100_000) {
    throw new Error(`${name} must be an integer between 1 and 100000`);
  }
  return value;
}

const sessionCount = positiveInteger("MESSAGE_SEARCH_BENCH_SESSIONS", 50);
const messagesPerSession = positiveInteger("MESSAGE_SEARCH_BENCH_MESSAGES", 2_000);
const iterations = positiveInteger("MESSAGE_SEARCH_BENCH_ITERATIONS", 5);
const targetSessionId = "session-0";
const terms = ["needlealpha", "needlebeta"];
const ftsQuery = terms.map((term) => `"${term}"`).join(" ");

function databaseSize(path) {
  return statSync(path).size;
}

function walSize(path) {
  try {
    return statSync(`${path}-wal`).size;
  } catch {
    return 0;
  }
}

function createDatabase(path, withFts) {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE messages (
      agent_name TEXT NOT NULL,
      session_id TEXT NOT NULL,
      message_index INTEGER NOT NULL,
      content_text TEXT NOT NULL,
      PRIMARY KEY (agent_name, session_id, message_index)
    );
    CREATE INDEX idx_messages_session
      ON messages(agent_name, session_id, message_index);
  `);
  if (withFts) {
    db.exec(`
      CREATE VIRTUAL TABLE message_content_fts USING fts5(
        content_text,
        content='messages',
        content_rowid='rowid',
        tokenize='trigram'
      );
      CREATE TRIGGER message_content_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO message_content_fts(rowid, content_text)
        VALUES (new.rowid, new.content_text);
      END;
      CREATE TRIGGER message_content_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO message_content_fts(message_content_fts, rowid, content_text)
        VALUES ('delete', old.rowid, old.content_text);
      END;
      CREATE TRIGGER message_content_fts_au AFTER UPDATE ON messages BEGIN
        INSERT INTO message_content_fts(message_content_fts, rowid, content_text)
        VALUES ('delete', old.rowid, old.content_text);
        INSERT INTO message_content_fts(rowid, content_text)
        VALUES (new.rowid, new.content_text);
      END;
    `);
  }
  return db;
}

function messageText(sessionIndex, messageIndex) {
  const term = messageIndex % 2 === 0 ? terms[0] : terms[1];
  return `${term} session-${sessionIndex} message-${messageIndex} searchable fixture content`;
}

function writeMessages(db) {
  const insert = db.prepare(
    "INSERT INTO messages(agent_name, session_id, message_index, content_text) VALUES (?, ?, ?, ?)",
  );
  const write = db.transaction(() => {
    for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
      const sessionId = `session-${sessionIndex}`;
      for (let messageIndex = 0; messageIndex < messagesPerSession; messageIndex += 1) {
        insert.run("agent", sessionId, messageIndex, messageText(sessionIndex, messageIndex));
      }
    }
  });
  const startedAt = performance.now();
  write();
  return performance.now() - startedAt;
}

function candidateBindings() {
  return Array.from({ length: sessionCount }, (_, index) => ["agent", `session-${index}`]).flat();
}

function candidateValues() {
  return Array.from({ length: sessionCount }, () => "(?, ?)").join(", ");
}

function scanQuery(db) {
  let predicateEvaluations = 0;
  db.function("message_matches_terms", { deterministic: true }, (content) => {
    predicateEvaluations += 1;
    const text = String(content ?? "").toLowerCase();
    return terms.every((term) => text.includes(term)) ? 1 : 0;
  });
  const statement = db.prepare(`
    WITH candidate_sessions(agent_name, session_id) AS (VALUES ${candidateValues()}),
    first_message_matches AS MATERIALIZED (
      SELECT
        c.agent_name,
        c.session_id,
        (
          SELECT m.rowid
          FROM messages m INDEXED BY idx_messages_session
          WHERE m.agent_name = c.agent_name
            AND m.session_id = c.session_id
            AND message_matches_terms(m.content_text)
          ORDER BY m.message_index
          LIMIT 1
        ) AS message_rowid
      FROM candidate_sessions c
    )
    SELECT count(*) AS value
    FROM first_message_matches
    WHERE message_rowid IS NOT NULL
  `);
  return () => {
    predicateEvaluations = 0;
    const startedAt = performance.now();
    const row = statement.get(...candidateBindings());
    return {
      matched_sessions: Number(row.value),
      predicate_evaluations: predicateEvaluations,
      duration_ms: performance.now() - startedAt,
    };
  };
}

function ftsQueryForCandidates(db) {
  let predicateEvaluations = 0;
  db.function("message_matches_terms", { deterministic: true }, (content) => {
    predicateEvaluations += 1;
    const text = String(content ?? "").toLowerCase();
    return terms.every((term) => text.includes(term)) ? 1 : 0;
  });
  const statement = db.prepare(`
    WITH candidate_sessions(agent_name, session_id) AS (VALUES ${candidateValues()}),
    message_fts_hits AS MATERIALIZED (
      SELECT
        m.agent_name,
        m.session_id,
        m.message_index,
        m.content_text
      FROM message_content_fts
      JOIN messages m ON m.rowid = message_content_fts.rowid
      JOIN candidate_sessions c ON c.agent_name = m.agent_name AND c.session_id = m.session_id
      WHERE message_content_fts MATCH ?
    ),
    exact_message_matches AS MATERIALIZED (
      SELECT
        *,
        ROW_NUMBER() OVER (
          PARTITION BY agent_name, session_id
          ORDER BY message_index
        ) AS session_rank
      FROM message_fts_hits
      WHERE message_matches_terms(content_text)
    )
    SELECT count(*) AS value
    FROM exact_message_matches
    WHERE session_rank = 1
  `);
  return () => {
    predicateEvaluations = 0;
    const startedAt = performance.now();
    const row = statement.get(...candidateBindings(), ftsQuery);
    return {
      matched_sessions: Number(row.value),
      predicate_evaluations: predicateEvaluations,
      duration_ms: performance.now() - startedAt,
    };
  };
}

function measure(run) {
  run();
  const runs = Array.from({ length: iterations }, () => run());
  const durations = runs
    .map(({ duration_ms }) => duration_ms)
    .toSorted((left, right) => left - right);
  const median = durations[Math.floor(durations.length / 2)] ?? 0;
  return {
    median_ms: Number(median.toFixed(2)),
    matched_sessions: runs[0]?.matched_sessions ?? 0,
    predicate_evaluations: runs[0]?.predicate_evaluations ?? 0,
  };
}

function updateTargetSession(db) {
  const startedAt = performance.now();
  db.prepare(
    "UPDATE messages SET content_text = content_text || ' updated' WHERE agent_name = ? AND session_id = ?",
  ).run("agent", targetSessionId);
  return performance.now() - startedAt;
}

const tempDir = mkdtempSync(join(tmpdir(), "codesesh-message-search-bench-"));
const scanPath = join(tempDir, "scan.db");
const ftsPath = join(tempDir, "fts.db");

try {
  const scanDb = createDatabase(scanPath, false);
  const ftsDb = createDatabase(ftsPath, true);
  const scanWriteMs = writeMessages(scanDb);
  const ftsWriteMs = writeMessages(ftsDb);
  scanDb.pragma("wal_checkpoint(TRUNCATE)");
  ftsDb.pragma("wal_checkpoint(TRUNCATE)");

  const scanResult = measure(scanQuery(scanDb));
  const ftsResult = measure(ftsQueryForCandidates(ftsDb));
  const scanTargetedWriteMs = updateTargetSession(scanDb);
  const ftsTargetedWriteMs = updateTargetSession(ftsDb);
  const scanWalBytes = walSize(scanPath);
  const ftsWalBytes = walSize(ftsPath);
  scanDb.pragma("wal_checkpoint(TRUNCATE)");
  ftsDb.pragma("wal_checkpoint(TRUNCATE)");
  scanDb.close();
  ftsDb.close();

  console.log(
    JSON.stringify(
      {
        sessions: sessionCount,
        messages_per_session: messagesPerSession,
        total_messages: sessionCount * messagesPerSession,
        query: terms.join(" "),
        scan: {
          ...scanResult,
          full_write_ms: Number(scanWriteMs.toFixed(2)),
          targeted_write_ms: Number(scanTargetedWriteMs.toFixed(2)),
          database_bytes: databaseSize(scanPath),
          wal_bytes_before_checkpoint: scanWalBytes,
        },
        trigram_fts: {
          ...ftsResult,
          full_write_ms: Number(ftsWriteMs.toFixed(2)),
          targeted_write_ms: Number(ftsTargetedWriteMs.toFixed(2)),
          database_bytes: databaseSize(ftsPath),
          wal_bytes_before_checkpoint: ftsWalBytes,
        },
        index_delta_bytes: databaseSize(ftsPath) - databaseSize(scanPath),
      },
      null,
      2,
    ),
  );
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
