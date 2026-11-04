const {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const { Client } = require("pg");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const migrate = require("node-pg-migrate").default;

// The instance certificate is verified against the RDS CA bundle shipped with the function
// https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
const RDS_CA = fs.readFileSync(path.join(__dirname, "certs", "global-bundle.pem"));

const sm = new SecretsManagerClient();

async function getSecret(name) {
  const data = await sm.send(new GetSecretValueCommand({ SecretId: name }));
  return JSON.parse(data.SecretString);
}

async function putSecret(name, secret) {
  await sm.send(
    new PutSecretValueCommand({
      SecretId: name,
      SecretString: JSON.stringify(secret),
    })
  );
}

async function runMigrations(db) {
  const dbUrl = `postgresql://${encodeURIComponent(
    db.username
  )}:${encodeURIComponent(db.password)}@${db.host}:${db.port || 5432}/${
    db.dbname
  }`;
  await migrate({
    databaseUrl: {
      connectionString: dbUrl,
      ssl: { rejectUnauthorized: true, ca: RDS_CA },
    },
    dir: path.join(__dirname, "migrations"),
    direction: "up",
    count: Infinity,
    migrationsTable: "pgmigrations",
    logger: console,
    createSchema: false,
  });
}

async function ensureBaselineOrMigrate(db) {
  await runMigrations(db);
}

async function createAppUsers(
  adminDb,
  dbSecretName,
  userSecretName,
  tableCreatorSecretName
) {
  const adminClient = new Client({
    user: adminDb.username,
    password: adminDb.password,
    host: adminDb.host,
    database: adminDb.dbname, // target DB
    port: adminDb.port || 5432,
    ssl: {
      rejectUnauthorized: true,
      ca: RDS_CA,
    },
  });
  await adminClient.connect();

  // Stable usernames; rotate passwords idempotently
  const RW_NAME = "app_rw";
  const TC_NAME = "app_tc";
  const rwPass = crypto.randomBytes(16).toString("hex");
  const tcPass = crypto.randomBytes(16).toString("hex");

  // Safe quoting for DB identifier inside SQL
  const dbIdent = adminDb.dbname.replace(/"/g, '""');

  const sql = `
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'readwrite') THEN
        CREATE ROLE readwrite;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tablecreator') THEN
        CREATE ROLE tablecreator;
      END IF;
    END$$;

    GRANT CONNECT ON DATABASE "${dbIdent}" TO readwrite;
    GRANT CONNECT ON DATABASE "${dbIdent}" TO tablecreator;

    GRANT USAGE ON SCHEMA public TO readwrite;
    GRANT USAGE ON SCHEMA public TO tablecreator;
    GRANT CREATE ON SCHEMA public TO tablecreator;

    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO readwrite;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO tablecreator;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO readwrite;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO tablecreator;

    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO readwrite;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO tablecreator;

    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO readwrite;
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO tablecreator;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${RW_NAME}') THEN
        EXECUTE format('CREATE USER ${RW_NAME} WITH PASSWORD %L', current_setting('app.rw_pass'));
      ELSE
        EXECUTE format('ALTER USER ${RW_NAME} WITH PASSWORD %L', current_setting('app.rw_pass'));
      END IF;

      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${TC_NAME}') THEN
        EXECUTE format('CREATE USER ${TC_NAME} WITH PASSWORD %L', current_setting('app.tc_pass'));
      ELSE
        EXECUTE format('ALTER USER ${TC_NAME} WITH PASSWORD %L', current_setting('app.tc_pass'));
      END IF;
    END$$;

    GRANT readwrite TO ${RW_NAME};
    GRANT tablecreator TO ${TC_NAME};
  `;

  await adminClient.query("BEGIN");
  try {
    // Passwords are bound as parameters and read back via transaction-local
    // settings, so they never appear in statement text or error output.
    await adminClient.query(
      "SELECT set_config('app.rw_pass', $1, true), set_config('app.tc_pass', $2, true)",
      [rwPass, tcPass]
    );
    await adminClient.query(sql);
    await adminClient.query("COMMIT");
  } catch (e) {
    await adminClient.query("ROLLBACK");
    throw e;
  } finally {
    await adminClient.end();
  }

  // Update Secrets Manager with the rotated creds
  const base = await getSecret(dbSecretName);
  await putSecret(tableCreatorSecretName, {
    ...base,
    username: TC_NAME,
    password: tcPass,
  });
  await putSecret(userSecretName, {
    ...base,
    username: RW_NAME,
    password: rwPass,
  });
}

exports.handler = async function () {
  const { DB_SECRET_NAME, DB_USER_SECRET_NAME, DB_TABLE_CREATOR_SECRET_NAME } =
    process.env; // Table creator secret name
  const adminDb = await getSecret(DB_SECRET_NAME);
  await ensureBaselineOrMigrate(adminDb);
  await createAppUsers(
    adminDb,
    DB_SECRET_NAME,
    DB_USER_SECRET_NAME,
    DB_TABLE_CREATOR_SECRET_NAME
  );
  return { status: "ok" };
};
