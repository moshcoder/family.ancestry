/**
 * The Family plan: one payment per tree, once, for good. It unlocks pets and
 * lifts the invitation limits for everyone in that family, so whoever pays can
 * bring the whole family (and the family's friends) in.
 *
 * Money goes through a CoinPay hosted checkout session: the buyer picks any coin
 * the business takes, or PayPal, on CoinPay's page. We write the payment down as
 * pending (keyed by the session id) before the buyer leaves, verify the webhook
 * over the raw bytes, and only a paid event for a session we started grants.
 *
 * Admins (ADMIN_EMAILS) never pay: every tree they own is on the plan.
 */
import { CoinPay as CoinPayClient, readWebhook as readCoinPayWebhook, verifyWebhook as verifyCoinPayWebhook } from '@profullstack/coinpay-onboard'
import { emailVerified, newId, type Store, type Tree, type User } from './db.js'

export type CoinPay = { baseUrl: string; apiKey: string; businessId: string; webhookSecret: string }
export type PlanConfig = {
  priceCents: number
  currency: string
  coinpay: CoinPay | null
  admins: Set<string>
}

export function planFromEnv(env: Record<string, string | undefined> = process.env): PlanConfig {
  const coinpay = env.COINPAY_API_KEY && env.COINPAY_BUSINESS_ID
    ? {
        // COINPAY_API_URL sometimes holds the site origin and sometimes /api; we add /api ourselves.
        baseUrl: (env.COINPAY_API_URL ?? 'https://coinpayportal.com').replace(/\/+$/, '').replace(/\/api$/, ''),
        apiKey: env.COINPAY_API_KEY,
        businessId: env.COINPAY_BUSINESS_ID,
        webhookSecret: env.COINPAY_WEBHOOK_SECRET ?? '',
      }
    : null
  return {
    priceCents: Math.round(Number(env.FAMILY_PLAN_USD ?? 49) * 100),
    currency: 'USD',
    coinpay,
    admins: new Set((env.ADMIN_EMAILS ?? '').split(/[\s,]+/).map((e) => e.trim().toLowerCase()).filter(Boolean)),
  }
}

export const isAdmin = (cfg: PlanConfig, user: Pick<User, 'email'> | null | undefined) => Boolean(user && cfg.admins.has(user.email.toLowerCase()))

/** Paid once, or owned by an admin. */
export function hasPlan(cfg: PlanConfig, store: Store, tree: Tree): boolean {
  if (tree.plan_paid_at) return true
  return isAdmin(cfg, store.user(tree.owner_id))
}

export const price = (cfg: PlanConfig) => `$${(cfg.priceCents / 100).toFixed(cfg.priceCents % 100 ? 2 : 0)}`

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** The address CoinPay sends the receipt to: the account's own, or the one typed on the form. */
export function buyerEmail(user: User, given?: unknown): string {
  const typed = typeof given === 'string' ? given.trim().toLowerCase() : ''
  if (typed) {
    if (!EMAIL.test(typed) || typed.endsWith('@pit.invalid')) throw new Error('give an email address for the receipt')
    return typed
  }
  if (emailVerified(user)) return user.email
  throw new Error('give an email address for the receipt')
}

/** Start a CoinPay checkout session for this tree; returns where to send the buyer. */
export async function startCheckout(
  cfg: PlanConfig,
  store: Store,
  args: { tree: Tree; user: User; email?: unknown; property: string; successUrl: string; cancelUrl: string },
  fetcher: typeof fetch = fetch,
): Promise<{ checkoutUrl: string; ref: string; sessionId: string }> {
  if (!cfg.coinpay) throw new Error('payments are not set up on this server')
  const email = buyerEmail(args.user, args.email)
  const ref = `fp_${newId()}`
  const client = new CoinPayClient({ token: cfg.coinpay.apiKey, base: cfg.coinpay.baseUrl, fetch: fetcher })
  const session = await client.createCheckoutSession({
    amount: cfg.priceCents / 100,
    currency: cfg.currency,
    description: `family.ancestry Family plan: ${args.tree.name}`,
    customerEmail: email,
    accountId: args.user.id,
    property: args.property,
    // Echoed on every webhook; the grant still comes from our row, found by the session id.
    metadata: { tree_id: args.tree.id, user_id: args.user.id, product: 'family_plan', payment_ref: ref },
    successUrl: args.successUrl,
    cancelUrl: args.cancelUrl,
    expiresInMinutes: 60,
  })
  if (!session.id || !session.url) throw new Error('CoinPay returned no checkout session')
  // Written before the buyer leaves: a webhook can beat the redirect.
  store.recordPayment({ ref, tree_id: args.tree.id, user_id: args.user.id, amount_cents: cfg.priceCents, currency: cfg.currency, chain: null, checkout_session_id: session.id, raw: session.raw })
  return { checkoutUrl: session.url, ref, sessionId: session.id }
}

/** `t=<unix>,v1=<hex hmac of "t.rawBody">`, within five minutes. */
export function verifyWebhook(secret: string, rawBody: string, header: string | null | undefined, nowSeconds = Date.now() / 1000): boolean {
  if (!secret || !header) return false
  return verifyCoinPayWebhook(rawBody, header, secret, nowSeconds * 1000)
}

/**
 * The live webhook is nested: { id: "evt_…", type, data: { payment_id, status, checkout_session_id, metadata } }.
 * Paid = payment.confirmed or payment.forwarded (a PayPal capture is confirmed with status completed).
 */
export function readWebhook(payload: unknown) {
  const w = readCoinPayWebhook(payload)
  return { sessionId: w.checkoutSessionId, paymentId: w.paymentId || null, status: w.status || (w.type.startsWith('payment.') ? w.type.slice('payment.'.length) : ''), paid: w.paid, type: w.type, meta: w.metadata }
}
