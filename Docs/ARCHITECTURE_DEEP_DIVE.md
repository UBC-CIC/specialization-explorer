# Architecture Deep Dive

## Architecture

![Architecture Diagram](./media/architecture-diagram.png)

1. The frontend is served by Amplify Hosting through Amazon CloudFront, which AWS Shield Standard protects automatically. Requests to the REST API pass through AWS WAF (managed rule sets and per-IP rate limits). WAF cannot be attached to the WebSocket API, so its messages are rate limited per user in the default route handler.

2. Users access the application through a React frontend hosted on AWS Amplify. AWS Cognito handles user authentication for admins (with required TOTP MFA), ensuring that only authorized administrators are able to access admin analytics and features. Students do not sign in, so they stay anonymous: the browser keeps a random user ID and user key and exchanges them for a 15-minute token bound to that user.

3. The frontend communicates with backend services via REST API (API Gateway → Lambda) for CRUD operations. Access is controlled using IAM roles and policies to ensure secure access to the services required to retain functionality. The WebSocket endpoint is used to stream live responses generated from the LLM to the user's frontend.

4. Application data is managed through AWS Lambda functions and stored in Amazon RDS through RDS Proxy, allowing the system to securely handle database requests while improving connection management and performance.

5. Amazon RDS acts as the main SQL database for the platform, storing the structured application data required to support the user experience.

6. The database contains LLM settings and prompts that guide it on how to respond to a user. It also contains the chat history needed for by LLM to continue the conversation.

7. The API also connects to a text generation Lambda function, which is responsible for preparing and sending user prompts into the generative AI workflow.

8. Amazon Bedrock processes the user query together with the retrieved context to generate a grounded response for the user based on the ingested knowledge base content.

9. Appointed administrators are able to upload files into Amazon S3 using pre-signed URLs, or provide website sources for ingestion into the knowledge base.

10. The content within the files and websites are stored as embeddings in Amazon OpenSearch Serverless. The system uses Retrieval-Augmented Generation (RAG) by searching the stored content for the most relevant context before generating a response.

The Bedrock Knowledge Base, its data sources and the OpenSearch Serverless collection are created by the KnowledgeBase CDK stack through custom resources. AWS CodePipeline and AWS CodeBuild build the container image for the vector index manager Lambda, which creates the vector index in the collection, and push it to Amazon ECR after a vulnerability scan.

### Why Amazon Bedrock Knowledge Bases?

Bedrock Knowledge Bases handles the full RAG pipeline out of the box — ingestion, chunking, embedding, and semantic retrieval — without requiring any custom tooling. A few reasons this was the right choice here:

- **Multi-source ingestion** — it natively supports websites, S3 files (CSV, JSON, PDF, etc.), and more, without needing separate ingestion scripts per source type. This is what makes the tool adaptable to different domains beyond UBC Science.
- **Managed embeddings** — there's no need to manage embedding models or vector stores manually. Bedrock handles the conversion of content into vector representations and stores them in OpenSearch Serverless automatically.
- **Semantic retrieval** — queries are matched against the knowledge base using semantic similarity rather than keyword search, meaning the AI retrieves contextually relevant content even when the wording doesn't match exactly.
- **Always up to date** — adding or updating a data source and triggering a sync is all it takes to refresh the knowledge base. No redeployment needed.

### Database Schema

![Database Diagram](./media/db-diagram.png)

### RDS PostgreSQL Tables

### Core Tables

#### `users` table

| Column Name                  | Description                                                |
| --------------------------- | ---------------------------------------------------------- |
| `id`                        | UUID, primary key                                          |
| `email`                     | Unique email of the user                                   |
| `display_name`              | Display name of the user                                   |
| `role`                      | User role (`student`, `admin`)                             |
| `created_at`                | Timestamp of account creation                              |
| `last_seen_at`              | Timestamp of the user's last activity                      |
| `messages_sent`             | Total number of messages sent by the user                  |
| `messages_window_started_at`| Timestamp marking the start of the current message window  |
| `metadata`                  | JSONB metadata, e.g. `contact_email` given by an anonymous user |
| `user_key_hash`             | SHA-256 hash of the anonymous user's key; clearing it revokes the key |
| `user_key_version`          | Incremented each time the user key is rotated              |

`email` is set only for administrators, from their verified Cognito address.

#### `data_sources` table

| Column Name        | Description                                              |
| ------------------ | -------------------------------------------------------- |
| `id`               | UUID, primary key                                        |
| `name`             | Name of the data source                                  |
| `type`             | Data source type (`website`, `csv`, `markdown`, `json`)  |
| `include_patterns` | List of patterns to include during ingestion             |
| `exclude_patterns` | List of patterns to exclude during ingestion             |
| `created_by`       | Foreign key to users table                               |
| `created_at`       | Timestamp of creation                                    |
| `metadata`         | JSONB metadata for additional data source information    |

#### `ingestion_runs` table

| Column Name      | Description                                                 |
| ---------------- | ----------------------------------------------------------- |
| `id`             | UUID, primary key                                           |
| `data_source_id` | Foreign key to data_sources table                           |
| `status`         | Ingestion status (`pending`, `queued`, `running`, `failed`, `completed`) |
| `error_message`  | Error message if ingestion fails                            |
| `created_at`     | Timestamp when the ingestion run was created                |
| `completed_at`   | Timestamp when the ingestion run completed                  |
| `metadata`       | JSONB metadata for additional ingestion run information     |

### Chat & Interaction Tables

#### `chat_sessions` table

| Column Name      | Description                        |
| ---------------- | ---------------------------------- |
| `id`             | UUID, primary key                  |
| `user_id`        | Foreign key to users table         |
| `title`          | Title of the chat session          |
| `created_at`     | Timestamp of creation              |
| `last_active_at` | Timestamp of last activity         |
| `metadata`       | JSONB metadata for session details |

#### `chat_messages` table

| Column Name       | Description                                              |
| ----------------- | -------------------------------------------------------- |
| `id`              | UUID, primary key                                        |
| `chat_session_id` | Foreign key to chat_sessions table                       |
| `sender`          | Sender role (`user`, `AI`)                               |
| `content`         | Message content                                          |
| `sources`         | JSONB list of sources used to generate the response      |
| `warning`         | Warning message attached to the response if applicable   |
| `created_at`      | Timestamp of message creation                            |

`chat_messages` is append-only: triggers reject `UPDATE`, `DELETE` and `TRUNCATE` (migrations `001` and `004`). Rows are removed only by the `ON DELETE CASCADE` foreign key when their chat session is deleted. Messages are indexed on `(chat_session_id, created_at, id)` (migration `005`).

### System Configuration Tables

#### `system_messages` table

| Column Name                  | Description                                                                |
| ---------------------------- | -------------------------------------------------------------------------- |
| `id`                         | UUID, primary key                                                          |
| `type`                       | System message type used in the application prompt flow                    |
| `content`                    | Content of the system message                                              |
| `character_limit`            | Maximum allowed character count for the message                            |
| `version`                    | Version number of the system message                                       |
| `is_active`                  | Whether this version is currently active                                   |
| `affects_text_generation`    | Whether this message affects LLM response generation                       |
| `created_by`                 | Foreign key to users table                                                 |
| `created_at`                 | Timestamp of creation                                                      |

#### `system_settings` table

| Column Name                     | Description                                                        |
| ------------------------------- | ------------------------------------------------------------------ |
| `id`                            | UUID, primary key                                                  |
| `max_messages_per_day`          | Maximum number of messages a user can send per day (default 45)    |
| `min_messages_before_suggest`   | Minimum number of messages before suggestions are shown (default 4) |
| `max_characters_per_user_message` | Maximum number of characters allowed in a user message (default 2000) |
| `max_characters_per_ai_message` | Maximum number of characters allowed in an AI message (default 5000) |
| `temperature`                   | Temperature setting used for text generation (default 0.2)         |
| `top_p`                         | Top-p setting used for text generation (default 0.9)               |
| `support_score_threshold`       | Minimum support score for a response's claims (default 0.25)       |
| `scope_alignment_score_threshold` | Minimum relevance of the retrieved sources (default 0.25)        |
| `grounded_threshold`            | Score above which a response is fully grounded (default 0.75)      |
| `partially_grounded_threshold`  | Score above which a response is partially grounded (default 0.50)  |
| `specialization_list`           | List of supported specialization areas                             |
| `updated_by`                    | Foreign key to users table                                         |
| `updated_at`                    | Timestamp of last update                                           |

### Enums

#### `user_role`

Defines the type of user in the system:

- `student`
- `admin`

#### `sender_role`

Defines who sent a chat message:

- `user`
- `AI`

#### `data_source_type`

Defines the type of managed data source:

- `website`
- `csv`
- `markdown`
- `json`

#### `ingestion_status`

Defines the status of an ingestion run:

- `pending`
- `queued`
- `running`
- `failed`
- `completed`

#### `system_message_type`

Defines the role of a system message in the text generation pipeline:

- `disclaimer`
- `guardrails`
- `system_role`
- `system_checklist`
- `system_instructions`
- `initial_prompt`
- `detective_phase_prompt`
- `suggestion_phase_prompt`
- `welcome_message`
- `partial_hallucination_warning`
- `full_hallucination_warning`