import type { SessionFileActivity, SessionHead } from "../../types/index.js";
import type { SQLiteDatabase } from "../../utils/sqlite.js";
import {
  messageCursorContentFromStructuredRecord,
  MESSAGE_PARTS_FORMAT_VERSION,
  prepareInsertFileActivity,
  prepareInsertMessageTool,
  prepareUpsertSession,
  requireSessionProjectIdentity,
  upsertSessionRow,
  writeFileActivityRows,
  type StructuredMessageRecord,
} from "./messages.js";
import { advanceMessageCursorDigest, initialMessageCursorDigest } from "./message-cursor.js";

export interface SessionMaterializationEntry {
  session: SessionHead;
  messages: StructuredMessageRecord[];
  fileActivity: SessionFileActivity[];
  sortIndex: number;
}

export interface SessionMaterializationWriter {
  deleteSession(sessionId: string): void;
  reuseSessionHead(session: SessionHead, sortIndex: number): void;
  writeSession(entry: SessionMaterializationEntry): void;
}

export function prepareSessionMaterializationWriter(
  db: SQLiteDatabase,
  agentName: string,
): SessionMaterializationWriter {
  const deleteMessages = db.prepare(
    "DELETE FROM messages WHERE agent_name = ? AND session_id = ? AND message_index >= ?",
  );
  const deleteMessageTools = db.prepare(
    "DELETE FROM message_tools WHERE agent_name = ? AND session_id = ? AND message_index >= ?",
  );
  const deleteFileActivity = db.prepare(
    "DELETE FROM session_file_activity WHERE agent_name = ? AND session_id = ?",
  );
  const updateFileActivityIdentity = db.prepare(
    "UPDATE session_file_activity SET project_identity_key = ? WHERE agent_name = ? AND session_id = ?",
  );
  const deleteModelCost = db.prepare(
    "DELETE FROM session_model_cost WHERE agent_name = ? AND session_id = ?",
  );
  const deleteCostSummary = db.prepare(
    "DELETE FROM session_cost_summary WHERE agent_name = ? AND session_id = ?",
  );
  // Rebuild both rollups from the message rows in the same transaction so
  // derived cost facts cannot drift from their source.
  const rebuildModelCost = db.prepare(`
    INSERT INTO session_model_cost(agent_name, session_id, model, cost, cost_recorded)
    SELECT
      agent_name,
      session_id,
      model,
      SUM(COALESCE(cost, 0)),
      SUM(CASE WHEN cost_source = 'recorded' THEN COALESCE(cost, 0) ELSE 0 END)
    FROM messages
    WHERE agent_name = ? AND session_id = ? AND model IS NOT NULL AND model <> ''
    GROUP BY agent_name, session_id, model
  `);
  const rebuildCostSummary = db.prepare(`
    WITH normalized AS (
      SELECT
        agent_name,
        session_id,
        COALESCE(time_completed, 0) <= 0 AND COALESCE(time_created, 0) <= 0 AS untimed,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.input'), 0) AS INTEGER), 0) AS input_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.output'), 0) AS INTEGER), 0) AS output_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.reasoning'), 0) AS INTEGER), 0) AS reasoning_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.cache_read'), 0) AS INTEGER), 0) AS cache_read_tokens,
        MAX(CAST(COALESCE(json_extract(tokens_json, '$.cache_create'), 0) AS INTEGER), 0) AS cache_create_tokens,
        CASE WHEN cost > 0 THEN cost ELSE 0 END AS normalized_cost
      FROM messages
      WHERE agent_name = ? AND session_id = ?
    )
    INSERT INTO session_cost_summary(
      agent_name,
      session_id,
      message_count,
      untimed_message_count,
      input_tokens,
      output_tokens,
      reasoning_tokens,
      cache_read_tokens,
      cache_create_tokens,
      untimed_input_tokens,
      untimed_output_tokens,
      untimed_reasoning_tokens,
      untimed_cache_read_tokens,
      untimed_cache_create_tokens,
      message_cost,
      untimed_message_cost
    )
    SELECT
      agent_name,
      session_id,
      COUNT(*),
      SUM(CASE WHEN untimed THEN 1 ELSE 0 END),
      SUM(input_tokens),
      SUM(output_tokens),
      SUM(reasoning_tokens),
      SUM(cache_read_tokens),
      SUM(cache_create_tokens),
      SUM(CASE WHEN untimed THEN input_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN output_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN reasoning_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN cache_read_tokens ELSE 0 END),
      SUM(CASE WHEN untimed THEN cache_create_tokens ELSE 0 END),
      SUM(normalized_cost),
      SUM(CASE WHEN untimed THEN normalized_cost ELSE 0 END)
    FROM normalized
    GROUP BY agent_name, session_id
  `);
  const writeMaterializedSession = prepareUpsertSession(db, "materialization");
  const insertFileActivity = prepareInsertFileActivity(db);
  const insertMessageTool = prepareInsertMessageTool(db);
  const upsertMessage = db.prepare(`
    INSERT INTO messages(
      agent_name,
      session_id,
      message_index,
      message_id,
      role,
      time_created,
      time_completed,
      agent,
      mode,
      model,
      provider,
      tokens_json,
      cost,
      cost_source,
      parts_json,
      parts_format_version,
      content_chain_digest,
      subagent_id,
      nickname,
      content_text,
      tool_metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_name, session_id, message_index) DO UPDATE SET
      message_id = excluded.message_id,
      role = excluded.role,
      time_created = excluded.time_created,
      time_completed = excluded.time_completed,
      agent = excluded.agent,
      mode = excluded.mode,
      model = excluded.model,
      provider = excluded.provider,
      tokens_json = excluded.tokens_json,
      cost = excluded.cost,
      cost_source = excluded.cost_source,
      parts_json = excluded.parts_json,
      parts_format_version = excluded.parts_format_version,
      content_chain_digest = excluded.content_chain_digest,
      subagent_id = excluded.subagent_id,
      nickname = excluded.nickname,
      content_text = excluded.content_text,
      tool_metadata_json = excluded.tool_metadata_json
  `);

  const writeSessionHead = (session: SessionHead, sortIndex: number): void => {
    upsertSessionRow(writeMaterializedSession, agentName, session, null, sortIndex, null);
  };

  return {
    deleteSession(sessionId) {
      deleteFileActivity.run(agentName, sessionId);
      deleteMessageTools.run(agentName, sessionId, 0);
      deleteMessages.run(agentName, sessionId, 0);
      deleteModelCost.run(agentName, sessionId);
      deleteCostSummary.run(agentName, sessionId);
    },
    reuseSessionHead(session, sortIndex) {
      writeSessionHead(session, sortIndex);
      updateFileActivityIdentity.run(
        requireSessionProjectIdentity(agentName, session).key,
        agentName,
        session.reference.sessionId,
      );
    },
    writeSession(entry) {
      const sessionId = entry.session.reference.sessionId;
      writeSessionHead(entry.session, entry.sortIndex);
      deleteFileActivity.run(agentName, sessionId);
      deleteMessageTools.run(agentName, sessionId, 0);
      writeFileActivityRows(insertFileActivity, entry.fileActivity);
      let contentChainDigest = initialMessageCursorDigest({ agentName, sessionId });
      for (const message of entry.messages) {
        contentChainDigest = advanceMessageCursorDigest(
          contentChainDigest,
          messageCursorContentFromStructuredRecord(message),
        );
        upsertMessage.run(
          agentName,
          sessionId,
          message.index,
          message.id,
          message.role,
          message.timeCreated,
          message.timeCompleted ?? null,
          message.agent ?? null,
          message.mode ?? null,
          message.model ?? null,
          message.provider ?? null,
          message.tokensJson ?? null,
          message.cost ?? null,
          message.costSource ?? null,
          message.partsJson,
          MESSAGE_PARTS_FORMAT_VERSION,
          contentChainDigest,
          message.subagentId ?? null,
          message.nickname ?? null,
          message.contentText,
          message.toolMetadataJson ?? null,
        );
        for (const toolName of message.toolNames) {
          insertMessageTool.run(agentName, sessionId, message.index, toolName);
        }
      }
      deleteMessages.run(agentName, sessionId, entry.messages.length);
      deleteModelCost.run(agentName, sessionId);
      deleteCostSummary.run(agentName, sessionId);
      rebuildModelCost.run(agentName, sessionId);
      rebuildCostSummary.run(agentName, sessionId);
    },
  };
}
