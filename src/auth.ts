/**
 * Who is asking. Four ways in, one account:
 *
 * - an emailed magic link, which is also sign-up (an unknown address makes the
 *   account) and the way back when a device is lost;
 * - a passkey, added afterwards from Settings, the fast path from then on;
 * - a session cookie, which is what either of those hands the browser;
 * - a bearer API token, which is what the CLI, the TUI, the MCP server and the
 *   desktop app carry. The CLI gets one through an authorization-code + PKCE
 *   (S256) round trip through the browser, so a token is never typed or pasted.
 *
 * Every secret is stored as its SHA-256 only. The magic-link endpoint never says
 * whether an address has an account.
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { newId, sha256, type Store, type User } from './db.js'

export const SESSION_COOKIE = 'fa_session'
const SESSION_DAYS = 90
const LINK_MINUTES = 20
const CLI_CODE_MINUTES = 5

export type Mail = { to: string; subject: string; text: string; html: string }
export type Mailer = (mail: Mail) => Promise<void>

export function resendMailer(apiKey: string, from: string, fetchImpl: typeof fetch = fetch): Mailer {
  return async ({ to, subject, text, html }) => {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`mail provider answered ${res.status}`)
  }
}

/** Without a mail key (local dev, the desktop app's own server) the link goes to the log instead. */
export const consoleMailer: Mailer = async ({ to, text }) => {
  console.log(`[mail] to ${to}\n${text}`)
}

export const validEmail = (value: unknown): string | null => {
  const email = String(value ?? '').trim().toLowerCase()
  return email.length <= 254 && /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[a-z0-9-]{2,}$/i.test(email) ? email : null
}

/** Only same-site paths survive a redirect, so a link can never bounce someone off-site. */
export const safeNext = (value: unknown): string | null => {
  const next = String(value ?? '')
  return next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') && next.length < 500 ? next : null
}

export class Auth {
  private challenges = new Map<string, { challenge: string; userId: string | null; expires: number }>()

  constructor(
    private store: Store,
    private mailer: Mailer,
    readonly site: string,
    private now = () => Date.now(),
  ) {}

  /** Send any mail through the configured mailer (invites use this). */
  mail(mail: Mail): Promise<void> {
    return this.mailer(mail)
  }

  get rpID() {
    return new URL(this.site).hostname
  }

  // ---- magic links -------------------------------------------------------

  /** Always resolves; the caller answers the same thing whatever happens, so nobody learns who has an account. */
  async sendLink(emailInput: string, next: string | null = null): Promise<boolean> {
    const email = validEmail(emailInput)
    if (!email) return false
    const recent = this.store.db.query<{ n: number }, [string, number]>('SELECT COUNT(*) AS n FROM magic_links WHERE email = ? AND created_at > ?').get(email, this.now() - 15 * 60_000)?.n ?? 0
    if (recent >= 5) return true
    const token = newId(24)
    this.store.db.query('INSERT INTO magic_links (token_hash,email,next,created_at,expires_at) VALUES (?,?,?,?,?)').run(sha256(token), email, safeNext(next), this.now(), this.now() + LINK_MINUTES * 60_000)
    const url = `${this.site}/auth/verify?token=${token}`
    const text = `Sign in to family.ancestry:\n\n${url}\n\nThe link works once, for ${LINK_MINUTES} minutes. If you did not ask for it, ignore this email.`
    const html = `<p>Sign in to <strong>family.ancestry</strong>:</p><p><a href="${url}" style="display:inline-block;padding:10px 18px;background:#3d6b4f;color:#fff;border-radius:6px;text-decoration:none">Sign in</a></p><p style="color:#666;font-size:13px">Or open ${url}<br>The link works once, for ${LINK_MINUTES} minutes. If you did not ask for it, ignore this email.</p>`
    try {
      await this.mailer({ to: email, subject: 'Your family.ancestry sign-in link', text, html })
    } catch (error) {
      console.error(`[auth] mail failed: ${(error as Error).message}`)
    }
    return true
  }

  /** Consume a link: one use, then it is gone. Returns the user (created on first sign-in) and where to go. */
  consumeLink(token: string): { user: User; next: string | null } | null {
    const hash = sha256(String(token))
    const row = this.store.db.query<{ email: string; next: string | null; expires_at: number }, [string]>('SELECT email, next, expires_at FROM magic_links WHERE token_hash = ?').get(hash)
    this.store.db.query('DELETE FROM magic_links WHERE token_hash = ? OR expires_at < ?').run(hash, this.now())
    if (!row || row.expires_at < this.now()) return null
    return { user: this.store.findOrCreateUser(row.email), next: row.next }
  }

  // ---- sessions ----------------------------------------------------------

  createSession(userId: string): string {
    const token = newId(24)
    this.store.db.query('INSERT INTO sessions (id_hash,user_id,created_at,expires_at) VALUES (?,?,?,?)').run(sha256(token), userId, this.now(), this.now() + SESSION_DAYS * 86_400_000)
    return token
  }

  sessionUser(token: string | undefined | null): User | null {
    if (!token) return null
    const row = this.store.db.query<{ user_id: string; expires_at: number }, [string]>('SELECT user_id, expires_at FROM sessions WHERE id_hash = ?').get(sha256(token))
    if (!row || row.expires_at < this.now()) return null
    return this.store.user(row.user_id)
  }

  endSession(token: string | undefined | null) {
    if (token) this.store.db.query('DELETE FROM sessions WHERE id_hash = ?').run(sha256(token))
  }

  // ---- API tokens (CLI, TUI, MCP, desktop) ------------------------------

  createToken(userId: string, label: string | null): string {
    const token = `fa_${newId(24)}`
    this.store.db.query('INSERT INTO api_tokens (id,user_id,token_hash,label,created_at) VALUES (?,?,?,?,?)').run(newId(), userId, sha256(token), label?.slice(0, 80) ?? null, this.now())
    return token
  }

  tokenUser(token: string | undefined | null): User | null {
    if (!token?.startsWith('fa_')) return null
    const row = this.store.db.query<{ id: string; user_id: string }, [string]>('SELECT id, user_id FROM api_tokens WHERE token_hash = ?').get(sha256(token))
    if (!row) return null
    this.store.db.query('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').run(this.now(), row.id)
    return this.store.user(row.user_id)
  }

  tokens(userId: string): { id: string; label: string | null; created_at: number; last_used_at: number | null }[] {
    return this.store.db.query<any, [string]>('SELECT id, label, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC').all(userId)
  }

  revokeToken(userId: string, id: string) {
    this.store.db.query('DELETE FROM api_tokens WHERE user_id = ? AND id = ?').run(userId, id)
  }

  // ---- CLI sign-in: authorization code + PKCE ---------------------------

  /** The CLI may only ask for its code to be delivered to a loopback address it is listening on. */
  static loopback(redirect: string): boolean {
    try {
      const url = new URL(redirect)
      return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
    } catch {
      return false
    }
  }

  issueCliCode(userId: string, challenge: string, redirectUri: string, label: string | null): string {
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new Error('code_challenge must be an S256 challenge')
    if (!Auth.loopback(redirectUri)) throw new Error('redirect_uri must be a loopback address')
    const code = newId(24)
    this.store.db.query('INSERT INTO cli_codes (code_hash,user_id,challenge,redirect_uri,label,expires_at) VALUES (?,?,?,?,?,?)').run(sha256(code), userId, challenge, redirectUri, label?.slice(0, 80) ?? null, this.now() + CLI_CODE_MINUTES * 60_000)
    return code
  }

  redeemCliCode(code: string, verifier: string, redirectUri: string): string | null {
    const hash = sha256(String(code))
    const row = this.store.db.query<{ user_id: string; challenge: string; redirect_uri: string; label: string | null; expires_at: number }, [string]>('SELECT * FROM cli_codes WHERE code_hash = ?').get(hash)
    this.store.db.query('DELETE FROM cli_codes WHERE code_hash = ? OR expires_at < ?').run(hash, this.now())
    if (!row || row.expires_at < this.now() || row.redirect_uri !== redirectUri) return null
    const expected = Buffer.from(row.challenge)
    const actual = Buffer.from(createHash('sha256').update(String(verifier)).digest('base64url'))
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null
    return this.createToken(row.user_id, row.label ?? 'CLI')
  }

  // ---- passkeys ----------------------------------------------------------

  private keepChallenge(challenge: string, userId: string | null): string {
    const id = newId()
    for (const [k, v] of this.challenges) if (v.expires < this.now()) this.challenges.delete(k)
    this.challenges.set(id, { challenge, userId, expires: this.now() + 5 * 60_000 })
    return id
  }

  private takeChallenge(id: string | undefined): { challenge: string; userId: string | null } | null {
    if (!id) return null
    const entry = this.challenges.get(id)
    this.challenges.delete(id)
    return entry && entry.expires > this.now() ? entry : null
  }

  passkeys(userId: string): { id: string; label: string | null; created_at: number; last_used_at: number | null }[] {
    return this.store.db.query<any, [string]>('SELECT id, label, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY created_at').all(userId)
  }

  removePasskey(userId: string, id: string) {
    this.store.db.query('DELETE FROM passkeys WHERE user_id = ? AND id = ?').run(userId, id)
  }

  async registrationOptions(user: User) {
    const existing = this.store.db.query<{ id: string; transports: string | null }, [string]>('SELECT id, transports FROM passkeys WHERE user_id = ?').all(user.id)
    const options = await generateRegistrationOptions({
      rpName: 'family.ancestry',
      rpID: this.rpID,
      userName: user.email,
      userDisplayName: user.name ?? user.email,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    })
    return { options, challengeId: this.keepChallenge(options.challenge, user.id) }
  }

  async finishRegistration(user: User, challengeId: string | undefined, response: RegistrationResponseJSON, label: string | null): Promise<boolean> {
    const entry = this.takeChallenge(challengeId)
    if (!entry || entry.userId !== user.id) return false
    const result = await verifyRegistrationResponse({ response, expectedChallenge: entry.challenge, expectedOrigin: this.origins(), expectedRPID: this.rpID, requireUserVerification: false }).catch(() => null)
    if (!result?.verified) return false
    const cred = result.registrationInfo.credential
    this.store.db
      .query('INSERT OR REPLACE INTO passkeys (id,user_id,public_key,counter,transports,label,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(cred.id, user.id, cred.publicKey, cred.counter, JSON.stringify(cred.transports ?? []), label?.slice(0, 80) ?? 'Passkey', this.now())
    return true
  }

  async authenticationOptions() {
    const options = await generateAuthenticationOptions({ rpID: this.rpID, userVerification: 'preferred' })
    return { options, challengeId: this.keepChallenge(options.challenge, null) }
  }

  async finishAuthentication(challengeId: string | undefined, response: AuthenticationResponseJSON): Promise<User | null> {
    const entry = this.takeChallenge(challengeId)
    if (!entry) return null
    const row = this.store.db.query<{ id: string; user_id: string; public_key: Uint8Array; counter: number; transports: string | null }, [string]>('SELECT * FROM passkeys WHERE id = ?').get(String(response?.id ?? ''))
    if (!row) return null
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: entry.challenge,
      expectedOrigin: this.origins(),
      expectedRPID: this.rpID,
      credential: { id: row.id, publicKey: new Uint8Array(row.public_key), counter: row.counter, transports: row.transports ? JSON.parse(row.transports) : undefined },
      requireUserVerification: false,
    }).catch(() => null)
    if (!result?.verified) return null
    this.store.db.query('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?').run(result.authenticationInfo.newCounter, this.now(), row.id)
    return this.store.user(row.user_id)
  }

  /** The site over https and http: a Moshpit name is served on both (see the nginx notes in README). */
  private origins(): string[] {
    const url = new URL(this.site)
    return [url.origin, `http://${url.host}`, `https://${url.host}`]
  }
}
