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
    tokenClient.requestAccessToken({ prompt: "consent" });
  });
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
