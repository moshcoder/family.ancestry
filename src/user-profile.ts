/**
 * The shared Profullstack profile (@profullstack/profile): email, first and last
 * name, company domain, job title and LinkedIn URL, in the package's own
 * `user_profiles` table keyed by users.id. Private to the account; unrelated to
 * the public person profiles in profile.ts.
 */
import type { Database } from 'bun:sqlite'
import { createProfileStore, migrate, splitFullName, type ProfileStore } from '@profullstack/profile'

/** The store, and `ready` once its table exists (created as the app starts). */
export function openUserProfiles(db: Database): { store: ProfileStore; ready: Promise<ProfileStore> } {
  // bun:sqlite's cached db.query() statements: close() finalizes them, so the file is released.
  const adapter = { dialect: 'sqlite' as const, query: async (text: string, params: unknown[] = []) => db.query(text).all(...(params as never[])) as Record<string, unknown>[] }
  const store = createProfileStore(adapter, { keyType: 'text' })
  const ready = migrate(store).then(async () => {
    await backfill(db, store)
    return store
  })
  ready.catch((error) => console.error(`[profile] migration failed: ${(error as Error).message}`))
  return { store, ready }
}

/** pit.world-only accounts have a placeholder address: no email to keep. */
export const realEmail = (email: string) => (email.endsWith('.invalid') ? null : email)

/**
 * One-time and idempotent: a name typed as "First Last" becomes the profile's
 * names. A single word is left alone, and fillBlanks never overwrites what a
 * member saved.
 */
async function backfill(db: Database, store: ProfileStore) {
  const rows = db.query<{ id: string; email: string; name: string }, []>(`SELECT u.id, u.email, u.name FROM users u
    WHERE instr(trim(u.name), ' ') > 0 AND NOT EXISTS (SELECT 1 FROM user_profiles p WHERE p.user_id = u.id)`).all()
  for (const row of rows) {
    const email = realEmail(row.email)
    try { await store.fillBlanks(row.id, { ...splitFullName(row.name), ...(email ? { email } : {}) }) } catch { /* a name the validator refuses is skipped */ }
  }
}
