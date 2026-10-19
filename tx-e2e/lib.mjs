// Shared harness for /tx end-to-end runs against an anvil fork of Base.
//
// - Chain: the real PoidhV3 contract on a local fork; fixtures are real txs
//   from anvil's unlocked accounts.
// - Wallet: an EIP-6963 test wallet that forwards to anvil as a chosen account.
// - Indexer: poidh's DB-backed tRPC reads are answered from LIVE fork state,
//   shaped like the real routers. Page ids are offset from onchain ids so any
//   page-id/onchain-id mix-up breaks the run.
import { createRequire } from 'node:module';
import { chromium } from 'playwright-core';
import { createPublicClient, createWalletClient, http, parseEther } from 'viem';
import { base } from 'viem/chains';

const require = createRequire(import.meta.url);
export const abi = require('./abi.cjs');

export const APP = 'http://localhost:3123';
export const ANVIL = 'http://127.0.0.1:8545';
export const POIDH = '0x5555fa783936c260f77385b4e153b9725fef1719';
export const OFFSET = 100_000; // page id = onchain id + OFFSET
export const ACCOUNTS = {
  A0: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
  A1: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  A2: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  A3: '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
};
const ZERO = '0x0000000000000000000000000000000000000000';

export const fork = createPublicClient({ chain: base, transport: http(ANVIL) });

/** Sends a real fixture transaction from an unlocked anvil account. */
export async function fixture(from, functionName, args, valueEth) {
  const wallet = createWalletClient({ account: from, chain: base, transport: http(ANVIL) });
  const hash = await wallet.writeContract({
    address: POIDH,
    abi,
    functionName,
    args,
    value: valueEth ? parseEther(valueEth) : undefined,
  });
  const receipt = await fork.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`fixture ${functionName} reverted`);
  return receipt;
}

// Only blocks mined on the fork are local; older ranges are forwarded to the
// public RPC, which rejects wide log queries. Every fixture lives after the fork.
let forkBlock;
async function firstLocalBlock() {
  forkBlock ??= BigInt((await fork.request({ method: 'anvil_nodeInfo', params: [] })).forkConfig.forkBlockNumber) + 1n;
  return forkBlock;
}

export async function events(eventName, args = {}, fromBlock = 0n) {
  const first = await firstLocalBlock();
  return fork.getContractEvents({
    address: POIDH,
    abi,
    eventName,
    args,
    fromBlock: fromBlock > first ? fromBlock : first,
  });
}

export async function chainNow() {
  return Number((await fork.getBlock()).timestamp);
}

export async function warp(seconds) {
  await fork.request({ method: 'evm_increaseTime', params: [seconds] });
  await fork.request({ method: 'evm_mine', params: [] });
}

const read = (functionName, args) => fork.readContract({ address: POIDH, abi, functionName, args });

/** bounties.fetch, from live chain state. */
async function bountyRecord(pageId) {
  const onChainId = pageId - OFFSET;
  if (onChainId < 0) throw new Error('not found');
  const [, issuer, name, description, amount, claimer] = await read('bounties', [BigInt(onChainId)]);
  if (issuer === ZERO) throw new Error('not found');
  const [created] = await events('BountyCreated', { id: BigInt(onChainId) });
  const started = await events('VotingStarted', { bountyId: BigInt(onChainId) });
  const resolved = await events('VotingResolved', { bountyId: BigInt(onChainId) });
  const claims = await events('ClaimCreated', { bountyId: BigInt(onChainId) });
  const isVoting = started.length > resolved.length;
  const canceled = claimer.toLowerCase() === issuer.toLowerCase();
  return {
    id: pageId,
    onChainId,
    chainId: 8453,
    title: name,
    description,
    amount: amount.toString(),
    issuer: issuer.toLowerCase(),
    inProgress: claimer === ZERO,
    isCanceled: canceled,
    isMultiplayer: !!created?.args.isOpenBounty,
    isVoting,
    deadline: isVoting ? Number(started.at(-1).args.deadline) : null,
    hasClaims: claims.length > 0,
  };
}

/** claims.fetch, from live chain state. */
async function claimRecord(pageClaimId) {
  const onChainId = pageClaimId - OFFSET;
  const [, issuer, bountyId, , name, description] = await read('claims', [BigInt(onChainId)]);
  if (issuer === ZERO) return null;
  const [created] = await events('ClaimCreated', { id: BigInt(onChainId) });
  return {
    id: pageClaimId,
    onChainId,
    chainId: 8453,
    bountyId: Number(bountyId) + OFFSET,
    title: name,
    description,
    url: created?.args.imageUri ?? '',
    issuer: issuer.toLowerCase(),
  };
}

const PROCS = {
  'bounties.fetch': ({ id }) => bountyRecord(id),
  'claims.fetch': ({ claimId }) => claimRecord(claimId),
  'claims.fetchVotingClaimByBountyId': async ({ bountyId }) => {
    const b = await bountyRecord(bountyId);
    if (!b.isVoting) return null;
    const claimId = await read('bountyCurrentVotingClaim', [BigInt(b.onChainId)]);
    return claimRecord(Number(claimId) + OFFSET);
  },
  // Mirrors bounties.mustUseVoteFlow: isMultiplayer && everHadExternalContributor.
  'bounties.mustUseVoteFlow': async ({ id }) => {
    const b = await bountyRecord(id);
    return b.isMultiplayer ? read('everHadExternalContributor', [BigInt(b.onChainId)]) : false;
  },
  'bounties.isNewlyCreated': async ({ id }) => ({ id: id + OFFSET, chainId: 8453 }),
};

/** Opens /tx as `account`, approves when asked, and reports what happened. */
export async function runTx(browser, { account, params, approve = true, clockAt, label }) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const calls = [];
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  if (clockAt) await page.clock.setSystemTime(clockAt * 1000);

  await page.addInitScript(
    ({ account }) => {
      const rpc = async (method, params = []) => {
        const res = await fetch('https://mainnet.base.org/', {
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
          if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [account];
          if (method === 'eth_sendTransaction') params = [{ ...params[0], from: account }];
          if (method.startsWith('wallet_')) return null;
          return rpc(method, params);
        },
      };
      const info = { uuid: 'e2e-wallet', name: 'E2E Wallet', icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>', rdns: 'xyz.poidh.e2e' };
      const announce = () =>
        window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
      window.addEventListener('eip6963:requestProvider', announce);
      announce();
    },
    { account }
  );

  await page.route(/mainnet\.base\.org/, async (route) => {
    const res = await fetch(ANVIL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: route.request().postData() });
    await route.fulfill({ status: 200, contentType: 'application/json', body: await res.text() });
  });

  await page.route(/\/api\/trpc\//, async (route) => {
    const url = new URL(route.request().url());
    const procs = url.pathname.split('/api/trpc/')[1].split(',');
    if (!procs.some((p) => PROCS[p])) return route.continue();
    const input = JSON.parse(url.searchParams.get('input') ?? '{}');
    const body = await Promise.all(
      procs.map(async (proc, i) => {
        const args = input[i]?.json;
        calls.push({ proc, args });
        if (!PROCS[proc]) return { error: { json: { message: 'not stubbed', code: -32603, data: { code: 'INTERNAL_SERVER_ERROR', httpStatus: 500 } } } };
        try {
          return { result: { data: { json: (await PROCS[proc](args)) ?? null } } };
        } catch (e) {
          return { error: { json: { message: e.message, code: -32004, data: { code: 'NOT_FOUND', httpStatus: 404 } } } };
        }
      })
    );
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const startBlock = await fork.getBlockNumber();
  await page.goto(`${APP}/tx?${new URLSearchParams(params)}`, { waitUntil: 'domcontentloaded' });
  const ready = page.getByRole('button', { name: /connect wallet to approve|approve in wallet/ });
  const alert = page.getByRole('alert');
  const invalid = page.getByRole('heading', { name: 'invalid link' });
  await Promise.race([
    ready.first().waitFor({ timeout: 120_000 }),
    alert.first().waitFor({ timeout: 120_000 }),
    invalid.waitFor({ timeout: 120_000 }),
  ]);

  // wagmi may auto-reconnect while we look, so every click here is best-effort.
  if (await page.getByRole('button', { name: 'connect wallet to approve' }).isVisible()) {
    await page.getByRole('button', { name: 'connect wallet to approve' }).click({ timeout: 3_000 }).catch(() => {});
    for (let i = 0; i < 10 && !(await page.getByRole('button', { name: 'approve in wallet' }).isVisible()); i++) {
      await page.getByRole('button', { name: /e2e wallet/i }).first().click({ timeout: 3_000 }).catch(() => {});
      await page.waitForTimeout(1_000);
    }
  }
  // Let issuer checks (re-run with the signer) and the preflight dry-run settle.
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(2_500);

  const approveBtn = page.getByRole('button', { name: 'approve in wallet' });
  // Each detail is its own div; textContent of the whole <details> runs them together.
  const fnRow = (await page.locator('details div', { hasText: /^function: / }).first().textContent({ timeout: 1_000 }).catch(() => '')) ?? '';
  const result = {
    functionName: fnRow.replace(/^function: /, '').trim() || null,
    calldata: ((await page.locator('details div', { hasText: /^data: / }).first().textContent({ timeout: 1_000 }).catch(() => '')) ?? '').replace(/^data: /, '').trim() || null,
    contract: ((await page.locator('details div', { hasText: /^contract: / }).last().textContent({ timeout: 1_000 }).catch(() => '')) ?? '').replace(/^contract: /, '').trim() || null,
    page,
    context,
    calls,
    errors,
    startBlock,
    summary: (await page.locator('main .font-semibold').first().textContent().catch(() => null))?.trim() ?? null,
    alerts: (await alert.allTextContents()).map((t) => t.trim()).filter(Boolean),
    approveVisible: await approveBtn.isVisible(),
    approveEnabled: (await approveBtn.isVisible()) && (await approveBtn.isEnabled()),
    done: false,
    doneHref: null,
  };
  if (label) await page.screenshot({ path: new URL(`./shots/${label}-review.png`, import.meta.url).pathname, fullPage: true });

  if (approve && result.approveEnabled) {
    await approveBtn.click();
    await page.getByRole('heading', { name: 'done' }).waitFor({ timeout: 60_000 });
    result.done = true;
    await page.waitForTimeout(1_000);
    result.doneHref = await page.locator('main a').first().getAttribute('href');
    if (label) await page.screenshot({ path: new URL(`./shots/${label}-done.png`, import.meta.url).pathname, fullPage: true });
  }
  return result;
}

export async function launch() {
  return chromium.launch({ channel: 'chrome', headless: true });
}

export function reporter() {
  const results = [];
  const check = (scenario, name, ok, detail = '') => {
    results.push({ scenario, name, ok: !!ok, detail: String(detail) });
    console.log(`${ok ? 'PASS' : 'FAIL'}  [${scenario}] ${name}${detail !== '' ? `  (${detail})` : ''}`);
  };
  return { results, check };
}
