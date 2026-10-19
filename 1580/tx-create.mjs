// End-to-end check of the /tx create_bounty "done" link against a real
// PoidhV3 contract on an anvil fork of Base. Only the indexer lookup
// (bounties.isNewlyCreated, which needs poidh's DB) is stubbed.
//
// usage: node tx-create.mjs <scenario: indexed|never> <label>
import { chromium } from 'playwright-core';
import { createPublicClient, http, decodeEventLog, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import { writeFileSync } from 'node:fs';

const scenario = process.argv[2] ?? 'indexed';
const label = process.argv[3] ?? scenario;
const APP = 'http://localhost:3123';
const ANVIL = 'http://127.0.0.1:8545';
const ACCOUNT = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'; // anvil #0, unlocked
const POIDH = '0x5555fa783936c260f77385b4e153b9725fef1719';
const PAGE_ID = 424242; // deliberately != onchain id: the page must use the indexer's id
const OUT = new URL('.', import.meta.url).pathname;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};

const fork = createPublicClient({ chain: base, transport: http(ANVIL) });
const startBlock = await fork.getBlockNumber();

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on('pageerror', (e) => console.log('pageerror:', e.message));
page.on('console', (m) => { const t = m.text(); if (t.startsWith('[wallet]') || m.type() === 'error') console.log('console:', t.slice(0, 200)); });

// Test wallet: an EIP-1193 provider that forwards to anvil's unlocked account.
await page.addInitScript(
  ({ anvil, account }) => {
    const rpc = async (method, params = []) => {
      const res = await fetch(anvil, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
      });
      const json = await res.json();
      if (json.error) throw Object.assign(new Error(json.error.message), json.error);
      return json.result;
    };
    const provider = {
            on() {},
      removeListener() {},
      async request({ method, params }) {
        console.log('[wallet]', method);
        if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
        if (method === 'wallet_switchEthereumChain') return null;
        if (method.startsWith('wallet_') && method !== 'wallet_getCapabilities') return null;
        return rpc(method, params);
      },
    };
    window.ethereum = provider;
    const info = { uuid: 'e2e-wallet', name: 'E2E Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'xyz.poidh.e2e' };
    const announce = () =>
      window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  },
  { anvil: 'https://mainnet.base.org/', account: ACCOUNT }
);

// The app's Base public client uses viem's default RPC: send it to the fork.
await page.route(/mainnet\.base\.org/, async (route) => {
  const res = await fetch(ANVIL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: route.request().postData(),
  });
  await route.fulfill({ status: 200, contentType: 'application/json', body: await res.text() });
});

// Indexer stub: only bounties.isNewlyCreated; every other tRPC call passes through.
const indexerCalls = [];
await page.route(/\/api\/trpc\/[^?]*isNewlyCreated/, async (route) => {
  const url = new URL(route.request().url());
  const procs = url.pathname.split('/api/trpc/')[1].split(',');
  const input = JSON.parse(url.searchParams.get('input') ?? '{}');
  const body = procs.map((proc, i) => {
    if (proc !== 'bounties.isNewlyCreated') {
      return { error: { json: { message: 'not stubbed', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR' } } } };
    }
    indexerCalls.push(input[i]?.json);
    const found = scenario === 'indexed' && indexerCalls.length >= 3; // lag: 2 misses first
    return { result: { data: { json: found ? { id: PAGE_ID, chainId: 8453 } : null } } };
  });
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

const params = new URLSearchParams({
  action: 'create_bounty',
  chain: 'base',
  type: 'solo',
  title: `e2e ${label} ${Date.now()}`,
  description: 'end-to-end test on an anvil fork',
  amountEth: '0.001',
});
await page.goto(`${APP}/tx?${params}`, { waitUntil: 'domcontentloaded' });
await page.getByText('create bounty').first().waitFor({ timeout: 120_000 });

// Connect the test wallet through RainbowKit.
await page.getByRole('button', { name: /connect wallet to approve|approve in wallet/ }).first().waitFor({ timeout: 60_000 });
if (await page.getByRole('button', { name: 'connect wallet to approve' }).isVisible()) {
  await page.getByRole('button', { name: 'connect wallet to approve' }).click();
}
// The modal re-renders as wallets are discovered; retry until connected.
for (let i = 0; i < 10 && !(await page.getByRole('button', { name: 'approve in wallet' }).isVisible()); i++) {
  await page.getByRole('button', { name: /e2e wallet/i }).first().click({ timeout: 3_000 }).catch(() => {});
  await page.waitForTimeout(1_000);
}
const approve = page.getByRole('button', { name: 'approve in wallet' });
await approve.waitFor({ timeout: 30_000 }).catch(async (e) => { await page.screenshot({ path: `${OUT}${label}-debug.png`, fullPage: true }); console.log('buttons:', await page.getByRole('button').allTextContents()); throw e; });
await page.waitForFunction(
  () => !document.querySelector('button[disabled]')?.textContent?.includes('approve in wallet'),
  null,
  { timeout: 30_000 }
);
await page.screenshot({ path: `${OUT}${label}-1-review.png`, fullPage: true });
await approve.click();

await page.getByRole('heading', { name: 'done' }).waitFor({ timeout: 60_000 });

// What actually happened onchain, read independently from the fork.
const logs = await fork.getLogs({
  address: POIDH,
  event: parseAbiItem(
    'event BountyCreated(uint256 indexed id, address indexed issuer, string title, string description, uint256 amount, uint256 createdAt, bool isOpenBounty, uint256 round)'
  ),
  fromBlock: startBlock + 1n,
});
check('real BountyCreated emitted by PoidhV3 on the fork', logs.length === 1, `${logs.length} event(s)`);
const onchainId = logs[0]?.args.id;
check('issuer is the connected wallet', logs[0]?.args.issuer?.toLowerCase() === ACCOUNT.toLowerCase());

const link = page.locator('main a').first();
const firstHref = await link.getAttribute('href');
const firstText = (await link.textContent())?.trim();
await page.screenshot({ path: `${OUT}${label}-2-done-immediately.png`, fullPage: true });
check(
  'link right after confirm is a real page, never /base/bounties',
  !/\/base\/bounties$/.test(firstHref ?? ''),
  `${firstText} -> ${firstHref}`
);

if (scenario === 'indexed') {
  await page.getByRole('link', { name: 'view your bounty' }).waitFor({ timeout: 30_000 });
  const href = await page.getByRole('link', { name: 'view your bounty' }).getAttribute('href');
  check('switches to the bounty page once indexed', href === `/base/bounty/${PAGE_ID}`, href);
  check('looked up the onchain id from the receipt', indexerCalls.at(-1)?.id === Number(onchainId), `asked ${indexerCalls.at(-1)?.id}, onchain ${onchainId}`);
  check('looked up on Base', indexerCalls.every((c) => c?.chainId === 8453));
  check('"can take a minute" note hidden once found', !(await page.getByText('it can take a minute').isVisible()));
  const before = indexerCalls.length;
  await page.waitForTimeout(6_000);
  check('stops polling once found', indexerCalls.length === before, `${before} -> ${indexerCalls.length}`);
  await page.screenshot({ path: `${OUT}${label}-3-done-indexed.png`, fullPage: true });
} else {
  await page.waitForTimeout(70_000);
  const href = await page.locator('main a').first().getAttribute('href');
  check('keeps the account-page fallback when never indexed', href === `https://poidh.xyz/account/${ACCOUNT}`, href);
  check('note still shown', await page.getByText('it can take a minute').isVisible());
  const n = indexerCalls.length;
  await page.waitForTimeout(6_000);
  check('gives up polling after ~a minute', indexerCalls.length === n && n <= 31, `${n} calls`);
  await page.screenshot({ path: `${OUT}${label}-3-done-never-indexed.png`, fullPage: true });
}

await browser.close();
writeFileSync(`${OUT}${label}-results.json`, JSON.stringify({ scenario, onchainId: String(onchainId), indexerCalls, results }, null, 2));
const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n${failed} FAILED` : '\nALL PASSED');
process.exit(failed ? 1 : 0);
