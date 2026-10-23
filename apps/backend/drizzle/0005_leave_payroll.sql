CREATE TABLE "leave_adjustments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"year" integer NOT NULL,
	"kind" text NOT NULL,
	"days" double precision NOT NULL,
	"comment" text NOT NULL,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_profiles" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"annual_days" double precision,
	"workdays_per_week" double precision,
	"entry_date" date,
	"exit_date" date,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_request_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"action" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leave_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"org_id" uuid,
	"kind" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"half_day_start" boolean DEFAULT false NOT NULL,
	"half_day_end" boolean DEFAULT false NOT NULL,
	"days" double precision NOT NULL,
	"minutes" integer NOT NULL,
	"note" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_comment" text,
	"cancelled_by" uuid,
	"cancelled_at" timestamp with time zone,
	"cancel_comment" text
);
--> statement-breakpoint
CREATE TABLE "member_payroll" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"org_id" uuid NOT NULL,
	"personnel_number" text,
	"personio_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "overtime_bookings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"month" text NOT NULL,
	"minutes" integer NOT NULL,
	"kind" text NOT NULL,
	"comment" text NOT NULL,
	"author_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_credentials" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_enc" text NOT NULL,
	"updated_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_transfers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"month" text NOT NULL,
	"provider" text NOT NULL,
	"actor_id" uuid NOT NULL,
	"status" text NOT NULL,
	"result" jsonb NOT NULL,
	"period_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "absences" ADD COLUMN "request_id" uuid;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "absences_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "leave_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "payroll_config" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "leave_adjustments" ADD CONSTRAINT "leave_adjustments_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_profiles" ADD CONSTRAINT "leave_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_events" ADD CONSTRAINT "leave_request_events_request_id_leave_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."leave_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_request_events" ADD CONSTRAINT "leave_request_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leave_requests" ADD CONSTRAINT "leave_requests_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_payroll" ADD CONSTRAINT "member_payroll_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_payroll" ADD CONSTRAINT "member_payroll_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "overtime_bookings" ADD CONSTRAINT "overtime_bookings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_credentials" ADD CONSTRAINT "payroll_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_transfers" ADD CONSTRAINT "payroll_transfers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "leave_adjustments_user" ON "leave_adjustments" USING btree ("user_id","year");--> statement-breakpoint
CREATE INDEX "leave_request_events_request" ON "leave_request_events" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "leave_requests_user" ON "leave_requests" USING btree ("user_id","from_date");--> statement-breakpoint
CREATE INDEX "leave_requests_org" ON "leave_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "overtime_bookings_user" ON "overtime_bookings" USING btree ("user_id","month");--> statement-breakpoint
CREATE INDEX "payroll_transfers_org" ON "payroll_transfers" USING btree ("org_id","month");--> statement-breakpoint
CREATE INDEX "absences_request" ON "absences" USING btree ("request_id");
--> statement-breakpoint
-- Urlaubs- und Überstundenkonto, Lohn-Export: Rechte und Row-Level-Security (zweite Linie neben
-- dem Fastify-Hook). Protokolle sind nur anhängbar.
GRANT SELECT, INSERT, UPDATE, DELETE ON leave_profiles, leave_requests, leave_request_events,
  leave_adjustments, overtime_bookings, member_payroll, payroll_credentials, payroll_transfers
  TO timelog_app;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON leave_request_events, leave_adjustments, overtime_bookings, payroll_transfers
  FROM timelog_app;
--> statement-breakpoint
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'leave_profiles', 'leave_requests', 'leave_request_events', 'leave_adjustments',
    'overtime_bookings', 'member_payroll', 'payroll_credentials', 'payroll_transfers'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
  -- Anspruch und manuelle Buchungen: lesen die Person selbst und wer sie sehen darf (Manager/Admin
  -- über app.actor_id); schreiben die Person selbst nur ohne Organisation (Privatkonto), sonst Admin.
  FOREACH t IN ARRAY ARRAY['leave_profiles', 'leave_adjustments', 'overtime_bookings'] LOOP
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR SELECT USING (app_bypass_rls() OR user_id = app_user_id())',
      t || '_read', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR INSERT WITH CHECK (app_bypass_rls() OR (user_id = app_user_id() '
      'AND ((app_actor_id() = user_id AND app_org_id() IS NULL) OR app_actor_role() = ''admin'')))',
      t || '_write', t
    );
  END LOOP;
END
$$;
--> statement-breakpoint
CREATE POLICY leave_profiles_update ON leave_profiles FOR UPDATE
  USING (app_bypass_rls() OR (user_id = app_user_id()
    AND ((app_actor_id() = user_id AND app_org_id() IS NULL) OR app_actor_role() = 'admin')));
--> statement-breakpoint
CREATE POLICY leave_profiles_delete ON leave_profiles FOR DELETE USING (app_bypass_rls());
--> statement-breakpoint
-- Anträge: Person stellt selbst (Firma: offen; privat: sofort genehmigt) und storniert selbst;
-- Manager/Admin entscheiden über sichtbare Mitglieder, nie über die eigenen Anträge.
CREATE POLICY leave_requests_read ON leave_requests FOR SELECT
  USING (app_bypass_rls() OR user_id = app_user_id() OR app_can_view(user_id));
--> statement-breakpoint
CREATE POLICY leave_requests_insert ON leave_requests FOR INSERT
  WITH CHECK (app_bypass_rls() OR (user_id = app_user_id() AND app_actor_id() = user_id
    AND ((org_id IS NOT NULL AND org_id = app_org_id() AND status = 'pending')
      OR (org_id IS NULL AND app_org_id() IS NULL AND status = 'approved'))));
--> statement-breakpoint
CREATE POLICY leave_requests_own_cancel ON leave_requests FOR UPDATE
  USING (app_bypass_rls() OR (user_id = app_user_id() AND app_actor_id() = user_id))
  WITH CHECK (app_bypass_rls() OR status = 'cancelled');
--> statement-breakpoint
CREATE POLICY leave_requests_decide ON leave_requests FOR UPDATE
  USING (app_bypass_rls() OR (user_id <> app_actor_id() AND org_id = app_org_id()
    AND app_actor_role() IN ('manager', 'admin') AND app_can_view(user_id)));
--> statement-breakpoint
CREATE POLICY leave_requests_delete ON leave_requests FOR DELETE USING (app_bypass_rls());
--> statement-breakpoint
CREATE POLICY leave_request_events_read ON leave_request_events FOR SELECT
  USING (app_bypass_rls() OR user_id = app_user_id() OR app_can_view(user_id));
--> statement-breakpoint
CREATE POLICY leave_request_events_insert ON leave_request_events FOR INSERT
  WITH CHECK (app_bypass_rls() OR (actor_id = app_actor_id()
    AND (user_id = app_user_id() OR app_can_view(user_id))));
--> statement-breakpoint
-- Abwesenheiten aus genehmigten Anträgen darf auch der entscheidende Manager anlegen bzw. bei
-- Stornierung entfernen (sonst schreibt nur die Person selbst oder ein Admin).
DROP POLICY absences_actor_ins ON absences;
--> statement-breakpoint
DROP POLICY absences_actor_del ON absences;
--> statement-breakpoint
CREATE POLICY absences_actor_ins ON absences AS RESTRICTIVE FOR INSERT
  WITH CHECK (app_bypass_rls() OR app_actor_id() = user_id OR app_actor_role() = 'admin'
    OR (request_id IS NOT NULL AND app_actor_role() = 'manager' AND app_can_view(user_id)));
--> statement-breakpoint
CREATE POLICY absences_actor_del ON absences AS RESTRICTIVE FOR DELETE
  USING (app_bypass_rls() OR app_actor_id() = user_id OR app_actor_role() = 'admin'
    OR (request_id IS NOT NULL AND app_actor_role() = 'manager' AND app_can_view(user_id)));
--> statement-breakpoint
-- Lohn-Zuordnung, Zugangsdaten und Übertragungsprotokoll: nur Admins der eigenen Organisation;
-- die eigene Personalnummer darf die Person lesen.
CREATE POLICY member_payroll_read ON member_payroll FOR SELECT
  USING (app_bypass_rls() OR (org_id = app_org_id()
    AND (user_id = app_actor_id() OR app_actor_role() = 'admin')));
--> statement-breakpoint
CREATE POLICY member_payroll_admin ON member_payroll FOR ALL
  USING (app_bypass_rls() OR (org_id = app_org_id() AND app_actor_role() = 'admin'))
  WITH CHECK (app_bypass_rls() OR (org_id = app_org_id() AND app_actor_role() = 'admin'));
--> statement-breakpoint
CREATE POLICY payroll_credentials_admin ON payroll_credentials FOR ALL
  USING (app_bypass_rls() OR (org_id = app_org_id() AND app_actor_role() = 'admin'))
  WITH CHECK (app_bypass_rls() OR (org_id = app_org_id() AND app_actor_role() = 'admin'));
--> statement-breakpoint
CREATE POLICY payroll_transfers_read ON payroll_transfers FOR SELECT
  USING (app_bypass_rls() OR (org_id = app_org_id() AND app_actor_role() = 'admin'));
--> statement-breakpoint
CREATE POLICY payroll_transfers_insert ON payroll_transfers FOR INSERT
  WITH CHECK (app_bypass_rls() OR (org_id = app_org_id() AND actor_id = app_actor_id()
    AND app_actor_role() = 'admin'));
