import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dollarsToCents, validateQuote, validateChallenge, paymentOrigin, payX402, getX402Quote } from '../../src/lib/x402.js';
import { setBaseURL, setAccessToken } from '../../src/lib/api.js';
const payTo='0x'+'22'.repeat(20);
const quote={creditCents:2000,feeCents:31,totalCents:2031,network:'eip155:8453',asset:'0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',payTo};
const challenge={x402Version:2,resource:{url:'https://lizard.build/api/billing/purchase/x402',mimeType:'application/json'},accepts:[{scheme:'exact',network:'eip155:8453' as const,asset:quote.asset,amount:'20310000',payTo,maxTimeoutSeconds:300,extra:{name:'USD Coin',version:'2'}}]};
const fetchMock=vi.fn();
let home: string;
function unpaid() { return new Response(JSON.stringify({...quote,attemptId:'a0000000-0000-4000-8000-000000000001',status:'quoted',...challenge}), {status:402,headers:{'PAYMENT-REQUIRED':Buffer.from(JSON.stringify(challenge)).toString('base64')}}); }
beforeEach(() => {
  fetchMock.mockReset(); vi.stubGlobal('fetch',fetchMock); setBaseURL('https://lizard.build'); setAccessToken('test-token');
  home=fs.mkdtempSync(path.join(os.tmpdir(),'lizard-x402-')); vi.stubEnv('LIZARD_HOME',home);
  vi.stubEnv('LIZARD_X402_TRUSTED_ORIGIN',''); vi.stubEnv('LIZARD_X402_PRIVATE_KEY','0x'+'11'.repeat(32));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('x402 client', () => {
  it('parses money without rounding fractional cents', () => {
    expect(dollarsToCents('20.31')).toBe(2031);
    for(const invalid of ['1.001','NaN','1e3','-1','0','Infinity']) expect(()=>dollarsToCents(invalid)).toThrow();
  });
  it('blocks untrusted hosts and malformed quotes', () => {
    setBaseURL('http://lizard.build'); expect(paymentOrigin).toThrow();
    setBaseURL('https://evil.example'); expect(paymentOrigin).toThrow();
    expect(()=>validateQuote({...quote,totalCents:2200},2000,2100)).toThrow();
    expect(()=>validateQuote({...quote,asset:payTo},2000,2100)).toThrow();
  });
  it('rejects a changed recipient, token, network, amount, domain or payment scheme', () => {
    for(const patch of [{payTo:'0x'+'33'.repeat(20)},{asset:payTo},{network:'eip155:1'},{amount:'99999999'},{extra:{name:'USDC',version:'2'}},{scheme:'upto'},{extra:{name:'USD Coin',version:'2',assetTransferMethod:'permit2'}}]) {
      expect(()=>validateChallenge({...challenge,accepts:[{...challenge.accepts[0],...patch}]} as never,quote,'https://lizard.build')).toThrow();
    }
  });
  it('quotes without accessing a wallet or signing', async () => {
    vi.stubEnv('LIZARD_X402_PRIVATE_KEY',''); fetchMock.mockResolvedValue(new Response(JSON.stringify(quote)));
    expect(await getX402Quote(2000)).toEqual(quote); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('never signs a plain INSUFFICIENT_CREDITS 402', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({error:'INSUFFICIENT_CREDITS'}),{status:402}));
    await expect(payX402(2000,2100,quote)).rejects.toThrow('Resume with --request-id'); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('persists the real SDK authorization and reuses it after a lost response', async () => {
    fetchMock.mockResolvedValueOnce(unpaid()).mockRejectedValueOnce(new Error('network timeout'));
    await expect(payX402(2000,2100,quote)).rejects.toThrow('Resume with --request-id');
    const sent=fetchMock.mock.calls[1][1]; const first=JSON.parse(sent.body);
    expect(sent.redirect).toBe('error'); expect(sent.headers.Authorization).toBe('Bearer test-token');
    const payload=JSON.parse(Buffer.from(sent.headers['PAYMENT-SIGNATURE'],'base64').toString());
    expect(payload.payload.authorization).toMatchObject({to:payTo,value:'20310000'});
    const paid={...quote,requestId:first.requestId,attemptId:'a0000000-0000-4000-8000-000000000001',status:'paid'};
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(paid)));
    expect(await payX402(2000,2100,quote,first.requestId)).toEqual(paid);
    expect(fetchMock.mock.calls[2][1].headers['PAYMENT-SIGNATURE']).toBe(sent.headers['PAYMENT-SIGNATURE']);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).requestId).toBe(first.requestId);
    expect(JSON.stringify(fs.readdirSync(path.join(home,'.lizard','payments')))).not.toContain('test-token');
    await expect(payX402(2000,2100,quote)).rejects.toThrow('Previous payment');
  });
  it('refuses a quote over the approved limit before any request', async () => {
    await expect(payX402(2000,2000,quote)).rejects.toThrow('exceeds --max-total'); expect(fetchMock).not.toHaveBeenCalled();
  });
});
