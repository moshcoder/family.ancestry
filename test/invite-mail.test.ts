import { expect, test } from 'bun:test'
import { Store } from '../src/db.ts'
import { Auth, resendMailer, resendStatus, type Mail, type MailStatus } from '../src/auth.ts'
import { createApp } from '../src/server.ts'

const SITE = 'http://family.test'
const CSRF = 'testcsrftoken0123456789'

test('an invite that bounces says so on the Members page, the API and the flash; a send error and the day limit too', async () => {
  // Invites made a minute ago, so the Members page asks the provider about them.
  const store = new Store(':memory:', () => Date.now() - 60_000)
  const sent: Mail[] = []
  const auth = new Auth(
    store,
    async (m) => {
      if (m.to === 'broken@example.com') throw new Error('mail provider answered 422: Invalid `to` field')
      sent.push(m)
      return `id-${m.to}`
    },
    SITE,
  )
  const answers: Record<string, MailStatus> = {
    'id-rmarcos@yahoo.example': { status: 'bounced', reason: 'smtp; 552 1 Requested mail action aborted, mailbox not found' },
    'id-achang@yahoo.example': { status: 'delivered', reason: null },
  }
  const asked: string[] = []
  const app = createApp({ store, auth, site: SITE, mailStatus: async (id) => (asked.push(id), answers[id] ?? null) })
  const me = store.findOrCreateUser('tony@example.com')
  const tree = store.createTree(me.id, 'The Ettinger Family')
  const cookie = `fa_session=${auth.createSession(me.id)}; fa_csrf=${CSRF}`
  const post = (path: string, fields: Record<string, string>) => app.request(`${SITE}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) })

  const res = await post(`/t/${tree.id}/invites`, { emails: 'rmarcos@yahoo.example, achang@yahoo.example, broken@example.com', role: 'editor' })
  const flash = await res.text()
  expect(flash).toContain('Emailed 2 of 3.')
  expect(flash).toContain('Could not email broken@example.com: mail provider answered 422: Invalid `to` field')
  expect(sent[0]!.subject).toBe('tony@example.com invited you to The Ettinger Family tree')

  const page = await (await app.request(`${SITE}/t/${tree.id}/members`, { headers: { cookie } })).text()
  expect(page).toContain('bounced: that address does not exist. Check the spelling, cancel and invite again')
  expect(page).toContain('email delivered')
  expect(page).toContain('could not send: mail provider answered 422')
  expect(page).toContain('mail-bad')
  // Final answers stick: the next visit asks nobody.
  const before = asked.length
  await app.request(`${SITE}/t/${tree.id}/members`, { headers: { cookie } })
  expect(asked.length).toBe(before)

  const token = auth.createToken(me.id, 'test')
  const api = (await (await app.request(`${SITE}/api/v1/trees/${tree.id}/invites`, { headers: { authorization: `Bearer ${token}` } })).json()) as any
  const bounced = api.invites.find((i: any) => i.email === 'rmarcos@yahoo.example')
  expect(bounced.mail_status).toBe('bounced')
  expect(bounced.mail.tone).toBe('bad')
})

test('over the day limit: held, and the page says it was not emailed', async () => {
  const store = new Store(':memory:')
  const auth = new Auth(store, async () => 'id', SITE)
  const app = createApp({ store, auth, site: SITE })
  const me = store.findOrCreateUser('tony@example.com')
  const tree = store.createTree(me.id, 'Fam')
  const cookie = `fa_session=${auth.createSession(me.id)}; fa_csrf=${CSRF}`
  const post = (fields: Record<string, string>) => app.request(`${SITE}/t/${tree.id}/invites`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: CSRF, ...fields }) })
  // 40 invitations a day per sender; a paste takes 20 at a time.
  let last = ''
  for (let batch = 0; batch < 3; batch++) last = await (await post({ emails: Array.from({ length: 20 }, (_, i) => `p${batch}-${i}@example.com`).join('\n') })).text()
  expect(last).toContain("20 more are over the day&#39;s invitation limit")
  expect(store.pendingInvites(tree.id).some((i) => i.mail_status === 'held')).toBe(true)
  const page = await (await app.request(`${SITE}/t/${tree.id}/members`, { headers: { cookie } })).text()
  expect(page).toContain("not emailed: over the day&#39;s invitation limit")
})

test('Resend: the send returns its id, an error carries the reason, the status reads the bounce', async () => {
  const calls: string[] = []
  const fake = (async (url: string, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`)
    if (String(url).endsWith('/emails') && String(init?.body).includes('bad@')) return new Response(JSON.stringify({ message: 'Invalid `to` field' }), { status: 422 })
    if (String(url).endsWith('/emails')) return new Response(JSON.stringify({ id: 'em_1' }))
    return new Response(JSON.stringify({ last_event: 'bounced', bounce: { message: 'hard', diagnosticCode: ['smtp; 552 mailbox not found'] } }))
  }) as unknown as typeof fetch
  const send = resendMailer('re_x', 'f <f@x>', fake)
  expect(await send({ to: 'a@x.com', subject: 's', text: 't', html: 'h' })).toBe('em_1')
  await expect(send({ to: 'bad@x.com', subject: 's', text: 't', html: 'h' })).rejects.toThrow('mail provider answered 422: Invalid `to` field')
  expect(await resendStatus('re_x', fake)('em_1')).toEqual({ status: 'bounced', reason: 'smtp; 552 mailbox not found' })
  expect(calls.at(-1)).toBe('GET https://api.resend.com/emails/em_1')
})
