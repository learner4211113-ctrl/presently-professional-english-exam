import http from 'node:http';
import { randomBytes, randomUUID, scrypt as scryptCb, timingSafeEqual, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, chmod, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scrypt = promisify(scryptCb);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const RUBRIC = [
  ['professionalEnglish', 'Professional English & grammar', 20],
  ['fluencyPronunciation', 'Fluency & pronunciation', 15],
  ['vocabulary', 'Vocabulary', 15],
  ['structure', 'Presentation structure', 15],
  ['eyeContactBodyLanguage', 'Eye contact & body language', 10],
  ['confidenceCommunication', 'Confidence & communication', 10],
  ['questionAnswers', 'Question & answer responses', 15],
];
const emptyStore = () => ({ users: [], assignments: [], submissions: [] });

function json(res, status, data, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}
function cookieValue(req, name) {
  const cookie = req.headers.cookie?.split(';').map((x) => x.trim()).find((x) => x.startsWith(`${name}=`));
  return cookie ? decodeURIComponent(cookie.slice(name.length + 1)) : null;
}
function safeUser(user) { return { id: user.id, name: user.name, email: user.email, role: user.role, active: user.active }; }
function clampText(value, max = 6000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }

export function createAppServer({ dataFile = process.env.DATA_FILE || path.join(ROOT, 'data', 'exam-store.json'), adminEmail = process.env.ADMIN_EMAIL, adminPassword = process.env.ADMIN_PASSWORD, apiKey = process.env.OPENAI_API_KEY, model = process.env.OPENAI_MODEL || 'gpt-4.1-mini', realtimeModel = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime', dataEncryptionKey = process.env.DATA_ENCRYPTION_KEY, retentionDays = Number(process.env.RETENTION_DAYS || 180), secureCookies = process.env.NODE_ENV === 'production', production = process.env.NODE_ENV === 'production', durationMs = 10 * 60_000, aiFetch = globalThis.fetch } = {}) {
  const sessions = new Map();
  const attempts = new Map();
  const encryptionKey = dataEncryptionKey ? createHash('sha256').update(dataEncryptionKey, 'utf8').digest() : null;
  let activeApiKey = apiKey;
  let writeQueue = Promise.resolve();
  let store = emptyStore();
  let initPromise;

  function persist() {
    const snapshot = JSON.stringify(store, null, 2);
    writeQueue = writeQueue.catch(() => {}).then(async () => {
      await mkdir(path.dirname(dataFile), { recursive: true });
      if (production && !encryptionKey) throw new Error('DATA_ENCRYPTION_KEY is required in production.');
      let content = snapshot;
      if (encryptionKey) {
        const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
        const encrypted = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
        content = JSON.stringify({ format: 'presently-encrypted-v1', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
      }
      const tempFile = `${dataFile}.${randomUUID()}.tmp`;
      await writeFile(tempFile, content, { mode: 0o600 });
      try { await chmod(tempFile, 0o600); } catch {}
      await rename(tempFile, dataFile);
    });
    return writeQueue;
  }
  async function init() {
    if (!Number.isInteger(retentionDays) || retentionDays < 1 || retentionDays > 3650) throw new Error('RETENTION_DAYS must be a whole number between 1 and 3650.');
    if (production && (!adminEmail || !adminPassword || adminPassword.length < 12 || !encryptionKey || String(dataEncryptionKey).length < 32 || !activeApiKey)) throw new Error('Production requires ADMIN_EMAIL, ADMIN_PASSWORD (12+ characters), OPENAI_API_KEY, and a strong DATA_ENCRYPTION_KEY.');
    if (adminPassword && adminPassword.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
    try {
      let saved = JSON.parse(await readFile(dataFile, 'utf8'));
      if (saved.format === 'presently-encrypted-v1') {
        if (!encryptionKey) throw new Error('This exam data is encrypted. Set DATA_ENCRYPTION_KEY to unlock it.');
        const decipher = createDecipheriv('aes-256-gcm', encryptionKey, Buffer.from(saved.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
        saved = JSON.parse(Buffer.concat([decipher.update(Buffer.from(saved.data, 'base64')), decipher.final()]).toString('utf8'));
      }
      store = { ...emptyStore(), ...saved };
    }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const oldCount = store.submissions.length;
    store.submissions = store.submissions.filter((submission) => {
      const at = Date.parse(submission.submittedAt || submission.startedAt || '');
      return !Number.isFinite(at) || Date.now() - at <= retentionDays * 24 * 60 * 60_000;
    });
    let recoveredAssessment = false;
    for (const submission of store.submissions) if (submission.status === 'assessing') { submission.status = 'in_progress'; recoveredAssessment = true; }
    if (store.submissions.length !== oldCount || recoveredAssessment) await persist();
    if (adminEmail && adminPassword && !store.users.some((u) => u.role === 'teacher')) {
      store.users.push({ id: randomUUID(), name: 'Teacher', email: adminEmail.toLowerCase(), role: 'teacher', active: true, passwordHash: await hashPassword(adminPassword), createdAt: new Date().toISOString() });
      await persist();
    }
  }
  function ready() { return initPromise ||= init(); }
  function setCookie(res, value, clear = false) {
    const flags = `Path=/; HttpOnly; SameSite=Strict${secureCookies ? '; Secure' : ''}`;
    res.setHeader('Set-Cookie', clear ? `exam_session=; ${flags}; Max-Age=0` : `exam_session=${encodeURIComponent(value)}; ${flags}; Max-Age=28800`);
  }
  function issueSession(user) { const token = randomBytes(32).toString('base64url'); sessions.set(token, { userId: user.id, expiresAt: Date.now() + 8 * 60 * 60 * 1000 }); return token; }
  function currentUser(req) {
    const token = cookieValue(req, 'exam_session');
    const session = token && sessions.get(token);
    if (!session || session.expiresAt < Date.now()) { if (token) sessions.delete(token); return null; }
    return store.users.find((u) => u.id === session.userId && u.active) || null;
  }
  async function body(req, limit = 2_500_000) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('Request is too large.'), { status: 413 }); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); }
    catch { throw Object.assign(new Error('Send valid JSON.'), { status: 400 }); }
  }
  function rateLimited(key) {
    const now = Date.now(); const list = (attempts.get(key) || []).filter((x) => now - x < 15 * 60_000);
    if (list.length >= 12) return true;
    list.push(now); attempts.set(key, list); return false;
  }
  function requireTeacher(user, res) { if (!user || user.role !== 'teacher') { json(res, user ? 403 : 401, { error: user ? 'Teacher access required.' : 'Please sign in.' }); return false; } return true; }

  async function askAI(prompt, images = []) {
    if (!activeApiKey) return null;
    const content = [{ type: 'input_text', text: prompt }, ...images.map((image) => ({ type: 'input_image', image_url: image }))];
    const response = await aiFetch('https://api.openai.com/v1/responses', {
      method: 'POST', headers: { authorization: `Bearer ${activeApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: [{ role: 'user', content }], store: false }), signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`AI service error (${response.status}). Check the server's API configuration.`);
    const payload = await response.json();
    return payload.output?.flatMap((item) => item.content || []).filter((part) => part.type === 'output_text').map((part) => part.text).join('\n') || '';
  }
  function parseAiJson(text) {
    const cleaned = text?.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(cleaned); } catch { throw new Error('AI returned an unreadable assessment. Please try again.'); }
  }
  function totalScore(rubric) { return RUBRIC.reduce((sum, [key, , max]) => sum + Math.min(max, Math.max(0, Number(rubric?.[key]?.score) || 0)), 0); }
  async function makeQuestions(assignment, transcript) {
    const response = await askAI(`Create exactly five concise oral follow-up questions in professional English, tailored to the assigned presentation and what the student said. Include exactly two straightforward comprehension questions and three challenging analytical/client-workplace scenario questions. Avoid yes/no questions. Return only JSON: {"questions":["..."]}. Topic: ${assignment.title}\nSlide brief: ${assignment.slides}\nStudent presentation transcript: ${transcript.slice(0, 9000)}`);
    if (!response) { if (production) throw new Error('Live AI question generation is required in production.'); return [
      `What was the main recommendation in your presentation about ${assignment.title}?`,
      'Which fact on your slide was most important to your decision?',
      'The client rejects your proposed timeline. How would you respond politely and negotiate a workable next step?',
      'A new data point weakens your recommendation. How would you explain the change and protect the client relationship?',
      'Your manager asks you to promise a deadline your team cannot guarantee. What would you say to the client instead?',
    ]; }
    const parsed = parseAiJson(response); const questions = parsed.questions;
    if (!Array.isArray(questions) || questions.length !== 5 || questions.some((q) => typeof q !== 'string' || !q.trim())) throw new Error('AI did not return exactly five questions. Please try again.');
    return questions.map((q) => q.trim().slice(0, 400));
  }
  function sampleQuestions(title) {
    return [
      `What was the main recommendation in your presentation about ${title}?`,
      'Which fact on your slide was most important to your decision?',
      'The client rejects your proposed timeline. How would you respond politely and negotiate a workable next step?',
      'New information weakens your recommendation. How would you explain the change and protect the client relationship?',
      'Your manager asks you to promise a deadline your team cannot guarantee. What would you say to the client instead?',
    ];
  }
  async function makeStudentSlide(assignment, studentName, studentId) {
    const response = await askAI(`Create one concise workplace presentation slide for a Professional English speaking examination. Make this student's scenario distinct. Return only JSON: {"title":"...","scenario":"...","slideTitle":"...","bullets":["...","...","...","..."],"task":"..."}. Use a realistic business/client-facing situation, a clear decision or recommendation, and practical facts that the student can explain. Do not include a script or model answer. Student: ${studentName}; private exam identifier: ${studentId}; assigned theme: ${assignment.title}; teacher brief: ${assignment.slides || 'professional client communication'}.`);
    if (!response) { if (production) throw new Error('Live AI slide generation is required in production.'); return { title: assignment.title, scenario: 'A client has reported delays in a service rollout and requests a clear update and recovery plan.', slideTitle: 'Responding to a delayed client rollout', bullets: ['A delivery milestone is two weeks behind schedule', 'The client needs a reliable revised timeline', 'Support capacity is limited during the next month', 'A recovery plan should protect service quality'], task: 'Present a clear, polite recommendation and explain how you would communicate it to the client.' }; }
    const slide = parseAiJson(response);
    if (!slide.title || !slide.scenario || !slide.slideTitle || !Array.isArray(slide.bullets) || slide.bullets.length < 3 || slide.bullets.length > 5 || !slide.task) throw new Error('AI returned an incomplete presentation slide. Please try again.');
    return { title: clampText(slide.title, 160), scenario: clampText(slide.scenario, 1200), slideTitle: clampText(slide.slideTitle, 180), bullets: slide.bullets.map((x) => clampText(x, 300)), task: clampText(slide.task, 600) };
  }
  async function assessSubmission(assignment, transcript, qa, frames) {
    const prompt = `Assess a student's Professional English presentation for workplace/client-facing readiness. In Professional English, assess grammar, politeness, respectful tone, clarity, and appropriate client communication. Return only JSON with this exact structure: {"rubric":{"professionalEnglish":{"score":0,"feedback":"..."},"fluencyPronunciation":{"score":0,"feedback":"..."},"vocabulary":{"score":0,"feedback":"..."},"structure":{"score":0,"feedback":"..."},"eyeContactBodyLanguage":{"score":0,"feedback":"..."},"confidenceCommunication":{"score":0,"feedback":"..."},"questionAnswers":{"score":0,"feedback":"..."}},"summary":"..."}. Scores must be whole numbers within these maxima: professionalEnglish 20, fluencyPronunciation 15, vocabulary 15, structure 15, eyeContactBodyLanguage 10, confidenceCommunication 10, questionAnswers 15. Score only observable evidence; if evidence is insufficient, say so and score conservatively. Pronunciation cannot be reliably established from a text transcript, so clearly limit that judgment. For eye contact/body language, use only visible behavior in the provided webcam stills; explain that a few still images cannot establish sustained eye contact or confidence. No inference about emotion, identity, disability, or personality. Q&A evidence: ${JSON.stringify(qa).slice(0, 6500)}\nPresentation transcript: ${transcript.slice(0, 12000)}\nAssignment: ${assignment.title}\nSlides: ${assignment.slides.slice(0, 6000)}`;
    const response = await askAI(prompt, frames);
    if (!response) { if (production) throw new Error('Live AI assessment is required in production.'); return {
      rubric: Object.fromEntries(RUBRIC.map(([key]) => [key, { score: null, feedback: 'AI assessment is not configured. Teacher review required; no automated score was assigned.' }])),
      summary: 'Automated assessment unavailable because OPENAI_API_KEY is not configured. No automated score was assigned.',
    }; }
    const data = parseAiJson(response);
    if (!data.rubric || RUBRIC.some(([key]) => !data.rubric[key])) throw new Error('AI assessment is missing rubric criteria. Please try again.');
    data.rubric = Object.fromEntries(RUBRIC.map(([key, , max]) => [key, { score: Math.min(max, Math.max(0, Math.round(Number(data.rubric[key].score) || 0))), feedback: clampText(data.rubric[key].feedback, 800) }]));
    data.summary = clampText(data.summary, 2000);
    return data;
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://api.openai.com; media-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      await ready();
      const url = new URL(req.url, 'http://localhost'); const user = currentUser(req);
      if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/api/session') {
        const student = user?.role === 'student' ? { assignments: store.assignments.filter((a) => a.active && (a.studentIds.includes(user.id) || a.openToAll)).map((a) => ({ ...a, submitted: store.submissions.some((s) => s.assignmentId === a.id && s.studentId === user.id && s.status !== 'in_progress') })), activeSubmission: store.submissions.filter((s) => s.studentId === user.id && s.status === 'in_progress').map((s) => ({ id: s.id, assignmentId: s.assignmentId, startedAt: s.startedAt, transcript: s.transcript || '', questions: s.questions || null, demoMode: Boolean(s.demoMode) }))[0] || null, results: store.submissions.filter((s) => s.studentId === user.id && s.status === 'published').map((s) => ({ id: s.id, assignmentTitle: s.assignmentTitle, score: s.finalScore, feedback: s.finalFeedback, rubric: s.finalRubric, publishedAt: s.publishedAt })) } : null;
        return json(res, 200, { user: user ? safeUser(user) : null, student, aiConfigured: Boolean(activeApiKey) });
      }
      if (req.method === 'POST' && url.pathname === '/api/register') {
        const data = await body(req, 10000); const email = clampText(data.email, 254).toLowerCase(); const name = clampText(data.name, 120); const password = typeof data.password === 'string' ? data.password : ''; const ip = req.socket.remoteAddress || 'unknown';
        if (rateLimited(`register:${ip}`)) return json(res, 429, { error: 'Too many account registrations from this connection. Try again later.' });
        if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12 || password.length > 256) return json(res, 400, { error: 'Enter your name, a valid email address, and a password with at least 12 characters.' });
        if (store.users.some((u) => u.email === email)) return json(res, 409, { error: 'An account with this email already exists. Please sign in instead.' });
        const student = { id: randomUUID(), name, email, role: 'student', active: true, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() };
        store.users.push(student); await persist(); setCookie(res, issueSession(student)); return json(res, 201, { user: safeUser(student) });
      }
      if (req.method === 'POST' && url.pathname === '/api/login') {
        const data = await body(req, 5000); const email = clampText(data.email, 254).toLowerCase(); const ip = req.socket.remoteAddress || 'unknown';
        if (rateLimited(ip) || rateLimited(`${ip}:${email}`)) return json(res, 429, { error: 'Too many sign-in attempts. Try again later.' });
        const target = store.users.find((u) => u.email === email && u.active); const valid = target && await verifyPassword(data.password || '', target.passwordHash);
        if (!valid) return json(res, 401, { error: 'Email or password is incorrect.' });
        setCookie(res, issueSession(target)); return json(res, 200, { user: safeUser(target) });
      }
      if (req.method === 'POST' && url.pathname === '/api/logout') { const token = cookieValue(req, 'exam_session'); if (token) sessions.delete(token); setCookie(res, '', true); return json(res, 200, { ok: true }); }
      if (req.method === 'POST' && url.pathname === '/api/student/identity') {
        if (!user || user.role !== 'student') return json(res, 401, { error: 'Student sign-in required.' });
        const data = await body(req, 5000); if (data.consent !== true || data.identityConfirmed !== true) return json(res, 400, { error: 'Confirm your identity and review the privacy notice to continue.' });
        const assignment = store.assignments.find((a) => a.id === data.assignmentId && a.active && (a.studentIds.includes(user.id) || a.openToAll));
        if (!assignment) return json(res, 404, { error: 'Assigned presentation not found.' });
        if (store.submissions.some((s) => s.assignmentId === assignment.id && s.studentId === user.id)) return json(res, 409, { error: 'This presentation has already been submitted.' });
        const submission = { id: randomUUID(), studentId: user.id, studentName: user.name, assignmentId: assignment.id, assignmentTitle: assignment.title, status: 'in_progress', startedAt: new Date().toISOString(), consentAt: new Date().toISOString() };
        store.submissions.push(submission); await persist(); return json(res, 201, { submissionId: submission.id, assignment: { ...assignment, studentIds: undefined } });
      }
      if (req.method === 'POST' && url.pathname === '/api/student/slide') {
        if (!user || user.role !== 'student') return json(res, 401, { error: 'Student sign-in required.' });
        const data = await body(req, 5000); const submission = store.submissions.find((s) => s.id === data.submissionId && s.studentId === user.id && s.status === 'in_progress');
        if (!submission) return json(res, 404, { error: 'Active presentation not found.' });
        if (!submission.examSlide) {
          const assignment = store.assignments.find((a) => a.id === submission.assignmentId);
          try { submission.examSlide = await makeStudentSlide(assignment, user.name, user.id); }
          catch (error) { if (production) throw Object.assign(new Error('The live slide examiner is unavailable. Please try again later.'), { status: 502 }); submission.demoMode = true; submission.examSlide = { title: assignment.title, scenario: 'A client reports that a service rollout is delayed and asks for a reliable update.', slideTitle: 'Responding to a delayed client rollout', bullets: ['A delivery milestone is two weeks behind schedule', 'The client needs a clear revised timeline', 'Support capacity is limited this month', 'A recovery plan should protect service quality'], task: 'Present a clear, polite recommendation and explain how you would communicate it to the client.' }; }
          await persist();
        }
        return json(res, 200, { slide: submission.examSlide, aiConfigured: Boolean(activeApiKey && !submission.demoMode), demoMode: Boolean(submission.demoMode) });
      }
      if (req.method === 'POST' && url.pathname === '/api/student/demo-mode') {
        if (!user || user.role !== 'student') return json(res, 401, { error: 'Student sign-in required.' });
        if (production) return json(res, 403, { error: 'Demo mode is disabled in production exams.' });
        const data = await body(req, 5000); const submission = store.submissions.find((s) => s.id === data.submissionId && s.studentId === user.id && s.status === 'in_progress');
        if (!submission) return json(res, 404, { error: 'Active presentation not found.' });
        submission.demoMode = true; await persist(); return json(res, 200, { demoMode: true });
      }
      if (req.method === 'POST' && url.pathname === '/api/student/realtime-session') {
        if (!user || user.role !== 'student') return json(res, 401, { error: 'Student sign-in required.' });
        if (!activeApiKey) return json(res, 503, { error: 'Live AI voice is not configured by the teacher yet.' });
        const data = await body(req, 5000); const submission = store.submissions.find((s) => s.id === data.submissionId && s.studentId === user.id && s.status === 'in_progress');
        if (!submission || !submission.consentAt) return json(res, 404, { error: 'Active consented exam not found.' });
        const assignment = store.assignments.find((a) => a.id === submission.assignmentId); const slide = submission.examSlide || await makeStudentSlide(assignment, user.name, user.id);
        submission.examSlide = slide; await persist();
        const instructions = `You are Ansha, a professional English presentation examiner. Speak warmly and clearly in English. Address the student as ${user.name}. This is a timed exam, not coaching. Assigned scenario: ${slide.scenario} Slide: ${slide.slideTitle}; points: ${slide.bullets.join('; ')}; task: ${slide.task}. The student must consent and use camera/microphone. You cannot see the camera; do not claim to check their room, eye contact, or body language. The website handles a one-minute setup, a three-second local-only room view, five-minute preparation, and a ten-minute presentation timer. Wait for website cues before each phase. Do not coach or give model answers. During the presentation, listen quietly. When prompted after time, ask the five questions supplied by the website one at a time, then listen for each answer. Be polite and neutral. Do not reveal or estimate a score.`;
        const safetyIdentifier = createHash('sha256').update(user.id).digest('hex');
        const response = await aiFetch('https://api.openai.com/v1/realtime/client_secrets', { method: 'POST', headers: { authorization: `Bearer ${activeApiKey}`, 'content-type': 'application/json', 'OpenAI-Safety-Identifier': safetyIdentifier }, body: JSON.stringify({ session: { type: 'realtime', model: realtimeModel, instructions, audio: { output: { voice: 'marin' }, input: { transcription: { model: 'gpt-4o-mini-transcribe', language: 'en' } } } } }), signal: AbortSignal.timeout(20_000) });
        if (!response.ok) throw new Error(`Live voice setup failed (${response.status}). Check OpenAI API access and billing.`);
        const payload = await response.json(); const clientSecret = payload.value || payload.client_secret?.value;
        if (!clientSecret) throw new Error('Live voice setup returned no temporary session token.');
        return json(res, 200, { clientSecret, realtimeModel, expiresAt: payload.expires_at || payload.client_secret?.expires_at });
      }
      if (req.method === 'POST' && url.pathname === '/api/student/presentation-start') {
        if (!user || user.role !== 'student') return json(res, 401, { error: 'Student sign-in required.' });
        const data = await body(req, 5000); const submission = store.submissions.find((s) => s.id === data.submissionId && s.studentId === user.id && s.status === 'in_progress');
        if (!submission) return json(res, 404, { error: 'Active presentation not found.' });
        if (!submission.presentationStartedAt) { submission.presentationStartedAt = new Date().toISOString(); await persist(); }
        return json(res, 200, { presentationStartedAt: submission.presentationStartedAt });
      }
      if (req.method === 'POST' && url.pathname === '/api/student/questions') {
        if (!user || user.role !== 'student') return json(res, 401, { error: 'Student sign-in required.' });
        const data = await body(req, 20000); const submission = store.submissions.find((s) => s.id === data.submissionId && s.studentId === user.id && s.status === 'in_progress');
        if (!submission) return json(res, 404, { error: 'Active presentation not found.' });
        if (production && submission.demoMode) return json(res, 409, { error: 'Demo mode is disabled in production exams.' });
        const assigned = store.assignments.find((a) => a.id === submission.assignmentId); const assignment = submission.examSlide ? { ...assigned, title: submission.examSlide.title, slides: `${submission.examSlide.scenario}\n${submission.examSlide.slideTitle}\n${submission.examSlide.bullets.join('\n')}\n${submission.examSlide.task}` } : assigned; const transcript = clampText(data.transcript, 12000);
        if (transcript.length < 80) return json(res, 400, { error: 'Please provide a presentation transcript of at least 80 characters before generating questions.' });
        const elapsed = Date.now() - new Date(submission.presentationStartedAt || submission.startedAt).getTime();
        if (elapsed < durationMs) return json(res, 425, { error: 'The 10-minute presentation period has not ended yet.' });
        submission.transcript = transcript;
        if (!submission.demoMode) { try { submission.questions = await makeQuestions(assignment, transcript); } catch (error) { if (production) throw Object.assign(new Error('Live AI question generation failed. Your spoken transcript was not submitted; please try again later.'), { status: 502 }); submission.demoMode = true; } }
        submission.questions ||= sampleQuestions(assignment.title); submission.questionsAt = new Date().toISOString(); await persist();
        return json(res, 200, { questions: submission.questions, aiConfigured: Boolean(activeApiKey && !submission.demoMode), demoMode: Boolean(submission.demoMode) });
      }
      if (req.method === 'POST' && url.pathname === '/api/student/submit') {
        if (!user || user.role !== 'student') return json(res, 401, { error: 'Student sign-in required.' });
        const data = await body(req); const submission = store.submissions.find((s) => s.id === data.submissionId && s.studentId === user.id && s.status === 'in_progress');
        if (!submission || !submission.questions) return json(res, 404, { error: 'Complete the presentation and questions first.' });
        const qa = Array.isArray(data.answers) ? data.answers.slice(0, 5).map((item, i) => ({ question: submission.questions[i], answer: clampText(item, 1500) })) : [];
        if (qa.length !== 5 || qa.some((x) => x.answer.length < 1)) return json(res, 400, { error: 'Please answer all five questions.' });
        const frames = Array.isArray(data.frames) ? data.frames.slice(0, 3).filter((f) => typeof f === 'string' && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(f) && f.length < 350_000) : [];
        const transcript = submission.transcript;
        const assigned = store.assignments.find((a) => a.id === submission.assignmentId); const assignment = submission.examSlide ? { ...assigned, title: submission.examSlide.title, slides: `${submission.examSlide.scenario}\n${submission.examSlide.slideTitle}\n${submission.examSlide.bullets.join('\n')}\n${submission.examSlide.task}` } : assigned;
        submission.status = 'assessing'; await persist();
        let assessment;
        if (production && submission.demoMode) { submission.status = 'in_progress'; await persist(); return json(res, 409, { error: 'Demo submissions cannot be used for a real exam.' }); }
        if (submission.demoMode) assessment = { rubric: Object.fromEntries(RUBRIC.map(([key]) => [key, { score: null, feedback: 'Live AI could not be reached. Demo mode does not assign an automated score; teacher review is required.' }])), summary: 'Demo run: the server could not reach OpenAI, so no automated assessment or score was assigned.' };
        else try { assessment = await assessSubmission(assignment, transcript, qa, frames); }
        catch (error) { submission.status = 'in_progress'; await persist(); throw error; }
        submission.answers = qa; submission.rubric = assessment.rubric; submission.aiScore = activeApiKey && !submission.demoMode ? totalScore(assessment.rubric) : null; submission.aiSummary = assessment.summary;
        submission.status = 'pending_review'; submission.submittedAt = new Date().toISOString(); submission.frameCount = frames.length;
        submission.reviewedBy = null; submission.finalScore = null;
        await persist(); return json(res, 200, { status: submission.status, notice: 'Your assessment is private. Your teacher must review and publish the final result.' });
      }
      if (url.pathname.startsWith('/api/teacher/')) {
        if (!requireTeacher(user, res)) return;
        if (req.method === 'GET' && url.pathname === '/api/teacher/dashboard') return json(res, 200, { students: store.users.filter((u) => u.role === 'student').map(safeUser), assignments: store.assignments.map((a) => ({ ...a, studentIds: a.studentIds })), submissions: store.submissions.map((s) => ({ ...s, transcript: s.transcript || '' })) });
        if (req.method === 'POST' && url.pathname === '/api/teacher/ai-key') {
          const data = await body(req, 5000); const key = typeof data.apiKey === 'string' ? data.apiKey.trim() : '';
          if (key.length < 20 || key.length > 500 || /\s/.test(key)) return json(res, 400, { error: 'Enter a valid API key with no spaces.' });
          activeApiKey = key;
          return json(res, 200, { aiConfigured: true, storage: 'memory-only' });
        }
        if (req.method === 'POST' && url.pathname === '/api/teacher/students') {
          const data = await body(req, 10000); const email = clampText(data.email, 254).toLowerCase(); const name = clampText(data.name, 120); const password = typeof data.password === 'string' ? data.password : '';
          if (!name || !/^\S+@\S+\.\S+$/.test(email) || password.length < 12) return json(res, 400, { error: 'Enter a name, valid email, and temporary password with at least 12 characters.' });
          if (store.users.some((u) => u.email === email)) return json(res, 409, { error: 'An account with this email already exists.' });
          const student = { id: randomUUID(), name, email, role: 'student', active: true, passwordHash: await hashPassword(password), createdAt: new Date().toISOString() }; store.users.push(student); await persist(); return json(res, 201, { student: safeUser(student) });
        }
        const studentMatch = url.pathname.match(/^\/api\/teacher\/students\/([^/]+)$/);
        if (req.method === 'DELETE' && studentMatch) {
          const student = store.users.find((u) => u.id === studentMatch[1] && u.role === 'student');
          if (!student) return json(res, 404, { error: 'Student account not found.' });
          store.users = store.users.filter((u) => u.id !== student.id);
          store.submissions = store.submissions.filter((s) => s.studentId !== student.id);
          store.assignments = store.assignments.map((a) => ({ ...a, studentIds: a.studentIds.filter((id) => id !== student.id) }));
          await persist(); return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && url.pathname === '/api/teacher/assignments') {
          const data = await body(req, 30000); const title = clampText(data.title, 160); const slides = clampText(data.slides, 10000); const slidesUrl = clampText(data.slidesUrl, 1000); const studentIds = Array.isArray(data.studentIds) ? [...new Set(data.studentIds)].filter((id) => store.users.some((u) => u.id === id && u.role === 'student' && u.active)) : []; const openToAll = data.openToAll === true;
          let validSlideUrl = false;
          if (slidesUrl) { try { const link = new URL(slidesUrl); validSlideUrl = link.protocol === 'https:' && !link.username && !link.password; } catch {} }
          if (!title || (slides.length < 10 && !validSlideUrl) || (slidesUrl && !validSlideUrl) || (!studentIds.length && !openToAll)) return json(res, 400, { error: 'Add a title, slide brief (10+ characters) or HTTPS slide link, and either select students or open registration. Slide links must use HTTPS.' });
          const assignment = { id: randomUUID(), title, slides, slidesUrl: validSlideUrl ? slidesUrl : '', studentIds, openToAll, durationMinutes: 10, createdAt: new Date().toISOString(), createdBy: user.id, active: true }; store.assignments.push(assignment); await persist(); return json(res, 201, { assignment });
        }
        const reviewMatch = url.pathname.match(/^\/api\/teacher\/submissions\/([^/]+)\/review$/);
        if (req.method === 'POST' && reviewMatch) {
          const submission = store.submissions.find((s) => s.id === reviewMatch[1] && ['pending_review', 'teacher_reviewed'].includes(s.status)); if (!submission) return json(res, 404, { error: 'Submission not found or already reviewed.' });
          const data = await body(req, 20000); const score = Number(data.finalScore); const feedback = clampText(data.finalFeedback, 3000); const status = data.action;
          if (!Number.isInteger(score) || score < 0 || score > 100 || !feedback || !['save', 'publish'].includes(status)) return json(res, 400, { error: 'Enter a final score from 0 to 100, feedback, and choose save or publish.' });
          if (status === 'publish' && data.confirmPublish !== true) return json(res, 400, { error: 'Confirm publication to release the result.' });
          submission.finalScore = score; submission.finalFeedback = feedback; submission.reviewedBy = user.id; submission.reviewedAt = new Date().toISOString(); submission.status = status === 'publish' ? 'published' : 'teacher_reviewed';
          if (status === 'publish') submission.publishedAt = new Date().toISOString();
          if (Array.isArray(data.finalRubric)) submission.finalRubric = data.finalRubric;
          await persist(); return json(res, 200, { status: submission.status, finalScore: submission.finalScore });
        }
        return json(res, 404, { error: 'Not found.' });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/app.js' || url.pathname === '/styles.css')) {
        const filename = url.pathname === '/app.js' ? 'app.js' : url.pathname === '/styles.css' ? 'styles.css' : 'index.html';
        const type = filename.endsWith('.js') ? 'text/javascript; charset=utf-8' : filename.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8';
        const content = await readFile(path.join(ROOT, filename)); res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' }); return res.end(content);
      }
      return json(res, 404, { error: 'Not found.' });
      } catch (error) {
      console.error(error.message);
      if (!res.headersSent) {
        const networkBlocked = error.cause?.code === 'EACCES' || error.message === 'fetch failed';
        const message = error.status ? error.message : networkBlocked ? 'This server cannot reach OpenAI. Its network blocks outbound API access; live AI cannot start until that access is available.' : 'Something went wrong. Please try again.';
        json(res, error.status || (networkBlocked ? 502 : 500), { error: message });
      }
      else res.end();
    }
  });
  return { server, ready, store, sessions };
}

export async function hashPassword(password) {
  const salt = randomBytes(16); const key = await scrypt(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${Buffer.from(key).toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  try { const [, saltHex, keyHex] = encoded.split('$'); const key = Buffer.from(await scrypt(String(password), Buffer.from(saltHex, 'hex'), 64)); const expected = Buffer.from(keyHex, 'hex'); return key.length === expected.length && timingSafeEqual(key, expected); } catch { return false; }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || (process.env.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1');
  const { server, ready } = createAppServer();
  ready().then(() => server.listen(port, host, () => console.log(`Presentation exam website running at http://localhost:${port}`))).catch((error) => { console.error('Startup failed:', error.message); process.exitCode = 1; });
}

