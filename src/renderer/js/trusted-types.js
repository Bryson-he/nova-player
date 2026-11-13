// The page's security policy requires Trusted Types, so script URLs (the
// hls.js and libass workers) must pass through this policy: only our own
// files and blob: URLs the page made itself are allowed. Nothing may create
// HTML or script from strings.
if (window.trustedTypes?.createPolicy) {
  window.trustedTypes.createPolicy('default', {
    createScriptURL(url) {
      const u = new URL(url, location.href);
      if (u.origin === location.origin || (u.protocol === 'blob:' && u.href.startsWith(`blob:${location.origin}/`))) return u.href;
      throw new TypeError(`Blocked script URL ${u.href}`);
    },
  });
}
