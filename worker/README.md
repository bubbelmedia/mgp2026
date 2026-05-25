# mgp2026-admin worker

Cloudflare Worker that powers the admin panel in [../index.html](../index.html).

It exposes two endpoints:

| Method | Path      | Body                              | Purpose                                                              |
|--------|-----------|-----------------------------------|----------------------------------------------------------------------|
| POST   | `/verify` | `{ "password": "..." }`           | Used by the Login button. Returns `200` on match, `401` otherwise.   |
| POST   | `/apply`  | `{ "password": "...", "prompt": "..." }` | Fetches `index.html` from GitHub, asks Claude to rewrite it per the prompt, commits the result back to `main`. |

The page hits `/apply`, then auto-reloads to show the committed version.

## One-time setup

```bash
npm install
npx wrangler login
```

### Create the GitHub token

Use a **fine-grained personal access token**, not a classic one:

1. https://github.com/settings/personal-access-tokens/new
2. **Resource owner:** your account / org
3. **Repository access:** select **`BubbelMedia/mgp2026`** only
4. **Permissions → Repository → Contents:** **Read and write**
5. Generate, copy the token.

### Push the three secrets to Cloudflare

```bash
npm run secret:anthropic   # paste your Anthropic API key
npm run secret:password    # pick a strong admin password
npm run secret:github      # paste the GitHub PAT
```

### Deploy

```bash
npm run deploy
```

Wrangler prints the worker URL, e.g. `https://mgp2026-admin.<account>.workers.dev`.

### Wire the URL into the page

Edit [../index.html](../index.html) and set:

```js
const ADMIN_WORKER_URL='https://mgp2026-admin.<account>.workers.dev';
```

Commit and push. Done — the admin panel is live.

## Local development

```bash
cp .dev.vars.example .dev.vars   # fill in the three values
npm run dev                       # wrangler dev, serves on http://localhost:8787
```

Then point `ADMIN_WORKER_URL` at `http://localhost:8787` while testing.

## Configuration

Non-secret config lives in [`wrangler.toml`](wrangler.toml) under `[vars]`:

| Var                | Default               | Notes                                              |
|--------------------|-----------------------|----------------------------------------------------|
| `GITHUB_OWNER`     | `BubbelMedia`         | Repo owner.                                        |
| `GITHUB_REPO`      | `mgp2026`             | Repo name.                                         |
| `GITHUB_BRANCH`    | `main`                | Branch to read from and commit to.                 |
| `GITHUB_FILE_PATH` | `index.html`          | File the worker rewrites.                          |
| `CLAUDE_MODEL`     | `claude-sonnet-4-6`   | Swap to `claude-opus-4-7` for higher quality.      |

## Cost & safety notes

- Each `/apply` call ships ~74 KB of HTML in and gets ~74 KB back. With Sonnet 4.6 that's roughly **$0.10–0.30 per change**. Opus 4.7 is ~5× that. Haiku 4.5 is cheaper but unreliable on full-file rewrites.
- The worker has **no rate limit**. If the admin password leaks, an attacker can rack up Anthropic charges. Add a Cloudflare WAF rate-limit rule before exposing the URL publicly.
- The worker does **not validate Claude's output beyond requiring it start with `<`**. If Claude returns something that breaks the page, the commit still happens — `git revert` to recover.
- The admin password is sent in the request body over HTTPS. Don't share it.
