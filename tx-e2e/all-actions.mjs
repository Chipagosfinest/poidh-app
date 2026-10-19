// Every /tx action end-to-end on the anvil fork: happy paths verified by the
// real contract's events/state, plus the guards that must stop a bad approval.
import { mkdirSync, writeFileSync } from 'node:fs';
import { parseEther } from 'viem';
import { ACCOUNTS, OFFSET, chainNow, events, fixture, fork, launch, POIDH, abi, reporter, runTx, warp } from './lib.mjs';

mkdirSync(new URL('./shots', import.meta.url).pathname, { recursive: true });
const { A0, A1, A2, A3 } = ACCOUNTS;
const { results, check } = reporter();
const browser = await launch();
const lc = (s) => s?.toLowerCase();
const fnOf = async (r) => r.functionName;
const pending = (who) => fork.readContract({ address: POIDH, abi, functionName: 'pendingWithdrawals', args: [who] });
const pageUrl = (onchain) => `https://poidh.xyz/base/bounty/${onchain + OFFSET}`;
const step = async (name, fn, needs = []) => {
  if (needs.some((v) => v === undefined)) return check(name, 'skipped: an earlier step it depends on failed', false);
  try {
    await fn();
  } catch (e) {
    check(name, 'ran without crashing', false, e.message.split('\n')[0]);
  }
};
const blocked = (r) => !r.approveEnabled && !r.done;

let B; // open bounty (issuer A1)
let C; // A2's claim on B
let S; // solo bounty (issuer A0)
let C2; // A3's claim on S

await step('create open', async () => {
  const r = await runTx(browser, {
    account: A1,
    label: 'create-open',
    params: { action: 'create_bounty', chain: 'base', type: 'open', title: `open e2e ${Date.now()}`, description: 'open bounty e2e', amountEth: '0.001' },
  });
  const [ev] = await events('BountyCreated', { issuer: A1 }, r.startBlock + 1n);
  check('create open', 'real BountyCreated, open, from A1', ev?.args.isOpenBounty === true, ev ? `onchain #${ev.args.id}` : 'none');
  B = Number(ev.args.id);
  check('create open', 'called createOpenBounty', (await fnOf(r)) === 'createOpenBounty');
  if (process.env.EXPECT_ARTICLE) check('create open', 'summary reads "Create an open bounty"', /^Create an open bounty "/.test(r.summary ?? ''), r.summary);
  await r.page.getByRole('link', { name: 'view your bounty' }).waitFor({ timeout: 15_000 });
  check('create open', 'done links to the new bounty', (await r.page.getByRole('link', { name: 'view your bounty' }).getAttribute('href')) === `/base/bounty/${B + OFFSET}`);
  await r.context.close();
});

await step('join own bounty', async () => {
  const r = await runTx(browser, { account: A1, params: { action: 'join_bounty', chain: 'base', id: B + OFFSET, amountEth: '0.002' } });
  check('join own bounty', 'issuer is blocked from adding funds', blocked(r) && r.alerts.some((a) => /cannot add funds/i.test(a)), r.alerts.join(' | '));
  await r.context.close();
}, [B]);

await step('join below minimum', async () => {
  const r = await runTx(browser, { account: A0, params: { action: 'join_bounty', chain: 'base', id: B + OFFSET, amountEth: '0.000001' } });
  check('join below minimum', 'blocked with the minimum', blocked(r) && r.alerts.some((a) => /minimum contribution/i.test(a)), r.alerts.join(' | '));
  await r.context.close();
}, [B]);

await step('join', async () => {
  const r = await runTx(browser, { account: A0, label: 'join', params: { action: 'join_bounty', chain: 'base', id: B + OFFSET, amountEth: '0.002' } });
  const [ev] = await events('BountyJoined', { bountyId: BigInt(B), participant: A0 }, r.startBlock + 1n);
  check('join', 'real BountyJoined for A0 with 0.002 ETH', ev?.args.amount === parseEther('0.002'), ev?.args.amount);
  check('join', 'joined the right onchain bounty', !!ev, `onchain #${B}`);
  check('join', 'done links to the bounty page', r.doneHref === pageUrl(B), r.doneHref);
  await r.context.close();
}, [B]);

await step('claim by issuer', async () => {
  const r = await runTx(browser, { account: A1, params: { action: 'submit_claim', chain: 'base', id: B + OFFSET, title: 'mine', description: 'x', proofUri: 'https://example.com/a.jpg' } });
  check('claim by issuer', 'issuer is blocked from claiming', blocked(r) && r.alerts.some((a) => /issuer cannot submit/i.test(a)), r.alerts.join(' | '));
  await r.context.close();
}, [B]);

await step('claim with javascript: proof', async () => {
  const r = await runTx(browser, { account: A2, params: { action: 'submit_claim', chain: 'base', id: B + OFFSET, title: 'x', description: 'x', proofUri: 'javascript:alert(1)' } });
  const invalid = await r.page.getByRole('heading', { name: 'invalid link' }).isVisible();
  check('claim with javascript: proof', 'rejected before any approval', blocked(r) && (invalid || r.alerts.some((a) => /proofUri|https/i.test(a))), invalid ? 'invalid link page' : r.alerts.join(' | '));
  await r.context.close();
}, [B]);

await step('claim', async () => {
  const proof = 'https://example.com/proof.jpg';
  const r = await runTx(browser, { account: A2, label: 'claim', params: { action: 'submit_claim', chain: 'base', id: B + OFFSET, title: 'e2e claim', description: 'did it', proofUri: proof } });
  const [ev] = await events('ClaimCreated', { issuer: A2, bountyId: BigInt(B) }, r.startBlock + 1n);
  check('claim', 'real ClaimCreated on the bounty with the proof URI', ev?.args.imageUri === proof, ev?.args.imageUri);
  C = Number(ev.args.id);
  check('claim', 'done links to the bounty page', r.doneHref === pageUrl(B), r.doneHref);
  await r.context.close();
}, [B]);

await step('accept by non-issuer', async () => {
  const r = await runTx(browser, { account: A0, params: { action: 'accept_claim', chain: 'base', id: B + OFFSET, claimId: C + OFFSET } });
  check('accept by non-issuer', 'blocked', blocked(r) && r.alerts.some((a) => /only the bounty issuer/i.test(a)), r.alerts.join(' | '));
  await r.context.close();
}, [B, C]);

await step('accept claim from another bounty', async () => {
  const r = await runTx(browser, { account: A1, params: { action: 'accept_claim', chain: 'base', id: B + OFFSET, claimId: OFFSET + 1 } });
  check('accept claim from another bounty', 'blocked as not found on this bounty', blocked(r) && r.alerts.some((a) => /not found on bounty/i.test(a)), r.alerts.join(' | '));
  await r.context.close();
}, [B]);

await step('accept → vote', async () => {
  const r = await runTx(browser, { account: A1, label: 'accept-vote', params: { action: 'accept_claim', chain: 'base', id: B + OFFSET, claimId: C + OFFSET } });
  check('accept → vote', 'summary says it starts a vote', /start a contributor vote/i.test(r.summary ?? ''), r.summary);
  check('accept → vote', 'calls submitClaimForVote (outside contributor)', (await fnOf(r)) === 'submitClaimForVote');
  const [ev] = await events('VotingStarted', { bountyId: BigInt(B), claimId: BigInt(C) }, r.startBlock + 1n);
  check('accept → vote', 'real VotingStarted for this claim', !!ev);
  check('accept → vote', 'done links to the bounty page', r.doneHref === pageUrl(B), r.doneHref);
  await r.context.close();
}, [B, C]);

await step('resolve too early', async () => {
  const r = await runTx(browser, { account: A3, params: { action: 'resolve_vote', chain: 'base', id: B + OFFSET }, clockAt: await chainNow() });
  check('resolve too early', 'blocked while the vote is open', blocked(r) && r.alerts.some((a) => /still open/i.test(a)), r.alerts.join(' | '));
  await r.context.close();
}, [B, C]);

await step('vote by non-contributor', async () => {
  const r = await runTx(browser, { account: A3, params: { action: 'vote', chain: 'base', id: B + OFFSET, approve: 'true' }, clockAt: await chainNow() });
  check('vote by non-contributor', 'blocked (dry-run would revert)', blocked(r), r.alerts.join(' | ') || 'approve enabled');
  await r.context.close();
}, [B, C]);

await step('vote', async () => {
  const r = await runTx(browser, { account: A0, label: 'vote', params: { action: 'vote', chain: 'base', id: B + OFFSET, approve: 'true' }, clockAt: await chainNow() });
  const [ev] = await events('VoteCast', { voter: A0, bountyId: BigInt(B) }, r.startBlock + 1n);
  check('vote', 'real VoteCast yes from A0 on this claim', ev?.args.support === true && Number(ev?.args.claimId) === C, ev ? `weight ${ev.args.weight}` : 'none');
  check('vote', 'done links to the bounty page', r.doneHref === pageUrl(B), r.doneHref);
  await r.context.close();
}, [B, C]);

await step('vote twice', async () => {
  const r = await runTx(browser, { account: A0, label: 'vote-twice', params: { action: 'vote', chain: 'base', id: B + OFFSET, approve: 'false' }, clockAt: await chainNow() });
  check('vote twice', 'blocked by the dry-run', blocked(r) && r.alerts.some((a) => /would fail onchain/i.test(a)), r.alerts.join(' | '));
  await r.context.close();
}, [B, C]);

await step('resolve', async () => {
  const period = Number(await fork.readContract({ address: POIDH, abi, functionName: 'votingPeriod' }));
  await warp(period + 60);
  const before = await pending(A2);
  const r = await runTx(browser, { account: A3, label: 'resolve', params: { action: 'resolve_vote', chain: 'base', id: B + OFFSET }, clockAt: await chainNow() });
  const [res] = await events('VotingResolved', { bountyId: BigInt(B) }, r.startBlock + 1n);
  check('resolve', 'real VotingResolved, passed', res?.args.passed === true, res ? `yes ${res.args.yes} / no ${res.args.no}` : 'none');
  const [acc] = await events('ClaimAccepted', { bountyId: BigInt(B), claimId: BigInt(C) }, r.startBlock + 1n);
  check('resolve', 'claim accepted and A2 credited', lc(acc?.args.claimIssuer) === lc(A2) && (await pending(A2)) - before === acc?.args.payout, acc ? `payout ${acc.args.payout}` : 'none');
  check('resolve', 'done links to the bounty page', r.doneHref === pageUrl(B), r.doneHref);
  await r.context.close();
}, [B, C]);

await step('claim on a finished bounty', async () => {
  const r = await runTx(browser, { account: A3, params: { action: 'submit_claim', chain: 'base', id: B + OFFSET, title: 'late', description: 'x', proofUri: 'https://example.com/b.jpg' } });
  check('claim on a finished bounty', 'blocked as not open', blocked(r) && r.alerts.some((a) => /not open/i.test(a)), r.alerts.join(' | '));
  await r.context.close();
}, [B, C]);

await step('withdraw', async () => {
  const owed = await pending(A2);
  const r = await runTx(browser, { account: A2, label: 'withdraw', params: { action: 'withdraw', chain: 'base' } });
  const [ev] = await events('Withdrawal', { user: A2 }, r.startBlock + 1n);
  check('withdraw', 'real Withdrawal of everything owed', owed > 0n && ev?.args.amount === owed && (await pending(A2)) === 0n, `owed ${owed}`);
  check('withdraw', 'done links to the signer account', r.doneHref === `https://poidh.xyz/account/${A2}`, r.doneHref);
  await r.context.close();
}, [B, C]);

await step('withdraw with nothing owed', async () => {
  const r = await runTx(browser, { account: A2, label: 'withdraw-empty', params: { action: 'withdraw', chain: 'base' } });
  check('withdraw with nothing owed', 'blocked by the dry-run', blocked(r), r.alerts.join(' | ') || 'approve enabled');
  await r.context.close();
}, [B, C]);

await step('solo setup', async () => {
  const rc = await fixture(A0, 'createSoloBounty', [`solo e2e ${Date.now()}`, 'solo bounty e2e'], '0.001');
  const [ev] = await events('BountyCreated', { issuer: A0 }, rc.blockNumber);
  S = Number(ev.args.id);
  const rc2 = await fixture(A3, 'createClaim', [BigInt(S), 'solo claim', 'did it', 'ipfs://bafyclaim']);
  const [cv] = await events('ClaimCreated', { bountyId: BigInt(S) }, rc2.blockNumber);
  C2 = Number(cv.args.id);
  check('solo setup', 'fixtures created onchain', S > 0 && C2 > 0, `bounty #${S}, claim #${C2}`);
});

await step('join a solo bounty', async () => {
  const r = await runTx(browser, { account: A1, params: { action: 'join_bounty', chain: 'base', id: S + OFFSET, amountEth: '0.002' } });
  check('join a solo bounty', 'blocked: solo bounties take no funds', blocked(r) && r.alerts.some((a) => /is solo/i.test(a)), r.alerts.join(' | '));
  await r.context.close();
}, [S]);

await step('accept solo', async () => {
  const before = await pending(A3);
  const r = await runTx(browser, { account: A0, label: 'accept-solo', params: { action: 'accept_claim', chain: 'base', id: S + OFFSET, claimId: C2 + OFFSET } });
  check('accept solo', 'calls acceptClaim directly (no vote)', (await fnOf(r)) === 'acceptClaim');
  check('accept solo', 'summary says it pays out', /accept claim .* pay out/i.test(r.summary ?? ''), r.summary);
  const [acc] = await events('ClaimAccepted', { bountyId: BigInt(S), claimId: BigInt(C2) }, r.startBlock + 1n);
  check('accept solo', 'real ClaimAccepted and A3 credited', !!acc && (await pending(A3)) - before === acc.args.payout, acc ? `payout ${acc.args.payout}` : 'none');
  check('accept solo', 'done links to the bounty page', r.doneHref === pageUrl(S), r.doneHref);
  await r.context.close();
}, [S, C2]);

await step('retired chain link', async () => {
  const r = await runTx(browser, { account: A0, approve: false, params: { action: 'withdraw', chain: 'degen' } });
  check('retired chain link', 'shows "invalid link", nothing to approve', (await r.page.getByRole('heading', { name: 'invalid link' }).isVisible()) && !r.approveVisible);
  await r.context.close();
});

await browser.close();
writeFileSync(new URL('./all-actions-results.json', import.meta.url).pathname, JSON.stringify({ B, C, S, C2, results }, null, 2));
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
for (const f of failed) console.log(`FAILED  [${f.scenario}] ${f.name}  (${f.detail})`);
process.exit(failed.length ? 1 : 0);
