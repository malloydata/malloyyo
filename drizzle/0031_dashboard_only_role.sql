-- A third built-in role, and the only one that takes something away.
--
-- A person holding MALLOYYO_DASHBOARD_ONLY opens dashboards and nothing else:
-- no query editor, no chat, no MCP connector, no API tokens, no draft
-- dashboards. Which dashboards is decided as it is for everyone — by the
-- datasets their roles open, and by who a private dashboard is shared with.
--
-- Nobody is given it here. Every existing person keeps exactly what they could
-- do before this ran, which is the reason it is a role that restricts rather
-- than a capability whose absence restricts: people admitted through a hosted
-- sign-in hold no built-in role at all, so "lacks the right to query" would
-- have described every one of them the moment it deployed.
INSERT INTO "roles" ("name", "description", "builtin") VALUES
  ('MALLOYYO_DASHBOARD_ONLY', 'Dashboards only: opens the dashboards their other roles allow, and cannot query — no query editor, chat, MCP connector, API tokens or draft dashboards. Admins are unaffected.', true)
ON CONFLICT ("name") DO NOTHING;
