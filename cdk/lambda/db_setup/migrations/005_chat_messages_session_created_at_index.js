// Chat history is read per session in created_at, id order. This index matches that order, so
// Postgres reads a session's messages already sorted instead of sorting them on every request.
// It also covers lookups by chat_session_id alone (including the delete cascade from
// chat_sessions), which makes the single-column index redundant.
exports.up = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created_at
      ON chat_messages (chat_session_id, created_at, id);
    DROP INDEX IF EXISTS idx_chat_messages_chat_session_id;
  `);
};

exports.down = (pgm) => {
  pgm.sql(`
    CREATE INDEX IF NOT EXISTS idx_chat_messages_chat_session_id
      ON chat_messages (chat_session_id);
    DROP INDEX IF EXISTS idx_chat_messages_session_created_at;
  `);
};
