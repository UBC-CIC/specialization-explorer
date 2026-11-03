// No table uses the pgvector types: embeddings live in the Bedrock knowledge base's
// OpenSearch Serverless collection. RESTRICT makes the migration fail instead of dropping
// anything if a column or function has started depending on the extension.
exports.up = (pgm) => {
  pgm.sql(`DROP EXTENSION IF EXISTS vector RESTRICT;`);
};

exports.down = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS vector;`);
};
