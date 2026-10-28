// Replaces OpenTakeoff's lib/msgraph/auth.js (vendor/PATCHES.md, OpenTakeoff section 3).
//
// Upstream's experimental Microsoft 365 sync signs in with MSAL (@azure/msal-browser). It
// only loads on a build configured for a 365 library (VITE_M365_*), which the Brink app
// never is: the project database is the store of record. The module is kept importable so
// upstream's plan navigator compiles; any call says why it is not available.
const NOT_HERE = "Microsoft 365 sync is not used in the Brink app: the project is stored in the Brink database.";

export function createMsalAuth(): { signIn(): Promise<never>; signOut(): Promise<void>; currentAccount(): Promise<null>; getToken(): Promise<never> } {
  return {
    signIn: () => Promise.reject(new Error(NOT_HERE)),
    signOut: () => Promise.resolve(),
    currentAccount: () => Promise.resolve(null),
    getToken: () => Promise.reject(new Error(NOT_HERE)),
  };
}
