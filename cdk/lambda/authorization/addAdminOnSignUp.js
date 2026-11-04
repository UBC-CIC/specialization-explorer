const crypto = require("crypto");
const { initializeConnection } = require("./initializeConnection.js");

const { SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT } = process.env;
let sqlConnection = global.sqlConnection;

exports.handler = async (event) => {
  console.log("Post-confirmation trigger:", {
    userName:event.userName,
    userPoolId: event.userPoolId, 
    triggerSource: event.triggerSource,
  })

  if (!sqlConnection) {
    await initializeConnection(SM_DB_CREDENTIALS, RDS_PROXY_ENDPOINT);
    sqlConnection = global.sqlConnection;
  }

  const { userName, request } = event;

  try {
    // Extract user attributes from the event
    const userAttributes = request.userAttributes;
    const email = userAttributes.email;
    const givenName = userAttributes.given_name || "";
    const familyName = userAttributes.family_name || "";
    const displayName = `${givenName} ${familyName}`.trim() || email;

    console.log("Creating user");

    // New accounts start without privileges; admins are granted via /admin/promote_user.
    // An existing row for the address is reset to student too, so a new account never inherits
    // a role left on the row; an administrator is re-recorded when they next sign in.
    const result = await sqlConnection`
      INSERT INTO users (id, display_name, email, role, created_at, last_seen_at)
      VALUES (${crypto.randomUUID()}, ${displayName}, ${email}, 'student', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (email) DO UPDATE
      SET last_seen_at = CURRENT_TIMESTAMP, role = 'student'
      RETURNING id, email, role
    `;

    console.log("User created/updated:", { id: result[0]?.id, role: result[0]?.role });

    // IMPORTANT: For Cognito triggers, you must return the event object
    return event;
  } catch (err) {
    console.error("Error inserting user into database:", err);
    // Even on error, return the event to allow sign-up to complete
    // The user can still authenticate, but won't be in the database yet
    return event;
  }
};
