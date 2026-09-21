const SCOPE = "https://www.googleapis.com/auth/drive";

// Google access tokens last ~1h and there is no refresh token in this flow
// (no backend to hold a client secret). Renewing means asking Google again,
// and a browser blocks the Google popup unless a user gesture triggered it -
// which used to leave every Drive call silently waiting forever. So:
//  1. renew ahead of time, from a real tap/click (gesture-triggered = allowed);
//  2. if a background renewal still doesn't answer, tell the UI so it can ask
//     the user to reconnect (a click) instead of freezing without a word.
const EXPIRY_MARGIN_MS = 30 * 1000;
const REFRESH_AHEAD_MS = 10 * 60 * 1000;
const NAG_WITHIN_MS = 2 * 60 * 1000;
const STALL_MS = 10 * 1000;

let tokenClient = null;
let currentToken = null;
let tokenExpiry = 0;
let hadToken = false;
let silentWaiters = []; // getToken() callers: they keep waiting until a token arrives
let interactiveWaiters = []; // signIn()/reconnect() callers: settled by Google's answer
let inFlight = false;
let stallTimer = null;
let needsUser = false;
let handlers = { onNeedsUser: null, onRecovered: null };

// onNeedsUser(reason): a silent renewal failed/stalled, show a "reconnect" prompt.
// onRecovered(): a token arrived again, hide it.
export function setAuthHandlers(next) {
  handlers = { ...handlers, ...next };
}

function clearStall() {
  if (stallTimer) clearTimeout(stallTimer);
  stallTimer = null;
}

function tokenNearlyGone() {
  return tokenExpiry - Date.now() < NAG_WITHIN_MS;
}

function markNeedsUser(reason) {
  inFlight = false;
  clearStall();
  // Before the first sign-in there is nothing to "reconnect", and a proactive
  // renewal that failed while the token is still good isn't worth a prompt.
  if (!hadToken || needsUser || !tokenNearlyGone()) return;
  needsUser = true;
  handlers.onNeedsUser?.(reason);
}

function rejectInteractive(err) {
  const waiters = interactiveWaiters;
  interactiveWaiters = [];
  waiters.forEach((w) => w.reject(err));
}

function onTokenResponse(resp) {
  inFlight = false;
  clearStall();
  if (resp.error) {
    rejectInteractive(new Error(resp.error));
    markNeedsUser(resp.error);
    return;
  }
  currentToken = resp.access_token;
  tokenExpiry = Date.now() + (Number(resp.expires_in) || 3500) * 1000;
  hadToken = true;
  const waiters = [...silentWaiters, ...interactiveWaiters];
  silentWaiters = [];
  interactiveWaiters = [];
  waiters.forEach((w) => w.resolve(currentToken));
  if (needsUser) {
    needsUser = false;
    handlers.onRecovered?.();
  }
}

// popup_failed_to_open (blocked), popup_closed (dismissed), unknown.
function onPopupError(err) {
  inFlight = false;
  clearStall();
  rejectInteractive(new Error(err?.type || "popup_error"));
  markNeedsUser(err?.type || "popup_error");
}

export function initAuth(clientId) {
  return new Promise((resolve, reject) => {
    let done = false;
    const giveUp = setTimeout(() => {
      if (!done) reject(new Error("Google Identity Services n'a pas pu charger."));
      done = true;
    }, 10000);
    const check = () => {
      if (done) return;
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPE,
          callback: onTokenResponse,
          error_callback: onPopupError,
        });
        done = true;
        clearTimeout(giveUp);
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
  });
}

function requestToken(prompt) {
  if (!tokenClient) throw new Error("Google Identity Services non initialise");
  clearStall();
  inFlight = true;
  // A request that never answers (popup blocked without any callback) must
  // neither leave the app hanging invisibly nor block every later renewal.
  stallTimer = setTimeout(() => markNeedsUser("stalled"), STALL_MS);
  try {
    tokenClient.requestAccessToken({ prompt });
  } catch (e) {
    inFlight = false;
    clearStall();
    throw e;
  }
}

function interactiveRequest(prompt) {
  return new Promise((resolve, reject) => {
    interactiveWaiters.push({ resolve, reject });
    try {
      requestToken(prompt);
    } catch (e) {
      interactiveWaiters = interactiveWaiters.filter((w) => w.reject !== reject);
      reject(e);
    }
  });
}

// First sign-in: always show the account chooser, so someone signed into
// several Google accounts doesn't silently get whichever one was last used.
export function signIn() {
  return interactiveRequest("select_account consent");
}

// Must be called from a click: the user is the one re-authorising.
export function reconnect() {
  return interactiveRequest("");
}

export function getToken() {
  if (currentToken && Date.now() < tokenExpiry - EXPIRY_MARGIN_MS) return Promise.resolve(currentToken);
  return new Promise((resolve, reject) => {
    silentWaiters.push({ resolve, reject });
    // Once we know a silent renewal can't work, don't keep re-opening
    // (blocked) popups for every pending Drive call - wait for the click.
    if (needsUser || inFlight) return;
    try {
      requestToken("");
    } catch (e) {
      silentWaiters = silentWaiters.filter((w) => w.reject !== reject);
      reject(e);
    }
  });
}

// Call from a user-gesture handler (pointerup, click, keydown). If the token
// is close to expiring, renews it now - inside a gesture the browser allows
// the popup, so nobody ever hits the frozen-after-an-hour case while active.
export function refreshFromGesture() {
  if (!tokenClient || !currentToken || inFlight || needsUser) return;
  if (tokenExpiry - Date.now() > REFRESH_AHEAD_MS) return;
  try {
    requestToken("");
  } catch {
    // ignore - the regular expiry path will surface a reconnect prompt
  }
}

// Google just rejected this token (401): forget it so the next getToken()
// asks for a fresh one instead of reusing it.
export function invalidateToken() {
  currentToken = null;
  tokenExpiry = 0;
}

export function isSignedIn() {
  return !!currentToken;
}

export function signOut() {
  if (currentToken && window.google?.accounts?.oauth2?.revoke) {
    window.google.accounts.oauth2.revoke(currentToken, () => {});
  }
  currentToken = null;
  tokenExpiry = 0;
  hadToken = false;
  needsUser = false;
  inFlight = false;
  clearStall();
  const err = new Error("Deconnecte");
  const waiters = [...silentWaiters, ...interactiveWaiters];
  silentWaiters = [];
  interactiveWaiters = [];
  waiters.forEach((w) => w.reject(err));
}
