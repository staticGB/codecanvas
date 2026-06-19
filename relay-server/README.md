# CodeCanvas Relay Server

This is the piece that makes the code panel actually sync between people in
the same Excalidraw room. GitHub Pages can only serve static files, so this
small always-on process has to live somewhere else. It has zero database and
almost no dependencies (just `ws`), so any of the free tiers below work fine.

## Local test

```
cd relay-server
npm install
npm start
```

It listens on port 8787 by default (or `$PORT` if set). You should see:
`codecanvas relay listening on :8787`

## Deploying (pick one)

### Render (free tier, easiest)
1. Push this `relay-server` folder to its own GitHub repo (or a subfolder of
   an existing one).
2. On render.com: New -> Web Service -> connect the repo.
3. Build command: `npm install`
4. Start command: `npm start`
5. Once deployed you'll get a URL like `https://codecanvas-relay.onrender.com`.
   Your WebSocket URL is the same host with `wss://` instead of `https://`:
   `wss://codecanvas-relay.onrender.com`

### Railway / Fly.io
Same idea — point them at this folder, `npm install` + `npm start`. Both give
you a public hostname; use `wss://<that-host>` as the relay URL.

### Glitch / Replit (quick and dirty)
Import this folder, hit run. Use the project's public URL with `wss://`.

## Wire it into the frontend

Open `code-panel-script.js` near the top and set:

```js
const RELAY_URL = "wss://YOUR-DEPLOYED-HOST-HERE";
```

That's the only thing you need to change. If you leave it as the placeholder,
the code panel still works — it just falls back to "local only" mode (no
cross-browser sync, only localStorage persistence on your own machine).

## Notes

- Rooms are kept in memory, not a database. If you redeploy/restart the
  relay, any code currently being edited gets wiped from the relay's memory
  (but each browser's localStorage cache means nobody loses their own copy).
- One process instance only — if your host spins up multiple instances behind
  a load balancer, rooms won't be consistent across instances. Free tiers
  normally run a single instance, so this isn't a problem until you scale.
