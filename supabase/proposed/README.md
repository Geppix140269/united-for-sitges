# Proposed SQL (NOT migrations, NOT applied)

Files here change production configuration and need explicit owner
authorisation before anyone runs them. They are kept out of
`supabase/migrations/` so that `supabase db push` can never apply them by
accident.

| File | Purpose | Prerequisites |
| --- | --- | --- |
| `harden_admin_contact.sql` | Defence in depth for `ufs_internal.admin_contact` (enable and force RLS, explicit revokes). Effective access is already blocked by missing schema USAGE. | Owner approval. Tested locally. |
| `agent_scheduler_supabase_cron.sql` | Calls `/api/agent/cron` every 5 minutes through `pg_cron` + `pg_net`, with the bearer secret stored in Supabase Vault. | Owner approval to enable the `pg_cron` and `pg_net` extensions; `CRON_SECRET` set in Vercel and Vault; agent migration applied; production deployment of the functions. |
