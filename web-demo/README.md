# Money Printer OS: web demo

A browser-only build of the real HUD that anyone can open from a website: no install, no server, no keys,
no trading. It is the unmodified `public/` HUD plus `demo-shim.js`, which answers every `/api/*` call in
the browser from a recorded PAPER session (`fixtures.json`).

Live at https://moneyprinter.bangbowbing.net (Cloudflare Pages project `money-printer`, also served at
https://money-printer-ad1.pages.dev).

## What visitors get

- The HUD's own log-on screen, the camera pull-back from the sky to the hill, then the welcome and the
  money shower. The bills can be grabbed and thrown.
- A new session on every page load. The paper book opens at 1 SOL, runs the Evolution Lab champion that
  was current at recording time, and plays for about 30 minutes: balances, trades, equity curve,
  scoreboard, journal and qualification. It then holds on the last frame instead of restarting.
  Timestamps are moved to "now", so ages and clocks read as live.
- Every desktop window and tab, in Simple and Advanced mode, drawn from real engine output.
- Buttons that would change something (pause, kill, place, reset, keys…) answer with a plain
  "this is the web demo" message. A ribbon at the top says it is a recorded paper session.

## Build and publish

```bash
npm run web-demo:build
npx wrangler@4 pages deploy web-demo/dist --project-name money-printer --branch main --commit-dirty=true
```

The build writes `web-demo/dist/`: plain static files, about 6–8 MB, with paths that are all relative.
It works on any static host and from any sub-folder. Wrangler uses the Cloudflare login stored by
`npx wrangler@4 login`. To check the build locally first, run `npm run web-demo:serve` and open
http://127.0.0.1:8840/.

## Refresh the recording

```bash
npm run web-demo:record -- --minutes 32
```

This starts the paper engine at 1 SOL behind a recording proxy at http://127.0.0.1:18793/. It runs from
a fresh temp folder with a scrubbed environment: no `.env`, no keys, none of your AppData or P/L.

- **Lab champion:** it copies the Lab's champion and module files in from
  `%APPDATA%/Money Printer OS/data/lab-link` and refreshes them every 30 s. Use `--lab <dir>` to pick
  another folder, or `--no-lab` for none.
- **No clicking needed:** it captures the opening book within a second of starting and saves the
  timeline endpoints every 20 s. At 2 and 6 minutes in, it also fetches every endpoint the previous
  recording knew about. Browse the proxy URL only to capture a panel that is new.

When it finishes, run the build and publish commands above.

The build removes local paths and your user name from the data. It refuses to write the bundle if any
are left, and it checks that every timeline frame rebuilds exactly. It also drops the project journal,
because that holds git commit history. In the browser, `window.__MPO_DEMO_MISSES` lists any API call the
recording did not cover.

## Limits

- It is a replay. Nothing is traded or simulated in the browser, and settings changes are not kept.
- Panels that need provider keys (Alpaca stock data, Polymarket US account…) show the same "keys needed"
  state as a fresh install.
- Data is as of the recording date. Re-record to refresh it.
