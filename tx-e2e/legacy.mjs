// A bounty from before poidh v3 lives on an older contract, but its on-chain
// id repeats on PoidhV3. Before the fix, /tx built a transaction for the
// PoidhV3 bounty that happens to share that id. Here that id belongs to an
// open bounty created on the fork, so the wrong-bounty transaction is real.
import { ACCOUNTS, LEGACY, events, fixture, launch, reporter, runTx } from './lib.mjs';

const { A0, A1 } = ACCOUNTS;
const { results, check } = reporter();

const rc = await fixture(A0, 'createOpenBounty', [`current bounty ${Date.now()}`, 'someone else’s bounty'], '0.001');
const [created] = await events('BountyCreated', { issuer: A0 }, rc.blockNumber);
const sharedId = Number(created.args.id);

// Shaped like prod's record for Base #176: an old bounty whose on-chain id
// is also used by a different PoidhV3 bounty.
const PAGE = 900;
LEGACY.set(PAGE, {
  id: PAGE, onChainId: sharedId, chainId: 8453, title: 'an old v2 bounty', description: 'v2',
  amount: '1000000000000000', issuer: A0.toLowerCase(), inProgress: true, isCanceled: false,
  isMultiplayer: true, isVoting: false, deadline: null, hasClaims: false,
});

const browser = await launch();
for (const [label, params] of [
  ['join', { action: 'join_bounty', chain: 'base', id: PAGE, amountEth: '0.002' }],
  ['claim', { action: 'submit_claim', chain: 'base', id: PAGE, title: 't', description: 'd', proofUri: 'https://example.com/a.jpg' }],
]) {
  const r = await runTx(browser, { account: A1, label: `${process.env.PREFIX ?? "after"}-legacy-${label}`, params, approve: false });
  check(`legacy ${label}`, 'no approve button', !r.approveVisible, r.functionName ? `would call ${r.functionName}` : '');
  check(`legacy ${label}`, 'explains the bounty is on the older contract', r.alerts.some((a) => /older contract/.test(a)), r.alerts.join(' | ').slice(0, 120));
  await r.context.close();
}
await browser.close();

const failed = results.filter((x) => !x.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`FAILED  [${f.scenario}] ${f.name}  (${f.detail})`);
process.exit(failed.length ? 1 : 0);
