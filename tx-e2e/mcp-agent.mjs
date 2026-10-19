// Agent → human handoff, end-to-end: an MCP client calls poidh's real
// /api/mcp endpoint (next dev with BASE_RPC_URL = the anvil fork), then
// either the agent sends the transaction itself, or a person opens signUrl
// in a browser and approves it. Both are checked against the real contract.
import { ACCOUNTS, APP, OFFSET, events, fork, launch, reporter, runTx } from './lib.mjs';

const { A0, A1, A3 } = ACCOUNTS;
const { results, check } = reporter();

let rpcId = 0;
async function mcp(name, args) {
  const res = await fetch(`${APP}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  const line = text.split('\n').find((l) => l.startsWith('data: ')) ?? text;
  const msg = JSON.parse(line.replace(/^data: /, ''));
  const result = msg.result;
  let body = result?.structuredContent ?? null;
  if (!body && !result?.isError) body = JSON.parse(result?.content?.[0]?.text ?? 'null');
  return { isError: !!result?.isError || !!msg.error, body, raw: result?.content?.[0]?.text ?? msg.error?.message };
}

// 1. Agent prepares a bounty for A0 and sends it itself.
const title = `agent e2e ${Date.now()}`;
const prep = await mcp('prepare_create_bounty', { chain: 'base', type: 'solo', title, description: 'posted by an agent', amountEth: '0.001', from: A0 });
check('agent prepare', 'returns a transaction, signUrl and afterSigning', !prep.isError && prep.body?.transaction && prep.body?.signUrl && prep.body?.afterSigning, prep.isError ? prep.raw : '');
check('agent prepare', 'dry-run against the fork succeeds', prep.body?.simulation?.ok === true, JSON.stringify(prep.body?.simulation));
check('agent prepare', 'afterSigning is a real page (account), not /base/bounties', prep.body?.afterSigning === `https://poidh.xyz/account/${A0}`, prep.body?.afterSigning);

const start = await fork.getBlockNumber();
const t = prep.body.transaction;
const hash = await fork.request({ method: 'eth_sendTransaction', params: [{ from: A0, to: t.to, data: t.data, value: t.value }] });
const receipt = await fork.waitForTransactionReceipt({ hash });
const [created] = await events('BountyCreated', { issuer: A0 }, start + 1n);
check('agent sends', 'real BountyCreated with the agent’s title', receipt.status === 'success' && created?.args.title === title, created ? `onchain #${created.args.id}` : receipt.status);

// 2. A person opens the agent's signUrl and approves with their own wallet.
const prep2 = await mcp('prepare_create_bounty', { chain: 'base', type: 'open', title: `${title} (human)`, description: 'approved by a person', amountEth: '0.002' });
const signUrl = new URL(prep2.body.signUrl);
check('handoff', 'signUrl points at poidh /tx with plain params, no calldata', signUrl.pathname === '/tx' && !signUrl.search.includes('0x'), signUrl.href.slice(0, 80));
const browser = await launch();
const r = await runTx(browser, { account: A1, label: 'mcp-handoff', params: Object.fromEntries(signUrl.searchParams) });
const [human] = await events('BountyCreated', { issuer: A1 }, r.startBlock + 1n);
check('handoff', 'the person’s approval created the agent’s bounty', human?.args.title === `${title} (human)` && human?.args.isOpenBounty === true && human?.args.amount === 2_000_000_000_000_000n);
check('handoff', 'page built byte-identical calldata, same contract, as the agent was given', r.calldata === prep2.body.transaction.data && r.contract?.toLowerCase() === prep2.body.transaction.to.toLowerCase(), `${r.calldata?.length} hex chars`);
await r.page.getByRole('link', { name: 'view your bounty' }).waitFor({ timeout: 15_000 }).catch(() => {});
check('handoff', 'done page links to the new bounty', (await r.page.getByRole('link', { name: 'view your bounty' }).getAttribute('href').catch(() => null)) === `/base/bounty/${Number(human?.args.id) + OFFSET}`);
await r.context.close();
await browser.close();

// 3. Wallet-type guards, with real code on the fork.
const contract = await mcp('prepare_create_bounty', { chain: 'base', type: 'solo', title: 'x', description: 'x', amountEth: '0.001', from: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' });
check('wallet guard', 'smart-contract wallet refused before signing', contract.isError && /smart-contract wallet/i.test(contract.raw ?? ''), (contract.raw ?? '').slice(0, 90));
await fork.request({ method: 'anvil_setCode', params: [A3, `0xef0100${'1'.repeat(40)}`] });
const delegated = await mcp('prepare_create_bounty', { chain: 'base', type: 'solo', title: 'x', description: 'x', amountEth: '0.001', from: A3 });
check('wallet guard', 'EIP-7702 wallet allowed, with a warning', !delegated.isError && (delegated.body?.warnings ?? []).some((w) => /7702/.test(w)), JSON.stringify(delegated.body?.warnings));
await fork.request({ method: 'anvil_setCode', params: [A3, '0x'] });

// 4. Withdraw with nothing owed: the agent learns before asking anyone to sign.
const wd = await mcp('prepare_withdraw', { chain: 'base', from: A1 });
check('withdraw', 'dry-run reports the revert to the agent', wd.body?.simulation?.ok === false, JSON.stringify(wd.body?.simulation));

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`FAILED  [${f.scenario}] ${f.name}  (${f.detail})`);
process.exit(failed.length ? 1 : 0);
