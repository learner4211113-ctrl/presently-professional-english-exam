# Presently — Professional English Speaking Exam

A student-facing exam portal with teacher-controlled final results. Students register, consent to the exam, speak their presentation, and answer five spoken questions. The browser transcribes what they say; students do not type answers. AI prepares an individual workplace slide and provisional assessment. Teachers review the transcript and assessment, set the final score, and publish it before the student can see the result.

## Features

- Student self-registration and sign-in.
- Individually generated professional workplace slide.
- Consent-first camera/microphone flow, five-minute preparation, and a ten-minute spoken presentation.
- Five AI-generated oral follow-up questions; spoken responses are transcribed automatically.
- 100-point rubric: professional English and grammar (20), fluency/pronunciation (15), vocabulary (15), structure (15), eye contact/body language (10), confidence/communication (10), and Q&A (15).
- Private teacher dashboard with review, score editing, feedback, and explicit result publishing.
- AI marks are provisional; students only see the teacher-published result.
- AES-GCM encryption for stored accounts, transcripts, assignments, and results in the Cloudflare D1 version.
- The OpenAI API key stays in a server secret; the browser receives only a short-lived Realtime credential.

## No-monthly-hosting deployment

GitHub stores the code. Cloudflare Workers serves the app and backend, and Cloudflare D1 stores encrypted exam records. GitHub Pages cannot run this server-side exam system, so deployment uses Cloudflare Workers. The included GitHub Actions workflow deploys on each push to `main`.

1. Create a D1 database named `presently-exam-data` in Cloudflare.
2. Replace `CREATE_D1_DATABASE_FIRST` in `cloudflare/wrangler.toml` with the database ID.
3. In GitHub repository **Settings → Secrets and variables → Actions**, add these secrets:
   - `CLOUDFLARE_API_TOKEN` — a Cloudflare token that can deploy Workers and manage D1.
   - `CLOUDFLARE_ACCOUNT_ID` — your Cloudflare account ID.
   - `D1_DATABASE_ID` — the ID from step 2.
   - `ADMIN_EMAIL` — teacher sign-in email.
   - `ADMIN_PASSWORD` — a unique password with at least 12 characters.
   - `OPENAI_API_KEY` — your OpenAI API key.
   - `DATA_ENCRYPTION_KEY` — a random secret at least 32 characters long. Save a secure backup; losing it means saved exam records cannot be decrypted.
4. Push the repository's `main` branch. The workflow applies the database schema and deploys the portal. Cloudflare displays the public `workers.dev` address after deployment.

Cloudflare Free has daily request and database quotas. If a quota is reached, the portal may return errors until it resets. OpenAI API usage is billed separately; it is not included in free hosting.

## Student privacy and assessment limits

Students must consent before the microphone connects. The website does not record webcam video or save webcam stills. It captures up to three small still images in the browser for the assessment request; the brief room view stays local. Live audio goes from the browser to OpenAI Realtime. Spoken transcripts and answers are encrypted in D1 and available to the teacher. Automated pronunciation scoring from a transcript is limited, and a few stills cannot establish sustained eye contact or body language. The AI is instructed not to infer emotion, identity, disability, or personality. A teacher must review and publish every final score.

Student registration is open and signs students in immediately, as requested. Assignments can be open to all registered students or limited to selected accounts. Confirm your school's identity, consent, accessibility, data-retention, and exam policies before inviting students.

## Local development and tests

The original Node server is available for local development with Node.js 20 or later. Set `ADMIN_EMAIL`, `ADMIN_PASSWORD`, and `OPENAI_API_KEY` in the process environment, then run `node server.mjs`. The Cloudflare Worker entry point is `cloudflare/worker.mjs`; GitHub Actions syntax-checks it before deploying. Run the Node regression tests with `node --test tests/server.test.mjs`.

This repository contains no API credentials, student accounts, or exam records. It is starter software and is not a claim of regulatory certification or a completed accessibility audit.

