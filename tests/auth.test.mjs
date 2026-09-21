import { test, mock, afterEach } from "node:test";
import assert from "node:assert/strict";

let moduleCounter = 0;

// A fake Google Identity Services: captures the callbacks so a test decides
// when (and whether) Google answers.
async function setup() {
  // Simulated clock from the very start, so token lifetimes and the stall
  // timer share one timeline (mixing real and simulated time is meaningless).
  mock.timers.enable({ apis: ["setTimeout", "Date"] });
  const gis = { requests: [], callback: null, errorCallback: null, revoked: [] };
  globalThis.window = {
    google: {
      accounts: {
        oauth2: {
          initTokenClient(cfg) {
            gis.callback = cfg.callback;
            gis.errorCallback = cfg.error_callback;
            return { requestAccessToken: (opts) => gis.requests.push(opts) };
          },
          revoke: (token) => gis.revoked.push(token),
        },
      },
    },
  };
  const auth = await import(`../docs/auth.js?case=${++moduleCounter}`);
  const events = { needsUser: [], recovered: 0 };
  auth.setAuthHandlers({
    onNeedsUser: (reason) => events.needsUser.push(reason),
    onRecovered: () => events.recovered++,
  });
  await auth.initAuth("client-id");
  return { auth, gis, events };
}

const answer = (gis, token = "TOKEN", expiresIn = 3600) => gis.callback({ access_token: token, expires_in: expiresIn });
const flush = () => new Promise((r) => setImmediate(r));

afterEach(() => {
  mock.timers.reset();
  delete globalThis.window;
});

test("a valid cached token is returned without asking Google again", async () => {
  const { auth, gis } = await setup();
  const first = auth.signIn();
  answer(gis);
  await first;
  assert.equal(await auth.getToken(), "TOKEN");
  assert.equal(gis.requests.length, 1);
});

test("concurrent getToken() calls share one silent request", async () => {
  const { auth, gis } = await setup();
  const p1 = auth.getToken();
  const p2 = auth.getToken();
  const p3 = auth.getToken();
  assert.equal(gis.requests.length, 1);
  answer(gis, "T2");
  assert.deepEqual(await Promise.all([p1, p2, p3]), ["T2", "T2", "T2"]);
});

test("signIn always asks with the account chooser", async () => {
  const { auth, gis } = await setup();
  const p = auth.signIn();
  assert.equal(gis.requests[0].prompt, "select_account consent");
  answer(gis);
  await p;
});

test("a refused sign-in rejects and does not trigger the reconnect prompt", async () => {
  const { auth, gis, events } = await setup();
  const p = auth.signIn();
  gis.callback({ error: "access_denied" });
  await assert.rejects(p, /access_denied/);
  assert.deepEqual(events.needsUser, []);
});

test("a silent renewal that never answers surfaces a reconnect prompt instead of hanging silently", async () => {
  const { auth, gis, events } = await setup();
  const first = auth.signIn();
  answer(gis, "T1", 1); // expires immediately
  await first;
  const waiting = auth.getToken();
  let settled = false;
  waiting.then(() => { settled = true; });
  mock.timers.tick(11000);
  await flush();
  assert.equal(settled, false, "the Drive call keeps waiting rather than failing");
  assert.equal(events.needsUser.length, 1);
});

test("a blocked popup is reported right away, once, and later calls do not reopen popups", async () => {
  const { auth, gis, events } = await setup();
  const first = auth.signIn();
  answer(gis, "T1", 1);
  await first;
  auth.getToken();
  gis.errorCallback({ type: "popup_failed_to_open" });
  auth.getToken();
  auth.getToken();
  assert.deepEqual(events.needsUser, ["popup_failed_to_open"]);
  assert.equal(gis.requests.length, 2, "sign-in + the single failed silent attempt only");
});

test("reconnecting (a click) resolves every waiting call and clears the prompt", async () => {
  const { auth, gis, events } = await setup();
  const first = auth.signIn();
  answer(gis, "T1", 1);
  await first;
  const w1 = auth.getToken();
  const w2 = auth.getToken();
  gis.errorCallback({ type: "popup_failed_to_open" });
  const reconnecting = auth.reconnect();
  assert.equal(gis.requests.at(-1).prompt, "");
  answer(gis, "T2");
  await reconnecting;
  assert.deepEqual(await Promise.all([w1, w2]), ["T2", "T2"]);
  assert.equal(events.recovered, 1);
});

test("a proactive renewal only happens near expiry", async () => {
  const { auth, gis } = await setup();
  const first = auth.signIn();
  answer(gis, "T1", 3600);
  await first;
  auth.refreshFromGesture();
  assert.equal(gis.requests.length, 1, "an hour left: nothing to do");
  mock.timers.tick(51 * 60 * 1000); // 9 minutes left
  auth.refreshFromGesture();
  assert.equal(gis.requests.length, 2);
  auth.refreshFromGesture();
  assert.equal(gis.requests.length, 2, "not asked twice while the first is still pending");
});

test("a failed proactive renewal stays quiet while the token is still good", async () => {
  const { auth, gis, events } = await setup();
  const first = auth.signIn();
  answer(gis, "T1", 3600);
  await first;
  mock.timers.tick(51 * 60 * 1000);
  auth.refreshFromGesture();
  gis.errorCallback({ type: "popup_closed" });
  assert.deepEqual(events.needsUser, []);
});

test("invalidateToken forces the next call to ask for a fresh token", async () => {
  const { auth, gis } = await setup();
  const first = auth.signIn();
  answer(gis, "OLD");
  await first;
  auth.invalidateToken();
  const p = auth.getToken();
  assert.equal(gis.requests.length, 2);
  answer(gis, "NEW");
  assert.equal(await p, "NEW");
});

test("signing out revokes the token and releases anything still waiting", async () => {
  const { auth, gis } = await setup();
  const first = auth.signIn();
  answer(gis, "T1", 1);
  await first;
  const waiting = auth.getToken();
  auth.signOut();
  await assert.rejects(waiting, /Deconnecte/);
  assert.equal(auth.isSignedIn(), false);
});

test("signing out with a live token revokes it", async () => {
  const { auth, gis } = await setup();
  const first = auth.signIn();
  answer(gis, "LIVE");
  await first;
  auth.signOut();
  assert.deepEqual(gis.revoked, ["LIVE"]);
});
