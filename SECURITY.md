# Security

## Reporting a problem

Please report security problems privately, not in a public issue:

- Use GitHub's **[Report a vulnerability](https://github.com/Bryson-he/nova-player/security/advisories/new)**
  form (Security tab → Advisories), or
- open a minimal public issue asking for a private contact, without details.

Say which version of Nova you're on (Settings → About), what you found and how to reproduce it. You should hear
back within a week. Fixes ship as a normal update, and you'll be credited in the release notes unless you'd rather
not be.

## Supported versions

Only the latest release gets security fixes. Nova updates itself, so most people are on it within a day.

## How Nova is built to be safe

- Your Jellyfin sign-in is kept in the main process, encrypted with Windows' data protection, and sent only to
  the server it was issued for, as a request header. It never appears in a link or in the page.
- The page runs sandboxed, with a strict content security policy and Trusted Types, and talks to the main process
  only through a fixed list of checked channels (`src/main/ipc-contract.js`).
- Nova connects to your Jellyfin server and, to check for updates, to GitHub. Nothing else, and no telemetry.
- Releases are built by a read-only GitHub Actions job with actions pinned by commit, and published by a separate
  job that needs approval. Each release lists SHA-256 hashes and a build provenance record:

  ```
  gh attestation verify NovaPlayer-Setup.exe --repo Bryson-he/nova-player
  ```

- Installers aren't code-signed yet; that's being worked on.
