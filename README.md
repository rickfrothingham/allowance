# Allowance

A small web app for tracking a kid's allowance. Both parents can add money or record spending from their phones, and the weekly allowance is added automatically every Monday.

Runs on Cloudflare Workers with a D1 database. Login is handled by Cloudflare Access, so only the email addresses you list can open it.

## How it works

- Every change to the balance is a row in the database: allowance deposits, money added, money spent.
- Nothing runs on a timer. When anyone opens the app, it adds any Monday deposits that are missing. If nobody opens it for three weeks, all three deposits show up the next time someone does.
- "Remove" hides an entry but keeps it in the database, so nothing is ever truly lost.
- Changing the weekly amount only affects future Mondays.

## One-time setup (all in the browser)

1. **Deploy.** Cloudflare dashboard → Workers & Pages → Create → Import a repository → pick this repo. Keep the defaults and deploy. The first deploy creates the database automatically.
2. **Turn on login.** Open the `allowance` Worker → Settings → Domains & Routes → next to `workers.dev`, click **Enable Cloudflare Access**. Then click **Manage Cloudflare Access** and make sure both parents' email addresses are on the allow list.
3. **Open the app** at `https://allowance.<your-subdomain>.workers.dev`, sign in with the code Cloudflare emails you, and fill in the setup screen.
4. **Add to home screen.** iPhone: Share → Add to Home Screen. Android: menu → Add to Home screen.

If the app says "Login is not set up yet," step 2 isn't done. The app refuses all requests until Access is on.

## Files

- `src/index.js`: the server (API and database logic)
- `public/index.html`: the page you see
- `wrangler.jsonc`: Cloudflare settings (app name, database, time zone)

## Local testing (optional)

`npm install`, create `.dev.vars` containing `DEV_USER=you@example.com`, then `npm run dev`.

## Backup

`npx wrangler d1 export allowance --remote --output backup.sql`
