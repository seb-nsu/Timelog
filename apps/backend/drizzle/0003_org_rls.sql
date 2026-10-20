-- Firmenversion: Rollen (user / manager / admin) und Mandantentrennung in der Datenbank.
-- Zweite Verteidigungslinie neben dem Fastify-Hook. Die API setzt app.user_id und app.org_id aus dem
-- Token; für Manager- und Admin-Zugriffe auf Daten eines Mitglieds zusätzlich app.actor_id
-- (app.user_id = Mitglied). Ob der Akteur das darf, prüft die Datenbank selbst (app_can_view).
GRANT SELECT, INSERT, UPDATE, DELETE ON invitations, sso_requests TO timelog_app;
--> statement-breakpoint
-- Audit-Log ist nur anhängbar.
REVOKE UPDATE, DELETE ON audit_log FROM timelog_app;
--> statement-breakpoint
CREATE FUNCTION app_actor_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('app.actor_id', true), '')::uuid, app_user_id())
$$;
--> statement-breakpoint
-- Die folgenden Funktionen lesen Nutzer und Teams ohne RLS. Sie schalten dafür app.bypass_rls nur
-- für ihre eigene Abfrage ein; verschachtelte Aufrufe aus Policies sehen das und kehren sofort zurück,
-- so entsteht keine Rekursion – auch wenn der Tabellen-Eigentümer kein Superuser ist.
CREATE FUNCTION app_actor_role() RETURNS text LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  r text;
BEGIN
  IF app_bypass_rls() THEN
    RETURN NULL;
  END IF;
  IF app_org_id() IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM set_config('app.bypass_rls', 'on', true);
  SELECT u.role INTO r FROM users u
   WHERE u.id = app_actor_id() AND u.org_id = app_org_id()
     AND u.deleted_at IS NULL AND u.deactivated_at IS NULL;
  PERFORM set_config('app.bypass_rls', '', true);
  RETURN r;
END
$$;
--> statement-breakpoint
-- Darf der Akteur die (eingeschränkten) Daten von target sehen? Selbst immer; Admin alle Mitglieder
-- der eigenen Organisation; Manager die Mitglieder der Teams, die er leitet.
CREATE FUNCTION app_can_view(target uuid) RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path = public AS $$
DECLARE
  ok boolean;
BEGIN
  IF app_bypass_rls() THEN
    RETURN true;
  END IF;
  IF target = app_actor_id() THEN
    RETURN true;
  END IF;
  IF app_org_id() IS NULL THEN
    RETURN false;
  END IF;
  PERFORM set_config('app.bypass_rls', 'on', true);
  SELECT EXISTS (
    SELECT 1 FROM users a JOIN users t ON t.org_id = a.org_id
     WHERE a.id = app_actor_id() AND a.org_id = app_org_id() AND t.id = target
       AND a.deleted_at IS NULL AND a.deactivated_at IS NULL
       AND (a.role = 'admin' OR (a.role = 'manager' AND EXISTS (
         SELECT 1 FROM teams tm
          WHERE tm.id = t.team_id AND tm.manager_id = a.id AND tm.org_id = a.org_id)))
  ) INTO ok;
  PERFORM set_config('app.bypass_rls', '', true);
  RETURN ok;
END
$$;
--> statement-breakpoint
-- Zu Beginn jeder Transaktion im Auftrag eines Mitglieds: bricht ab, wenn der Akteur das Mitglied
-- nicht sehen darf.
CREATE FUNCTION app_assert_delegate() RETURNS void LANGUAGE plpgsql VOLATILE AS $$
BEGIN
  IF NOT app_can_view(app_user_id()) THEN
    RAISE EXCEPTION 'delegate not allowed' USING ERRCODE = '42501';
  END IF;
END
$$;
--> statement-breakpoint
-- Schreiben in Nutzerdaten im Auftrag eines anderen (app.actor_id ≠ user_id) nur als Admin.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'events', 'presence_spans', 'devices', 'absences', 'target_hours', 'work_days',
    'corrections', 'refresh_tokens', 'auth_tokens'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT '
      'WITH CHECK (app_bypass_rls() OR app_actor_id() = user_id OR app_actor_role() = ''admin'')',
      t || '_actor_ins', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR UPDATE '
      'USING (app_bypass_rls() OR app_actor_id() = user_id OR app_actor_role() = ''admin'')',
      t || '_actor_upd', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR DELETE '
      'USING (app_bypass_rls() OR app_actor_id() = user_id OR app_actor_role() = ''admin'')',
      t || '_actor_del', t
    );
  END LOOP;
END
$$;
--> statement-breakpoint
-- Nutzer: eingeschränkte Sicht für Manager/Admins, Rollen- und Teamänderungen nur durch Admins.
CREATE POLICY users_org_view ON users FOR SELECT USING (app_can_view(id));
--> statement-breakpoint
CREATE POLICY users_org_admin ON users FOR UPDATE
  USING (org_id = app_org_id() AND app_actor_role() = 'admin')
  WITH CHECK (org_id = app_org_id());
--> statement-breakpoint
CREATE FUNCTION users_guard_org_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user = 'timelog_app' AND NOT app_bypass_rls()
     AND (NEW.role, NEW.org_id, NEW.team_id, NEW.deactivated_at, NEW.sso_subject)
         IS DISTINCT FROM (OLD.role, OLD.org_id, OLD.team_id, OLD.deactivated_at, OLD.sso_subject)
     AND coalesce(app_actor_role(), '') <> 'admin' THEN
    RAISE EXCEPTION 'role, organization and team are managed by an admin' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER users_guard BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION users_guard_org_fields();
--> statement-breakpoint
-- Freigaben: Mitglied reicht ein (auch nach Zurückweisung erneut), Manager/Admin entscheiden –
-- nie über den eigenen Monat.
DROP POLICY approvals_owner ON approvals;
--> statement-breakpoint
CREATE POLICY approvals_read ON approvals FOR SELECT
  USING (app_bypass_rls() OR user_id = app_user_id() OR app_can_view(user_id));
--> statement-breakpoint
CREATE POLICY approvals_submit ON approvals FOR INSERT
  WITH CHECK (app_bypass_rls()
    OR (user_id = app_user_id() AND app_actor_id() = user_id AND status = 'submitted'));
--> statement-breakpoint
CREATE POLICY approvals_resubmit ON approvals FOR UPDATE
  USING (app_bypass_rls()
    OR (user_id = app_user_id() AND app_actor_id() = user_id AND status <> 'approved'))
  WITH CHECK (app_bypass_rls() OR status = 'submitted');
--> statement-breakpoint
CREATE POLICY approvals_decide ON approvals FOR UPDATE
  USING (app_bypass_rls()
    OR (user_id <> app_actor_id() AND app_actor_role() IN ('manager', 'admin')
        AND app_can_view(user_id)));
--> statement-breakpoint
CREATE POLICY approvals_delete ON approvals FOR DELETE USING (app_bypass_rls());
--> statement-breakpoint
DROP POLICY audit_log_org ON audit_log;
--> statement-breakpoint
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (app_bypass_rls() OR (org_id = app_org_id() AND actor_id = app_actor_id()));
--> statement-breakpoint
CREATE POLICY audit_log_read ON audit_log FOR SELECT
  USING (app_bypass_rls() OR (org_id = app_org_id() AND app_actor_role() = 'admin'));
--> statement-breakpoint
DROP POLICY organizations_member ON organizations;
--> statement-breakpoint
CREATE POLICY organizations_read ON organizations FOR SELECT
  USING (app_bypass_rls() OR id = app_org_id());
--> statement-breakpoint
CREATE POLICY organizations_admin ON organizations FOR UPDATE
  USING (app_bypass_rls() OR (id = app_org_id() AND app_actor_role() = 'admin'))
  WITH CHECK (app_bypass_rls() OR id = app_org_id());
--> statement-breakpoint
CREATE POLICY organizations_insert ON organizations FOR INSERT WITH CHECK (app_bypass_rls());
--> statement-breakpoint
CREATE POLICY organizations_delete ON organizations FOR DELETE USING (app_bypass_rls());
--> statement-breakpoint
DROP POLICY teams_org ON teams;
--> statement-breakpoint
CREATE POLICY teams_read ON teams FOR SELECT USING (app_bypass_rls() OR org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY teams_admin_ins ON teams FOR INSERT
  WITH CHECK (app_bypass_rls() OR (org_id = app_org_id() AND app_actor_role() = 'admin'));
--> statement-breakpoint
CREATE POLICY teams_admin_upd ON teams FOR UPDATE
  USING (app_bypass_rls() OR (org_id = app_org_id() AND app_actor_role() = 'admin'))
  WITH CHECK (app_bypass_rls() OR org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY teams_admin_del ON teams FOR DELETE
  USING (app_bypass_rls() OR (org_id = app_org_id() AND app_actor_role() = 'admin'));
--> statement-breakpoint
-- Arbeitsnetze: eigene Netze verwaltet der Nutzer selbst, Firmen-Netze nur der Admin.
DROP POLICY work_networks_owner ON work_networks;
--> statement-breakpoint
CREATE POLICY work_networks_read ON work_networks FOR SELECT
  USING (app_bypass_rls() OR user_id = app_user_id() OR org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY work_networks_ins ON work_networks FOR INSERT
  WITH CHECK (app_bypass_rls()
    OR (user_id = app_user_id() AND org_id IS NULL AND app_actor_id() = user_id)
    OR (user_id IS NULL AND org_id = app_org_id() AND app_actor_role() = 'admin'));
--> statement-breakpoint
CREATE POLICY work_networks_upd ON work_networks FOR UPDATE
  USING (app_bypass_rls()
    OR (user_id = app_user_id() AND org_id IS NULL AND app_actor_id() = user_id)
    OR (user_id IS NULL AND org_id = app_org_id() AND app_actor_role() = 'admin'));
--> statement-breakpoint
CREATE POLICY work_networks_del ON work_networks FOR DELETE
  USING (app_bypass_rls()
    OR (user_id = app_user_id() AND org_id IS NULL AND app_actor_id() = user_id)
    OR (user_id IS NULL AND org_id = app_org_id() AND app_actor_role() = 'admin'));
--> statement-breakpoint
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE invitations FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY invitations_admin ON invitations
  USING (app_bypass_rls() OR (org_id = app_org_id() AND app_actor_role() = 'admin'))
  WITH CHECK (app_bypass_rls() OR (org_id = app_org_id() AND app_actor_role() = 'admin'));
--> statement-breakpoint
ALTER TABLE sso_requests ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE sso_requests FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY sso_requests_system ON sso_requests
  USING (app_bypass_rls()) WITH CHECK (app_bypass_rls());
