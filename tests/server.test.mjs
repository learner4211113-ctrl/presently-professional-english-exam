import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAppServer } from '../server.mjs';

async function fixture(options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'presently-test-'));
  const { server, ready } = createAppServer({ dataFile: path.join(dir, 'store.json'), adminEmail: 'teacher@example.edu', adminPassword: 'very-long-teacher-password', apiKey: '', durationMs: 0, ...options });
  await ready(); await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { dir, server, base, close: async () => { await new Promise((resolve) => server.close(resolve)); await rm(dir, { recursive: true, force: true }); } };
}
function client(base) {
  let cookie = '';
  return {
    get: async (url) => { const res = await fetch(`${base}${url}`, { headers: cookie ? { cookie } : {} }); cookie ||= res.headers.get('set-cookie')?.split(';')[0] || ''; const body = res.headers.get('content-type')?.includes('application/json') ? await res.json() : await res.text(); return [res.status, body, res.headers]; },
    post: async (url, data) => { const res = await fetch(`${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify(data) }); cookie ||= res.headers.get('set-cookie')?.split(';')[0] || ''; return [res.status, await res.json(), res.headers]; },
    del: async (url) => { const res = await fetch(`${base}${url}`, { method: 'DELETE', headers: cookie ? { cookie } : {} }); return [res.status, await res.json()]; },
  };
}

test('serves the website with baseline security headers and rejects unauthenticated teacher access', async (t) => {
  const f = await fixture(); t.after(f.close); const c = client(f.base);
  const [status, html, headers] = await c.get('/'); assert.equal(status, 200); assert.match(html, /Professional English Exam/);
  assert.equal(headers.get('x-frame-options'), 'DENY'); assert.match(headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await c.get('/health'))[0], 200);
  assert.equal((await c.get('/api/teacher/dashboard'))[0], 401);
});

test('teacher creates students and slide assignments; students cannot inspect unpublished scores', async (t) => {
  const f = await fixture(); t.after(f.close); const teacher = client(f.base); const student = client(f.base);
  assert.equal((await teacher.post('/api/login', { email: 'teacher@example.edu', password: 'very-long-teacher-password' }))[0], 200);
  const [createStatus, created] = await teacher.post('/api/teacher/students', { name: 'Jordan Lee', email: 'jordan@example.edu', password: 'temporary-password-123' });
  assert.equal(createStatus, 201);
  const [assignmentStatus, assigned] = await teacher.post('/api/teacher/assignments', { title: 'Market proposal', slides: 'Slide 1: market context\nSlide 2: recommendation', studentIds: [created.student.id] });
  assert.equal(assignmentStatus, 201); assert.equal(assigned.assignment.durationMinutes, 10);
  assert.equal((await student.post('/api/login', { email: 'jordan@example.edu', password: 'temporary-password-123' }))[0], 200);
  const [sessionStatus, session] = await student.get('/api/session'); assert.equal(sessionStatus, 200); assert.equal(session.student.assignments.length, 1);
  assert.equal((await student.get('/api/teacher/dashboard'))[0], 403);
  assert.equal((await student.post('/api/student/identity', { assignmentId: assigned.assignment.id, consent: false, identityConfirmed: true }))[0], 400);
  const [, start] = await student.post('/api/student/identity', { assignmentId: assigned.assignment.id, consent: true, identityConfirmed: true });
  assert.ok(start.submissionId);
  const transcript = 'Today I will introduce our market research and explain the proposed response. Our data shows three clear customer needs. First, our audience values dependable service. Second, customers want transparent pricing. Third, they need quick support. I recommend a phased launch, with weekly reviews to measure results and adjust our approach.';
  const [questionsStatus, questions] = await student.post('/api/student/questions', { submissionId: start.submissionId, transcript });
  assert.equal(questionsStatus, 200); assert.equal(questions.questions.length, 5); assert.equal(questions.aiConfigured, false);
  const answers = questions.questions.map((_, i) => `My answer to question ${i + 1} is to use our research and measure the outcome.`);
  const [submitStatus, submitted] = await student.post('/api/student/submit', { submissionId: start.submissionId, answers, frames: [] });
  assert.equal(submitStatus, 200); assert.equal('aiScore' in submitted, false); assert.match(submitted.notice, /private/i);
  const [, dashboard] = await teacher.get('/api/teacher/dashboard'); const queued = dashboard.submissions[0];
  assert.equal(queued.status, 'pending_review'); assert.equal(queued.aiScore, null); assert.equal(queued.transcript, transcript);
  const publishedBeforeApproval = await student.get('/api/session'); assert.equal(publishedBeforeApproval[1].student.results.length, 0);
  const [invalidScore] = await teacher.post(`/api/teacher/submissions/${queued.id}/review`, { finalScore: 101, finalFeedback: 'Invalid score', action: 'publish', confirmPublish: true }); assert.equal(invalidScore, 400);
  const [unconfirmed] = await teacher.post(`/api/teacher/submissions/${queued.id}/review`, { finalScore: 84, finalFeedback: 'Private review.', action: 'publish', confirmPublish: false }); assert.equal(unconfirmed, 400);
  const [savedStatus] = await teacher.post(`/api/teacher/submissions/${queued.id}/review`, { finalScore: 84, finalFeedback: 'Clear structure and useful evidence.', action: 'save' });
  assert.equal(savedStatus, 200);
  const [, afterSave] = await teacher.get('/api/teacher/dashboard'); assert.equal(afterSave.submissions[0].status, 'teacher_reviewed');
  const [publishStatus] = await teacher.post(`/api/teacher/submissions/${queued.id}/review`, { finalScore: 86, finalFeedback: 'Strong recommendation and professional delivery.', action: 'publish', confirmPublish: true });
  assert.equal(publishStatus, 200);
  const [, visibleResult] = await student.get('/api/session'); assert.equal(visibleResult.student.results.length, 1); assert.equal(visibleResult.student.results[0].score, 86);
  const [, finalDashboard] = await teacher.get('/api/teacher/dashboard'); assert.equal(finalDashboard.submissions[0].status, 'published');
  assert.equal((await teacher.get(`/api/teacher/students/${created.student.id}`))[0], 404);
  const [deleteStatus] = await teacher.del(`/api/teacher/students/${created.student.id}`);
  assert.equal(deleteStatus, 200);
  const [, deletedDashboard] = await teacher.get('/api/teacher/dashboard'); assert.equal(deletedDashboard.students.length, 0); assert.equal(deletedDashboard.submissions.length, 0);
});

test('students can register without teacher approval and enter exams open to registration', async (t) => {
  const f = await fixture(); t.after(f.close); const teacher = client(f.base); const learner = client(f.base);
  await teacher.post('/api/login', { email: 'teacher@example.edu', password: 'very-long-teacher-password' });
  const [openStatus, open] = await teacher.post('/api/teacher/assignments', { title: 'Open client presentation', slides: 'Present a clear client response and recommendation.', studentIds: [], openToAll: true });
  assert.equal(openStatus, 201); assert.equal(open.assignment.openToAll, true);
  const [, assignedStudent] = await teacher.post('/api/teacher/students', { name: 'Assigned Only', email: 'assigned@example.edu', password: 'assigned-student-password' });
  const [, privateAssignment] = await teacher.post('/api/teacher/assignments', { title: 'Private client presentation', slides: 'Present only to the selected student group.', studentIds: [assignedStudent.student.id], openToAll: false });
  const [shortPasswordStatus] = await learner.post('/api/register', { name: 'Amina Noor', email: 'amina@example.edu', password: 'short' }); assert.equal(shortPasswordStatus, 400);
  const [registerStatus, registered, registerHeaders] = await learner.post('/api/register', { name: 'Amina Noor', email: 'amina@example.edu', password: 'a-strong-student-password' });
  assert.equal(registerStatus, 201); assert.equal(registered.user.role, 'student'); assert.match(registerHeaders.get('set-cookie'), /HttpOnly/); assert.match(registerHeaders.get('set-cookie'), /SameSite=Strict/);
  const [, session] = await learner.get('/api/session'); assert.equal(session.user.email, 'amina@example.edu'); assert.equal(session.student.assignments.length, 1); assert.equal(session.student.assignments[0].id, open.assignment.id);
  assert.equal((await learner.post('/api/student/identity', { assignmentId: privateAssignment.assignment.id, consent: true, identityConfirmed: true }))[0], 404);
  const [identityStatus, identity] = await learner.post('/api/student/identity', { assignmentId: open.assignment.id, consent: true, identityConfirmed: true }); assert.equal(identityStatus, 201); assert.ok(identity.submissionId);
  const [duplicateStatus] = await client(f.base).post('/api/register', { name: 'Duplicate', email: 'AMINA@example.edu', password: 'another-strong-password' }); assert.equal(duplicateStatus, 409);
});

test('production refuses to start without the real OpenAI examiner credentials', async () => {
  const app = createAppServer({ dataFile: path.join(os.tmpdir(), `presently-production-${Date.now()}.json`), production: true, secureCookies: true, adminEmail: 'examiner@example.edu', adminPassword: 'strong-teacher-password', dataEncryptionKey: 'a-strong-encryption-key-of-32-bytes', apiKey: '' });
  await assert.rejects(app.ready(), /OPENAI_API_KEY/);
  await new Promise((resolve) => app.server.close(resolve));
});

test('production never converts a failed live slide request into a demo exam', async (t) => {
  const aiFetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EACCES' } }); };
  const f = await fixture({ production: true, secureCookies: true, adminEmail: 'teacher@example.edu', adminPassword: 'very-long-teacher-password', dataEncryptionKey: 'a-strong-encryption-key-of-32-bytes', apiKey: 'private-test-api-key', aiFetch }); t.after(f.close);
  const teacher = client(f.base); const student = client(f.base);
  await teacher.post('/api/login', { email: 'teacher@example.edu', password: 'very-long-teacher-password' });
  const [, assignment] = await teacher.post('/api/teacher/assignments', { title: 'Production presentation', slides: 'Present a reliable client response and recovery plan.', studentIds: [], openToAll: true });
  await student.post('/api/register', { name: 'Voice Only Learner', email: 'voice@example.edu', password: 'strong-student-password' });
  const [, start] = await student.post('/api/student/identity', { assignmentId: assignment.assignment.id, consent: true, identityConfirmed: true });
  const [slideStatus, error] = await student.post('/api/student/slide', { submissionId: start.submissionId });
  assert.equal(slideStatus, 502); assert.match(error.error, /live slide examiner is unavailable/i);
  assert.equal((await student.post('/api/student/demo-mode', { submissionId: start.submissionId }))[0], 403);
});

test('enforces assignment, transcript, answer, score and publication confirmation rules', async (t) => {
  const f = await fixture({ durationMs: 60_000 }); t.after(f.close); const teacher = client(f.base); const student = client(f.base);
  await teacher.post('/api/login', { email: 'teacher@example.edu', password: 'very-long-teacher-password' });
  const [, created] = await teacher.post('/api/teacher/students', { name: 'Taylor', email: 'taylor@example.edu', password: 'temporary-password-123' });
  const [, assignment] = await teacher.post('/api/teacher/assignments', { title: 'Product plan', slides: 'Present the product plan and key benefits.', studentIds: [created.student.id] });
  await student.post('/api/login', { email: 'taylor@example.edu', password: 'temporary-password-123' });
  const [, start] = await student.post('/api/student/identity', { assignmentId: assignment.assignment.id, consent: true, identityConfirmed: true });
  const [shortTranscript] = await student.post('/api/student/questions', { submissionId: start.submissionId, transcript: 'too short' }); assert.equal(shortTranscript, 400);
  const [earlyStatus] = await student.post('/api/student/questions', { submissionId: start.submissionId, transcript: 'A sufficiently long presentation transcript. '.repeat(5) }); assert.equal(earlyStatus, 425);
  assert.equal((await teacher.post('/api/teacher/assignments', { title: '', slides: '', studentIds: [] }))[0], 400);
});

test('encrypts persisted assessment and refuses production startup without required secrets', async (t) => {
  const key = 'development-only-test-key-material-32-bytes'; const f = await fixture({ dataEncryptionKey: key }); t.after(f.close); const teacher = client(f.base);
  await teacher.post('/api/login', { email: 'teacher@example.edu', password: 'very-long-teacher-password' });
  await teacher.post('/api/teacher/students', { name: 'Encrypted Student', email: 'secret@example.edu', password: 'temporary-password-123' });
  const raw = await readFile(path.join(f.dir, 'store.json'), 'utf8');
  assert.match(raw, /presently-encrypted-v1/); assert.doesNotMatch(raw, /secret@example\.edu/);
  const other = createAppServer({ dataFile: path.join(f.dir, 'other.json'), production: true, adminEmail: '', adminPassword: '', dataEncryptionKey: '' });
  await assert.rejects(other.ready(), /Production requires/);
  await new Promise((resolve) => other.server.close(resolve));
});

test('lets an authenticated teacher enable a session-only AI key without saving it in exam data', async (t) => {
  const f = await fixture(); t.after(f.close); const teacher = client(f.base);
  await teacher.post('/api/login', { email: 'teacher@example.edu', password: 'very-long-teacher-password' });
  const [badStatus] = await teacher.post('/api/teacher/ai-key', { apiKey: 'short' }); assert.equal(badStatus, 400);
  const secret = 'sk-test-session-only-secret-not-real';
  const [status, result] = await teacher.post('/api/teacher/ai-key', { apiKey: secret }); assert.equal(status, 200); assert.equal(result.storage, 'memory-only');
  const [, session] = await teacher.get('/api/session'); assert.equal(session.aiConfigured, true);
  const raw = await readFile(path.join(f.dir, 'store.json'), 'utf8'); assert.doesNotMatch(raw, new RegExp(secret));
});

test('keeps AI credentials server side and sends assessment requests without provider storage', async (t) => {
  const requests = [];
  const rubric = { professionalEnglish: 18, fluencyPronunciation: 13, vocabulary: 12, structure: 14, eyeContactBodyLanguage: 8, confidenceCommunication: 8, questionAnswers: 13 };
  const aiFetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.headers.authorization, 'Bearer private-test-key');
    const request = JSON.parse(options.body); requests.push(request); assert.equal(request.store, false);
    const text = requests.length === 1 ? JSON.stringify({ questions: ['One?', 'Two?', 'Three?', 'Four?', 'Five?'] }) : JSON.stringify({ rubric: Object.fromEntries(Object.entries(rubric).map(([key, score]) => [key, { score, feedback: 'Good evidence.' }])), summary: 'A clear presentation.' });
    return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text }] }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const f = await fixture({ apiKey: 'private-test-key', aiFetch }); t.after(f.close); const teacher = client(f.base); const student = client(f.base);
  await teacher.post('/api/login', { email: 'teacher@example.edu', password: 'very-long-teacher-password' });
  const [, user] = await teacher.post('/api/teacher/students', { name: 'Morgan', email: 'morgan@example.edu', password: 'temporary-password-123' });
  const [, assignment] = await teacher.post('/api/teacher/assignments', { title: 'Launch plan', slides: 'Explain the launch plan and support your recommendation.', studentIds: [user.student.id] });
  await student.post('/api/login', { email: 'morgan@example.edu', password: 'temporary-password-123' });
  const [, start] = await student.post('/api/student/identity', { assignmentId: assignment.assignment.id, consent: true, identityConfirmed: true });
  const transcript = 'Our launch plan uses a small pilot, clear customer communication, and weekly measures to evaluate the first three months.';
  const [, questions] = await student.post('/api/student/questions', { submissionId: start.submissionId, transcript }); assert.deepEqual(questions.questions, ['One?', 'Two?', 'Three?', 'Four?', 'Five?']);
  const answers = questions.questions.map(() => 'I would compare customer outcomes with the launch goals.');
  const [, submitted] = await student.post('/api/student/submit', { submissionId: start.submissionId, answers, frames: ['data:image/jpeg;base64,AA=='] });
  assert.equal('aiScore' in submitted, false); assert.equal(requests.length, 2); assert.ok(requests[1].input[0].content.some((part) => part.type === 'input_image'));
});

test('creates an individual slide and short-lived realtime credential without exposing the main key', async (t) => {
  const calls = [];
  const aiFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/responses')) return new Response(JSON.stringify({ output: [{ content: [{ type: 'output_text', text: JSON.stringify({ title: 'Client launch recovery', scenario: 'A client launch is delayed and needs a professional update.', slideTitle: 'Recovering a client launch', bullets: ['Timeline is two weeks late', 'Client needs a reliable date', 'Support staff are limited'], task: 'Recommend a polite recovery plan.' }) }] }] }), { status: 200 });
    if (url.endsWith('/realtime/client_secrets')) return new Response(JSON.stringify({ value: 'ek-temporary-client-secret', expires_at: 12345 }), { status: 200 });
    throw new Error(`Unexpected provider URL: ${url}`);
  };
  const f = await fixture({ apiKey: 'private-server-key-test', aiFetch }); t.after(f.close);
  const teacher = client(f.base); const student = client(f.base);
  await teacher.post('/api/login', { email: 'teacher@example.edu', password: 'very-long-teacher-password' });
  const [, created] = await teacher.post('/api/teacher/students', { name: 'Amina Rahman', email: 'amina@example.edu', password: 'temporary-password-123' });
  const [, assignment] = await teacher.post('/api/teacher/assignments', { title: 'Client communication', slides: 'Use clear, polite professional English.', studentIds: [created.student.id] });
  await student.post('/api/login', { email: 'amina@example.edu', password: 'temporary-password-123' });
  const [, start] = await student.post('/api/student/identity', { assignmentId: assignment.assignment.id, consent: true, identityConfirmed: true });
  const [slideStatus, slide] = await student.post('/api/student/slide', { submissionId: start.submissionId });
  assert.equal(slideStatus, 200); assert.equal(slide.slide.title, 'Client launch recovery'); assert.equal(slide.slide.bullets.length, 3);
  const [voiceStatus, voice] = await student.post('/api/student/realtime-session', { submissionId: start.submissionId });
  assert.equal(voiceStatus, 200); assert.equal(voice.clientSecret, 'ek-temporary-client-secret');
  assert.equal(calls[1].options.headers.authorization, 'Bearer private-server-key-test');
  assert.match(calls[1].options.headers['OpenAI-Safety-Identifier'], /^[a-f0-9]{64}$/);
  const [unauthorized] = await client(f.base).post('/api/student/realtime-session', { submissionId: start.submissionId });
  assert.equal(unauthorized, 401);
});

test('keeps the exam flow usable in honest demo mode when outbound AI access is blocked', async (t) => {
  const aiFetch = async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'EACCES' } }); };
  const f = await fixture({ apiKey: 'private-server-key-test', aiFetch }); t.after(f.close);
  const teacher = client(f.base); const student = client(f.base);
  await teacher.post('/api/login', { email: 'teacher@example.edu', password: 'very-long-teacher-password' });
  const [, created] = await teacher.post('/api/teacher/students', { name: 'Demo Learner', email: 'learner@example.edu', password: 'temporary-password-123' });
  const [, assignment] = await teacher.post('/api/teacher/assignments', { title: 'Client proposal', slides: 'Recommend a clear client-facing action.', studentIds: [created.student.id] });
  await student.post('/api/login', { email: 'learner@example.edu', password: 'temporary-password-123' });
  const [, start] = await student.post('/api/student/identity', { assignmentId: assignment.assignment.id, consent: true, identityConfirmed: true });
  const [slideStatus, slide] = await student.post('/api/student/slide', { submissionId: start.submissionId });
  assert.equal(slideStatus, 200); assert.equal(slide.demoMode, true); assert.equal(slide.aiConfigured, false); assert.ok(slide.slide.bullets.length >= 3);
  assert.equal((await student.post('/api/student/demo-mode', { submissionId: start.submissionId }))[0], 200);
  const transcript = 'Today I will recommend a revised timeline to the client. I will explain the delay clearly, give a realistic date, and offer weekly progress updates so the client can make informed decisions.';
  const [questionStatus, questionResult] = await student.post('/api/student/questions', { submissionId: start.submissionId, transcript });
  assert.equal(questionStatus, 200); assert.equal(questionResult.questions.length, 5); assert.equal(questionResult.aiConfigured, false);
  const answers = questionResult.questions.map(() => 'I would explain the facts politely and agree on a practical next step.');
  assert.equal((await student.post('/api/student/presentation-start', { submissionId: start.submissionId }))[0], 200);
  const [submitStatus, submitted] = await student.post('/api/student/submit', { submissionId: start.submissionId, answers, frames: [] });
  assert.equal(submitStatus, 200); assert.equal('aiScore' in submitted, false);
  const [, dashboard] = await teacher.get('/api/teacher/dashboard');
  assert.equal(dashboard.submissions[0].aiScore, null); assert.match(dashboard.submissions[0].aiSummary, /Demo run/i);
});


