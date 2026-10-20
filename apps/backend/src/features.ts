// Schalter für Projekte, Kalender und Homeoffice-Monatszahlen: privat aus den Einstellungen,
// in Firmen aus organizations.features (Admin).
import { type OrgFeatures, orgFeatures, settingsSchema } from '@timelog/shared';
import { eq } from 'drizzle-orm';
import type { Tx } from './db/index.js';
import { organizations, type users } from './db/schema.js';

export function parseFeatures(raw: unknown): OrgFeatures {
  const parsed = orgFeatures.safeParse(raw);
  return parsed.success ? parsed.data : orgFeatures.parse({});
}

export interface EffectiveFeatures {
  projects: boolean;
  calendar: boolean;
  homeOfficeReport: boolean;
}

export async function featuresOf(
  tx: Tx,
  user: typeof users.$inferSelect,
): Promise<EffectiveFeatures> {
  if (user.orgId) {
    const [org] = await tx
      .select({ features: organizations.features })
      .from(organizations)
      .where(eq(organizations.id, user.orgId));
    return parseFeatures(org?.features);
  }
  const settings = settingsSchema.safeParse(user.settings);
  return {
    projects: settings.success && settings.data.projects,
    calendar: true,
    homeOfficeReport: false,
  };
}
