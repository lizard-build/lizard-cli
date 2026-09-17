import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { PaymentRequired } from '@x402/core/types';
import { APIError, getBaseURL, getRequestToken } from './api.js';

const NETWORK = 'eip155:8453';
const ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ENDPOINT = '/api/billing/purchase/x402';
export interface X402Quote { creditCents: number; feeCents: number; totalCents: number; network: string; asset: string; payTo: string; }
export interface X402Result extends X402Quote { requestId: string; attemptId: string; status: string; transaction?: string | null; paymentIntentId?: string | null; }
class PaymentInputError extends Error {}
interface Journal { requestId: string; creditCents: number; maxTotalCents: number; origin: string; signature?: string; result?: X402Result; }
export function dollarsToCents(value: string): number {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) throw new Error('Use a positive dollar amount with at most two decimal places.');
  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('Invalid dollar amount.');
  return cents;
}
export function paymentOrigin(): string {
  const url = new URL(getBaseURL());
  const trusted = process.env.LIZARD_X402_TRUSTED_ORIGIN || 'https://lizard.build';
  if (url.protocol !== 'https:' || url.origin !== trusted || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('x402 requires a trusted HTTPS API origin. Set LIZARD_X402_TRUSTED_ORIGIN explicitly for another server.');
  }
  return url.origin;
}
async function request(method: string, route: string, body?: unknown, signature?: string): Promise<Response> {
  const token = getRequestToken();
  if (!token) throw new APIError(401, 'Sign in before buying credits.');
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  if (signature) headers['PAYMENT-SIGNATURE'] = signature;
  return fetch(paymentOrigin() + route, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(45_000) });
}
async function json<T>(res: Response): Promise<T> {
  const value = await res.json() as T & { error?: string; message?: string };
  if (!res.ok) throw new APIError(res.status, value.error || value.message || 'Payment request failed.', value.error, value);
  return value;
}
export function validateQuote(q: X402Quote, creditCents: number, maxTotalCents = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(q.creditCents) || !Number.isSafeInteger(q.feeCents) || !Number.isSafeInteger(q.totalCents) ||
    q.creditCents !== creditCents || q.feeCents < 0 || q.totalCents !== q.creditCents + q.feeCents || q.totalCents > maxTotalCents ||
    q.network !== NETWORK || q.asset.toLowerCase() !== ASSET.toLowerCase() || !/^0x[0-9a-fA-F]{40}$/.test(q.payTo)) throw new Error('Payment quote is invalid or exceeds --max-total.');
}
export async function getX402Quote(creditCents: number): Promise<X402Quote> {
  const q = await json<X402Quote>(await request('POST', `${ENDPOINT}/quote`, { creditCents }));
  validateQuote(q, creditCents);
  return q;
}
export function validateChallenge(value: PaymentRequired, q: X402Quote, origin: string) {
  const r = value.accepts?.[0];
  if (value.x402Version !== 2 || value.accepts?.length !== 1 || value.resource?.url !== origin + ENDPOINT || !r ||
    r.scheme !== 'exact' || r.network !== NETWORK || r.asset.toLowerCase() !== ASSET.toLowerCase() ||
    r.payTo.toLowerCase() !== q.payTo.toLowerCase() || r.amount !== String(BigInt(q.totalCents) * 10_000n) ||
    r.maxTimeoutSeconds <= 0 || r.maxTimeoutSeconds > 300 ||
    (value.extensions && Object.keys(value.extensions).length > 0) ||
    (r.extra?.assetTransferMethod !== undefined && r.extra.assetTransferMethod !== 'eip3009') ||
    Object.keys(r.extra || {}).some(key => !['name', 'version', 'assetTransferMethod'].includes(key)) || r.extra?.name !== 'USD Coin' || r.extra?.version !== '2') throw new Error('Untrusted x402 payment challenge.');
}
function journalPath(creditCents: number, requestId?: string) {
  if (requestId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('--request-id must be a UUID.');
  const account = createHash('sha256').update(paymentOrigin() + '\0' + getRequestToken()).digest('hex');
  const dir = path.join(process.env.LIZARD_HOME || os.homedir(), '.lizard', 'payments', account);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const pending = path.join(dir, `pending-${creditCents}.json`);
  if (requestId && fs.existsSync(pending)) {
    const previous = JSON.parse(fs.readFileSync(pending, 'utf8')) as Journal;
    if (previous.requestId === requestId) return pending;
  }
  return path.join(dir, requestId || `pending-${creditCents}.json`);
}
function persist(file: string, state: Journal) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
  fs.renameSync(temporary, file);
}
export async function payX402(creditCents: number, maxTotalCents: number, expected: X402Quote, requestId?: string): Promise<X402Result> {
  validateQuote(expected, creditCents, maxTotalCents);
  const origin = paymentOrigin();
  const file = journalPath(creditCents, requestId);
  let state: Journal = { requestId: requestId || randomUUID(), creditCents, maxTotalCents, origin };
  try { fs.writeFileSync(file, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    state = JSON.parse(fs.readFileSync(file, 'utf8')) as Journal;
    if (state.origin !== origin || state.creditCents !== creditCents || state.maxTotalCents > maxTotalCents) throw new Error('Saved payment differs. Resume with the original amount and limit.');
    if (state.result?.status === 'paid') {
      if (requestId) return state.result;
      throw new Error(`Previous payment ${state.requestId} is paid. Use a new --request-id UUID for another purchase of this amount.`);
    }
  }
  try {
    let response = await request('POST', ENDPOINT, { creditCents, requestId: state.requestId }, state.signature);
    if (response.status === 402 && !state.signature) {
      const header = response.headers.get('PAYMENT-REQUIRED');
      if (!header || header.length > 16_384) throw new Error('Server returned 402 without a valid x402 challenge.');
      const challenge = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentRequired;
      const body = await response.json() as X402Result;
      validateQuote(body, creditCents, Math.min(state.maxTotalCents, maxTotalCents));
      if (body.payTo.toLowerCase() !== expected.payTo.toLowerCase() || body.totalCents !== expected.totalCents) throw new Error('Quote changed. Request a fresh quote before paying.');
      validateChallenge(challenge, body, origin);
      const key = process.env.LIZARD_X402_PRIVATE_KEY;
      if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new PaymentInputError('Set LIZARD_X402_PRIVATE_KEY to a funded Base wallet key through your secret manager.');
      const [{ x402Client }, { ExactEvmScheme }, { privateKeyToAccount }] = await Promise.all([
        import('@x402/core/client'), import('@x402/evm/exact/client'), import('viem/accounts'),
      ]);
      const signer = privateKeyToAccount(key as `0x${string}`);
      const client = new x402Client().register(NETWORK, new ExactEvmScheme(signer))
        .setSpendControls({ maxAmountPerPayment: `$${(Math.min(state.maxTotalCents, maxTotalCents) / 100).toFixed(2)}` });
      const payload = await client.createPaymentPayload(challenge);
      state.signature = Buffer.from(JSON.stringify(payload)).toString('base64');
      state.result = body;
      persist(file, state); // Persist the authorization before sending it anywhere.
      response = await request('POST', ENDPOINT, { creditCents, requestId: state.requestId }, state.signature);
    }
    const result = await json<X402Result>(response);
    state.result = result;
    persist(file, state);
    return result;
  } catch (e) {
    if (e instanceof APIError && e.code === 'QUOTE_EXPIRED') throw new Error('Quote expired before payment was accepted. Use a new --request-id UUID.');
    const message = e instanceof APIError || e instanceof PaymentInputError ? e.message : 'Payment did not finish. No new payment was started.';
    throw new Error(`${message} Resume with --request-id ${state.requestId}. Saved state: ${file}`);
  }
}
export async function getX402Status(attemptId: string): Promise<X402Result> {
  if (!/^[0-9a-f-]{36}$/i.test(attemptId)) throw new Error('Payment attempt ID must be a UUID.');
  return json<X402Result>(await request('GET', `${ENDPOINT}/${attemptId}`));
}
