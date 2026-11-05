# Database Migrations

This document provides comprehensive information about the database migration system used in the Specialization Explorer project.

## Table of Contents

1. [Overview](#overview)
2. [Quick Start](#quick-start)
3. [Migration System Architecture](#migration-system-architecture)
4. [Migration Files Structure](#migration-files-structure)
5. [How Migrations Work](#how-migrations-work)
6. [Creating New Migrations](#creating-new-migrations)
7. [Common Migration Patterns](#common-migration-patterns)
8. [Running Migrations](#running-migrations)
9. [Migration Patterns and Best Practices](#migration-patterns-and-best-practices)

## Overview

The Specialization Explorer project uses a `node-pg-migrate` system to manage database schema changes with numbered JavaScript files. This provides a reliable, trackable, and automated approach to database schema evolution throughout the project lifecycle.

## Quick Start

### Creating a New Migration

1. **Find the next migration number:**

   ```bash
   ls cdk/lambda/db_setup/migrations/ | tail -1
   # Use the next sequential number (the last is currently 006, so use 007)
   ```

2. **Create migration file:**

   ```bash
   # Replace XXX with next number and describe_change with description
   touch cdk/lambda/db_setup/migrations/XXX_describe_change.js
   ```

3. **Basic migration template:**

   ```javascript
   exports.up = (pgm) => {
     // Your migration code here
     pgm.sql(`
       -- Your SQL here
     `);
   };

   exports.down = (pgm) => {
     // Optional: rollback logic
   };
   ```

## Migration System Architecture

The migration system is built on `node-pg-migrate` and consists of:

- **Migration Files**: Located in `cdk/lambda/db_setup/migrations/` with numbered JavaScript files
- **Migration Runner**: The `index.js` file contains the main migration execution logic
- **Migration Tracking**: Uses a `pgmigrations` table to track which migrations have been applied
- **Automatic Execution**: The `<StackPrefix>-DBFlow-initializerFunction` Lambda is a CDK `TriggerFunction`, so it runs on every deployment of the DBFlow stack. Its description includes the synth time, so each deployment runs it again.

The runner connects to the database instance directly (not through RDS Proxy) as the admin user, with TLS verified against the RDS CA bundle in `certs/global-bundle.pem`. After the migrations it creates or updates the `readwrite` and `tablecreator` roles and the `app_rw` and `app_tc` users, gives them new random passwords and writes those to Secrets Manager. `node-pg-migrate` and `pg` come from the `layers/node-pg-migrate.zip` Lambda layer.

### Key Components

```
cdk/lambda/db_setup/
├── index.js              # Main entry point: runs node-pg-migrate, then creates the app users
├── certs/
│   └── global-bundle.pem # RDS CA bundle used to verify the database certificate
└── migrations/           # Migration files directory
    ├── 000_initial_schema.js
    ├── 001_chat_messages_append_only.js
    ├── 002_prompt_formatting_style.js
    ├── 003_user_key_hash.js
    ├── 004_chat_messages_no_delete.js
    ├── 005_chat_messages_session_created_at_index.js
    └── 006_drop_vector_extension.js
```

### Current Migrations

| Migration | Change |
| --- | --- |
| `000_initial_schema` | Enums, tables, indexes, foreign keys, and seed `system_settings` and `system_messages` rows |
| `001_chat_messages_append_only` | Trigger that rejects `UPDATE` on `chat_messages` |
| `002_prompt_formatting_style` | Adds a `STYLE:` line to the active `system_instructions` and `initial_prompt` as a new version |
| `003_user_key_hash` | Adds `users.user_key_hash` and `users.user_key_version` for anonymous user keys |
| `004_chat_messages_no_delete` | `ON DELETE CASCADE` from `chat_sessions`; triggers that reject direct `DELETE` and `TRUNCATE` on `chat_messages` |
| `005_chat_messages_session_created_at_index` | Index on `(chat_session_id, created_at, id)`, replacing the single-column index |
| `006_drop_vector_extension` | Drops the unused `vector` extension (embeddings live in OpenSearch Serverless) |

Because of `001` and `004`, a migration cannot update or delete rows in `chat_messages` directly. Delete the parent `chat_sessions` rows instead, or drop and recreate the triggers inside the migration if a change is truly required.

## Migration Files Structure

### JavaScript Migration Files

Each migration file follows this naming convention: `{number}_{description}.js`

**Example Structure:**

```javascript
exports.up = (pgm) => {
  // Forward migration logic
  pgm.sql(`
    ALTER TABLE users ADD COLUMN new_field VARCHAR(255);
  `);
};

exports.down = (pgm) => {
  // Rollback logic (optional but recommended)
  pgm.sql(`
    ALTER TABLE users DROP COLUMN new_field;
  `);
};
```

### Common Migration Operations

#### Adding Tables

```javascript
exports.up = (pgm) => {
  pgm.createTable("new_table", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("uuid_generate_v4()"),
    },
    name: { type: "varchar", notNull: true },
    created_at: { type: "timestamp", default: pgm.func("now()") },
  });
};
```

#### Adding Columns

```javascript
exports.up = (pgm) => {
  pgm.addColumn("existing_table", {
    new_column: {
      type: "jsonb",
      default: "{}",
      comment: "Description of the column purpose",
    },
  });
};
```

#### Modifying Columns

```javascript
exports.up = (pgm) => {
  pgm.sql(`
    ALTER TABLE table_name ALTER COLUMN column_name TYPE new_type;
  `);
};
```

## How Migrations Work

### Execution Flow

1. **Migration Discovery**: The system scans the `migrations/` directory for `.js` files
2. **Sorting**: Files are sorted numerically by their prefix (e.g., `001_`, `002_`)
3. **Tracking Check**: Each migration is checked against the `pgmigrations` table
4. **Execution**: Only unapplied migrations are executed in order
5. **Recording**: Successfully applied migrations are recorded in the tracking table

### Migration Tracking

The system uses a PostgreSQL table to track applied migrations:

- **`pgmigrations`**: Used by node-pg-migrate to track which migrations have been successfully applied

### Deployment Process

```mermaid
graph TD
    A[Lambda Function Triggered] --> B[Connect to Database]
    B --> C[Run node-pg-migrate]
    C --> D[Check Migration Files]
    D --> E[Apply Pending Migrations]
    E --> F[Create Application Users]
    F --> G[Update Secrets Manager]
    G --> H[Return Success]
```

## Creating New Migrations

### Method 1: JavaScript Migration Files (Recommended)

1. **Determine the next migration number:**

   ```bash
   # Look at existing files in migrations/ directory
   ls cdk/lambda/db_setup/migrations/
   # Use the next sequential number
   ```

2. **Create the migration file:**

   ```bash
   # Example: Adding audit table
   touch cdk/lambda/db_setup/migrations/007_add_audit_table.js
   ```

3. **Write the migration:**

   ```javascript
   exports.up = (pgm) => {
     pgm.createTable("audit_logs", {
       id: {
         type: "uuid",
         primaryKey: true,
         default: pgm.func("uuid_generate_v4()"),
       },
       created_at: { type: "timestamp", default: pgm.func("now()") },
     });
   };

   exports.down = (pgm) => {
     pgm.dropTable("audit_logs");
   };
   ```

## Common Migration Patterns

### Adding a New Table

```javascript
exports.up = (pgm) => {
  pgm.createTable("table_name", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("uuid_generate_v4()"),
    },
    name: { type: "varchar", notNull: true },
    description: { type: "text" },
    status: {
      type: "varchar",
      default: "active",
      check: "status IN ('active', 'inactive')",
    },
    created_at: { type: "timestamp", default: pgm.func("now()") },
    updated_at: { type: "timestamp" },
  });

  // Add indexes
  pgm.createIndex("table_name", "name");
};
```

### Adding Columns

```javascript
exports.up = (pgm) => {
  pgm.addColumns("existing_table", {
    new_column: {
      type: "varchar",
      default: "default_value",
      notNull: true,
      comment: "Description of the column",
    },
    optional_column: {
      type: "jsonb",
      default: "{}",
    },
  });
};
```

### Modifying Columns

```javascript
exports.up = (pgm) => {
  // Change column type
  pgm.sql(`ALTER TABLE table_name ALTER COLUMN column_name TYPE new_type;`);

  // Add constraint
  pgm.sql(
    `ALTER TABLE table_name ADD CONSTRAINT constraint_name CHECK (condition);`
  );

  // Set default value
  pgm.sql(
    `ALTER TABLE table_name ALTER COLUMN column_name SET DEFAULT 'value';`
  );
};
```

### Adding Foreign Keys

```javascript
exports.up = (pgm) => {
  pgm.addColumns("child_table", {
    parent_id: {
      type: "uuid",
      references: "parent_table(id)",
      onDelete: "CASCADE",
      onUpdate: "CASCADE",
    },
  });

  // Or add constraint to existing column
  pgm.addConstraint("child_table", "fk_parent", {
    foreignKeys: {
      columns: "parent_id",
      references: "parent_table(id)",
      onDelete: "SET NULL",
    },
  });
};
```

### Creating Indexes

```javascript
exports.up = (pgm) => {
  // Simple index
  pgm.createIndex("table_name", "column_name");

  // Composite index
  pgm.createIndex("table_name", ["col1", "col2"], {
    name: "idx_custom_name",
  });

  // Unique index
  pgm.createIndex("table_name", "email", {
    unique: true,
    name: "idx_unique_email",
  });

  // Partial index
  pgm.createIndex("table_name", "status", {
    where: "status = 'active'",
    name: "idx_active_status",
  });
};
```

### Working with ENUMs

```javascript
exports.up = (pgm) => {
  // Create ENUM type safely
  pgm.sql(`
    DO $$ BEGIN
        CREATE TYPE status_type AS ENUM ('pending', 'active', 'inactive');
    EXCEPTION
        WHEN duplicate_object THEN null;
    END $$;
  `);

  // Use in table
  pgm.addColumn("table_name", {
    status: {
      type: "status_type",
      default: "pending",
    },
  });
};
```

### Adding Extensions

```javascript
exports.up = (pgm) => {
  pgm.sql(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp";`);
};
```

The `vector` (pgvector) extension was removed in migration `006`; embeddings are stored in OpenSearch Serverless, not PostgreSQL.

### Data Migrations

```javascript
exports.up = (pgm) => {
  // Insert default data
  pgm.sql(`
    INSERT INTO system_settings (max_messages_per_day)
    SELECT 45
    WHERE NOT EXISTS (SELECT 1 FROM system_settings);
  `);

  // Update existing data
  pgm.sql(`
    UPDATE users
    SET messages_sent = 0
    WHERE messages_sent IS NULL;
  `);
};
```

## Running Migrations

### Automatic Execution

Migrations run automatically every time the `<StackPrefix>-DBFlow` stack is deployed (for example with `npx cdk deploy --all`), through the initializer trigger function. To re-run them without other changes, redeploy that stack:

```bash
npx cdk deploy <StackPrefix>-DBFlow --profile <YOUR-PROFILE-NAME>
```

Check the `/aws/lambda/<StackPrefix>-DBFlow-initializerFunction` log group for the node-pg-migrate output. A failing migration fails the trigger, and with it the DBFlow stack deployment.

### Manual Execution (Development)

The database is in isolated subnets and requires TLS, so it cannot be reached from a laptop. To test migrations, run them against a local PostgreSQL 16:

```bash
# From the repository root, in a scratch directory
npm install node-pg-migrate pg

node -e "
const migrate = require('node-pg-migrate').default;
migrate({
  databaseUrl: 'postgresql://user:pass@localhost:5432/specEx',
  dir: 'cdk/lambda/db_setup/migrations',
  direction: 'up',
  count: Infinity,
  migrationsTable: 'pgmigrations',
}).then(() => console.log('Done'));
"
```

Use the same major version of `node-pg-migrate` as the Lambda layer.

## Safety Guidelines

### Always Use These Patterns

```javascript
// ✅ Safe table creation
CREATE TABLE IF NOT EXISTS table_name (...);

// ✅ Safe column addition with default
pgm.addColumn('table', {
  column: { type: 'varchar', default: 'value', notNull: true }
});

// ✅ Safe ENUM creation
DO $$ BEGIN
    CREATE TYPE enum_name AS ENUM ('val1', 'val2');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

// ✅ Safe index creation
CREATE INDEX IF NOT EXISTS idx_name ON table (column);
```

### Avoid These Patterns

```javascript
// ❌ Dangerous: Non-nullable without default
pgm.addColumn('table', {
  required_field: { type: 'varchar', notNull: true } // Will fail on existing rows
});

// ❌ Dangerous: Dropping columns (data loss)
pgm.dropColumn('table', 'column');

// ❌ Dangerous: Dropping tables (data loss)
pgm.dropTable('table');

// ❌ Dangerous: Raw SQL without IF NOT EXISTS
CREATE TABLE table_name (...); // Will fail if table exists
```

## Migration Patterns and Best Practices

### 1. Safety First

- **Always use `IF NOT EXISTS`** for CREATE statements
- **Handle duplicate objects gracefully** using `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN null; END $$;`
- **Test migrations in development** before applying to production

### 2. Data Integrity

```javascript
// Good: Safe column addition with default
exports.up = (pgm) => {
  // Insert default system settings row
  pgm.sql(`
    INSERT INTO system_settings (
      max_messages_per_day,
      min_messages_before_suggest,
      max_characters_per_user_message,
      max_characters_per_ai_message,
      temperature,
      top_p,
      specialization_list,
      updated_by,
      updated_at
    )
    SELECT
      45,
      4,
      2000,
      5000,
      0.2,
      0.9,
      ARRAY[]::text[],
      NULL,
      now()
    WHERE NOT EXISTS (SELECT 1 FROM system_settings);
  `);

  // Backfill existing users message count if needed
  pgm.sql(`
    UPDATE users
    SET messages_sent = 0
    WHERE messages_sent IS NULL;
  `);
};

// Avoid: Non-nullable column without default
exports.up = (pgm) => {
  pgm.addColumn("users", {
    required_field: { type: "varchar", notNull: true }, // This will fail!
  });
};
```

### 3. Index Management

```javascript
exports.up = (pgm) => {
  // Add table first
  pgm.createTable("large_table", {
    /* ... */
  });

  // Then add indexes
  pgm.createIndex("large_table", "frequently_queried_column");
  pgm.createIndex("large_table", ["composite", "index"], {
    name: "idx_composite_key",
  });
};
```

### 4. Type Safety

```javascript
// Good: Handle ENUM types safely
exports.up = (pgm) => {
  pgm.sql(`
    DO $$ BEGIN
        CREATE TYPE new_status AS ENUM ('pending', 'active', 'inactive');
    EXCEPTION
        WHEN duplicate_object THEN null;
    END $$;
  `);
};
```

### 5. Foreign Key Constraints

```javascript
exports.up = (pgm) => {
  pgm.createTable("child_table", {
    id: { type: "uuid", primaryKey: true },
    parent_id: {
      type: "uuid",
      references: "parent_table(id)",
      onDelete: "CASCADE", // or 'SET NULL', 'RESTRICT'
      onUpdate: "CASCADE",
    },
  });
};
```

### 6. Large Data Migrations

For migrations involving large datasets:

```javascript
exports.up = (pgm) => {
  // Use batch processing for large updates
  pgm.sql(`
    UPDATE large_table 
    SET new_column = old_column 
    WHERE id IN (
      SELECT id FROM large_table 
      WHERE new_column IS NULL 
      LIMIT 1000
    );
  `);
};
```

## Migration States and Lifecycle

### Migration States

1. **Pending**: Migration file exists but hasn't been applied
2. **Applied**: Migration has been successfully executed and recorded
3. **Failed**: Migration encountered an error during execution

### Rollback Considerations

- **Forward-only approach**: The runner only migrates `up`; the `down` functions are never called automatically
- **Manual rollbacks**: Rollback procedures must be handled manually if needed
- **Backups**: The instance keeps 7 days of automated backups, and AWS Backup takes a daily recovery point kept for 35 days
- **Data loss prevention**: Always backup before major schema changes

### Best Practices Summary

1. **Use sequential numbering** for migration files
2. **Always use IF NOT EXISTS** for CREATE statements
3. **Provide defaults** when adding NOT NULL columns
4. **Test migrations** on development database first
5. **Keep migrations focused** - one logical change per file
6. **Add appropriate indexes** for new columns that will be queried
7. **Document complex migrations** with comments
8. **Consider performance** for large table modifications
9. **Plan rollback strategy** for critical changes
10. **Backup production** before major schema changes

## Getting Help

- Review existing migrations for patterns: `cdk/lambda/db_setup/migrations/`
- Test in development environment first
- Ask team for review of complex migrations
- Check PostgreSQL documentation for advanced SQL features

This comprehensive migration system ensures safe, trackable, and reliable database schema evolution throughout the Specialization Explorer project lifecycle.
