# Specialization Explorer
This prototype explores how Large Language Models (LLMs) and Retrieval-Augmented Generation can support undergraduate students in navigating Bachelor of Science specialization choices through an AI-powered conversational experience. By leveraging conversational AI, institutional academic information, and publicly available alumni data, the Specialization Explorer enables students to reflect on their interests, compare specialization options, and discover academic pathways that align with their goals through personalized, open-ended dialogue.

| Index | Description |
| :---------------------------------------------------- | :------------------------------------------------------ |
| [High Level Architecture](#high-level-architecture) | High level overview illustrating component interactions |
| [Deployment](#deployment-guide) | How to deploy the project |
| [User Guide](#user-guide) | The working solution |
| [Knowledge Base](#knowledge-base) | How the project uses Bedrock Knowledge Bases |
| [Directories](#directories) | General project directory structure |
| [Additional Documentation](#additional-documentation) | Comprehensive guides and references |
| [Credits](#credits) | Meet the team behind the solution |
| [License](#license) | License details |

## High-Level Architecture

The following architecture diagram illustrates the various AWS components utilized to deliver the solution. For an in-depth explanation of the frontend and backend stacks, please look at the [Architecture Deep Dive](Docs/ARCHITECTURE_DEEP_DIVE.md).

![Architecture Diagram](Docs/media/architecture-diagram.png)

## Deployment Guide

To deploy this solution, please follow the steps laid out in the [Deployment Guide](Docs/DEPLOYMENT_GUIDE.md).

## User Guide

Please refer to the [Web App User Guide](Docs/USER_GUIDE.md) for instructions on navigating the web app interface.

## Knowledge Base

Please refer to [Knowledge Base Documentation](docs/KNOWLEDGE_BASE_DOCUMENTATION.md) as it explains how the project uses Bedrock Knowledges Bases. This includes the data source state machine, S3 and website ingestion phases, scheduler polling, retry behavior, and admin dashboard integration.

## Directories

```
├── cdk/
│   ├── bin/
│   │   └── cdk.ts
│   ├── lambda/
│   │   ├── adminAuthorizerFunction/
│   │   │   └── adminAuthorizerFunction.js
│   │   ├── authorization/
│   │   │   ├── addAdminOnSignUp.js
│   │   │   ├── initializeConnection.js
│   │   │   ├── preSignUp.js
│   │   │   └── userAuthorizerFunction.js
│   │   ├── db_setup/
│   │   │   ├── migrations/
│   │   │   │   └── 000_initial_schema.js
│   │   │   └── index.js
│   │   ├── ecrImageWaiter/
│   │   │   ├── index.js
│   │   │   └── package.json
│   │   ├── handlers/
│   │   │   ├── utils/
│   │   │   │   ├── cors.js
│   │   │   │   ├── handlerUtils.js
│   │   │   │   └── validation.js
│   │   │   ├── adminHandler.js
│   │   │   ├── chatSessionHandler.js
│   │   │   ├── initializeConnection.js
│   │   │   ├── systemMessagesHandler.js
│   │   │   └── userHandler.js
│   │   ├── knowledgeBase/
│   │   │   ├── helpers/
│   │   │   └── main.py
│   │   ├── knowledgeBaseProvisioner/
│   │   │   └── main.py
│   │   ├── publicTokenFunction/
│   │   │   ├── cors.js
│   │   │   └── publicTokenFunction.js
│   │   ├── textGeneration/
│   │   │   ├── helpers/
│   │   │   ├── main.py
│   │   │   └── requirements.txt
│   │   ├── vectorIndexManagerSigV4/
│   │   │   ├── Dockerfile
│   │   │   ├── main.py
│   │   │   ├── requirements.in
│   │   │   └── requirements.txt
│   │   └── websocket/
│   │       ├── connect.js
│   │       ├── default.js
│   │       └── disconnect.js
│   ├── layers/
│   │   ├── aws-jwt-verify.zip
│   │   ├── node-pg-migrate.zip
│   │   ├── postgres.zip
│   │   └── psycopg2.zip
│   ├── lib/
│   │   ├── amplify-stack.ts
│   │   ├── api-stack.ts
│   │   ├── cicd-stack.ts
│   │   ├── database-stack.ts
│   │   ├── dbFlow-stack.ts
│   │   ├── knowledge-base-stack.ts
│   │   └── vpc-stack.ts
│   └── OpenAPI_Swagger_Definition.yaml
│
├── Docs/
│   ├── media/
│   ├── API_DOCUMENTATION.md
│   ├── ARCHITECTURE_DEEP_DIVE.md
│   ├── AWS_MANAGED_KEYS.md
│   ├── BEDROCK_GUARDRAILS.md
│   ├── DATABASE_MIGRATIONS.md
│   ├── DEPENDENCY_MANAGEMENT.MD
│   ├── DEPLOYMENT_GUIDE.md
│   ├── MODIFICATION_GUIDE.md
│   ├── SECURITY_OVERVIEW.md
│   └── USER_GUIDE.md
│
└── frontend/
    └── src/
        ├── assets/
        ├── components/
        │   ├── Admin/
        │   ├── ChatInterface/
        │   └── ui/
        ├── functions/
        ├── hooks/
        ├── layouts/
        ├── lib/
        ├── pages/
        │   ├── Admin/
        │   └── ChatInterface/
        ├── providers/
        ├── types/
        ├── App.tsx
        └── main.tsx
```

## Technology Stack

### Frontend

- **React 19** with TypeScript
- **Vite** for build tooling
- **Tailwind CSS** for styling
- **shadcn/ui** (Radix UI) for UI components
- **AWS Amplify** for hosting and Cognito authentication
- **Recharts** for analytics charts
- **React Router** for client-side routing

### Backend

- **AWS Lambda** (Python 3.12 and Node.js 24) for serverless compute
- **Amazon Bedrock** for LLM inference — Claude Haiku 5.5 and Claude Sonnet 5.5 (Anthropic)
- **Amazon Bedrock Knowledge Base** with **Cohere Embed English v3** for vector embeddings
- **Amazon OpenSearch Serverless** for vector storage and similarity search
- **PostgreSQL** (RDS) for relational data storage
- **Amazon S3** for knowledge base document storage
- **API Gateway** (REST and WebSocket) for APIs
- **AWS Cognito** for authentication and authorization

### Infrastructure

- **AWS CDK** (TypeScript) for infrastructure as code
- **AWS CodePipeline** for CI/CD (Docker image builds)
- **Amazon RDS** with RDS Proxy for managed PostgreSQL
- **Amazon VPC** for network isolation

## Additional Documentation

### Architecture and Design

- **[Architecture Deep Dive](Docs/ARCHITECTURE_DEEP_DIVE.md)**: Comprehensive overview of system architecture and component interactions
- **[Security Overview](Docs/SECURITY_OVERVIEW.md)**: Security architecture, controls, and compliance summary

### Deployment and Configuration

- **[Deployment Guide](Docs/DEPLOYMENT_GUIDE.md)**: Step-by-step instructions for deploying to AWS
- **[Modification Guide](Docs/MODIFICATION_GUIDE.md)**: Guidelines for customizing and extending the application
- **[Bedrock Guardrails](Docs/BEDROCK_GUARDRAILS.md)**: Configuration and management of AWS Bedrock guardrails for AI safety

### Development and Maintenance

- **[Database Migrations](Docs/DATABASE_MIGRATIONS.md)**: Guide to the database migration system and best practices
- **[Dependency Management](Docs/DEPENDENCY_MANAGEMENT.MD)**: Managing Python dependencies in Lambda functions using pip-tools
- **[Changelog](Docs/CHANGELOG.md)**: Version history and release notes

### API and Usage

- **[API Documentation](Docs/API_DOCUMENTATION.md)**: Comprehensive API reference for all REST and WebSocket endpoints
- **[User Guide](Docs/USER_GUIDE.md)**: Complete guide for end-users on how to interact with Specialization Explorer

## Credits

This application was architected and developed by the UBC Cloud Innovation Centre team. Thanks to the UBC CIC Technical and Project Management teams for their guidance and support.

## License

This project is distributed under the [MIT License](LICENSE).

Licenses of third-party libraries and services used by this system:

**[PostgreSQL License](https://www.postgresql.org/about/licence/)**
For PostgreSQL — a liberal open source license, similar to BSD or MIT.

**[Cohere Terms of Use](https://cohere.com/terms-of-use)**
For Cohere Embed English v3, accessed via Amazon Bedrock for vector embeddings.

**[Anthropic Usage Policy](https://www.anthropic.com/legal/aup)**
For Claude Haiku 5.5 and Claude Sonnet 5.5, accessed via Amazon Bedrock for text generation.

**[MIT License](https://opensource.org/licenses/MIT)**
For open-source libraries and components used in this project.
