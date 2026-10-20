CREATE TABLE "calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"refresh_token" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"all_day" boolean NOT NULL,
	"start_date" date,
	"end_date" date,
	"kind" text NOT NULL,
	"project_id" uuid
);
--> statement-breakpoint
CREATE TABLE "calendar_oauth_states" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text NOT NULL,
	"redirect" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "day_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"location" text,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_assignments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"date" date NOT NULL,
	"from_ts" timestamp with time zone NOT NULL,
	"to_ts" timestamp with time zone NOT NULL,
	"project_id" uuid,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"org_id" uuid,
	"team_id" uuid,
	"name" text NOT NULL,
	"customer" text,
	"color" text DEFAULT '#1d4ed8' NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "features" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "work_networks" ADD COLUMN "location" text DEFAULT 'office' NOT NULL;--> statement-breakpoint
ALTER TABLE "work_networks" ADD COLUMN "default_project_id" uuid;--> statement-breakpoint
ALTER TABLE "calendar_connections" ADD CONSTRAINT "calendar_connections_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_entries" ADD CONSTRAINT "calendar_entries_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_entries" ADD CONSTRAINT "calendar_entries_connection_id_calendar_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."calendar_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "calendar_oauth_states" ADD CONSTRAINT "calendar_oauth_states_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "day_locations" ADD CONSTRAINT "day_locations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_assignments" ADD CONSTRAINT "project_assignments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_team_id_teams_id_fk" FOREIGN KEY ("team_id") REFERENCES "public"."teams"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "calendar_connections_user_provider" ON "calendar_connections" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "calendar_entries_user_start" ON "calendar_entries" USING btree ("user_id","start_at");--> statement-breakpoint
CREATE INDEX "day_locations_user_date" ON "day_locations" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "project_assignments_user_date" ON "project_assignments" USING btree ("user_id","date");--> statement-breakpoint
CREATE INDEX "projects_user" ON "projects" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_org" ON "projects" USING btree ("org_id");--> statement-breakpoint
-- ── Paket B: Rechte, Row-Level-Security, Unveränderlichkeit ──────────────────
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_xor" CHECK (("user_id" IS NULL) <> ("org_id" IS NULL));
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON projects, calendar_connections, calendar_entries, calendar_oauth_states TO timelog_app;
--> statement-breakpoint
-- Manuelle Projektzuordnungen und Tagesorte sind wie Ereignisse nur anhängbar.
GRANT SELECT, INSERT ON project_assignments, day_locations TO timelog_app;
--> statement-breakpoint
CREATE FUNCTION append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME;
END
$$;
--> statement-breakpoint
CREATE TRIGGER project_assignments_no_update BEFORE UPDATE ON project_assignments
  FOR EACH ROW EXECUTE FUNCTION append_only();
--> statement-breakpoint
CREATE TRIGGER day_locations_no_update BEFORE UPDATE ON day_locations
  FOR EACH ROW EXECUTE FUNCTION append_only();
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'project_assignments', 'day_locations', 'calendar_connections', 'calendar_entries',
    'calendar_oauth_states'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (app_bypass_rls() OR user_id = app_user_id()) '
      'WITH CHECK (app_bypass_rls() OR user_id = app_user_id())',
      t || '_owner', t
    );
  END LOOP;

  -- Projektzuordnung und Tagesort im Auftrag eines anderen nur durch Admins (wie Korrekturen).
  FOREACH t IN ARRAY ARRAY['project_assignments', 'day_locations'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE FOR INSERT '
      'WITH CHECK (app_bypass_rls() OR app_actor_id() = user_id OR app_actor_role() = ''admin'')',
      t || '_actor_ins', t
    );
  END LOOP;

  -- Kalenderdaten sieht und ändert nur die Person selbst, auch kein Admin oder Manager.
  FOREACH t IN ARRAY ARRAY['calendar_connections', 'calendar_entries', 'calendar_oauth_states'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I AS RESTRICTIVE '
      'USING (app_bypass_rls() OR app_actor_id() = user_id) '
      'WITH CHECK (app_bypass_rls() OR app_actor_id() = user_id)',
      t || '_self', t
    );
  END LOOP;
END
$$;
--> statement-breakpoint
-- Projekte: eigene verwaltet der Nutzer, Firmenprojekte nur der Admin; lesen dürfen alle Mitglieder.
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE projects FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY projects_read ON projects FOR SELECT
  USING (app_bypass_rls() OR user_id = app_user_id() OR org_id = app_org_id());
--> statement-breakpoint
CREATE POLICY projects_ins ON projects FOR INSERT
  WITH CHECK (app_bypass_rls()
    OR (user_id = app_user_id() AND org_id IS NULL AND app_actor_id() = user_id)
    OR (user_id IS NULL AND org_id = app_org_id() AND app_actor_role() = 'admin'));
--> statement-breakpoint
CREATE POLICY projects_upd ON projects FOR UPDATE
  USING (app_bypass_rls()
    OR (user_id = app_user_id() AND org_id IS NULL AND app_actor_id() = user_id)
    OR (user_id IS NULL AND org_id = app_org_id() AND app_actor_role() = 'admin'))
  WITH CHECK (app_bypass_rls()
    OR (user_id = app_user_id() AND org_id IS NULL)
    OR (user_id IS NULL AND org_id = app_org_id()));
--> statement-breakpoint
CREATE POLICY projects_del ON projects FOR DELETE USING (app_bypass_rls());
