const SCOPE = "https://www.googleapis.com/auth/drive";

let tokenClient = null;
let currentToken = null;
let tokenExpiry = 0;
let pendingResolvers = [];

export function initAuth(clientId) {
  return new Promise((resolve, reject) => {
    const check = () => {
      if (window.google && window.google.accounts && window.google.accounts.oauth2) {
        tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: clientId,
          scope: SCOPE,
          callback: (resp) => {
            if (resp.error) {
              const resolvers = pendingResolvers;
              pendingResolvers = [];
              resolvers.forEach((r) => r.reject(new Error(resp.error)));
              return;
            }
            currentToken = resp.access_token;
            tokenExpiry = Date.now() + (Number(resp.expires_in) || 3500) * 1000;
            const resolvers = pendingResolvers;
            pendingResolvers = [];
            resolvers.forEach((r) => r.resolve(currentToken));
          },
        });
        resolve();
      } else {
        setTimeout(check, 50);
      }
    };
    check();
    setTimeout(() => reject(new Error("Google Identity Services n'a pas pu charger.")), 10000);
  });
}

export function signIn() {
  return new Promise((resolve, reject) => {
    pendingResolvers.push({ resolve, reject });
    // "select_account" forces Google to show the account chooser instead of
    // silently reusing whichever Google account the browser last used - important
    // for people signed into several Google accounts at once.
    tokenClient.requestAccessToken({ prompt: "select_account consent" });
  });
}

// Tries to get a token without showing the account picker, reusing prior
// consent for the current Google session. Must be called from a click
// handler - Google still opens a (usually instant) popup under the hood,
// and browsers silently block popups not triggered by a user gesture, which
// would otherwise leave this promise hanging forever. Rejects (instead of
// prompting) if that's not possible, and always settles within 8s so the
// caller can fall back to signIn().
export function trySilentSignIn() {
  const attempt = new Promise((resolve, reject) => {
    pendingResolvers.push({ resolve, reject });
    tokenClient.requestAccessToken({ prompt: "" });
  });
  const timeout = new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Delai depasse")), 8000);
  });
  return Promise.race([attempt, timeout]);
}

export function getToken() {
  return new Promise((resolve, reject) => {
    if (currentToken && Date.now() < tokenExpiry - 30000) {
      resolve(currentToken);
      return;
    }
    pendingResolvers.push({ resolve, reject });
    tokenClient.requestAccessToken({ prompt: "" });
  });
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
}
