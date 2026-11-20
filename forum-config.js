// Public endpoints of the United for Sitges community backend (Neon project united-for-sitges,
// region eu-central-1). These are browser-safe URLs, not credentials: there is no key here.
// Access is enforced by Neon Auth (verified email) and row-level security (neon/schema.sql).
// Never put a database connection string, password or API key in browser code.
window.UFS_FORUM_CONFIG = Object.freeze({
  authUrl: "https://ep-steep-poetry-bak6vf4f.neonauth.c-8.eu-central-1.aws.neon.tech/neondb/auth",
  dataApiUrl: "https://ep-steep-poetry-bak6vf4f.apirest.c-8.eu-central-1.aws.neon.tech/neondb/rest/v1",
  enabled: true,      // public member registration
  betaEnabled: true   // keep moderator sign-in available if public registration is turned off
});
