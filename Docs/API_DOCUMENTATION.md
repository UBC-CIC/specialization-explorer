# Specialization Explorer REST API Documentation

This document provides comprehensive documentation for the Specialization Explorer REST API, including endpoint descriptions, authentication requirements, request/response formats, and example usage.

## Table of Contents

- [Authentication](#authentication)
- [Base URL](#base-url)
- [Common Headers](#common-headers)
- [Error Responses](#error-responses)
- [Public Endpoints](#public-endpoints)
- [User Endpoints](#user-endpoints)
- [Chat Session Endpoints](#chat-session-endpoints)
- [System Message Endpoints](#system-message-endpoints)
- [Admin Endpoints](#admin-endpoints)
- [Security Considerations](#security-considerations)
- [WebSocket API](#websocket-api)
- [Troubleshooting](#troubleshooting)

## Authentication

The API has two kinds of callers, each with its own token in the `Authorization` header:

- **Students** are anonymous. They use a short-lived HS256 token from `GET /user/publicToken`, sent as `Authorization: Bearer <token>`.
- **Administrators** sign in with AWS Cognito (SRP and TOTP MFA) and send their Cognito ID token as `Authorization: <id-token>`.

---

### Obtaining a Student Token

1. Call `GET /user/publicToken` with no `Authorization` header. The result is an **anonymous** token, which can only call `POST /user`, `GET /system_message/{message_type}` and `GET /system-settings/*`.
2. Call `POST /user` with the anonymous token. The response contains `userId` and a random `userKey`. Store both; the server keeps only a SHA-256 hash of the key.
3. Call `GET /user/publicToken` with `Authorization: UserKey <userId>:<userKey>`. The result is a token **bound to the user** (`sub` = `userId`), which can call every user-tier endpoint for that user.

Tokens expire after 15 minutes; request a new one with the same `UserKey` header. Rotate the key with `POST /user/{user_id}/key`.

### Obtaining an Administrator Token

```javascript
// JavaScript example using AWS Amplify
import { fetchAuthSession } from "aws-amplify/auth";

const session = await fetchAuthSession();
const token = session.tokens?.idToken?.toString();
```

---

### Authorization Levels

The API uses two custom Lambda authorizers:

- **adminAuthorizer**: Verifies a Cognito ID token whose user is in the `admin` group. Required for all `/admin/*` endpoints. It passes the caller's verified `email` to the handlers, which use it (never the request body) to identify the administrator.
- **userAuthorizer**: Verifies a student token. Required for the user, chat session, system message and `/system-settings/*` endpoints. It passes only the bound `userId`, and every handler checks that the requested user or chat session belongs to it. Student tokens are always denied on `/admin/*`.

`GET /user/publicToken` requires no authentication.

## Base URL

```
https://{api-id}.execute-api.{region}.amazonaws.com/prod
```

Replace `{api-id}` and `{region}` with your API Gateway deployment values (found in the AWS Console or CDK outputs).

## Common Headers

```
Authorization: Bearer {student-token}      # user-tier endpoints
Authorization: {cognito-id-token}          # /admin/* endpoints
Content-Type: application/json
```

## Error Responses

### Standard Error Format

```json
{ "error": "Error message description" }
```

### HTTP Status Codes

- `200` - Success
- `201` - Created
- `204` - No Content
- `400` - Bad Request
- `401` - Unauthorized (missing or invalid token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `409` - Conflict (e.g. duplicate resource)
- `429` - Too Many Requests (per-user message rate limit or daily message quota)
- `500` - Internal Server Error
- `503` - Service Unavailable (the rate limit could not be checked)

Requests blocked by AWS WAF rate rules receive `403` from WAF.

---

# Public Endpoints

These endpoints require no authentication.

## Get Public Token

Returns a 15-minute HS256 token for students. Without a header the token is anonymous; with a valid `UserKey` header it is bound to that user.

**Endpoint:** `GET /user/publicToken`

**Headers (optional):**

```
Authorization: UserKey {userId}:{userKey}
```

**Response:**

```json
{ "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." }
```

Returns `401` with `{ "error": "Invalid user credentials" }` if the `UserKey` header does not match the stored key hash (including users whose key was revoked).

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/publicToken" \
  -H "Authorization: UserKey uuid:userKey"
```

---

# User Endpoints

These endpoints require a student token (`userAuthorizer`). `POST /user` accepts an anonymous token; the others need a token bound to the `user_id` in the path, and return `401` for an anonymous token and `403` for another user's ID.

## Create User

Create a new anonymous student record and its user key.

**Endpoint:** `POST /user`

**Request Body:**

```json
{
  "email": "student@example.com",
  "display_name": "Jane Doe"
}
```

**Parameters:**

- `email` (string, optional): Unverified contact email, stored as `metadata.contact_email` (never as `users.email`)
- `display_name` (string, optional): Display name, at most 100 characters

The role is always `student`; a `role` field in the body is ignored.

**Response:**

```json
{
  "userId": "uuid",
  "userKey": "64 hex characters",
  "email": "student@example.com",
  "display_name": "Jane Doe",
  "role": "student",
  "created_at": "2024-01-15T10:30:00.000Z",
  "last_seen_at": "2024-01-15T10:30:00.000Z",
  "metadata": { "contact_email": "student@example.com" }
}
```

`userKey` is returned only here and by key rotation. Exchange it at `GET /user/publicToken` for a token bound to the user.

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user" \
  -H "Authorization: Bearer {anonymous-token}" \
  -H "Content-Type: application/json" \
  -d '{}'
```

---

## Get User

Retrieve the calling user. Also updates `last_seen_at`.

**Endpoint:** `GET /user/{user_id}`

**Path Parameters:**

- `user_id` (uuid, required): The caller's UUID

**Response:** `200 OK` with `id`, `email` (the contact email, if any), `display_name`, `role`, `created_at`, `last_seen_at`, `messages_sent`, `messages_window_started_at` and `metadata`

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/uuid" \
  -H "Authorization: Bearer {user-token}"
```

---

## Rotate User Key

Replace the user's key. The caller must present the current key in addition to a token bound to the user. The previous key stops working immediately.

**Endpoint:** `POST /user/{user_id}/key`

**Request Body:**

```json
{ "currentKey": "current user key" }
```

**Response:**

```json
{ "userKey": "new user key" }
```

Returns `401` if `currentKey` does not match, and `409` if another rotation changed the key at the same time.

---

## Update User Email

Save a contact email for an anonymous user. The address is unverified and is stored as metadata.contact_email, not as the account email.

**Endpoint:** `PUT /user/{user_id}`

**Path Parameters:**

- `user_id` (uuid, required): The user's UUID

**Request Body:**

```json
{ "email": "newemail@example.com" }
```

**Response:** `200 OK`

**Example (cURL):**

```bash
curl -X PUT "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/uuid" \
  -H "Authorization: Bearer {user-token}" \
  -H "Content-Type: application/json" \
  -d '{"email": "newemail@example.com"}'
```

---

## Get Chat History

Get paginated message history for a chat session owned by a user.

**Endpoint:** `GET /user/{user_id}/chat_sessions/{chat_session_id}/chat_history`

**Path Parameters:**

- `user_id` (uuid, required): Owner's UUID
- `chat_session_id` (uuid, required): Chat session UUID

**Query Parameters:**

- `limit` (integer, optional): Messages to return, max 1000 (default: 200)
- `offset` (integer, optional): Messages to skip (default: 0)

**Response:**

```json
{
  "chat_session_id": "uuid",
  "user_id": "uuid",
  "messages": [
    {
      "id": "uuid",
      "chat_session_id": "uuid",
      "sender": "user",
      "content": "What programs are available?",
      "sources": null,
      "warning": null,
      "created_at": "2024-01-20T14:22:00.000Z"
    }
  ],
  "pagination": {
    "limit": 200,
    "offset": 0,
    "total": 42,
    "hasMore": false
  }
}
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/user/uuid/chat_sessions/uuid/chat_history?limit=50&offset=0" \
  -H "Authorization: Bearer {user-token}"
```

---

# Chat Session Endpoints

These endpoints require a student token bound to a user (`userAuthorizer`). The owner is always the user in the token; an anonymous token gets `401`, and a session owned by another user gets `403`.

## Create Chat Session

Create a new chat session for the calling user.

**Endpoint:** `POST /chat_sessions`

**Request Body:**

```json
{
  "title": "My first chat",
  "metadata": {}
}
```

**Parameters:**

- `title` (string, optional): Chat session title
- `metadata` (object, optional): Arbitrary metadata (size-limited)

**Response:** `201 Created`

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "title": "My first chat",
  "created_at": "2024-01-15T10:30:00.000Z",
  "last_active_at": "2024-01-15T10:30:00.000Z",
  "metadata": {}
}
```

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions" \
  -H "Authorization: Bearer {user-token}" \
  -H "Content-Type: application/json" \
  -d '{"title": "My first chat"}'
```

---

## Get Chat Sessions for User

Get all chat sessions belonging to the calling user, newest first.

**Endpoint:** `GET /chat_sessions/user/{user_id}`

**Path Parameters:**

- `user_id` (uuid, required): The caller's UUID

**Response:** `200 OK` with list of chat session objects

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions/user/uuid" \
  -H "Authorization: Bearer {user-token}"
```

---

## Rename Chat Session

Rename a chat session. Only the owning user may update.

**Endpoint:** `PUT /chat_sessions/{chat_session_id}`

**Path Parameters:**

- `chat_session_id` (uuid, required): Chat session UUID

**Request Body:**

```json
{ "title": "Renamed session" }
```

**Response:** `200 OK` with the updated chat session object

**Example (cURL):**

```bash
curl -X PUT "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions/uuid" \
  -H "Authorization: Bearer {user-token}" \
  -H "Content-Type: application/json" \
  -d '{"title": "Renamed session"}'
```

---

## Delete Chat Session

Delete a chat session and its messages. Only the owning user may delete.

**Endpoint:** `DELETE /chat_sessions/{chat_session_id}`

**Path Parameters:**

- `chat_session_id` (uuid, required): Chat session UUID

**Response:** `204 No Content`

**Example (cURL):**

```bash
curl -X DELETE "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions/uuid" \
  -H "Authorization: Bearer {user-token}"
```

---

## Generate Text Response

Generate an AI response for a message in a chat session, without streaming. The chat page uses the [WebSocket API](#websocket-api) and falls back to this endpoint when streaming is not available. REST replies are capped at about 1,200 output tokens so they finish within the API Gateway timeout.

**Endpoint:** `POST /chat_sessions/{chat_session_id}/text_generation`

**Path Parameters:**

- `chat_session_id` (uuid, required): Chat session UUID

**Request Body:**

```json
{
  "query": "What specializations are available in Computer Science?",
  "message_id": "uuid"
}
```

**Parameters:**

- `query` (string, required): The user's message. Limited to the `max_characters_per_user_message` setting; NUL characters are rejected.
- `message_id` (uuid, optional): Client-generated id saved as the user message's id. A request that repeats an id that is already saved returns `409` with `"error": "DUPLICATE_MESSAGE"` and is not answered again.
- `is_intro_message` (boolean, optional): Set by the app for its fixed opening prompt. Ignored unless the query matches that prompt exactly.

**Response:**

```json
{
  "response": "There are several specializations available...",
  "sources": [],
  "warning": null,
  "chat_session_id": "uuid",
  "token_usage": {}
}
```

`warning` holds the partial or full hallucination warning when the answer is not well grounded. The endpoint returns `429` with `"error": "RATE_LIMITED"` above 10 messages a minute per user, and `429` with `"error": "TOKEN_LIMIT_EXCEEDED"` when the daily message quota (`max_messages_per_day`) is used up.

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/chat_sessions/uuid/text_generation" \
  -H "Authorization: Bearer {user-token}" \
  -H "Content-Type: application/json" \
  -d '{"query": "What specializations are available?"}'
```

---

# System Message Endpoints

These endpoints require a student token (`userAuthorizer`); an anonymous token is enough.

## Get Active System Message

Get the currently active version of a UI system message by type. Messages that shape the prompt are only available through the admin routes.

**Endpoint:** `GET /system_message/{message_type}`

**Path Parameters:**

- `message_type` (string, required): `disclaimer` or `welcome_message`. Any other type returns `400`.

**Response:**

```json
{
  "id": "uuid",
  "type": "disclaimer",
  "message": "AI can make mistakes. Check important info.",
  "version": 2,
  "created_at": "2024-01-15T10:30:00.000Z"
}
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/system_message/disclaimer" \
  -H "Authorization: Bearer {user-token}"
```

---

## Get Maximum User Message Length

Return the current `max_characters_per_user_message` setting, used by the chat input.

**Endpoint:** `GET /system-settings/max-characters-per-user-message`

**Response:**

```json
{ "max_characters_per_user_message": 2000 }
```

---

# Admin Endpoints

All admin endpoints require a Cognito ID token for a member of the `admin` group (`adminAuthorizer`). Endpoints that change data also require the caller's e-mail to exist in `users` with the `admin` role, which `POST /admin/promote_user` records at sign-in. The caller is always identified from the token; no endpoint takes the administrator's e-mail from the request. Every admin request is written to the audit log.

## User Management

### List Users

Get a paginated list of all users, most recently active first.

**Endpoint:** `GET /admin/users`

**Query Parameters:**

- `limit` (integer, optional): Number of users to return (default: 50, max: 100)
- `offset` (integer, optional): Number of users to skip (default: 0)

**Response:** `200 OK` with a list of `{ id, email, display_name, role, created_at, last_seen_at, user_number }`, where `user_number` numbers users by creation order (oldest = 1)

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/users?limit=50&offset=0" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Register Calling Administrator

Records the calling administrator in the users table with the `admin` role. The user is identified by the verified e-mail in the caller's Cognito ID token; the request takes no body, and no other user can be targeted. Each call is written to the audit log with the previous and new role.

**Endpoint:** `POST /admin/promote_user`

**Response:** `200 OK` with the caller's user record

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/promote_user" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Get User Chat Sessions

Get all chat sessions for a specific user.

**Endpoint:** `GET /admin/users/{userId}/chat_sessions`

**Path Parameters:**

- `userId` (uuid, required): The user's UUID

**Query Parameters:**

- `limit` (integer, optional): Default 50
- `offset` (integer, optional): Default 0

**Response:** `200 OK` with a list of `{ id, user_id, title, created_at, last_active_at, chat_number }`, most recently active first, where `chat_number` numbers the user's sessions by creation order (oldest = 1)

---

### Get Chat Session Messages

Get all messages for a specific chat session.

**Endpoint:** `GET /admin/chat_sessions/{sessionId}/messages`

**Path Parameters:**

- `sessionId` (uuid, required): Chat session UUID

**Query Parameters:**

- `limit` (integer, optional): Default 200
- `offset` (integer, optional): Default 0

**Response:** `200 OK` with a list of `{ id, chat_session_id, sender, content, sources, created_at }` in chronological order

---

## Knowledge Base / Data Sources

### List Data Sources

List all data sources with their latest ingestion run status.

**Endpoint:** `GET /admin/data_sources`

**Response:**

```json
{
  "items": [
    {
      "data_source": {
        "id": "uuid",
        "name": "https://example.com",
        "type": "website",
        "created_at": "2024-01-15T10:30:00.000Z",
        "metadata": {},
        "include_patterns": ["..."],
        "exclude_patterns": ["..."]
      },
      "latest_ingestion_run": {
        "id": "uuid",
        "data_source_id": "uuid",
        "status": "completed",
        "error_message": null,
        "created_at": "2024-01-15T10:30:00.000Z",
        "completed_at": "2024-01-15T10:35:00.000Z"
      }
    }
  ]
}
```

`include_patterns` and `exclude_patterns` are omitted when the source has none, and `latest_ingestion_run` is `null` for a source with no runs. Sources are listed newest first.

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/data_sources" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Stage Data Sources

Stage a new data source (website, CSV or Markdown) for the next sync. Files must first be uploaded with a presigned POST; staging copies them from `quarantine/` to `uploads/`, the only prefix Bedrock reads.

**Endpoint:** `POST /admin/data_sources`

**Request Body (website):**

```json
{
  "type": "website",
  "name": "https://example.com/science/",
  "include_patterns": ["^https://example\\.com/science/.*"],
  "exclude_patterns": [".*\\.pdf$"]
}
```

**Request Body (CSV):**

```json
{
  "type": "csv",
  "csv_file_name": "data.csv",
  "csv_s3_bucket": "my-kb-bucket",
  "csv_s3_key": "quarantine/csv/1712345678_data.csv",
  "metadata_file_name": "data.csv.metadata.json",
  "metadata_s3_bucket": "my-kb-bucket",
  "metadata_s3_key": "quarantine/json/1712345678_data.csv.metadata.json"
}
```

**Parameters:**

- `type` (string, required): `website`, `csv` or `markdown`
- `name` (string, required for websites): `http(s)` URL, at most 2,048 characters
- `include_patterns` / `exclude_patterns` (array, optional): Up to 20 crawler regular expressions each, at most 500 characters; an include pattern may not match every URL
- `csv_file_name`, `csv_s3_bucket`, `csv_s3_key` (string): Required for CSV sources
- `markdown_file_name`, `markdown_s3_bucket`, `markdown_s3_key` (string): Required for Markdown sources
- `metadata_file_name`, `metadata_s3_bucket`, `metadata_s3_key` (string, required for files): The companion metadata JSON, named `{primary_file_name}.metadata.json`

CSV files over 900,000 characters are split into parts at staging. A Markdown file, or a single CSV row, over that size is rejected with `400`. A website or file that is already staged returns `409`.

**Response (website):**

```json
{
  "message": "Website staged successfully.",
  "action": "staged_website",
  "type": "website",
  "created_by": "admin@example.com",
  "staged_data_source_ids": ["uuid"],
  "pending_ingestion_run_ids": ["uuid"]
}
```

---

### Sync Data Sources

Queue all pending data sources and start the first ingestion phase (files first, then websites). No request body is needed.

**Endpoint:** `POST /admin/data_sources/sync`

**Response:**

```json
{
  "message": "Pending data sources queued and S3 sync started.",
  "action": "queued_and_started_s3_sync",
  "sync_session_id": "hex id",
  "queued_count": 3,
  "phase_started": "s3",
  "details": {}
}
```

`phase_started` is `s3` or `website` (with `action` `queued_and_started_website_sync`). If no phase can start, the endpoint returns `409` with `error`, `queued_count`, `s3_result` and `website_result`. See the [Knowledge Base Documentation](./KNOWLEDGE_BASE_DOCUMENTATION.md#sync-sessions) for details.

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/data_sources/sync" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Generate Presigned Upload URL

Generate an S3 presigned POST for uploading a single knowledge base file. Upload with a `multipart/form-data` `POST` to `presignedUrl` containing every entry of `fields` followed by the file as the last field, named `file`. S3 rejects objects larger than 50 MB.

**Endpoint:** `GET /admin/generate-presigned-url`

**Query Parameters:**

- `file_name` (string, required): Name of the file to upload
- `content_type` (string, optional): MIME type (default: `application/octet-stream`)

**Response:**

```json
{
  "presignedUrl": "https://bucket.s3.region.amazonaws.com/",
  "fields": { "Content-Type": "text/csv", "key": "...", "policy": "...", "x-amz-signature": "..." },
  "key": "quarantine/csv/1712345678_data.csv",
  "bucket": "my-kb-bucket"
}
```

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/generate-presigned-url?file_name=data.csv&content_type=text/csv" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Generate Presigned Upload URLs (Batch)

Generate presigned S3 upload URLs for multiple files in a single request. Use this for zip uploads to avoid hitting WAF rate limits from calling the single-file endpoint in a loop.

**Endpoint:** `POST /admin/generate-presigned-urls/batch`

**Request Body:**

```json
{
  "files": [
    { "file_name": "alumni.csv", "content_type": "text/csv" },
    { "file_name": "alumni.csv.metadata.json", "content_type": "application/json" },
    { "file_name": "courses.md", "content_type": "text/markdown" },
    { "file_name": "courses.md.metadata.json", "content_type": "application/json" }
  ]
}
```

**Parameters:**

- `files` (array, required): Up to 200 file descriptors
  - `file_name` (string, required): File name
  - `content_type` (string, optional): MIME type (default: `application/octet-stream`)

**Response:**

```json
{
  "presigned_urls": [
    {
      "file_name": "alumni.csv",
      "presigned_url": "https://bucket.s3.region.amazonaws.com/",
      "fields": { "Content-Type": "text/csv", "key": "...", "policy": "...", "x-amz-signature": "..." },
      "key": "quarantine/csv/1712345678_alumni.csv",
      "bucket": "my-kb-bucket"
    }
  ]
}
```

**Notes:**
- Presigned URLs expire after 10 minutes
- Each upload is a `multipart/form-data` `POST` with the returned `fields` followed by the file as the last field (`file`); S3 rejects objects larger than 50 MB
- S3 uploads go directly to S3 and do not pass through WAF
- Supported content types: `text/csv`, `text/markdown`, `application/json`, `text/json`, `application/octet-stream`

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/generate-presigned-urls/batch" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"files": [{"file_name": "alumni.csv", "content_type": "text/csv"}]}'
```

---

### Stage Data Sources (Batch)

Stage multiple CSV/Markdown + metadata JSON file pairs in a single request. Designed for zip uploads. Duplicates are silently skipped.

**Endpoint:** `POST /admin/data_sources/batch`

**Request Body:**

```json
{
  "items": [
    {
      "type": "csv",
      "primary_file_name": "alumni.csv",
      "primary_s3_bucket": "my-kb-bucket",
      "primary_s3_key": "quarantine/csv/1712345678_alumni.csv",
      "metadata_file_name": "alumni.csv.metadata.json",
      "metadata_s3_bucket": "my-kb-bucket",
      "metadata_s3_key": "quarantine/json/1712345678_alumni.csv.metadata.json"
    }
  ]
}
```

**Parameters:**

- `items` (array, required): Up to 100 file pairs
  - `type` (string, required): `csv` or `markdown`
  - `primary_file_name` (string, required): CSV or Markdown file name
  - `primary_s3_bucket` / `primary_s3_key` (string, required): S3 location of the primary file
  - `metadata_file_name` (string, required): Must match `{primary_file_name}.metadata.json`
  - `metadata_s3_bucket` / `metadata_s3_key` (string, required): S3 location of the metadata file

**Response:**

```json
{
  "message": "Batch staging complete. 2 staged, 1 skipped, 0 failed.",
  "staged_count": 2,
  "skipped_count": 1,
  "error_count": 0,
  "staged": [{ "index": 0, "file": "alumni.csv", "data_source_ids": ["uuid", "uuid"] }],
  "skipped": [{ "index": 1, "file": "courses.csv", "reason": "already_staged" }],
  "errors": []
}
```

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/data_sources/batch" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"items": [...]}'
```

---

## System Settings

### Get System Settings

Retrieve the latest system configuration settings.

**Endpoint:** `GET /admin/system-settings`

**Response:**

```json
{
  "id": "uuid",
  "max_messages_per_day": 45,
  "min_messages_before_suggest": 4,
  "max_characters_per_user_message": 2000,
  "max_characters_per_ai_message": 5000,
  "temperature": 0.2,
  "top_p": 0.9,
  "support_score_threshold": 0.25,
  "scope_alignment_score_threshold": 0.25,
  "grounded_threshold": 0.75,
  "partially_grounded_threshold": 0.5,
  "specialization_list": ["Major in Computer Science", "..."],
  "updated_by_email": "admin@example.com",
  "updated_at": "2024-01-15T10:30:00.000Z"
}
```

The values shown are the seeded defaults.

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-settings" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Update System Settings

Update one or more system configuration settings (partial update).

**Endpoint:** `PUT /admin/system-settings`

**Request Body:**

```json
{
  "max_messages_per_day": 50,
  "temperature": 0.8,
  "top_p": 0.95
}
```

**Parameters (all optional):**

- `max_messages_per_day` (integer, 1–1000): Max messages per user per day
- `min_messages_before_suggest` (integer, 0–500): Messages before AI suggestions appear
- `max_characters_per_user_message` (integer, 1–200000): Max user message length
- `max_characters_per_ai_message` (integer, 1–200000): Max AI response length
- `temperature` (number, 0.0–2.0): LLM temperature
- `top_p` (number, 0.0–1.0): LLM top-p
- `support_score_threshold` (number, 0.0–1.0): Threshold for support scoring
- `scope_alignment_score_threshold` (number, 0.0–1.0): Threshold for scope alignment
- `grounded_threshold` (number, 0.0–1.0): Threshold for grounded responses
- `partially_grounded_threshold` (number, 0.0–1.0): Threshold for partially grounded responses
- `specialization_list` (array of strings): At most 200 non-empty entries of at most 200 characters, without `<` or `>`

Out-of-range values return `400`. The changed fields are recorded in the audit log.

**Response:** `200 OK` with updated settings object (including `updated_by`, the admin's user ID)

**Example (cURL):**

```bash
curl -X PUT "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-settings" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"max_messages_per_day": 50, "temperature": 0.8}'
```

---

## Analytics

### Get Analytics

Get usage analytics time series and totals.

**Endpoint:** `GET /admin/analytics`

**Query Parameters:**

- `timeRange` (string, optional): `<N>d`, `<N>m` (30-day months) or `<N>y`, e.g. `7d`, `90d`, `6m`. Capped at 365 days. Without `timeRange`, only all-time `totals` are returned.

**Response:**

```json
{
  "timeSeries": [
    {
      "date": "Jan 20",
      "users": 12,
      "questions": 45,
      "chat_sessions": 18
    }
  ],
  "totals": {
    "users": 120,
    "chat_sessions": 450,
    "messages": 3200,
    "questions": 1800
  }
}
```

`users` counts distinct users with a chat session; `questions` counts user messages.

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/analytics?timeRange=30d" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## System Messages

### Get All System Messages

Get all system message types with their full version history. Active version is listed first.

**Endpoint:** `GET /admin/system-messages`

**Response:**

```json
{
  "disclaimer": [
    {
      "id": "uuid",
      "type": "disclaimer",
      "content": "AI can make mistakes. Check important info.",
      "character_limit": 400,
      "version": 2,
      "is_active": true,
      "affects_text_generation": false,
      "created_by": "uuid",
      "created_by_email": "admin@example.com",
      "created_at": "2024-01-15T10:30:00.000Z"
    }
  ],
  "welcome_message": [...]
}
```

**System message types:**

| Type | Description |
|---|---|
| `disclaimer` | Disclaimer shown to users |
| `guardrails` | Content guardrail instructions |
| `system_role` | AI system role definition |
| `system_checklist` | AI checklist instructions |
| `system_instructions` | General AI instructions |
| `initial_prompt` | Initial conversation prompt |
| `detective_phase_prompt` | Detective phase AI prompt |
| `suggestion_phase_prompt` | Suggestion phase AI prompt |
| `welcome_message` | Welcome message shown on chat |
| `partial_hallucination_warning` | Warning for partial hallucinations |
| `full_hallucination_warning` | Warning for full hallucinations |

**Example (cURL):**

```bash
curl -X GET "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-messages" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Create System Message Version

Create a new version of a system message and set it as active.

**Endpoint:** `POST /admin/system-messages/{system_message_type}`

**Path Parameters:**

- `system_message_type` (string, required): One of the types listed above

**Request Body:**

```json
{
  "content": "AI can make mistakes. Always verify important information."
}
```

**Parameters:**

- `content` (string, required): The full message content, at most the type's `character_limit` (otherwise `400` with `character_limit` and `content_length`)

**Response:** `200 OK` with the newly created version object (is_active: true)

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-messages/disclaimer" \
  -H "Authorization: eyJraWQiOiJ..." \
  -H "Content-Type: application/json" \
  -d '{"content": "AI can make mistakes."}'
```

---

### Activate System Message Version

Set a specific version as the active version for its type.

**Endpoint:** `POST /admin/system-messages/{system_message_type}/{version_id}/activate`

**Path Parameters:**

- `system_message_type` (string, required): Message type
- `version_id` (uuid, required): UUID of the version to activate

No request body is needed.

**Response:**

```json
{
  "success": true,
  "status": "activated",
  "activated": { "id": "uuid", "type": "disclaimer", "version": 2, "is_active": true, "..." : "..." },
  "previous_active": { "id": "uuid", "version": 1 }
}
```

If the version is already active, `status` is `already_active` and `previous_active` is `null`.

**Example (cURL):**

```bash
curl -X POST "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-messages/disclaimer/uuid/activate" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

### Delete System Message Version

Delete a non-active system message version. Active versions cannot be deleted.

**Endpoint:** `DELETE /admin/system-messages/{system_message_type}/{version_id}`

**Path Parameters:**

- `system_message_type` (string, required): Message type
- `version_id` (uuid, required): UUID of the version to delete

No request body is needed. Deleting the active version returns `400`.

**Response:**

```json
{
  "success": true,
  "deleted": { "id": "uuid", "type": "disclaimer", "version": 1 }
}
```

**Example (cURL):**

```bash
curl -X DELETE "https://{api-id}.execute-api.{region}.amazonaws.com/prod/admin/system-messages/disclaimer/uuid" \
  -H "Authorization: eyJraWQiOiJ..."
```

---

## Security Considerations

### Token Management

- Cognito ID tokens expire after 1 hour — use refresh tokens to obtain new ones
- Student tokens expire after 15 minutes; request a new one from `/user/publicToken`
- Never expose tokens in logs or client-side code
- Use AWS Amplify for automatic secure token storage and refresh

### CORS

Responses carry `Access-Control-Allow-Origin` only when the request's `Origin` is in the `/<STACK-PREFIX>-Api/API/AllowedOrigins` SSM parameter (set to the Amplify URL on deployment). The other headers are:

- `Access-Control-Allow-Methods: OPTIONS,GET,PUT,POST,DELETE`
- `Access-Control-Allow-Headers: Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token`

### Input Validation

- API Gateway validates required request parameters (the default `params-only` validator); request bodies are not schema-validated by the gateway
- Handlers validate path IDs (UUID format), string lengths, enums and numeric ranges before using them
- All database access uses parameterized queries
- The raw OpenAPI/Swagger definition is located at `cdk/OpenAPI_Swagger_Definition.yaml`

### Rate Limits

- WAF (per IP, per 5 minutes): 2,000 requests overall, 1,000 to `/chat_sessions*`, 20 `POST /user`, 100 `/user/publicToken`
- API Gateway stage throttle: 100 requests per second (burst 200); `GET /user/publicToken` 50 per second (burst 100)
- Per user: 10 text generation messages a minute (REST and WebSocket combined), and the daily `max_messages_per_day` quota

## WebSocket API

For real-time streaming AI responses, use the WebSocket API instead of the REST text generation endpoint.

**WebSocket URL:**

```
wss://{websocket-api-id}.execute-api.{region}.amazonaws.com/prod?token={user-token}
```

The WebSocket URL is available as a CDK output after deployment. The `$connect` authorizer accepts only a student token bound to a user, passed in the `token` query parameter; every message on the connection acts as that user.

**Client messages:**

```json
{ "action": "generate_text", "chat_session_id": "uuid", "query": "...", "message_id": "uuid" }
```

```json
{ "action": "warmup" }
```

`message_id` is optional and works as in the REST endpoint. `warmup` starts the text generation function ahead of the first message. Each user may send 10 `generate_text` and 2 `warmup` messages a minute, across all connections.

**Server messages:**

| `type` | Fields | Meaning |
| --- | --- | --- |
| `start` | | Generation has started |
| `chunk` | `content` | Next piece of the reply |
| `complete` | `sources`, `warning`, `chat_session_id`, `token_usage` | Reply finished |
| `error` | `error`, `message` | `RATE_LIMITED`, `MESSAGE_NOT_SENT`, `DUPLICATE_MESSAGE`, `TOKEN_LIMIT_EXCEEDED` or `GENERATION_FAILED` |

## Troubleshooting

### 401 Unauthorized

- Verify the `Authorization` header is present: `Bearer {student-token}` for user-tier endpoints, the Cognito ID token for `/admin/*`
- Check the token hasn't expired (15 minutes for student tokens, 1 hour for Cognito ID tokens)
- User-tier endpoints other than `POST /user` return `401` for an anonymous token; get a token with the `UserKey` header

For administrators, refresh the Cognito session:

```javascript
import { fetchAuthSession } from "aws-amplify/auth";
const session = await fetchAuthSession({ forceRefresh: true });
const token = session.tokens?.idToken?.toString();
```

### 403 Forbidden

- Verify the user is in the Cognito `admin` group for `/admin/*` endpoints, and has signed in through `/admin/login` so `POST /admin/promote_user` has recorded the `admin` role
- For user-tier endpoints, check that the `user_id` or chat session belongs to the user in the token
- WAF rate rules also return `403` when an IP exceeds its limit

### 404 Not Found

- Verify the resource ID is correct
- Check the user owns the resource (for user-scoped endpoints)

### 409 Conflict

- A resource with the same identifier already exists (e.g. a data source that is already staged, or a repeated `message_id`)

### 500 Internal Server Error

- Check CloudWatch logs for the relevant Lambda function for detailed error information
- Verify the request body matches the expected schema

---

**API Version:** 1.0.0  
**OpenAPI Spec:** `cdk/OpenAPI_Swagger_Definition.yaml`
