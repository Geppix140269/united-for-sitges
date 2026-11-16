-- PROPOSED scheduler for the Community Agent. NOT APPLIED.
-- Why Supabase Cron: Vercel Hobby cron runs at most once per day with up to
-- 59 minutes of jitter, which cannot meet 09:00 and 18:00 slots or keep the
-- review queue moving. pg_cron supports minute-level schedules (UTC).
-- Every agent job is idempotent and lease-based, so a 5 minute tick is safe
-- even if runs overlap, are delayed or repeat.
--
-- Run ONLY after: owner approval, extensions enabled in the dashboard,
-- agent migration applied, functions deployed, CRON_SECRET set in Vercel.

-- 1. Extensions (Dashboard > Database > Extensions is preferred).
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 2. Store the bearer secret in Vault (paste the value interactively in the
--    SQL editor; never commit it).
-- select vault.create_secret('<CRON_SECRET value>', 'u4s_agent_cron_secret');

-- 3. Schedule the tick every 5 minutes.
select cron.schedule(
  'u4s-agent-tick',
  '*/5 * * * *',
  $$
  select net.http_post(
    url := 'https://unitedforsitges.com/api/agent/cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'u4s_agent_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);

-- Pause:   select cron.unschedule('u4s-agent-tick');
-- Inspect: select * from cron.job_run_details order by start_time desc limit 20;
--          select * from net._http_response order by created desc limit 20;
