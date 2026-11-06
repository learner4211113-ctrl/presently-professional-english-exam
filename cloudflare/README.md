# Free Cloudflare deployment (GitHub source)

This is the no-monthly-hosting version of the Professional English speaking exam portal. GitHub stores the code; Cloudflare Workers serves the site and API; Cloudflare D1 stores encrypted exam records. It does not use GitHub Pages, because GitHub Pages cannot run the secure server required by student login and AI assessment.

## What this version does

- Students register and sign in, then speak their presentation and five answers. The browser displays automatic speech transcripts; there are no answer text boxes in the exam flow.
- The OpenAI API key remains a Cloudflare Worker secret. A temporary Realtime credential is returned to the browser for the student voice session.
- User accounts, transcripts, assignments, and scores are encrypted with AES-GCM before they are stored in D1.
- Automated marks stay private until a teacher reviews and publishes them.
- It fails closed if the AI key or required configuration is missing. There is no demo grade path in the production Worker.

## Cloudflare free-plan limits

Free plan limits apply (currently up to 100,000 Worker requests/day, 5 million D1 row reads/day, 100,000 D1 row writes/day, and 5 GB database storage). If a daily quota is reached, requests can fail until reset. OpenAI API usage is billed separately and is not included in Cloudflare's free plan.

## Required one-time setup

1. Create a new **private** GitHub repository for this portal and upload the project files from the package root. Do not upload `.env`, API keys, student data, or the local `data/` folder.
2. In the signed-in Cloudflare account, create a D1 database named `presently-exam-data`.
3. Replace `CREATE_D1_DATABASE_FIRST` in `cloudflare/wrangler.toml` with that database's ID. Keep the configured binding name `DB`.
4. In GitHub repository **Settings → Secrets and variables → Actions**, add these repository secrets:
   - `CLOUDFLARE_API_TOKEN` — a Cloudflare account token with **Workers Scripts Edit** and **D1 Edit** permissions, restricted to this account.
   - `CLOUDFLARE_ACCOUNT_ID` — shown in the Cloudflare dashboard URL/account overview.
   - `D1_DATABASE_ID` — the ID of the database created above.
   - `ADMIN_EMAIL` — the teacher's sign-in email.
   - `ADMIN_PASSWORD` — a unique password of at least 12 characters.
   - `OPENAI_API_KEY` — the OpenAI secret key; never place it in the source code or send it in chat.
   - `DATA_ENCRYPTION_KEY` — a random secret of at least 32 characters. Keep a secure backup; without it, encrypted exam records cannot be read.
5. In the repository's **Actions** tab, select **Deploy exam portal to Cloudflare Workers**, then click **Run workflow**. `.github/workflows/deploy-cloudflare.yml` creates the tables, uploads the secrets, and deploys the site. The public address appears in the Cloudflare Worker overview as a `workers.dev` URL.

The first student registration creates the student account immediately. Create and activate an assignment from the teacher dashboard after signing in.

## Local checks

The Worker entry point is syntax-checked by GitHub Actions before deployment. The Node server and its regression suite remain in the repository for local development (`node --test tests/server.test.mjs`).

