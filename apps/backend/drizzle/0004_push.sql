CREATE TABLE "push_prompts" (
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ref" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"sent_to" integer DEFAULT 0 NOT NULL,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "push_prompts_user_id_kind_ref_pk" PRIMARY KEY("user_id","kind","ref")
);
--> statement-breakpoint
ALTER TABLE "devices" ADD COLUMN "locale" text;--> statement-breakpoint
ALTER TABLE "push_prompts" ADD CONSTRAINT "push_prompts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "push_prompts_user_created" ON "push_prompts" USING btree ("user_id","created_at");
--> statement-breakpoint
-- Rückfragen per Push: nur der Nutzer selbst (bzw. Job mit bypass); Manager und Admins sehen sie
-- nie. Löschen nur als Eigentümer (Kontolöschung, Lösch-Job).
GRANT SELECT, INSERT, UPDATE ON push_prompts TO timelog_app;
--> statement-breakpoint
ALTER TABLE push_prompts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE push_prompts FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY push_prompts_owner ON push_prompts
  USING (app_bypass_rls() OR (user_id = app_user_id() AND app_actor_id() = user_id))
  WITH CHECK (app_bypass_rls() OR (user_id = app_user_id() AND app_actor_id() = user_id));