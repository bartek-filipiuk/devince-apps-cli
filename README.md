# devince-apps

Installs what you bought on [apps.devince.dev](https://apps.devince.dev) into Claude Code with one command.

```bash
npx devince-apps install <link from the e-mail>   # downloads, verifies, places the files
npx devince-apps buy security-audit               # checkout in the browser, then install
npx devince-apps claim <session id>               # finish a purchase started with buy
npx devince-apps status                           # what is installed
```

### From inside Claude Code

Type `! npx devince-apps buy security-audit --agree` at the Claude Code prompt (the `!` runs a shell
command). There is no terminal to answer a question in, so `--agree` stands for the consent that
`buy` prints. The payment page opens in your browser; the command waits about a minute, and if the
payment is not in yet it prints `npx devince-apps claim <session id>` to finish with. The download
link also arrives by e-mail.

Files go to `~/.claude/skills/<name>`. A previous copy is moved to `~/.claude/skills/.devince-backup/`, never deleted.

## What it checks before writing anything

- It talks only to `apps.devince.dev` over https and follows redirects only there.
- The archive is parsed by a strict reader: entries with `..`, absolute paths, backslashes, symlinks,
  encryption, unsupported compression, a size or CRC that does not match the central directory, or an
  extracted size over the cap are refused. The archive is never passed to a shell or an unzip binary.
- The archive must carry `devince-install.json` naming the product and the folders to place.
  Destinations are confined to `~/.claude/skills/<name>`.
- A symlinked destination is left alone unless you pass `--force`.
- No telemetry, no configuration files, no environment variables except `DEVINCE_APPS_HOME` (where
  `~/.claude` is; used by the tests).

## Buying from the terminal

`buy` asks for the consent required for digital content (you lose the right of withdrawal once the
file is delivered), creates a checkout session with the store, opens the payment page in your browser
and polls the store until the payment is confirmed. The price is set by the store, never by this tool.
The download link is also e-mailed to you, so a closed terminal loses nothing.

## Develop

```bash
node --test test/          # zip reader, manifest, install, store helpers
node src/cli.js install ./some-package.zip   # install a local archive
```

Zero dependencies. Node 20 or newer. MIT.
