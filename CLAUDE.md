# devince-apps CLI

## Mapa terenu (2026-10-04)

### Architektura
- `src/cli.js`: argv, commands (`install`, `buy`, `claim`, `status`), all user-facing output.
- `src/store.js`: every network call; https and the `apps.devince.dev` / `devince.dev` allowlist only.
- `src/install.js`: manifest validation, placing skills in `~/.claude/skills`, saving project archives.
- `src/zip.js`: strict zip reader, no unzip binary, no shell.

### Przepływy krytyczne
- install: `cli.install` → `store.downloadUrlFrom` → `store.downloadArchive` → `install.inspectArchive` → `install.installArchive` (skills) or `install.saveArchive` (project zip, no `devince-install.json`).
- buy: `cli.buy` (consent) → `store.createCheckout` → `store.waitForGrant` → install.

### Pułapki
- A download link allows 5 uses. Any failure after a download must leave the buyer with the file (kept zip or saved project), never just an error.
- Importing `src/cli.js` runs the CLI; test logic in `install.js` / `store.js`, not in `cli.js`.
- Server side lives in `~/main-projects/devince.dev` (`src/app/(frontend)/api/apps/`).

### Weryfikacja
- `npm test` (node --test test/): all pass, 7 tests on 2026-10-04.
- Publishing: GitHub release triggers `.github/workflows/publish.yml` (tests, then `npm publish --provenance`). Bump `version` in package.json first.
