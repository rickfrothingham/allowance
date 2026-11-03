# Allowance

A small web app for tracking a kid's allowance. Both parents can add money or record spending from their phones, and the weekly allowance is added automatically every Monday.

Runs on Cloudflare Workers with a D1 database. There's no login. The app only opens at a secret link, `https://allowance.<your-subdomain>.workers.dev/k/<APP_KEY>/`, where `APP_KEY` is a long random string you keep as a Cloudflare secret. Any other address, including the bare one, shows "Not found".

Anyone who has the link can use the app, so share it only with each other. If it ever gets out, change `APP_KEY` (see below) and the old link stops working.

## How it works

- Every change to the balance is a row in the database: allowance deposits, money added, money spent.
- Nothing runs on a timer. When anyone opens the app, it adds any Monday deposits that are missing. If nobody opens it for three weeks, all three deposits show up the next time someone does.
- Add and Spend have a date field (defaults to today). Tap any entry in the history to change its date. Automatic Monday deposits can't be moved, since the schedule is worked out from them. Future dates aren't allowed.
- Each phone asks "Who's using this phone?" once (with Rick and Megan offered as buttons, set by `PEOPLE` in `wrangler.jsonc`) and shows that name next to its entries. It's for the history only, not security. On iPhone, the home-screen app keeps its own storage, so it asks once more there.
- "Remove" hides an entry but keeps it in the database, so nothing is ever truly lost.
- Changing the weekly amount only affects future Mondays.

## One-time setup (all in the browser)

1. **Deploy.** Cloudflare dashboard → Workers & Pages → Create → Import a repository → pick this repo. Keep the defaults and deploy. The first deploy creates the database automatically.
2. **Make a key.** Any random string of at least 24 letters and numbers works. Easiest: run `openssl rand -hex 16` in a terminal, or use a password manager's generator (letters and numbers only, 32 characters).
3. **Save it as a secret.** Open the `allowance` Worker → Settings → Variables and Secrets → Add. Type: **Secret**, name: `APP_KEY`, value: your key. Save and deploy. It has to be the Secret type: plain variables get replaced on the next deploy from GitHub, secrets don't.
4. **Open the app** at `https://allowance.<your-subdomain>.workers.dev/k/<your key>/`, pick your name, and fill in the setup screen.
5. **Add to home screen** from that page. iPhone: Share → Add to Home Screen. Android: menu → Add to Home screen. The icon opens the secret link, so you never type it again.
6. **Send the link to the other parent** by text or however you like, and they do step 5.

If the app says "This app is locked," the `APP_KEY` secret isn't set (or is shorter than 24 characters).

### Changing the key

Edit `APP_KEY` in Variables and Secrets and deploy. The old link and old home-screen icons stop working right away. Delete the old icons, open the new link, and add it to the home screen again. Nothing in the database changes.

### Moving over from the old Cloudflare Access login

After the secret is set and the new link works, open the Worker → Settings → Domains & Routes → next to `workers.dev`, click **Disable Cloudflare Access**. Entries made under the old login keep showing the email's first part (e.g. `rick`) as the name.

## Files

- `src/index.js`: the server (API and database logic)
- `src/page.html`: the page you see (served only at the secret link)
- `public/`: app icons (public, harmless)
- `wrangler.jsonc`: Cloudflare settings (app name, database, time zone)

## Local testing (optional)

`npm install`, create `.dev.vars` containing `APP_KEY=localtestkey_0123456789abc`, then `npm run dev` and open `http://localhost:8787/k/localtestkey_0123456789abc/`.

## Backup

`npx wrangler d1 export allowance --remote --output backup.sql`
