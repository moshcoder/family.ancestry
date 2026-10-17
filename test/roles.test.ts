import { describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { Store, inviteRole } from '../src/db.ts'
import { Auth } from '../src/auth.ts'
import { createApp } from '../src/server.ts'

const SITE = 'https://family.test'
const CSRF = 'testcsrftoken0123456789'

function world() {
  const store = new Store(':memory:')
  const mail: { to: string; text: string }[] = []
  const auth = new Auth(store, async (m) => void mail.push(m), SITE)
  const app = createApp({ store, auth, site: SITE })
  const as = (userId: string) => {
    const cookie = `fa_session=${auth.createSession(userId)}; fa_csrf=${CSRF}`
    return {
      get: (path: string) => app.request(`${SITE}${path}`, { headers: { cookie } }),
      post: (path: string, fields: Record<string, string> = {}) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: SITE }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) }),
    }
  }
  return { store, auth, app, mail, as }
}

describe('one owner, then admins, editors and viewers', () => {
  test('who may hand out which role', () => {
    expect(inviteRole('owner', 'admin')).toBe('admin')
    expect(inviteRole('admin', 'admin')).toBe('admin')
    expect(inviteRole('admin', 'owner')).toBe('viewer')
    expect(inviteRole('editor', 'editor')).toBe('viewer')
    expect(inviteRole('viewer', 'viewer')).toBe('viewer')
  })

  test('an admin runs the family; only the owner can delete it, and nobody touches the owner', async () => {
    const w = world()
    const owner = w.store.findOrCreateUser('owner@example.com')
    const admin = w.store.findOrCreateUser('admin@example.com')
    const tree = w.store.createTree(owner.id, 'Fam')
    w.store.setMember(tree.id, admin.id, 'admin')
    const a = w.as(admin.id)
    // Invites as editor and admin, by email.
    await a.post(`/t/${tree.id}/invites`, { emails: 'ken@example.com', role: 'editor' })
    await a.post(`/t/${tree.id}/invites`, { emails: 'cousin@example.com', role: 'admin' })
    expect(w.store.pendingInvites(tree.id).map((i) => [i.email, i.role]).sort()).toEqual([['cousin@example.com', 'admin'], ['ken@example.com', 'editor']])
    expect(w.mail.find((m) => m.to === 'cousin@example.com')!.text).toContain('an admin')
    // Role changes and removal, but never the owner.
    const ed = w.store.findOrCreateUser('ed@example.com')
    w.store.setMember(tree.id, ed.id, 'viewer')
    await a.post(`/t/${tree.id}/members/${ed.id}`, { role: 'editor' })
    expect(w.store.role(tree.id, ed.id)).toBe('editor')
    await a.post(`/t/${tree.id}/members/${owner.id}`, { role: 'viewer' })
    await a.post(`/t/${tree.id}/members/${owner.id}/remove`)
    expect(w.store.role(tree.id, owner.id)).toBe('owner')
    expect((await a.post(`/t/${tree.id}/delete`)).status).toBe(403)
    expect(w.store.tree(tree.id)).not.toBeNull()
    // The members page offers admins every role below owner.
    const page = await (await a.get(`/t/${tree.id}/members`)).text()
    expect(page).toContain('<option>admin</option>')
  })

  test('an editor invites viewers only; an invite never demotes', async () => {
    const w = world()
    const owner = w.store.findOrCreateUser('owner@example.com')
    const editor = w.store.findOrCreateUser('editor@example.com')
    const tree = w.store.createTree(owner.id, 'Fam')
    w.store.setMember(tree.id, editor.id, 'editor')
    await w.as(editor.id).post(`/t/${tree.id}/invites`, { emails: 'x@example.com', role: 'admin' })
    expect(w.store.pendingInvites(tree.id)[0]!.role).toBe('viewer')
    expect((await w.as(editor.id).post(`/t/${tree.id}/members/${owner.id}`, { role: 'viewer' })).status).toBe(403)
    const viewerLink = w.store.createInvite(tree.id, owner.id, 'viewer')
    const adminLink = w.store.createInvite(tree.id, owner.id, 'admin')
    w.store.acceptInvite(adminLink, editor.id)
    expect(w.store.role(tree.id, editor.id)).toBe('admin')
    w.store.acceptInvite(viewerLink, editor.id)
    expect(w.store.role(tree.id, editor.id)).toBe('admin')
  })

  test('a living person without a profile shows a visible invite with the roles you may give', async () => {
    const w = world()
    const owner = w.store.findOrCreateUser('owner@example.com')
    const tree = w.store.createTree(owner.id, 'Fam')
    const ken = w.store.addPerson(tree.id, { given: 'Ken', surname: 'Ettinger' })
    const html = await (await w.as(owner.id).get(`/t/${tree.id}/p/${ken.id}`)).text()
    expect(html).toContain('<h2>Invite Ken</h2>')
    expect(html).toContain('editor: adds and changes people (their branch)')
    expect(html).toContain('admin: also invites and manages the family')
  })
})

test('an older database gets the admin role without losing a member or an invite', () => {
  const dir = mkdtempSync(join(import.meta.dir, '.tmp-roles-'))
  try {
    const path = join(dir, 'family.db')
    const first = new Store(path)
    const owner = first.findOrCreateUser('owner@example.com')
    const tree = first.createTree(owner.id, 'Fam')
    first.createInvite(tree.id, owner.id, 'editor', 'ken@example.com', { note: 'hi' })
    first.db.close()
    // Put the tables back the way 0.8 made them: the narrow CHECKs.
    const raw = new Database(path)
    for (const [table, wide, narrow] of [['members', "CHECK (role IN ('owner','admin','editor','viewer'))", "CHECK (role IN ('owner','editor','viewer'))"], ['invites', "CHECK (role IN ('admin','editor','viewer'))", "CHECK (role IN ('editor','viewer'))"]] as const) {
      const sql = raw.query<{ sql: string }, [string]>("SELECT sql FROM sqlite_master WHERE name = ?").get(table)!.sql
      raw.run('PRAGMA foreign_keys = OFF')
      raw.run(sql.replace(wide, narrow).replace(`CREATE TABLE ${table}`, 'CREATE TABLE old_t'))
      raw.run(`INSERT INTO old_t SELECT * FROM ${table}`)
      raw.run(`DROP TABLE ${table}`)
      raw.run(`ALTER TABLE old_t RENAME TO ${table}`)
    }
    expect(() => raw.run(`UPDATE members SET role = 'admin'`)).toThrow()
    raw.close()
    const again = new Store(path)
    expect(again.role(tree.id, owner.id)).toBe('owner')
    expect(again.pendingInvites(tree.id).map((i) => [i.email, i.role, i.note])).toEqual([['ken@example.com', 'editor', 'hi']])
    const admin = again.findOrCreateUser('admin@example.com')
    again.setMember(tree.id, admin.id, 'admin')
    expect(again.role(tree.id, admin.id)).toBe('admin')
    again.db.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
