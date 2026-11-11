// Supabase public credentials for the isolated United for Sitges community project.
// This is a publishable (browser-safe) key, NEVER a service_role or secret key.
// Public forum launch is requested, but the UI verifies Supabase Auth public
// signup settings before rendering signup. If Auth disallows signups or cannot
// be checked, the page fails closed and leaves moderator login available.
// This flag does not bypass Supabase Auth or email confirmation.
window.UFS_FORUM_CONFIG = Object.freeze({
  url: "https://tlmkeofpeigkfxdydwqt.supabase.co",
  publishableKey: "sb_publishable_STEFkmE2VB_fBTBoQoHbhA_Bjpcqqei",
  enabled: true,
  betaEnabled: true // Keep verified moderator testing accessible if signup is blocked
});
