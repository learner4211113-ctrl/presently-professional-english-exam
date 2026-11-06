const RUBRIC = [
  ['professionalEnglish', 'Professional English & grammar', 20],
  ['fluencyPronunciation', 'Fluency & pronunciation', 15],
  ['vocabulary', 'Vocabulary', 15],
  ['structure', 'Presentation structure', 15],
  ['eyeContactBodyLanguage', 'Eye contact & body language', 10],
  ['confidenceCommunication', 'Confidence & communication', 10],
  ['questionAnswers', 'Question & answer responses', 15],
];
const EMPTY = () => ({ users: [], assignments: [], submissions: [] });
const now = () => Date.now();
const uuid = () => crypto.randomUUID();
const clean = (x, max = 6000) => typeof x === 'string' ? x.trim().slice(0, max) : '';
const base64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unbase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
const safeUser = (u) => ({ id: u.id, name: u.name, email: u.email, role: u.role, active: u.active });

async function sha256(value) { return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))); }
async function keyFrom(secret) { return crypto.subtle.importKey('raw', await sha256(secret), 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function seal(value, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(value)));
  return JSON.stringify({ iv: base64(iv), data: base64(data) });
}
async function unseal(value, key) {
  const box = JSON.parse(value); const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(box.iv) }, key, unbase64(box.data));
  return JSON.parse(new TextDecoder().decode(clear));
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 120000 }, material, 256);
  return `pbkdf2$120000$${base64(salt)}$${base64(bits)}`;
}
async function verifyPassword(password, encoded) {
  try {
    const [, iterations, salt, expected] = encoded.split('$');
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(password)), 'PBKDF2', false, ['deriveBits']);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: unbase64(salt), iterations: Number(iterations) }, material, 256));
    const want = unbase64(expected); return bits.length === want.length && bits.every((v, i) => v === want[i]);
  } catch { return false; }
}
function response(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}
function cookie(req) { return req.headers.get('cookie')?.split(';').map((x) => x.trim()).find((x) => x.startsWith('exam_session='))?.slice(13) || ''; }
function cookieHeader(token, clear = false) { return `exam_session=${clear ? '' : encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${clear ? 0 : 28800}`; }
function totalScore(r) { return RUBRIC.reduce((n, [k, , max]) => n + Math.min(max, Math.max(0, Number(r?.[k]?.score) || 0)), 0); }
async function readBody(req, limit = 2_500_000) {
  const text = await req.text(); if (text.length > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 });
  try { return JSON.parse(text || '{}'); } catch { throw Object.assign(new Error('Send valid JSON.'), { status: 400 }); }
}
async function dbStore(db, key) {
  const rows = await db.prepare('SELECT type, id, payload FROM exam_records').all();
  const store = EMPTY();
  for (const row of rows.results || []) {
    if (store[row.type]) store[row.type].push(await unseal(row.payload, key));
  }
  return store;
}
async function saveStore(db, before, after, key) {
  const statements = [];
  for (const type of ['users', 'assignments', 'submissions']) {
    const old = new Map(before[type].map((x) => [x.id, JSON.stringify(x)]));
    const next = new Map(after[type].map((x) => [x.id, x]));
    for (const id of old.keys()) if (!next.has(id)) statements.push(db.prepare('DELETE FROM exam_records WHERE type = ? AND id = ?').bind(type, id));
    for (const [id, value] of next) {
      if (old.get(id) === JSON.stringify(value)) continue;
      statements.push(db.prepare('INSERT INTO exam_records (type, id, payload) VALUES (?, ?, ?) ON CONFLICT(type, id) DO UPDATE SET payload = excluded.payload').bind(type, id, await seal(value, key)));
    }
  }
  for (let i = 0; i < statements.length; i += 80) await db.batch(statements.slice(i, i + 80));
}
async function aiText(env, prompt, images = []) {
  if (!env.OPENAI_API_KEY) throw Object.assign(new Error('Live AI is not configured.'), { status: 503 });
  const content = [{ type: 'input_text', text: prompt }, ...images.map((image_url) => ({ type: 'input_image', image_url }))];
  const res = await fetch('https://api.openai.com/v1/responses', { method: 'POST', headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: env.OPENAI_MODEL || 'gpt-4.1-mini', input: [{ role: 'user', content }], store: false }) });
  if (!res.ok) throw Object.assign(new Error(`Live AI request failed (${res.status}).`), { status: 502 });
  const data = await res.json(); return data.output?.flatMap((x) => x.content || []).filter((x) => x.type === 'output_text').map((x) => x.text).join('\n') || '';
}
function parseJson(text) { try { return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { throw Object.assign(new Error('AI returned an unreadable response. Try again.'), { status: 502 }); } }
async function questionsFor(env, assignment, transcript) {
  const t = await aiText(env, `Create exactly five concise oral follow-up questions in professional English, tailored to the assigned presentation and what the student said. Include exactly two straightforward comprehension questions and three challenging analytical/client-workplace scenario questions. Avoid yes/no questions. Return only JSON: {"questions":["..."]}. Topic: ${assignment.title}\nSlide brief: ${assignment.slides}\nTranscript: ${transcript.slice(0, 9000)}`);
  const qs = parseJson(t).questions;
  if (!Array.isArray(qs) || qs.length !== 5 || qs.some((x) => typeof x !== 'string' || !x.trim())) throw Object.assign(new Error('AI did not return exactly five questions.'), { status: 502 });
  return qs.map((x) => x.trim().slice(0, 400));
}
async function slideFor(env, assignment, user) {
  const t = await aiText(env, `Create one concise workplace presentation slide for a Professional English speaking examination. Make this student's scenario distinct. Return only JSON: {"title":"...","scenario":"...","slideTitle":"...","bullets":["...","...","...","..."],"task":"..."}. Use a realistic business/client-facing situation and practical facts. Do not include a script or model answer. Student: ${user.name}; exam identifier: ${user.id}; assigned theme: ${assignment.title}; teacher brief: ${assignment.slides || 'professional client communication'}.`);
  const x = parseJson(t);
  if (!x.title || !x.scenario || !x.slideTitle || !Array.isArray(x.bullets) || x.bullets.length < 3 || x.bullets.length > 5 || !x.task) throw Object.assign(new Error('AI returned an incomplete slide.'), { status: 502 });
  return { title: clean(x.title, 160), scenario: clean(x.scenario, 1200), slideTitle: clean(x.slideTitle, 180), bullets: x.bullets.map((b) => clean(b, 300)), task: clean(x.task, 600) };
}
async function assess(env, assignment, transcript, qa, frames) {
  const prompt = `Assess this Professional English workplace presentation. Consider grammar, politeness, respectful client communication, fluency, vocabulary, structure, confidence, and Q&A. Return only JSON: {"rubric":{"professionalEnglish":{"score":0,"feedback":"..."},"fluencyPronunciation":{"score":0,"feedback":"..."},"vocabulary":{"score":0,"feedback":"..."},"structure":{"score":0,"feedback":"..."},"eyeContactBodyLanguage":{"score":0,"feedback":"..."},"confidenceCommunication":{"score":0,"feedback":"..."},"questionAnswers":{"score":0,"feedback":"..."}},"summary":"..."}. Maxima: 20,15,15,15,10,10,15 respectively. Use only observable evidence; explain that pronunciation cannot be reliably assessed from text and webcam stills cannot prove sustained eye contact. Do not infer emotion, identity, disability, or personality. Q&A: ${JSON.stringify(qa).slice(0, 6500)}\nTranscript: ${transcript.slice(0, 12000)}\nAssignment: ${assignment.title}\nSlides: ${assignment.slides.slice(0, 6000)}`;
  const result = parseJson(await aiText(env, prompt, frames));
  if (!result.rubric || RUBRIC.some(([k]) => !result.rubric[k])) throw Object.assign(new Error('AI assessment is missing rubric criteria.'), { status: 502 });
  result.rubric = Object.fromEntries(RUBRIC.map(([k, , max]) => [k, { score: Math.min(max, Math.max(0, Math.round(Number(result.rubric[k].score) || 0))), feedback: clean(result.rubric[k].feedback, 800) }]));
  result.summary = clean(result.summary, 2000); return result;
}
async function rateLimited(db, bucket, max = 12) {
  const current = await db.prepare('SELECT hits, started FROM exam_rate_limits WHERE bucket = ?').bind(bucket).first();
  const stamp = now(); if (!current || stamp - current.started > 900_000) {
    await db.prepare('INSERT INTO exam_rate_limits(bucket,hits,started) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET hits=1, started=excluded.started').bind(bucket, stamp).run(); return false;
  }
  if (current.hits >= max) return true;
  await db.prepare('UPDATE exam_rate_limits SET hits = hits + 1 WHERE bucket = ?').bind(bucket).run(); return false;
}
function assignedFor(store, submission) {
  const a = store.assignments.find((x) => x.id === submission.assignmentId);
  return submission.examSlide ? { ...a, title: submission.examSlide.title, slides: `${submission.examSlide.scenario}\n${submission.examSlide.slideTitle}\n${submission.examSlide.bullets.join('\n')}\n${submission.examSlide.task}` } : a;
}

export default {
  async fetch(req, env) {
    const headers = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer', 'Permissions-Policy': 'camera=(self), microphone=(self), geolocation=()', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://api.openai.com; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" };
    const url = new URL(req.url);
    if (url.pathname === '/health') {
      try { if (!env.DB) throw new Error('D1 is not configured'); await env.DB.prepare('SELECT 1 AS ok').first(); return response({ ok: true }, 200, headers); }
      catch { return response({ ok: false }, 503, headers); }
    }
    if (!url.pathname.startsWith('/api/')) {
      const asset = await env.ASSETS.fetch(req); const assetHeaders = new Headers(asset.headers);
      for (const [name, value] of Object.entries(headers)) assetHeaders.set(name, value);
      return new Response(asset.body, { status: asset.status, statusText: asset.statusText, headers: assetHeaders });
    }
    if (!env.DB || (env.DATA_ENCRYPTION_KEY || '').length < 32 || !env.ADMIN_EMAIL || (env.ADMIN_PASSWORD || '').length < 12 || !env.OPENAI_API_KEY) return response({ error: 'The exam portal is not fully configured yet.' }, 503, headers);
    const key = await keyFrom(env.DATA_ENCRYPTION_KEY); const db = env.DB;
    let before = await dbStore(db, key); let store = structuredClone(before);
    const persist = () => saveStore(db, before, store, key);
    try {
      const retained = store.submissions.filter((x) => { const at = Date.parse(x.submittedAt || x.startedAt || ''); return !Number.isFinite(at) || now() - at <= 180 * 24 * 60 * 60_000; });
      if (retained.length !== store.submissions.length) { store.submissions = retained; await persist(); }
      if (!store.users.some((x) => x.role === 'teacher')) {
        store.users.push({ id: uuid(), name: 'Teacher', email: env.ADMIN_EMAIL.toLowerCase(), role: 'teacher', active: true, passwordHash: await hashPassword(env.ADMIN_PASSWORD), createdAt: new Date().toISOString() }); await persist(); before = structuredClone(store);
      }
      const token = decodeURIComponent(cookie(req));
      const tokenHash = token ? base64(await sha256(token)) : '';
      const session = tokenHash ? await db.prepare('SELECT user_id, expires_at FROM exam_sessions WHERE token_hash = ?').bind(tokenHash).first() : null;
      const user = session && session.expires_at > now() ? store.users.find((x) => x.id === session.user_id && x.active) : null;
      const send = (data, status = 200, extra = {}) => response(data, status, { ...headers, ...extra });
      const body = (limit) => readBody(req, limit);
      const requireStudent = () => user?.role === 'student' ? null : send({ error: 'Student sign-in required.' }, 401);
      const requireTeacher = () => user?.role === 'teacher' ? null : send({ error: user ? 'Teacher access required.' : 'Please sign in.' }, user ? 403 : 401);
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const student = user?.role === 'student' ? { assignments: store.assignments.filter((a) => a.active && (a.studentIds.includes(user.id) || a.openToAll)).map((a) => ({ ...a, submitted: store.submissions.some((s) => s.assignmentId === a.id && s.studentId === user.id && s.status !== 'in_progress') })), activeSubmission: store.submissions.filter((s) => s.studentId === user.id && s.status === 'in_progress').map((s) => ({ id: s.id, assignmentId: s.assignmentId, startedAt: s.startedAt, transcript: s.transcript || '', questions: s.questions || null, demoMode: Boolean(s.demoMode) }))[0] || null, results: store.submissions.filter((s) => s.studentId === user.id && s.status === 'published').map((s) => ({ id: s.id, assignmentTitle: s.assignmentTitle, score: s.finalScore, feedback: s.finalFeedback, rubric: s.finalRubric, publishedAt: s.publishedAt })) } : null;
        return send({ user: user ? safeUser(user) : null, student, aiConfigured: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/register') {
        const d = await body(10000); const email = clean(d.email, 254).toLowerCase(); const name = clean(d.name, 120); const pass = typeof d.password === 'string' ? d.password : '';
        if (await rateLimited(db, `register:${req.headers.get('cf-connecting-ip') || 'unknown'}`)) return send({ error: 'Too many registrations. Try later.' }, 429);
        if (!name || !/^\S+@\S+\.\S+$/.test(email) || pass.length < 12 || pass.length > 256) return send({ error: 'Enter your name, a valid email, and a password of at least 12 characters.' }, 400);
        if (store.users.some((x) => x.email === email)) return send({ error: 'An account with this email already exists.' }, 409);
        const student = { id: uuid(), name, email, role: 'student', active: true, passwordHash: await hashPassword(pass), createdAt: new Date().toISOString() }; store.users.push(student); await persist();
        const t = base64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (x) => ({ '+': '-', '/': '_', '=': '' })[x]); await db.prepare('INSERT INTO exam_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(base64(await sha256(t)), student.id, now() + 28_800_000).run();
        return send({ user: safeUser(student) }, 201, { 'Set-Cookie': cookieHeader(t) });
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const d = await body(5000); const email = clean(d.email, 254).toLowerCase(); const ip = req.headers.get('cf-connecting-ip') || 'unknown';
        if (await rateLimited(db, ip) || await rateLimited(db, `${ip}:${email}`)) return send({ error: 'Too many sign-in attempts. Try later.' }, 429);
        const target = store.users.find((x) => x.email === email && x.active); if (!target || !await verifyPassword(d.password || '', target.passwordHash)) return send({ error: 'Email or password is incorrect.' }, 401);
        const t = base64(crypto.getRandomValues(new Uint8Array(32))).replace(/[+/=]/g, (x) => ({ '+': '-', '/': '_', '=': '' })[x]); await db.prepare('INSERT INTO exam_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').bind(base64(await sha256(t)), target.id, now() + 28_800_000).run();
        return send({ user: safeUser(target) }, 200, { 'Set-Cookie': cookieHeader(t) });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') { if (tokenHash) await db.prepare('DELETE FROM exam_sessions WHERE token_hash = ?').bind(tokenHash).run(); return send({ ok: true }, 200, { 'Set-Cookie': cookieHeader('', true) }); }
      if (url.pathname.startsWith('/api/student/')) { const denied = requireStudent(); if (denied) return denied; }
      if (req.method === 'POST' && url.pathname === '/api/student/identity') {
        const d = await body(5000); if (d.consent !== true || d.identityConfirmed !== true) return send({ error: 'Confirm your identity and review the privacy notice.' }, 400);
        const a = store.assignments.find((x) => x.id === d.assignmentId && x.active && (x.studentIds.includes(user.id) || x.openToAll)); if (!a) return send({ error: 'Assigned presentation not found.' }, 404);
        if (store.submissions.some((x) => x.assignmentId === a.id && x.studentId === user.id)) return send({ error: 'This presentation has already been submitted.' }, 409);
        const sub = { id: uuid(), studentId: user.id, studentName: user.name, assignmentId: a.id, assignmentTitle: a.title, status: 'in_progress', startedAt: new Date().toISOString(), consentAt: new Date().toISOString() }; store.submissions.push(sub); await persist(); return send({ submissionId: sub.id, assignment: { ...a, studentIds: undefined } }, 201);
      }
      if (req.method === 'POST' && url.pathname === '/api/student/slide') {
        const d = await body(5000); const sub = store.submissions.find((x) => x.id === d.submissionId && x.studentId === user.id && x.status === 'in_progress'); if (!sub) return send({ error: 'Active exam not found.' }, 404);
        if (!sub.examSlide) {
          if (await rateLimited(db, `slide:${sub.id}`, 2)) return send({ error: 'Slide generation limit reached. Contact your teacher.' }, 429);
          sub.examSlide = await slideFor(env, store.assignments.find((x) => x.id === sub.assignmentId), user); await persist();
        }
        return send({ slide: sub.examSlide, aiConfigured: true, demoMode: false });
      }
      if (req.method === 'POST' && url.pathname === '/api/student/realtime-session') {
        const d = await body(5000); const sub = store.submissions.find((x) => x.id === d.submissionId && x.studentId === user.id && x.status === 'in_progress' && x.consentAt); if (!sub) return send({ error: 'Active consented exam not found.' }, 404);
        if (await rateLimited(db, `voice:${sub.id}`, 10)) return send({ error: 'Voice session limit reached. Contact your teacher.' }, 429);
        const a = store.assignments.find((x) => x.id === sub.assignmentId); sub.examSlide ||= await slideFor(env, a, user); await persist();
        const s = sub.examSlide; const instructions = `You are Ansha, a professional English presentation examiner. Speak warmly and clearly in English, addressing ${user.name}. Assigned scenario: ${s.scenario} Slide: ${s.slideTitle}; points: ${s.bullets.join('; ')}; task: ${s.task}. The website handles room check, preparation, and a ten-minute presentation timer. Wait for cues, do not coach or give model answers, listen quietly during presentation, ask five questions one at a time when prompted, and never reveal a score. You cannot see the camera; do not claim to monitor eye contact or body language.`;
        const secretRes = await fetch('https://api.openai.com/v1/realtime/client_secrets', {
          method: 'POST',
          headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json', 'OpenAI-Safety-Identifier': hex(await sha256(user.id)) },
          body: JSON.stringify({ session: { type: 'realtime', model: env.OPENAI_REALTIME_MODEL || 'gpt-realtime', instructions, audio: { output: { voice: 'marin' }, input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' } } } } }),
        });
        if (!secretRes.ok) return send({ error: `Live voice setup failed (${secretRes.status}). Check API access and billing.` }, 502);
        const p = await secretRes.json(); const clientSecret = p.value || p.client_secret?.value; if (!clientSecret) return send({ error: 'No temporary voice session token returned.' }, 502);
        return send({ clientSecret, realtimeModel: env.OPENAI_REALTIME_MODEL || 'gpt-realtime', expiresAt: p.expires_at || p.client_secret?.expires_at });
      }
      if (req.method === 'POST' && url.pathname === '/api/student/presentation-start') {
        const d = await body(5000); const sub = store.submissions.find((x) => x.id === d.submissionId && x.studentId === user.id && x.status === 'in_progress'); if (!sub) return send({ error: 'Active presentation not found.' }, 404);
        sub.presentationStartedAt ||= new Date().toISOString(); await persist(); return send({ presentationStartedAt: sub.presentationStartedAt });
      }
      if (req.method === 'POST' && url.pathname === '/api/student/questions') {
        const d = await body(20000); const sub = store.submissions.find((x) => x.id === d.submissionId && x.studentId === user.id && x.status === 'in_progress'); if (!sub) return send({ error: 'Active presentation not found.' }, 404);
        if (sub.questions) return send({ questions: sub.questions, aiConfigured: true, demoMode: false });
        if (await rateLimited(db, `questions:${sub.id}`, 2)) return send({ error: 'Question generation limit reached. Contact your teacher.' }, 429);
        const transcript = clean(d.transcript, 12000); if (transcript.length < 80) return send({ error: 'A spoken presentation transcript of at least 80 characters is required.' }, 400);
        if (now() - new Date(sub.presentationStartedAt || sub.startedAt).getTime() < 600000) return send({ error: 'The 10-minute presentation period has not ended.' }, 425);
        sub.transcript = transcript; sub.questions = await questionsFor(env, assignedFor(store, sub), transcript); sub.questionsAt = new Date().toISOString(); await persist(); return send({ questions: sub.questions, aiConfigured: true, demoMode: false });
      }
      if (req.method === 'POST' && url.pathname === '/api/student/submit') {
        const d = await body(2_500_000); const sub = store.submissions.find((x) => x.id === d.submissionId && x.studentId === user.id && x.status === 'in_progress'); if (!sub?.questions) return send({ error: 'Complete the spoken exam first.' }, 404);
        const qa = Array.isArray(d.answers) ? d.answers.slice(0, 5).map((x, i) => ({ question: sub.questions[i], answer: clean(x, 1500) })) : []; if (qa.length !== 5 || qa.some((x) => !x.answer)) return send({ error: 'All five spoken answers are required.' }, 400);
        const frames = Array.isArray(d.frames) ? d.frames.slice(0, 3).filter((x) => typeof x === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(x) && x.length < 350000) : [];
        sub.status = 'assessing'; await persist();
        try {
          const assessment = await assess(env, assignedFor(store, sub), sub.transcript, qa, frames);
          sub.answers = qa; sub.rubric = assessment.rubric; sub.aiScore = totalScore(assessment.rubric); sub.aiSummary = assessment.summary; sub.status = 'pending_review'; sub.submittedAt = new Date().toISOString(); sub.frameCount = frames.length; sub.reviewedBy = null; sub.finalScore = null;
          await persist(); return send({ status: sub.status, notice: 'Your teacher must review and publish the final result.' });
        } catch (e) { sub.status = 'in_progress'; await persist(); throw e; }
      }
      if (url.pathname.startsWith('/api/teacher/')) { const denied = requireTeacher(); if (denied) return denied; }
      if (req.method === 'GET' && url.pathname === '/api/teacher/dashboard') return send({ students: store.users.filter((x) => x.role === 'student').map(safeUser), assignments: store.assignments, submissions: store.submissions });
      if (req.method === 'POST' && url.pathname === '/api/teacher/students') {
        const d = await body(10000); const email = clean(d.email, 254).toLowerCase(); const name = clean(d.name, 120); const pass = typeof d.password === 'string' ? d.password : '';
        if (!name || !/^\S+@\S+\.\S+$/.test(email) || pass.length < 12) return send({ error: 'Enter name, valid email, and temporary password (12+ characters).' }, 400);
        if (store.users.some((x) => x.email === email)) return send({ error: 'An account with this email already exists.' }, 409);
        const student = { id: uuid(), name, email, role: 'student', active: true, passwordHash: await hashPassword(pass), createdAt: new Date().toISOString() }; store.users.push(student); await persist(); return send({ student: safeUser(student) }, 201);
      }
      if (req.method === 'DELETE' && /^\/api\/teacher\/students\/[^/]+$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/').pop()); if (!store.users.some((x) => x.id === id && x.role === 'student')) return send({ error: 'Student not found.' }, 404);
        store.users = store.users.filter((x) => x.id !== id); store.submissions = store.submissions.filter((x) => x.studentId !== id); store.assignments = store.assignments.map((x) => ({ ...x, studentIds: x.studentIds.filter((v) => v !== id) })); await persist(); return send({ ok: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/teacher/assignments') {
        const d = await body(30000); const title = clean(d.title, 160); const slides = clean(d.slides, 10000); const slidesUrl = clean(d.slidesUrl, 1000); const studentIds = Array.isArray(d.studentIds) ? [...new Set(d.studentIds)].filter((id) => store.users.some((u) => u.id === id && u.role === 'student' && u.active)) : []; const openToAll = d.openToAll === true;
        let validUrl = false; if (slidesUrl) try { const u = new URL(slidesUrl); validUrl = u.protocol === 'https:' && !u.username && !u.password; } catch {}
        if (!title || (slides.length < 10 && !validUrl) || (slidesUrl && !validUrl) || (!studentIds.length && !openToAll)) return send({ error: 'Add a title, slide brief or HTTPS slide link, and students or open registration.' }, 400);
        const a = { id: uuid(), title, slides, slidesUrl: validUrl ? slidesUrl : '', studentIds, openToAll, durationMinutes: 10, createdAt: new Date().toISOString(), createdBy: user.id, active: true }; store.assignments.push(a); await persist(); return send({ assignment: a }, 201);
      }
      if (req.method === 'POST' && /^\/api\/teacher\/submissions\/[^/]+\/review$/.test(url.pathname)) {
        const id = decodeURIComponent(url.pathname.split('/')[4]); const sub = store.submissions.find((x) => x.id === id && ['pending_review', 'teacher_reviewed'].includes(x.status)); if (!sub) return send({ error: 'Submission not found or already reviewed.' }, 404);
        const d = await body(20000); const score = Number(d.finalScore); const feedback = clean(d.finalFeedback, 3000); if (!Number.isInteger(score) || score < 0 || score > 100 || !feedback || !['save', 'publish'].includes(d.action)) return send({ error: 'Enter score, feedback, and save or publish.' }, 400);
        if (d.action === 'publish' && d.confirmPublish !== true) return send({ error: 'Confirm publication to release result.' }, 400);
        sub.finalScore = score; sub.finalFeedback = feedback; sub.reviewedBy = user.id; sub.reviewedAt = new Date().toISOString(); sub.status = d.action === 'publish' ? 'published' : 'teacher_reviewed'; if (d.action === 'publish') sub.publishedAt = new Date().toISOString(); if (Array.isArray(d.finalRubric)) sub.finalRubric = d.finalRubric;
        await persist(); return send({ status: sub.status, finalScore: score });
      }
      return send({ error: 'Not found.' }, 404);
    } catch (e) {
      console.error(e.message); const status = e.status || 500; return response({ error: status === 500 ? 'Something went wrong. Please try again.' : e.message }, status, headers);
    }
  },
};

