-- Row-Level-Security: zweite Verteidigungslinie neben der Prüfung im Fastify-Hook.
-- Die API arbeitet in jeder Transaktion als Rolle timelog_app (SET LOCAL ROLE) und setzt
-- app.user_id / app.org_id aus dem Token. Nur der Auth-Dienst setzt app.bypass_rls.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'timelog_app') THEN
    CREATE ROLE timelog_app NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT timelog_app TO CURRENT_USER;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO timelog_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO timelog_app;
--> statement-breakpoint
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO timelog_app;
--> statement-breakpoint
-- Ereignisse sind unveränderlich: kein UPDATE, kein DELETE über die API-Rolle.
REVOKE UPDATE, DELETE ON events FROM timelog_app;
--> statement-breakpoint
CREATE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'events are append-only';
END
$$;
--> statement-breakpoint
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
--> statement-breakpoint
CREATE FUNCTION app_user_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.user_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION app_org_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.org_id', true), '')::uuid
$$;
--> statement-breakpoint
CREATE FUNCTION app_bypass_rls() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('app.bypass_rls', true), '') = 'on'
$$;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'events', 'presence_spans', 'devices', 'absences', 'target_hours', 'work_days',
    'corrections', 'approvals', 'refresh_tokens', 'auth_tokens'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app_bypass_rls() OR user_id = app_user_id()) '
      'WITH CHECK (app_bypass_rls() OR user_id = app_user_id())',
      t || '_owner', t
    );
  END LOOP;

  FOREACH t IN ARRAY ARRAY['teams', 'audit_log'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app_bypass_rls() OR org_id = app_org_id()) '
      'WITH CHECK (app_bypass_rls() OR org_id = app_org_id())',
      t || '_org', t
    );
  END LOOP;
END
$$;
--> statement-breakpoint
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE users FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY users_self ON users
  USING (app_bypass_rls() OR id = app_user_id())
  WITH CHECK (app_bypass_rls() OR id = app_user_id());
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE organizations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY organizations_member ON organizations
  USING (app_bypass_rls() OR id = app_org_id())
  WITH CHECK (app_bypass_rls() OR id = app_org_id());
--> statement-breakpoint
ALTER TABLE work_networks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE work_networks FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY work_networks_owner ON work_networks
  USING (app_bypass_rls() OR user_id = app_user_id() OR org_id = app_org_id())
  WITH CHECK (app_bypass_rls() OR user_id = app_user_id() OR org_id = app_org_id());
