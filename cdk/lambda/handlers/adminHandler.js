/**
 * AWS Lambda Handler for Admin Operations
 *
 * This Lambda function handles HTTP requests for administrative operations including:
 * - Admin user management (create, read, update, delete)
 * - System administration tasks
 * - Content management operations
 *
 * This handler requires admin-level authentication via AWS Cognito.
 * Only authenticated admin users can access these endpoints.
 */

const postgres = require("postgres");
const { getCorsHeaders } = require("./utils/cors.js");
const { auditLog } = require("./utils/audit.js");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const crypto = require("crypto");

let sqlConnection;
const secretsManager = new SecretsManagerClient();

const initConnection = async () => {
  if (!sqlConnection) {
    try {
      const getSecretValueCommand = new GetSecretValueCommand({
        SecretId: process.env.SM_DB_CREDENTIALS,
      });
      const secretResponse = await secretsManager.send(getSecretValueCommand);
      const credentials = JSON.parse(secretResponse.SecretString);

      const connectionConfig = {
        host: process.env.RDS_PROXY_ENDPOINT,
        port: credentials.port,
        username: credentials.username,
        password: credentials.password,
        database: credentials.dbname,
        ssl: { rejectUnauthorized: true },
      };

      sqlConnection = postgres(connectionConfig);
      await sqlConnection`SELECT 1`;
      console.log("Database connection initialized successfully");
    } catch (error) {
      console.error("Error initializing database connection:", error);
      throw error;
    }
  }
};

const createResponse = async (event) => ({
    statusCode: 200,
    headers: await getCorsHeaders(event),
    body: "",
});

const parseBody = (body) => {
  try {
    return JSON.parse(body || "{}");
  } catch {
    throw new Error("Invalid JSON body");
  }
};

const handleError = (error, response) => {
  response.statusCode = 500;
  console.error("Internal server error:", error);
  response.body = JSON.stringify({ error: "Internal server error" });
};

/**
 * Main Lambda handler function
 * @param {Object} event - AWS Lambda event object containing HTTP request data
 * @returns {Object} HTTP response object with statusCode, headers, and body
 */
exports.handler = async (event) => {
  const response = await createResponse(event);

  const callerRole = event.requestContext?.authorizer?.role;
  if (callerRole !== 'admin') {
    response.statusCode = 403;
    response.body = JSON.stringify({ error: 'Admin access required' });
    auditLog(event, response, { privileged: true });
    return response;
  }

  // Ensure database connection is ready
  await initConnection();

  let data; // Variable to store response data
  let auditDetails; // Extra fields for the audit record of privileged changes
  try {
    // Route requests based on HTTP method and URL path
    // event.httpMethod: GET, POST, PUT, DELETE
    // event.resource: URL pattern like /admin/users
    const pathData = event.httpMethod + " " + event.resource;

    // Handle different API endpoints using switch statement
    switch (pathData) {
      // POST /admin/promote_user - Record the caller as an administrator in the users table.
      // The caller is already in the Cognito admin group (enforced by the authorizer); the only
      // row this can change is the one for the caller's own verified Cognito address, so no
      // user, role or address is taken from the request.
      case "POST /admin/promote_user": {
        const callerEmail = (event.requestContext?.authorizer?.email || "").trim().toLowerCase();
        if (!callerEmail) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        const promoted = await sqlConnection.begin(async (tx) => {
          const existing = await tx`
            SELECT id, role
            FROM users
            WHERE lower(email) = ${callerEmail}
            FOR UPDATE
          `;

          if (existing.length > 0) {
            const rows = await tx`
              UPDATE users
              SET role = 'admin'::user_role, last_seen_at = NOW()
              WHERE id = ${existing[0].id}
              RETURNING id, email, display_name, role, created_at, last_seen_at,
                        messages_sent, messages_window_started_at, metadata
            `;
            return { row: rows[0], previousRole: existing[0].role };
          }

          const rows = await tx`
            INSERT INTO users (id, email, role, created_at, last_seen_at)
            VALUES (${crypto.randomUUID()}, ${callerEmail}, 'admin'::user_role, NOW(), NOW())
            RETURNING id, email, display_name, role, created_at, last_seen_at,
                      messages_sent, messages_window_started_at, metadata
          `;
          return { row: rows[0], previousRole: null };
        });

        auditDetails = {
          targetUserId: promoted.row.id,
          previousRole: promoted.previousRole,
          newRole: promoted.row.role,
        };

        response.statusCode = 200;
        response.body = JSON.stringify(promoted.row);
        break;
      }

      // Fetch all system messages with version history
      case "GET /admin/system-messages": {
        const rows = await sqlConnection`
          SELECT
            sm.id,
            sm.type,
            sm.content,
            sm.character_limit,
            sm.version,
            sm.is_active,
            sm.affects_text_generation,
            sm.created_by,
            sm.created_at,
            u.email AS created_by_email
          FROM system_messages sm
          LEFT JOIN users u ON u.id = sm.created_by
          ORDER BY
            sm.type ASC,
            sm.is_active DESC,
            sm.version DESC,
            sm.created_at DESC
        `;

        // Group into { [type]: SystemMessageVersion[] }
        const grouped = {};
        for (const r of rows) {
          if (!grouped[r.type]) grouped[r.type] = [];
          grouped[r.type].push({
            id: r.id,
            type: r.type,
            content: r.content,
            character_limit: r.character_limit,
            version: r.version,
            is_active: r.is_active,
            affects_text_generation: r.affects_text_generation,
            created_by: r.created_by ?? null,
            created_by_email: r.created_by_email ?? null,
            created_at: r.created_at,
          });
        }

        response.statusCode = 200;
        response.body = JSON.stringify(grouped);
        break;
      }

      // Create new system message version + set active
      case "POST /admin/system-messages/{system_message_type}": {
        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const messageType = event?.pathParameters?.system_message_type;

        const allowedTypes = new Set([
          "disclaimer",
          "guardrails",
          "system_role",
          "system_checklist",
          "system_instructions",
          "initial_prompt",
          "detective_phase_prompt",
          "suggestion_phase_prompt",
          "welcome_message",
          "partial_hallucination_warning",
          "full_hallucination_warning",
        ]);

        // Validate system_message_type
        if (!messageType || typeof messageType !== "string" || !allowedTypes.has(messageType)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Invalid system_message_type",
            allowed: Array.from(allowedTypes),
          });
          break;
        }

        // Validate content
        const content = typeof body?.content === "string" ? body.content.trim() : "";
        if (!content) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "content is required" });
          break;
        }

        const adminEmail = event.requestContext?.authorizer?.email;
        if (!adminEmail) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        // Find admin user id (ensure role is admin)
        const adminRows = await sqlConnection`
          SELECT id, email, role
          FROM users
          WHERE email = ${adminEmail}
          LIMIT 1
        `;

        if (adminRows.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Admin user not found" });
          break;
        }

        if (adminRows[0].role !== "admin") {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "User is not an admin" });
          break;
        }

        const createdByUserId = adminRows[0].id;

        // Create new version, make it active, deactivate old
        try {
          const created = await sqlConnection.begin(async (tx) => {
            const [{ next_version }] = await tx`
              SELECT COALESCE(MAX(version), 0) + 1 AS next_version
              FROM system_messages
              WHERE type = ${messageType}::system_message_type
            `;

            const limitRows = await tx`
              SELECT character_limit
              FROM system_messages
              WHERE type = ${messageType}::system_message_type
              ORDER BY is_active DESC, version DESC, created_at DESC
              LIMIT 1
            `;

            const defaultCharacterLimit =
              messageType === "guardrails" || messageType === "system_instructions"
                ? 1000
                : 700;

            const characterLimit =
              limitRows.length > 0 && typeof limitRows[0].character_limit === "number"
                ? limitRows[0].character_limit
                : defaultCharacterLimit;

            if (content.length > characterLimit) {
              return {
                kind: "too_long",
                character_limit: characterLimit,
                content_length: content.length,
              };
            }

            await tx`
              UPDATE system_messages
              SET is_active = false
              WHERE type = ${messageType}::system_message_type
                AND is_active = true
            `;

            const inserted = await tx`
              INSERT INTO system_messages (
                type,
                content,
                character_limit,
                version,
                is_active,
                created_by,
                created_at
              )
              VALUES (
                ${messageType}::system_message_type,
                ${content},
                ${characterLimit},
                ${next_version},
                true,
                ${createdByUserId},
                NOW()
              )
              RETURNING id
            `;

            const out = await tx`
              SELECT
                sm.id,
                sm.type,
                sm.content,
                sm.character_limit,
                sm.version,
                sm.is_active,
                sm.affects_text_generation,
                sm.created_by,
                u.email AS created_by_email,
                sm.created_at
              FROM system_messages sm
              LEFT JOIN users u ON u.id = sm.created_by
              WHERE sm.id = ${inserted[0].id}
              LIMIT 1
            `;

            return {
              kind: "created",
              row: out[0],
            };
          });

          if (created.kind === "too_long") {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "content exceeds character_limit",
              character_limit: created.character_limit,
              content_length: created.content_length,
            });
            break;
          }

          response.statusCode = 200;
          response.body = JSON.stringify(created.row);
          break;
        } catch (err) {
          console.error("POST /admin/system-messages/{system_message_type} failed:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Failed to create system message version" });
          break;
        }
      }

      // Delete a non-active system message version
      case "DELETE /admin/system-messages/{system_message_type}/{version_id}": {
        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const messageType = event?.pathParameters?.system_message_type;
        const versionId = event?.pathParameters?.version_id;

        const allowedTypes = new Set([
          "disclaimer",
          "guardrails",
          "system_role",
          "system_checklist",
          "system_instructions",
          "initial_prompt",
          "detective_phase_prompt",
          "suggestion_phase_prompt",
          "welcome_message",
          "partial_hallucination_warning",
          "full_hallucination_warning",
        ]);

        // Validate path params
        if (!messageType || typeof messageType !== "string" || !allowedTypes.has(messageType)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Invalid system_message_type",
            allowed: Array.from(allowedTypes),
          });
          break;
        }

        if (!versionId || typeof versionId !== "string") {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "version_id is required" });
          break;
        }

        const adminEmail = event.requestContext?.authorizer?.email;
        if (!adminEmail) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        // Find admin user id
        const adminRows = await sqlConnection`
          SELECT id, email, role
          FROM users
          WHERE email = ${adminEmail}
          LIMIT 1
        `;

        if (adminRows.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Admin user not found" });
          break;
        }

        if (adminRows[0].role !== "admin") {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "User is not an admin" });
          break;
        }

        try {
          const deleted = await sqlConnection.begin(async (tx) => {
            const targetRows = await tx`
              SELECT id, type, version, is_active
              FROM system_messages
              WHERE id = ${versionId}
                AND type = ${messageType}::system_message_type
              FOR UPDATE
            `;

            if (targetRows.length === 0) {
              return { kind: "not_found" };
            }

            const target = targetRows[0];

            if (target.is_active) {
              return { kind: "active_forbidden", version: target.version };
            }

            const removed = await tx`
              DELETE FROM system_messages
              WHERE id = ${versionId}
                AND type = ${messageType}::system_message_type
              RETURNING id, type, version
            `;

            if (removed.length === 0) {
              return { kind: "not_found" };
            }

            return {
              kind: "deleted",
              id: removed[0].id,
              type: removed[0].type,
              version: removed[0].version,
            };
          });

          if (deleted.kind === "not_found") {
            response.statusCode = 404;
            response.body = JSON.stringify({
              error: "System message version not found for given type/version_id",
            });
            break;
          }

          if (deleted.kind === "active_forbidden") {
            response.statusCode = 400;
            response.body = JSON.stringify({
              error: "Cannot delete the active version",
              version: deleted.version,
            });
            break;
          }

          response.statusCode = 200;
          response.body = JSON.stringify({
            success: true,
            deleted: {
              id: deleted.id,
              type: deleted.type,
              version: deleted.version,
            },
          });
          break;
        } catch (err) {
          console.error("DELETE /admin/system-messages/{system_message_type}/{version_id} failed:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Failed to delete system message version" });
          break;
        }
      }

      // Activate a historical version
      case "POST /admin/system-messages/{system_message_type}/{version_id}/activate": {
        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const messageType = event?.pathParameters?.system_message_type;
        const versionId = event?.pathParameters?.version_id;

        const allowedTypes = new Set([
          "disclaimer",
          "guardrails",
          "system_role",
          "system_checklist",
          "system_instructions",
          "initial_prompt",
          "detective_phase_prompt",
          "suggestion_phase_prompt",
          "welcome_message",
          "partial_hallucination_warning",
          "full_hallucination_warning",
        ]);

        // Validate path params
        if (!messageType || typeof messageType !== "string" || !allowedTypes.has(messageType)) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "Invalid system_message_type",
            allowed: Array.from(allowedTypes),
          });
          break;
        }

        if (!versionId || typeof versionId !== "string") {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "version_id is required" });
          break;
        }

        const adminEmail = event.requestContext?.authorizer?.email;
        if (!adminEmail) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        // Find admin user id (ensure role is admin)
        const adminRows = await sqlConnection`
          SELECT id, email, role
          FROM users
          WHERE email = ${adminEmail}
          LIMIT 1
        `;

        if (adminRows.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Admin user not found" });
          break;
        }

        if (adminRows[0].role !== "admin") {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "User is not an admin" });
          break;
        }

        try {
          const result = await sqlConnection.begin(async (tx) => {
            // Lock target row and verify it exists + belongs to specified type
            const targetRows = await tx`
              SELECT id, type, version, is_active
              FROM system_messages
              WHERE id = ${versionId}
                AND type = ${messageType}::system_message_type
              FOR UPDATE
            `;

            if (targetRows.length === 0) {
              return { kind: "not_found" };
            }

            const target = targetRows[0];

            // If already active, return success
            if (target.is_active) {
              const out = await tx`
                SELECT
                  sm.id,
                  sm.type,
                  sm.content,
                  sm.character_limit,
                  sm.version,
                  sm.is_active,
                  sm.affects_text_generation,
                  sm.created_by,
                  u.email AS created_by_email,
                  sm.created_at
                FROM system_messages sm
                LEFT JOIN users u ON u.id = sm.created_by
                WHERE sm.id = ${target.id}
                LIMIT 1
              `;

              return {
                kind: "already_active",
                activated: out[0],
                previous_active: null,
              };
            }

            // Find currently active version for this type (if any), lock it
            const previousActiveRows = await tx`
              SELECT id, version
              FROM system_messages
              WHERE type = ${messageType}::system_message_type
                AND is_active = true
              FOR UPDATE
            `;

            const previousActive = previousActiveRows[0] ?? null;

            // Deactivate all active rows for this type (defensive, in case of bad data)
            await tx`
              UPDATE system_messages
              SET is_active = false
              WHERE type = ${messageType}::system_message_type
                AND is_active = true
            `;

            // Activate target
            await tx`
              UPDATE system_messages
              SET is_active = true
              WHERE id = ${target.id}
            `;

            const out = await tx`
              SELECT
                sm.id,
                sm.type,
                sm.content,
                sm.character_limit,
                sm.version,
                sm.is_active,
                sm.affects_text_generation,
                sm.created_by,
                u.email AS created_by_email,
                sm.created_at
              FROM system_messages sm
              LEFT JOIN users u ON u.id = sm.created_by
              WHERE sm.id = ${target.id}
              LIMIT 1
            `;

            return {
              kind: "activated",
              activated: out[0],
              previous_active: previousActive
                ? {
                  id: previousActive.id,
                  version: previousActive.version,
                }
                : null,
            };
          });

          if (result.kind === "not_found") {
            response.statusCode = 404;
            response.body = JSON.stringify({
              error: "System message version not found for given type/version_id",
            });
            break;
          }

          // Both "already_active" and "activated" return 200
          response.statusCode = 200;
          response.body = JSON.stringify({
            success: true,
            status: result.kind === "already_active" ? "already_active" : "activated",
            activated: result.activated,
            previous_active: result.previous_active,
          });
          break;
        } catch (err) {
          console.error("POST /admin/system-messages/{system_message_type}/{version_id}/activate failed:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Failed to activate system message version" });
          break;
        }
      }

      // POST /admin/users - Create new admin user in the system
      case "POST /admin/users":
        // Parse JSON request body containing new user data
        let userData;
        try {
          userData = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        // Extract user fields from request body
        const { display_name, email, institution_id } = userData;

        // Validate required fields
        if (!display_name || !email) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "display_name and email are required",
          });
          break;
        }

        // Insert new admin user into database
        // Using postgres library template literal syntax for better performance
        const result = await sqlConnection`
          INSERT INTO users (display_name, email, institution_id, role)
          VALUES (${display_name}, ${email}, ${institution_id || null}, 'admin')
          RETURNING id, display_name, email, role, institution_id, created_at
        `;

        response.statusCode = 201; // Created
        data = result[0];
        response.body = JSON.stringify(data);
        break;

      // Get analytics data
      case "GET /admin/analytics": {
        const qs = event.queryStringParameters ?? {};

        // If timeRange is NOT provided, return all-time totals only (no timeSeries)
        const timeRangeProvided = typeof qs.timeRange === "string" && qs.timeRange.trim().length > 0;

        // Helper: compute totals (either all-time or since startDate)
        const fetchTotals = async (startDateIso /* string | null */) => {
          if (!startDateIso) {
            const totalsRows = await sqlConnection`
              SELECT
                (SELECT COUNT(DISTINCT cs.user_id)::int FROM chat_sessions cs) AS users,
                (SELECT COUNT(cs.id)::int FROM chat_sessions cs) AS chat_sessions,
                (SELECT COUNT(cm.id)::int FROM chat_messages cm) AS messages,
                (SELECT COUNT(cm.id)::int FROM chat_messages cm WHERE cm.sender = 'user') AS questions
            `;
            return totalsRows[0];
          }

          const totalsRows = await sqlConnection`
            SELECT
              (SELECT COUNT(DISTINCT cs.user_id)::int
              FROM chat_sessions cs
              WHERE cs.created_at >= ${startDateIso}) AS users,

              (SELECT COUNT(cs.id)::int
              FROM chat_sessions cs
              WHERE cs.created_at >= ${startDateIso}) AS chat_sessions,

              (SELECT COUNT(cm.id)::int
              FROM chat_messages cm
              WHERE cm.created_at >= ${startDateIso}) AS messages,

              (SELECT COUNT(cm.id)::int
              FROM chat_messages cm
              WHERE cm.created_at >= ${startDateIso}
                AND cm.sender = 'user') AS questions
          `;
          return totalsRows[0];
        };

        if (!timeRangeProvided) {
          const totals = await fetchTotals(null);

          response.statusCode = 200;
          response.body = JSON.stringify({ totals });
          break;
        }

        // time series for provided timeRange (cap 365)
        const timeRange = qs.timeRange || "90d";

        let daysBack = 90;
        const m = String(timeRange).match(/^(\d+)([dmy])$/);
        if (m) {
          const value = parseInt(m[1], 10);
          const unit = m[2];
          if (unit === "d") daysBack = value;
          if (unit === "m") daysBack = value * 30;
          if (unit === "y") daysBack = value * 365;
        }
        daysBack = Math.min(Math.max(1, daysBack), 365);

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - daysBack);
        const startDateIso = startDate.toISOString();

        const timeSeries = await sqlConnection`
          WITH date_series AS (
            SELECT generate_series(
              DATE_TRUNC('day', ${startDateIso}::timestamp),
              DATE_TRUNC('day', NOW()),
              '1 day'::interval
            )::date AS date
          ),
          daily_chat_sessions AS (
            SELECT
              DATE_TRUNC('day', cs.created_at)::date AS date,
              COUNT(cs.id)::int AS chat_sessions,
              COUNT(DISTINCT cs.user_id)::int AS session_users
            FROM chat_sessions cs
            WHERE cs.created_at >= ${startDateIso}
            GROUP BY DATE_TRUNC('day', cs.created_at)::date
          ),
          daily_questions AS (
            SELECT
              DATE_TRUNC('day', cm.created_at)::date AS date,
              COUNT(cm.id)::int AS questions,
              COUNT(DISTINCT cs.user_id)::int AS question_users
            FROM chat_messages cm
            JOIN chat_sessions cs ON cs.id = cm.chat_session_id
            WHERE cm.created_at >= ${startDateIso}
              AND cm.sender = 'user'
            GROUP BY DATE_TRUNC('day', cm.created_at)::date
          )
          SELECT
            TO_CHAR(ds.date, 'Mon DD') AS date,
            COALESCE(GREATEST(dcs.session_users, dq.question_users), 0)::int AS users,
            COALESCE(dq.questions, 0)::int AS questions,
            COALESCE(dcs.chat_sessions, 0)::int AS chat_sessions
          FROM date_series ds
          LEFT JOIN daily_chat_sessions dcs ON ds.date = dcs.date
          LEFT JOIN daily_questions dq ON ds.date = dq.date
          ORDER BY ds.date ASC
        `;

        const totals = await fetchTotals(startDateIso);

        response.statusCode = 200;
        response.body = JSON.stringify({ timeSeries, totals });
        break;
      }

      // Fetches data sources and latest ingestion run per source
      case "GET /admin/data_sources": {
        try {

          const rows = await sqlConnection`
            SELECT
              ds.id::text AS ds_id,
              ds.name AS ds_name,
              ds.type::text AS ds_type,
              ds.created_at::text AS ds_created_at,
              COALESCE(ds.metadata, '{}'::jsonb) AS ds_metadata,
              ds.include_patterns AS ds_include_patterns,
              ds.exclude_patterns AS ds_exclude_patterns,

              ir.id::text AS ir_id,
              ir.data_source_id::text AS ir_data_source_id,
              ir.status::text AS ir_status,
              ir.error_message AS ir_error_message,
              ir.created_at::text AS ir_created_at,
              ir.completed_at::text AS ir_completed_at
            FROM data_sources ds
            LEFT JOIN LATERAL (
              SELECT *
              FROM ingestion_runs ir
              WHERE ir.data_source_id = ds.id
              ORDER BY ir.created_at DESC
              LIMIT 1
            ) ir ON TRUE
            ORDER BY ds.created_at DESC
          `;

          const items = rows.map((r) => {
            const data_source = {
              id: r.ds_id,
              name: r.ds_name,
              type: r.ds_type,
              created_at: r.ds_created_at,
              metadata: r.ds_metadata ?? {},
              include_patterns: r.ds_include_patterns ?? undefined,
              exclude_patterns: r.ds_exclude_patterns ?? undefined,
            };

            const latest_ingestion_run = r.ir_id
              ? {
                id: r.ir_id,
                data_source_id: r.ir_data_source_id,
                status: r.ir_status,
                error_message: r.ir_error_message ?? null,
                created_at: r.ir_created_at,
                completed_at: r.ir_completed_at ?? null,
              }
              : null;

            return { data_source, latest_ingestion_run };
          });

          response.statusCode = 200;
          response.body = JSON.stringify({ items });
          break;
        } catch (err) {
          console.error("GET /admin/data_sources error:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ message: "Internal Server Error" });
          break;
        }
      }

      // Fetch latest system settings
      case "GET /admin/system-settings": {
        const rows = await sqlConnection`
          WITH latest AS (
            SELECT *
            FROM system_settings
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1
          )
          SELECT
            latest.id,
            latest.max_messages_per_day,
            latest.min_messages_before_suggest,
            latest.max_characters_per_user_message,
            latest.max_characters_per_ai_message,
            latest.temperature,
            latest.top_p,
            latest.support_score_threshold,
            latest.scope_alignment_score_threshold,
            latest.grounded_threshold,
            latest.partially_grounded_threshold,
            latest.specialization_list,
            u.email AS updated_by_email,
            latest.updated_at
          FROM latest
          LEFT JOIN users u ON u.id = latest.updated_by
        `;

        // But keep a safe fallback to avoid crashing UI.
        const fallback = {
          max_messages_per_day: 45,
          min_messages_before_suggest: 4,
          max_characters_per_user_message: 2000,
          max_characters_per_ai_message: 5000,
          temperature: 0.2,
          top_p: 0.9,
          support_score_threshold: 0.25,
          scope_alignment_score_threshold: 0.25,
          grounded_threshold: 0.75,
          partially_grounded_threshold: 0.5,
          updated_by: null,
          updated_at: null,
        };

        response.statusCode = 200;
        response.body = JSON.stringify(rows[0] ?? fallback);
        break;
      }

      // fetches the list of users for admin to view
      case "GET /admin/users": {
        try {
          const qs = event.queryStringParameters ?? {};
          const limit = Math.min(parseInt(qs.limit ?? "50", 10), 100); // cap limit to 100
          const offset = parseInt(qs.offset ?? "0", 10);

          const rows = await sqlConnection`
            SELECT id, email, display_name, role, created_at, last_seen_at
            FROM users
            ORDER BY COALESCE(last_seen_at, created_at) DESC
            LIMIT ${limit} OFFSET ${offset}
          `;

          response.statusCode = 200;
          response.body = JSON.stringify(rows);
          break;
        } catch (err) {
          console.error("GET /admin/users error:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
          break;
        }
      }

      // fetches the chat sessions for a specific user 
      case "GET /admin/users/{userId}/chat_sessions": {
        try {
          const userId = event.pathParameters?.userId;
          if (!userId) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "User ID is required" });
            break;
          }

          const qs = event.queryStringParameters ?? {};
          const limit = parseInt(qs.limit ?? "50", 10);
          const offset = parseInt(qs.offset ?? "0", 10);

          // chat_number counts the user's sessions by creation (oldest = 1), matching the
          // "Chat N" fallback label in the student sidebar. The window runs before
          // LIMIT/OFFSET, so numbers stay correct across pages and activity re-sorting.
          const rows = await sqlConnection`
            SELECT id, user_id, title, created_at, last_active_at,
                   ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC)::int AS chat_number
            FROM chat_sessions
            WHERE user_id = ${userId}
            ORDER BY COALESCE(last_active_at, created_at) DESC
            LIMIT ${limit} OFFSET ${offset}
          `;

          response.statusCode = 200;
          response.body = JSON.stringify(rows);
          break;
        } catch (err) {
          console.error("GET /admin/users/{userId}/chat_sessions error:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
          break;
        }
      }

      // fetches the messages for a specific chat session
      case "GET /admin/chat_sessions/{sessionId}/messages": {
        try {
          const sessionId = event.pathParameters?.sessionId;
          if (!sessionId) {
            response.statusCode = 400;
            response.body = JSON.stringify({ error: "Session ID is required" });
            break;
          }

          const qs = event.queryStringParameters ?? {};
          const limit = parseInt(qs.limit ?? "200", 10);
          const offset = parseInt(qs.offset ?? "0", 10);

          const rows = await sqlConnection`
             SELECT id, chat_session_id, sender, content, sources, created_at
             FROM chat_messages
             WHERE chat_session_id = ${sessionId}
             ORDER BY created_at ASC
             LIMIT ${limit} OFFSET ${offset}
          `;

          response.statusCode = 200;
          response.body = JSON.stringify(rows);
          break;
        } catch (err) {
          console.error("GET /admin/chat_sessions/{sessionId}/messages error:", err);
          response.statusCode = 500;
          response.body = JSON.stringify({ error: "Internal Server Error" });
          break;
        }
      }

      // Update settings (patch-style)
      case "PUT /admin/system-settings": {
        let body;
        try {
          body = parseBody(event.body);
        } catch (error) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: error.message });
          break;
        }

        const validateOptionalUnitIntervalField = (obj, fieldName) => {
          const value = obj[fieldName];

          if (value === undefined) return null;

          if (!isFiniteNumber(value) || value < 0 || value > 1) {
            return `${fieldName} must be a number between 0 and 1`;
          }

          return null;
        };

        const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);
        const isFiniteInt = (v) => Number.isInteger(v) && Number.isFinite(v);

        const allowed = [
          "max_messages_per_day",
          "min_messages_before_suggest",
          "max_characters_per_user_message",
          "max_characters_per_ai_message",
          "temperature",
          "top_p",
          "support_score_threshold",
          "scope_alignment_score_threshold",
          "grounded_threshold",
          "partially_grounded_threshold",
          "specialization_list",
        ];

        const patch = {};
        for (const key of allowed) {
          if (body[key] !== undefined) patch[key] = body[key];
        }

        if (Object.keys(patch).length === 0) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: "No valid fields to update" });
          break;
        }

        // validate user
        const adminEmail = event.requestContext?.authorizer?.email;
        if (!adminEmail) {
          response.statusCode = 401;
          response.body = JSON.stringify({ error: "Unauthorized" });
          break;
        }

        if (
          patch.max_messages_per_day !== undefined &&
          (!isFiniteInt(patch.max_messages_per_day) ||
            patch.max_messages_per_day < 1 ||
            patch.max_messages_per_day > 1000)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_messages_per_day must be an integer between 1 and 1000",
          });
          break;
        }

        if (
          patch.min_messages_before_suggest !== undefined &&
          (!isFiniteInt(patch.min_messages_before_suggest) ||
            patch.min_messages_before_suggest < 0 ||
            patch.min_messages_before_suggest > 500)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "min_messages_before_suggest must be an integer between 0 and 500",
          });
          break;
        }

        if (
          patch.max_characters_per_user_message !== undefined &&
          (!isFiniteInt(patch.max_characters_per_user_message) ||
            patch.max_characters_per_user_message < 1 ||
            patch.max_characters_per_user_message > 200000)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_characters_per_user_message must be a positive integer",
          });
          break;
        }

        if (
          patch.max_characters_per_ai_message !== undefined &&
          (!isFiniteInt(patch.max_characters_per_ai_message) ||
            patch.max_characters_per_ai_message < 1 ||
            patch.max_characters_per_ai_message > 200000)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "max_characters_per_ai_message must be a positive integer",
          });
          break;
        }

        if (
          patch.temperature !== undefined &&
          (!isFiniteNumber(patch.temperature) ||
            patch.temperature < 0 ||
            patch.temperature > 2)
        ) {
          response.statusCode = 400;
          response.body = JSON.stringify({
            error: "temperature must be a number between 0 and 2",
          });
          break;
        }

        const unitIntervalFields = [
          "top_p",
          "support_score_threshold",
          "scope_alignment_score_threshold",
          "grounded_threshold",
          "partially_grounded_threshold",
        ];

        let unitIntervalError = null;

        for (const field of unitIntervalFields) {
          unitIntervalError = validateOptionalUnitIntervalField(patch, field);
          if (unitIntervalError) break;
        }

        if (unitIntervalError) {
          response.statusCode = 400;
          response.body = JSON.stringify({ error: unitIntervalError });
          break;
        }

        // get admin user ID and confirm role
        const adminRows = await sqlConnection`
          SELECT id, role
          FROM users
          WHERE email = ${adminEmail}
          LIMIT 1
        `;

        if (adminRows.length === 0) {
          response.statusCode = 404;
          response.body = JSON.stringify({ error: "Admin user not found" });
          break;
        }

        if (adminRows[0].role !== "admin") {
          response.statusCode = 403;
          response.body = JSON.stringify({ error: "User is not an admin" });
          break;
        }

        const updatedByUserId = adminRows[0].id;

        // Single UPDATE of the latest row (no â€œensure row existsâ€ step)
        const updated = await sqlConnection`
          WITH latest AS (
            SELECT id
            FROM system_settings
            ORDER BY updated_at DESC NULLS LAST
            LIMIT 1
          )
          UPDATE system_settings s
          SET
            max_messages_per_day = COALESCE(${patch.max_messages_per_day}, s.max_messages_per_day),
            min_messages_before_suggest = COALESCE(${patch.min_messages_before_suggest}, s.min_messages_before_suggest),
            max_characters_per_user_message = COALESCE(${patch.max_characters_per_user_message}, s.max_characters_per_user_message),
            max_characters_per_ai_message = COALESCE(${patch.max_characters_per_ai_message}, s.max_characters_per_ai_message),
            temperature = COALESCE(${patch.temperature}, s.temperature),
            top_p = COALESCE(${patch.top_p}, s.top_p),
            support_score_threshold = COALESCE(${patch.support_score_threshold}, s.support_score_threshold),
            scope_alignment_score_threshold = COALESCE(${patch.scope_alignment_score_threshold}, s.scope_alignment_score_threshold),
            grounded_threshold = COALESCE(${patch.grounded_threshold}, s.grounded_threshold),
            partially_grounded_threshold = COALESCE(${patch.partially_grounded_threshold}, s.partially_grounded_threshold),
            specialization_list = COALESCE(${patch.specialization_list}, s.specialization_list),
            updated_by = ${updatedByUserId},
            updated_at = NOW()
          WHERE s.id = (SELECT id FROM latest)
          RETURNING
            s.id,
            s.max_messages_per_day,
            s.min_messages_before_suggest,
            s.max_characters_per_user_message,
            s.max_characters_per_ai_message,
            s.temperature,
            s.top_p,
            s.support_score_threshold,
            s.scope_alignment_score_threshold,
            s.grounded_threshold,
            s.partially_grounded_threshold,
            s.specialization_list,
            s.updated_by,
            s.updated_at
        `;

        if (updated.length === 0) {
          // Should never happen because we seed system_settings
          response.statusCode = 500;
          response.body = JSON.stringify({
            error: "system_settings row not found (seed may not have run)",
          });
          break;
        }

        response.statusCode = 200;
        response.body = JSON.stringify(updated[0]);
        break;
      }

        break;

      // Handle unsupported routes
      default:
        throw new Error(`Unsupported route: "${pathData}"`);
    }
  } catch (error) {
    // Handle specific PostgreSQL error codes
    if (error.code === "23505") {
      // Unique constraint violation (duplicate email)
      response.statusCode = 409; // Conflict
      response.body = JSON.stringify({ error: "Email already exists" });
    } else if (error.code === "23502") {
      // Not null constraint violation
      response.statusCode = 400; // Bad Request
      response.body = JSON.stringify({ error: "Required field is missing" });
    } else {
      // Generic server error for other exceptions
      handleError(error, response);
    }
  }

  auditLog(event, response, { privileged: true, details: auditDetails });
  console.log({ statusCode: response.statusCode });

  // Return HTTP response to API Gateway, which forwards it to the client
  return response;
};
