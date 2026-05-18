require("dotenv").config({ quiet: true });

const parseOrigins = (value) =>
  (value || "http://localhost:3000,http://127.0.0.1:3000")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

module.exports = {
  port: Number(process.env.PORT || 3001),
  allowedOrigins: parseOrigins(process.env.CORS_ORIGINS),
  tallyHost: process.env.TALLY_HOST || "127.0.0.1",
  tallyPort: Number(process.env.TALLY_PORT || 9000),
  tallyCompanyName: process.env.TALLY_COMPANY_NAME || "",
  databasePath: process.env.DATABASE_PATH || "backend/data/msme-guard.sqlite",
  udyamFailureDir: process.env.UDYAM_FAILURE_DIR || "backend/storage/udyam-failures",
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  anthropicChatModel: process.env.ANTHROPIC_CHAT_MODEL || "claude-sonnet-4-20250514",
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || "msme-guard",
  firebaseServiceAccountPath: process.env.FIREBASE_SERVICE_ACCOUNT_PATH || "",
  authDisabled: process.env.DISABLE_BACKEND_AUTH === "true",
};
