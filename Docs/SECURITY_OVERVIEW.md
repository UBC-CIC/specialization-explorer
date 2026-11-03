# Security Overview

**Project:** Specialization Explorer
**Document Type:** Public Security Architecture Overview
**Last Updated:** May 2026

---

## Table of Contents

1. [Introduction](#1-introduction)
2. [Security Architecture](#2-security-architecture)
3. [Authentication & Authorization](#3-authentication--authorization)
4. [API Security](#4-api-security)
5. [Network Security](#5-network-security)
6. [Data Protection](#6-data-protection)
7. [GenAI Security](#7-genai-security)
8. [Monitoring & Compliance](#8-monitoring--compliance)

---

## 1. Introduction

Specialization Explorer is an AI-powered conversational application that helps undergraduate students navigate academic specialization choices. This document provides an overview of the security measures implemented to protect user data, ensure system integrity, and maintain service availability.

### 1.1 Security Principles

| Principle | Description |
|-----------|-------------|
| **Defense in Depth** | Multiple layers of security controls |
| **Least Privilege** | Minimal permissions for all components |
| **Encryption Everywhere** | Data protected at rest and in transit |
| **Zero Trust** | Verify every request, trust nothing by default |
| **Privacy by Design** | PII protection built into the architecture |

---

## 2. Security Architecture

### 2.1 High-Level Architecture

```
╔═════════════════════════════════════════════════════════════════╗
║                          INTERNET                               ║
╚══════════════════════════════╤══════════════════════════════════╝
                               │
                               ▼
╔═════════════════════════════════════════════════════════════════╗
║                      EDGE SECURITY LAYER                        ║
║                                                                 ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐   ║
║   │   CloudFront    │  │    AWS WAF      │  │  AWS Shield   │   ║
║   │   CDN + TLS     │  │   Firewall      │  │    DDoS       │   ║
║   └─────────────────┘  └─────────────────┘  └───────────────┘   ║
╚══════════════════════════════╤══════════════════════════════════╝
                               │
                               ▼
╔═════════════════════════════════════════════════════════════════╗
║                      APPLICATION LAYER                          ║
║                                                                 ║
║   ┌─────────────────────────────────────────────────────────┐   ║
║   │            API Gateway  (REST + WebSocket)              │   ║
║   │   Request validation · Rate limiting · Access logging   │   ║
║   └───────────────────────────┬─────────────────────────────┘   ║
║                               │                                 ║
║   ┌─────────────────────────────────────────────────────────┐   ║
║   │                  Lambda Authorizers                     │   ║
║   │   JWT validation · Role-based access · Session verify   │   ║
║   └───────────────────────────┬─────────────────────────────┘   ║
║                               │                                 ║
║   ┌─────────────────────────────────────────────────────────┐   ║
║   │               Lambda Functions  (VPC)                   │   ║
║   │   Input validation · Business logic · Param. queries    │   ║
║   └─────────────────────────────────────────────────────────┘   ║
╚══════════════════════════════╤══════════════════════════════════╝
                               │
                               ▼
╔═════════════════════════════════════════════════════════════════╗
║                         DATA LAYER                              ║
║                                                                 ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐   ║
║   │   RDS Proxy     │  │   PostgreSQL    │  │  S3 Bucket    │   ║
║   │     TLS         │  │   Encrypted     │  │  Encrypted    │   ║
║   └─────────────────┘  └─────────────────┘  └───────────────┘   ║
╚══════════════════════════════╤══════════════════════════════════╝
                               │
                               ▼
╔═════════════════════════════════════════════════════════════════╗
║                         AI / ML LAYER                           ║
║                                                                 ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐   ║
║   │    Bedrock      │  │ Knowledge Base  │  │  OpenSearch   │   ║
║   │   Guardrails    │  │     RAG         │  │  Serverless   │   ║
║   └─────────────────┘  └─────────────────┘  └───────────────┘   ║
╚═════════════════════════════════════════════════════════════════╝
```

### 2.2 Security Layers Summary

| Layer | Components | Security Controls |
|-------|------------|-------------------|
| **Edge** | CloudFront, WAF, Shield | DDoS protection, TLS termination, rate limiting |
| **Application** | API Gateway, Lambda | Authentication, authorization, input validation |
| **Data** | RDS, S3, Secrets Manager | Encryption, access control, credential rotation |
| **AI/ML** | Bedrock, Knowledge Base | PII protection, prompt security, output validation |

---

## 3. Authentication & Authorization

### 3.1 Dual Authentication Model

```
╔═════════════════════════════════════════════════════════════════╗
║                     AUTHENTICATION FLOW                         ║
╠══════════════════════════════╦══════════════════════════════════╣
║        ADMIN USERS           ║          PUBLIC USERS            ║
║                              ║                                  ║
║   ┌──────────────────────┐   ║   ┌──────────────────────┐       ║
║   │     AWS Cognito      │   ║   │     Custom JWT       │       ║
║   │                      │   ║   │                      │       ║
║   │  · Email / password  │   ║   │  · Anonymous access  │       ║
║   │  · Required TOTP MFA │   ║   │  · Short-lived token │       ║
║   │  · Email verify      │   ║   │  · Bound to user key │       ║
║   │  · Group membership  │   ║   │                      │       ║
║   └──────────┬───────────┘   ║   └──────────┬───────────┘       ║
║              │               ║              │                   ║
║              ▼               ║              ▼                   ║
║   ┌──────────────────────┐   ║   ┌──────────────────────┐       ║
║   │   Admin Authorizer   │   ║   │   User Authorizer    │       ║
║   │    (Cognito JWT)     │   ║   │    (Custom JWT)      │       ║
║   └──────────────────────┘   ║   └──────────────────────┘       ║
╚══════════════════════════════╩══════════════════════════════════╝
```

### 3.2 Authorization Controls

| Control | Implementation |
|---------|----------------|
| **Role-Based Access** | Admin vs. user roles enforced at API and handler level |
| **Resource Ownership** | Users can only access their own sessions and data |
| **Session Validation** | UUID format validation and ownership verification |
| **Token Expiration** | Short-lived tokens with automatic refresh |

### 3.3 Password Policy

- Minimum 10 characters
- Requires uppercase, lowercase, digits, and symbols
- Account recovery via verified email only

### 3.4 Administrator Sign-In

| Control | Implementation |
|---------|----------------|
| **MFA** | Required; authenticator app (TOTP) only, enrolled at first sign-in |
| **Auth flow** | SRP only; the password is never sent to Cognito |
| **Threat protection** | Cognito Plus plan, full-function mode: compromised passwords and high-risk sign-ins are blocked |
| **Account enumeration** | Sign-in and recovery errors do not reveal whether an account exists |
| **Pool deletion** | Deletion protection on, and the pool is retained if the stack is deleted |

### 3.5 Anonymous User Key (Accepted Risk)

Students do not sign in. On first visit the browser receives a user id and a random user key, and stores both in `localStorage`. The key is sent to the token endpoint (`Authorization: UserKey <userId>:<userKey>`) to get a 15-minute token bound to that user. The database stores only the SHA-256 hash of the key.

**Risk:** script running on the site's origin can read `localStorage`. Anyone who obtains a user's id and key can read that user's chat history and send messages within that user's quota.

**Mitigations:**

| Control | Effect |
|---------|--------|
| **Content Security Policy** | `script-src 'self'`, `object-src 'none'`, `base-uri 'self'` and `frame-ancestors 'none'` block injected and framed scripts. Chat messages are rendered as Markdown through `rehype-sanitize`, with no raw HTML |
| **Key rotation** | When the app loads and the key is more than 24 hours old, the browser replaces it; the previous key stops working at once |
| **Short-lived tokens** | Tokens expire after 15 minutes and are kept in memory only |
| **Revocation** | Clearing `users.user_key_hash` for a user stops new tokens being issued for that user (see [6.3](#63-credential-management)) |
| **Scope** | A key gives access only to its own user's anonymous chats; it carries no admin rights |

A key whose owner never returns is not rotated, and stays valid until it is revoked.

**Why an `HttpOnly` cookie is not used:** the site is served from `amplifyapp.com` and the API from `execute-api.amazonaws.com`, so a cookie set by the token endpoint would be a third-party cookie (`SameSite=None`). Safari blocks these by default and other browsers are restricting them, so returning students would silently lose their chat history. The WebSocket connection also authenticates with a token in the query string, not a cookie. Moving the key to a cookie becomes practical if the site and API are served from one custom domain (for example `app.example.edu` and `api.example.edu`), so the cookie is first-party.

This risk is accepted for the current deployment and should be reviewed if a custom domain is added.

---

## 4. API Security

### 4.1 Request Security Pipeline

```
  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
  │   WAF    │───▶ │  Rate    │────▶│  Schema  │────▶│ Auth    │
  │  Rules   │     │  Limit   │     │  Valid.  │     │  Check   │
  └──────────┘     └──────────┘     └──────────┘     └──────────┘
       │                │                │                │
       ▼                ▼                ▼                ▼
  ┌──────────┐     ┌──────────┐     ┌──────────┐     ┌──────────┐
  │  Block   │     │ Throttle │     │  Reject  │     │   Deny   │
  │ Attacks  │     │  Excess  │     │ Invalid  │     │  Unauth  │
  └──────────┘     └──────────┘     └──────────┘     └──────────┘
```

### 4.2 WAF Rules

| Rule Category | Protection |
|---------------|------------|
| **IP Reputation** | Blocks sources on the AWS threat intelligence IP reputation list |
| **Managed Rules** | SQL injection, XSS, path traversal, and common attacks |
| **Known Bad Inputs** | Log4j/JNDI lookups, Java deserialization and other known exploit patterns |
| **Rate Limiting** | Per-IP limit on all requests |
| **Endpoint Protection** | Stricter limits for expensive AI operations, account creation, and token issuance |

WAF logs requests that a rule blocked or counted to the `aws-waf-logs-<stack>` CloudWatch log group, with the `Authorization` header redacted. Allowed requests are in the API access logs.

### 4.3 WebSocket Rate Limiting

WAF cannot be associated with a WebSocket API, and chat replies stream over the WebSocket API. The default route therefore limits each user to 10 messages a minute (and 2 warm-ups a minute) before it invokes text generation. Counters are kept in a DynamoDB table with one item per user per minute, removed by TTL. The limit is keyed on the user, so opening extra connections does not raise it. If the counter cannot be checked, the message is refused. The stage throttle and the per-user daily message quota still apply.

Each new anonymous user gets a fresh daily quota. Account creation is limited to 20 per IP every 5 minutes. The limit is not lower because a class on a shared campus network reaches the API from a few NAT addresses. A WAF CAPTCHA or Challenge on `POST /user` would tighten this further, but it needs the WAF client integration script in the frontend and is billed per challenge.

### 4.4 Request Validation

| Control | Detail |
|---------|--------|
| **OpenAPI Schema** | Request structure validated against specification |
| **Input Sanitization** | UUID format, length limits, enum validation |
| **Parameterized Queries** | SQL injection prevention at the database layer |

### 4.5 Browser Security Headers

Amplify Hosting sends these headers with every page:

| Header | Value |
|--------|-------|
| **Content-Security-Policy** | Scripts, styles and connections limited to the site, the API and the AWS services it calls; no framing |
| **Strict-Transport-Security** | `max-age=31536000; includeSubDomains` |
| **Referrer-Policy** | `strict-origin-when-cross-origin` |
| **X-Content-Type-Options** | `nosniff` |
| **Permissions-Policy** | Camera, microphone, geolocation, payment and USB turned off |

### 4.6 CORS Configuration

- Dynamic origin validation from configuration
- Restricted to known application domains
- Proper headers enforced on all error responses

---

## 5. Network Security

### 5.1 VPC Architecture

```
╔═════════════════════════════════════════════════════════════════╗
║                       VPC ARCHITECTURE                          ║
╠═════════════════════════════════════════════════════════════════╣
║                                                                 ║
║   ┌─────────────────────────────────────────────────────────┐   ║
║   │                    PUBLIC SUBNETS                       │   ║
║   │   · NAT Gateway  (outbound internet access)             │   ║
║   │   · Internet Gateway                                    │   ║
║   └───────────────────────────┬─────────────────────────────┘   ║
║                               │                                 ║
║                               ▼                                 ║
║   ┌─────────────────────────────────────────────────────────┐   ║
║   │                   PRIVATE SUBNETS                       │   ║
║   │   · Lambda functions  (VPC-connected)                   │   ║
║   │   · Outbound access via NAT                             │   ║
║   └───────────────────────────┬─────────────────────────────┘   ║
║                               │                                 ║
║                               ▼                                 ║
║   ┌─────────────────────────────────────────────────────────┐   ║
║   │                   ISOLATED SUBNETS                      │   ║
║   │   · RDS PostgreSQL  (no internet access)                │   ║
║   │   · RDS Proxy                                           │   ║
║   │   · VPC Endpoints  (AWS services)                       │   ║
║   └─────────────────────────────────────────────────────────┘   ║
╚═════════════════════════════════════════════════════════════════╝
```

### 5.2 Network Controls

| Control | Implementation |
|---------|----------------|
| **Subnet Isolation** | Database in isolated subnets with no internet route |
| **Security Groups** | The database admits only the RDS Proxy, secret rotation and database initializer security groups; the proxy admits the private and isolated subnet ranges |
| **VPC Endpoints** | Private connectivity to AWS services (no public internet) |
| **VPC Flow Logs** | Network traffic auditing |

### 5.3 Encryption in Transit

| Connection | Protocol |
|------------|----------|
| API Gateway | HTTPS / TLS 1.2+ (HTTP not accepted) |
| WebSocket | WSS |
| Lambda → RDS Proxy | TLS with certificate and host name verification (Node.js: built-in roots; Python: `verify-full` against the bundled Amazon Trust Services roots) |
| RDS Proxy → Database | TLS required |
| Lambda → AWS services | TLS via VPC endpoints |

---

## 6. Data Protection

### 6.1 Data Classification

| Data Type | Classification | Protection |
|-----------|----------------|------------|
| User credentials | Sensitive | Cognito managed, never stored in app |
| Chat messages | Private | Encrypted at rest, user-scoped access |
| Session data | Private | UUID-based, ownership validated |
| Knowledge base | Internal | Encrypted, admin-only upload |
| System config | Internal | Database stored, admin-only access |

### 6.2 Encryption at Rest

```
╔═════════════════════════════════════════════════════════════════╗
║                      ENCRYPTION AT REST                         ║
╠═════════════════════════════════════════════════════════════════╣
║                                                                 ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐   ║
║   │      RDS        │  │       S3        │  │  OpenSearch   │   ║
║   │    AES-256      │  │     SSE-S3      │  │ AWS-managed   │   ║
║   └─────────────────┘  └─────────────────┘  └───────────────┘   ║
║                                                                 ║
╠═════════════════════════════════════════════════════════════════╣
║                      ENCRYPTION IN TRANSIT                      ║
╠═════════════════════════════════════════════════════════════════╣
║                                                                 ║
║   ┌─────────────────┐  ┌─────────────────┐  ┌───────────────┐   ║
║   │   API Gateway   │  │   RDS Proxy     │  │   Bedrock     │   ║
║   │    TLS 1.2+     │  │  TLS Required   │  │     TLS       │   ║
║   └─────────────────┘  └─────────────────┘  └───────────────┘   ║
║                                                                 ║
╚═════════════════════════════════════════════════════════════════╝
```

> All encrypted resources currently use AWS managed keys. For details on which resources are affected and how to switch to customer-managed KMS keys, see [`Docs/AWS_MANAGED_KEYS.md`](./AWS_MANAGED_KEYS.md).

### 6.3 Credential Management

| Credential | Storage | Rotation |
|------------|---------|----------|
| Database credentials (admin) | AWS Secrets Manager | 30-day automatic |
| Database credentials (app users) | AWS Secrets Manager | 30-day automatic |
| JWT signing key | AWS Secrets Manager | 30-day automatic (custom rotation function) |
| Cognito secrets | AWS Secrets Manager | N/A (static IDs) |

The token verifiers re-read the signing key every 5 minutes and accept the previous key for 25 minutes after a rotation (token lifetime plus cache time). To retire a compromised key, run `aws secretsmanager rotate-secret` on the JWT secret and wait 25 minutes, or rotate twice; tokens signed with the old key are then rejected. Tokens are valid for 15 minutes, and a single user's access is withdrawn by clearing `users.user_key_hash`, which stops new tokens being issued for that user.

### 6.4 S3 Bucket Security

| Control | Detail |
|---------|--------|
| **Block Public Access** | Enabled on all buckets |
| **SSL Required** | All requests must use HTTPS |
| **Presigned URLs** | Short expiration for uploads |
| **Content-Type Validation** | Enforced for uploaded files |

### 6.5 Data Retention (Post-POC)

> **Status:** Not implemented. Deferred until after the proof of concept.

The POC has no data retention policy, so stored data grows without limit:

- `chat_messages` is append-only. Triggers reject direct `UPDATE`, `DELETE`, and `TRUNCATE` (migrations `001` and `004`). Rows can only be removed by the `ON DELETE CASCADE` from `chat_sessions`.
- Anonymous `users` rows are never purged.

Keeping chat history and anonymous user records indefinitely is also a privacy concern.

**Recommended approach:**

1. Choose a retention period, for example deleting sessions inactive for N months.
2. Add a scheduled job (for example, an EventBridge rule invoking a Lambda) that deletes expired rows from `chat_sessions`. The foreign key cascade removes their `chat_messages`, so the append-only triggers stay in place.
3. Purge anonymous `users` rows that no longer have any sessions.
4. State the retention period in the privacy notice.

---

## 7. GenAI Security

### 7.1 AI Security Pipeline

```
  USER INPUT
      │
      ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  1 · INPUT VALIDATION                                       │
  │      · Length limits (2 000 characters)                     │
  │      · Format validation                                    │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  2 · BEDROCK GUARDRAILS                                     │
  │      · PII Detection & Anonymization                        │
  │      · Prompt Attack Detection                              │
  │     ✗  Blocked → return denial  (no LLM call made)          │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  3 · RAG RETRIEVAL                                          │
  │      · Knowledge Base query                                 │
  │      · Source document retrieval                            │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  4 · LLM GENERATION                                         │
  │      · Grounded in retrieved context                        │
  │      · System prompts enforce topic scope                   │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  ┌─────────────────────────────────────────────────────────────┐
  │  5 · OUTPUT VALIDATION                                      │
  │      · Hallucination detection                              │
  │      · Source grounding verification                        │
  │      · Warning injected if response is ungrounded           │
  └───────────────────────────┬─────────────────────────────────┘
                              │
                              ▼
  RESPONSE TO USER
```

### 7.2 PII Protection

| Category | Protected Data Types |
|----------|---------------------|
| **Contact** | Email, phone, address |
| **Identity** | Name, age, username |
| **Financial** | Credit card numbers, bank accounts |
| **Government** | Social insurance numbers, health numbers |
| **Technical** | IP addresses, URLs |

### 7.3 Prompt Security

| Control | Description |
|---------|-------------|
| **Prompt Attack Detection** | Identifies and blocks injection attempts |
| **Scope Enforcement** | System prompts restrict topic to academic advising |
| **Guardrails** | Strict boundaries on acceptable responses |

For guardrail configuration details, see [`Docs/BEDROCK_GUARDRAILS.md`](./BEDROCK_GUARDRAILS.md).

### 7.4 Output Validation

| Control | Description |
|---------|-------------|
| **Grounding Verification** | Responses checked against source documents |
| **Hallucination Detection** | LLM-based verification of claims |
| **Warning System** | Users notified when responses may be ungrounded |

---

## 8. Monitoring & Compliance

### 8.1 Logging Architecture

```
  ┌─────────────────┐   ┌─────────────────┐   ┌─────────────────┐
  │   API Gateway   │   │     Lambda      │   │   VPC Flow      │
  │   Access Logs   │   │      Logs       │   │     Logs        │
  └────────┬────────┘   └────────┬────────┘   └────────┬────────┘
           │                     │                     │
           └─────────────────────┼─────────────────────┘
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │  CloudWatch Logs      │
                     │  & Metrics            │
                     └───────────┬───────────┘
                                 │
                                 ▼
                     ┌───────────────────────┐
                     │  CloudWatch Alarms    │
                     │  (concurrency, errors,│
                     │   WAF block rate)     │
                     └───────────────────────┘
```

### 8.2 Security Logging

| Log Type | Content | Retention |
|----------|---------|-----------|
| **API Access Logs** | Request metadata, status codes, latency | 1 week |
| **WAF Logs** | Blocked and counted requests, `Authorization` header redacted | 90 days |
| **Lambda Logs** | Function execution, errors (body excluded) | 1 week |
| **VPC Flow Logs** | Network traffic metadata | Configurable |
| **WebSocket Logs** | Connection events, route keys | 1 week |

### 8.3 Alerting

| Alert | Trigger | Purpose |
|-------|---------|---------|
| **Concurrency Alarm** | Lambda approaching reserved limit | Prevent service degradation |
| **Error Rate Alarm** | Elevated 5XX responses | Detect service issues |
| **WAF Block Alarm** | High block rate | Detect attack patterns |

### 8.4 Compliance Summary

| Control Area | Status | Notes |
|--------------|--------|-------|
| **Encryption at Rest** | ✅ Enabled | AWS managed keys (CMK upgrade available — see [`AWS_MANAGED_KEYS.md`](./AWS_MANAGED_KEYS.md)) |
| **Encryption in Transit** | ✅ Enabled | TLS enforced on all connections |
| **Access Control** | ✅ Enabled | Role-based, least privilege |
| **Audit Logging** | ✅ Enabled | Comprehensive logging across all layers |
| **Credential Management** | ✅ Enabled | Secrets Manager with automatic rotation |
| **PII Protection** | ✅ Enabled | Automatic anonymization via Bedrock Guardrails |
| **Input Validation** | ✅ Enabled | Schema and application-level validation |
| **Rate Limiting** | ✅ Enabled | Multi-layer WAF and API Gateway throttling |
| **Data Retention** | ⚠️ Post-POC | No retention policy; chat data and anonymous users kept indefinitely (see [6.5](#65-data-retention-post-poc)) |

---

## 9. Security Contact

For security concerns or to report vulnerabilities, please contact the project maintainers through the repository's security policy.

---

*This document provides a high-level overview of security controls. Implementation details are maintained in internal documentation.*
