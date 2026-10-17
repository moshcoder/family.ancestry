/**
 * The Family plan: one payment per tree, once, for good. It unlocks pets and
 * lifts the invitation limits for everyone in that family, so whoever pays can
 * bring the whole family (and the family's friends) in.
 *
 * Money goes through CoinPay, crypto only. The shape is the fleet's
 * packages/payments: write the payment down as pending before the buyer leaves,
 * verify the webhook over the raw bytes, and only a settled status grants.
 *
 * Admins (ADMIN_EMAILS) never pay: every tree they own is on the plan.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import type { Store, Tree, User } from './db.js'

export type CoinPay = { baseUrl: string; apiKey: string; businessId: string; webhookSecret: string }
export type PlanConfig = {
  priceCents: number
  currency: string
  /** Chains the CoinPay business holds wallets for; a chain without one is refused at checkout. */
  chains: string[]
  coinpay: CoinPay | null
  admins: Set<string>
}

/** The account-global wallets on our CoinPay business; checkout offers only these. */
export const DEFAULT_CHAINS = ['USDC_POL', 'USDC_SOL', 'USDC_ETH', 'USDT_POL', 'BTC', 'ETH', 'SOL', 'POL', 'DOGE', 'BCH', 'XRP', 'ADA', 'BNB']

export const CHAIN_LABELS: Record<string, string> = {
  USDC_POL: 'USDC on Polygon', USDC_SOL: 'USDC on Solana', USDC_ETH: 'USDC on Ethereum', USDT_POL: 'USDT on Polygon', USDT_SOL: 'USDT on Solana', USDT_ETH: 'USDT on Ethereum',
  BTC: 'Bitcoin', ETH: 'Ether', SOL: 'Solana', POL: 'Polygon', DOGE: 'Dogecoin', BCH: 'Bitcoin Cash', XRP: 'XRP', ADA: 'Cardano', BNB: 'BNB',
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
  const chains = (env.COINPAY_CHAINS ?? '').split(/[\s,]+/).filter(Boolean)
  return {
    priceCents: Math.round(Number(env.FAMILY_PLAN_USD ?? 49) * 100),
    currency: 'USD',
    chains: chains.length ? chains : DEFAULT_CHAINS,
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

/** Start a crypto payment for this tree; returns where to send the buyer. */
export async function startCheckout(
  cfg: PlanConfig,
  store: Store,
  args: { tree: Tree; user: User; chain: string; successUrl: string; cancelUrl: string },
  fetcher: typeof fetch = fetch,
): Promise<{ checkoutUrl: string; ref: string }> {
  if (!cfg.coinpay) throw new Error('payments are not set up on this server')
  if (!cfg.chains.includes(args.chain)) throw new Error('pick a currency from the list')
  const res = await fetcher(`${cfg.coinpay.baseUrl}/api/payments/create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.coinpay.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      business_id: cfg.coinpay.businessId,
      amount: cfg.priceCents / 100,
      currency: cfg.currency,
      blockchain: args.chain,
      payment_method: 'crypto',
      description: `family.ancestry Family plan: ${args.tree.name}`,
      // The echo on the webhook is what ties money to a tree.
      metadata: { tree_id: args.tree.id, user_id: args.user.id, product: 'family_plan' },
      success_url: args.successUrl,
      cancel_url: args.cancelUrl,
    }),
    signal: AbortSignal.timeout(20_000),
  })
  if (!res.ok) throw new Error(`CoinPay said ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const body = (await res.json()) as any
  // { success, payment: {...} }: the id is nested, not body.id.
  const payment = body?.payment ?? body
  const ref = payment?.id ?? payment?.payment_id
  if (!ref) throw new Error('CoinPay returned no payment reference')
  // Written before the buyer leaves: a webhook can beat the redirect.
  store.recordPayment({ ref: String(ref), tree_id: args.tree.id, user_id: args.user.id, amount_cents: cfg.priceCents, currency: cfg.currency, chain: args.chain, raw: body })
  return { checkoutUrl: `${cfg.coinpay.baseUrl}/pay/${ref}`, ref: String(ref) }
}

/** `t=<unix>,v1=<hex hmac of "t.rawBody">`, within five minutes. */
export function verifyWebhook(secret: string, rawBody: string, header: string | null | undefined, nowSeconds = Date.now() / 1000): boolean {
  if (!secret || !header) return false
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=').map((s) => s.trim())))
  const t = Number(parts.t)
  if (!Number.isFinite(t) || !parts.v1 || Math.abs(nowSeconds - t) > 300) return false
  const expected = Buffer.from(createHmac('sha256', secret).update(`${parts.t}.${rawBody}`).digest('hex'), 'hex')
  const given = Buffer.from(String(parts.v1), 'hex')
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** Statuses that mean money arrived. A verified webhook can still say no. */
export const SETTLED = new Set(['paid', 'completed', 'confirmed', 'succeeded', 'settled'])

/** The live webhook is { id: "evt_…", type, data: { payment_id, status, metadata } }; the top-level id is the event. */
export function readWebhook(payload: any): { ref: string | null; status: string; meta: Record<string, unknown> } {
  const data = payload?.data ?? payload
  return { ref: data?.payment_id ?? data?.id ?? null, status: String(data?.status ?? '').toLowerCase(), meta: data?.metadata ?? payload?.metadata ?? {} }
}
