import { mkdir, realpath, open, link, unlink } from 'node:fs/promises';
import { isAbsolute, relative, join, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHmac, timingSafeEqual, createHash } from 'node:crypto';
import { transaction, readJson, atomicJson } from './workflow-store.mjs';
import { notifyCodex, readCodex } from './codex-notifier.mjs';
import { captureBaseline } from './baseline.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const terminal = new Set(['ACCEPTED', 'CANCELLED']);
export function identifier(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw Error('INVALID_ID');
  return value;
}
export function text(value, max = 8192) {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw Error('INVALID_TEXT');
  return value;
}
export function reviewer(config, env = process.env) {
  if (config.role === 'worker') throw Error('REVIEWER_ONLY');
  return identifier(env.CODEX_THREAD_ID || config.reviewerThreadId);
}
function owned(task, who) { if (!task || task.originCodexTaskId !== who) throw Error('TASK_NOT_OWNED'); }
function publicTask(task) {
  const { ticket, secret, prompt, ...safe } = task;
  return structuredClone(safe);
}
function signature(secret, payload) { return createHmac('sha256', secret).update(JSON.stringify(payload)).digest('hex'); }
const taskDirectory = (dir, id) => join(dir, createHash('sha256').update(id).digest('hex'));
export function validateReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw Error('INVALID_REPORT');
  if (Object.keys(report).some(k => !['summary', 'changedFiles', 'checks', 'blockers'].includes(k))) throw Error('UNKNOWN_REPORT_FIELD');
  const strings = (values, max, length) => {
    if (!Array.isArray(values) || values.length > max) throw Error('INVALID_REPORT_LIST');
    return values.map(v => text(v, length));
  };
  const normalized = { summary: text(report.summary), changedFiles: strings(report.changedFiles || [], 64, 512),
    checks: strings(report.checks || [], 32, 512), blockers: strings(report.blockers || [], 16, 512) };
  if (Buffer.byteLength(JSON.stringify(normalized)) > 32768) throw Error('REPORT_TOO_LARGE');
  return normalized;
}

export async function submitReport(ticketPath, report) {
  const ticket = await readJson(ticketPath, 8192);
  identifier(ticket.taskId);
  if (ticket.version !== 1 || typeof ticket.secret !== 'string' || !/^[a-f0-9]{64}$/.test(ticket.secret) || !Number.isInteger(ticket.round)) throw Error('INVALID_TICKET');
  if (!isAbsolute(ticket.receiptPath)) throw Error('INVALID_TICKET');
  const payload = { taskId: ticket.taskId, round: ticket.round, report: validateReport(report) };
  const receipt = { payload, mac: signature(ticket.secret, payload) };
  try {
    const old = await readJson(ticket.receiptPath, 65536);
    if (JSON.stringify(old) !== JSON.stringify(receipt)) throw Error('REPORT_ALREADY_SUBMITTED');
    return { submitted: true, replay: true };
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  // Exclusive create: competing reporters cannot overwrite the first accepted receipt.
  const temp = ticket.receiptPath + '.' + randomBytes(8).toString('hex') + '.tmp';
  try {
    const file = await open(temp, 'wx', 0o600);
    try { await file.writeFile(JSON.stringify(receipt)); await file.sync(); } finally { await file.close(); }
    // Hard-link publication is exclusive and exposes only a completely written file.
    // Local NTFS/ext4 supported; unsupported filesystems fail rather than overwrite.
    try { await link(temp, ticket.receiptPath); }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      if (JSON.stringify(await readJson(ticket.receiptPath,65536)) !== JSON.stringify(receipt)) throw Error('REPORT_ALREADY_SUBMITTED');
    }
  } finally { await unlink(temp).catch(() => {}); }
  return { submitted: true };
}

async function prepare(config, db, task, dir) {
  const taskDir = taskDirectory(dir, task.taskId);
  await mkdir(taskDir, { recursive: true, mode: 0o700 });
  task.secret = randomBytes(32).toString('hex');
  task.ticket = join(taskDir, `ticket-${task.round}.json`);
  const receiptPath = join(taskDir, `receipt-${task.round}.json`);
  await atomicJson(task.ticket, { version: 1, taskId: task.taskId, round: task.round, secret: task.secret, receiptPath });
  task.receiptPath = receiptPath;
  task.requestId = `wf-${task.taskId}-${task.round}`;
  task.state = 'DELIVERY_UNKNOWN'; task.notification = { state: 'NONE', attempts: 0 };
  task.deadline = Date.now() + (config.workflowTimeoutMs || 86400000);
  task.updatedAt = new Date().toISOString();
}
function taskPrompt(task) {
  return `${task.prompt}\n\nBound task ${task.taskId}, round ${task.round}.\nProject: ${task.projectPath}\nScope: ${task.scope}\nAcceptance: ${task.acceptance}\nDo not change unrelated dirty work, reset/clean/force-push, publish, or approve your own work. The scope is a task instruction, not a sandbox.\nWhen work stops, write a UTF-8 JSON report with summary, changedFiles (strings), checks (strings), blockers (strings). All arrays are optional. Then run the following argv without printing ticket contents:\n${JSON.stringify([process.execPath, join(root, 'report.mjs'), '--ticket', task.ticket, '--report', join(dirname(task.ticket), `result-${task.round}.json`)])}\nThe result JSON is your report, not an acceptance verdict. Report blockers honestly. Do not start additional work after submitting.\n`;
}
async function send(config, task, invoke) {
  let result;
  try { result = await invoke(config, { sessionId: task.dshSessionId, requestId: task.requestId, text: taskPrompt(task) }); }
  catch { result = { state: 'DELIVERY_UNKNOWN' }; }
  return transaction(config, db => {
    const current = db.tasks[task.taskId];
    if (current.round === task.round && current.state === 'DELIVERY_UNKNOWN') {
      current.state = result.accepted ? 'RUNNING' : 'DELIVERY_UNKNOWN';
      current.delivery = result.accepted ? 'ACCEPTED' : 'UNKNOWN';
    }
    return publicTask(current);
  });
}

export async function dispatch(config, args, adapters, env = process.env) {
  const who = reviewer(config, env);
  const taskId = identifier(args.taskId), session = identifier(args.dshSessionId);
  const project = await realpath(text(args.projectPath, 2048));
  const roots = await Promise.all((config.allowedProjects || []).map(p => realpath(p)));
  if (!roots.some(p => { const r = relative(p, project); return !r || (!r.startsWith('..' + sep) && r !== '..' && !isAbsolute(r)); })) throw Error('PROJECT_NOT_ALLOWED');
  const scope = text(args.scope, 4096), acceptance = text(args.acceptance, 4096), prompt = text(args.text, 65536);
  const maxRounds = args.maxRounds ?? 2;
  if (!Number.isInteger(maxRounds) || maxRounds < 1 || maxRounds > 5) throw Error('INVALID_ROUND_LIMIT');
  const previous = await transaction(config, db => db.tasks[taskId] ? structuredClone(db.tasks[taskId]) : null);
  if (previous) {
    owned(previous, who);
    if (previous.dshSessionId !== session || previous.projectPath !== project || previous.scope !== scope || previous.acceptance !== acceptance || previous.initialPrompt !== prompt || previous.maxRounds !== maxRounds) throw Error('TASK_BINDING_COLLISION');
    return publicTask(previous); // Never automatically re-dispatch an uncertain write.
  }
  await (adapters.readCodex || readCodex)(config, who);
  // The bridge also checks queues/jobs immediately before submission.
  const listing = await adapters.sessions(config);
  if (listing.connected === false) throw Error('DSH_AUTH_OR_CONNECTION_REQUIRED');
  const found = (listing.items || []).filter(s => s.sessionId === session);
  if (found.length !== 1 || found[0].running) throw Error('SESSION_UNAVAILABLE');
  const actualCwd = found[0].cwd || found[0].projectPath;
  if (!actualCwd || await realpath(actualCwd) !== project) throw Error('SESSION_PROJECT_MISMATCH');
  const baseline = await (adapters.captureBaseline || captureBaseline)(project);
  const task = await transaction(config, async (db, dir) => {
    if (db.tasks[taskId]) throw Error('TASK_BINDING_COLLISION');
    try { await readJson(join(taskDirectory(dir, taskId), 'archived.json')); throw Error('TASK_ALREADY_ARCHIVED'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (Object.keys(db.tasks).length >= 256) throw Error('WORKFLOW_LIMIT');
    if (Object.values(db.tasks).some(t => t.dshSessionId === session && !terminal.has(t.state))) throw Error('SESSION_HAS_BOUND_TASK');
    const record = { taskId, originCodexTaskId: who, dshSessionId: session, projectPath: project, scope, acceptance,
      prompt, initialPrompt: prompt, baseline, maxRounds, round: 1, createdAt: new Date().toISOString() };
    await prepare(config, db, record, dir); db.tasks[taskId] = record;
    return structuredClone(record);
  });
  return send(config, task, adapters.submit);
}

export async function review(config, args, adapters, env = process.env) {
  const who = reviewer(config, env);
  identifier(args.taskId); text(args.notes);
  if (!['accept', 'changes'].includes(args.decision)) throw Error('INVALID_DECISION');
  const task = await transaction(config, async (db, dir) => {
    const t = db.tasks[args.taskId]; owned(t, who);
    if (t.round !== args.round) throw Error('STALE_ROUND');
    if (t.state === 'ACCEPTED' && args.decision === 'accept' && t.review?.notes === args.notes) return structuredClone(t);
    if (t.state !== 'AWAITING_REVIEW') throw Error('NOT_AWAITING_REVIEW');
    t.review = { decision: args.decision, notes: args.notes, reviewer: who, at: new Date().toISOString() };
    if (args.decision === 'accept') { t.state = 'ACCEPTED'; return structuredClone(t); }
    if (t.round >= t.maxRounds) { t.state = 'BLOCKED'; t.reason = 'REWORK_LIMIT'; return structuredClone(t); }
    t.round++; t.prompt = `Fix only the review findings for the original task.\nOriginal goal: ${t.initialPrompt}\nReviewer findings: ${args.notes}`;
    delete t.report; await prepare(config, db, t, dir);
    return structuredClone(t);
  });
  return task.state === 'DELIVERY_UNKNOWN' ? send(config, task, adapters.submit) : publicTask(task);
}

export async function workflowQuery(config, args = {}, env = process.env) {
  const who = reviewer(config, env);
  return transaction(config, db => {
    if (args.taskId) { const t = db.tasks[identifier(args.taskId)]; owned(t, who); return publicTask(t); }
    return { items: Object.values(db.tasks).filter(t => t.originCodexTaskId === who).map(publicTask) };
  });
}

export async function archive(config, args, env = process.env) {
  const who = reviewer(config, env);
  return transaction(config, async (db, dir) => {
    const t = db.tasks[identifier(args.taskId)]; owned(t, who);
    if (!terminal.has(t.state)) throw Error('TASK_NOT_TERMINAL');
    // Explicit archival releases capacity; never deletes project files or DSH history.
    const path = join(taskDirectory(dir, t.taskId), 'archived.json'); await atomicJson(path, publicTask(t));
    delete db.tasks[t.taskId];
    return { archived: true, taskId: t.taskId };
  });
}

export async function resolveNotification(config, args, env = process.env) {
  const who = reviewer(config, env); text(args.notes);
  if (!['acknowledged', 'retry'].includes(args.action)) throw Error('INVALID_RESOLUTION');
  return transaction(config, db => {
    const t = db.tasks[identifier(args.taskId)]; owned(t, who);
    if (t.round !== args.round || t.state !== 'AWAITING_REVIEW') throw Error('STALE_ROUND');
    if (!['UNKNOWN', 'BLOCKED'].includes(t.notification.state)) throw Error('NOTIFICATION_NOT_UNCERTAIN');
    t.notification = { ...t.notification, state: args.action === 'retry' ? 'PENDING' : 'ACKNOWLEDGED', attempts: 0,
      nextAttempt: 0, resolution: { notes: args.notes, by: who } };
    return publicTask(t);
  });
}

export async function tick(config, adapters = {}) {
  // Single worker lease is held by runner.mjs. Transactions also serialize MCP clients.
  const candidates = await transaction(config, db => Object.values(db.tasks).filter(t => !terminal.has(t.state)).map(t => t.taskId));
  const results = [];
  for (const id of candidates) {
    let task = await transaction(config, async db => {
      const t = db.tasks[id]; if (!t) return null;
      if (['RUNNING', 'DELIVERY_UNKNOWN'].includes(t.state)) {
        try {
          const receipt = await readJson(t.receiptPath, 65536);
          const expected = signature(t.secret, receipt.payload);
          if (typeof receipt.mac !== 'string' || !/^[a-f0-9]{64}$/.test(receipt.mac) || !timingSafeEqual(Buffer.from(expected), Buffer.from(receipt.mac)) || receipt.payload.taskId !== t.taskId || receipt.payload.round !== t.round) throw Error('INVALID_RECEIPT');
          t.report = validateReport(receipt.payload.report); t.state = 'AWAITING_REVIEW';
          t.notification = { state: 'PENDING', attempts: 0, nextAttempt: 0 };
        } catch (e) {
          if (e.code !== 'ENOENT') { t.lastError = 'INVALID_OR_PARTIAL_RECEIPT'; }
          if (Date.now() > t.deadline) { t.state = 'BLOCKED'; t.reason = 'COMPLETION_DEADLINE'; }
        }
      }
      return structuredClone(t);
    });
    if (!task) continue;
    if (task.state !== 'AWAITING_REVIEW' || !['PENDING', 'RETRY'].includes(task.notification.state) || task.notification.nextAttempt > Date.now()) continue;
    let sent = false;
    try {
      const ack = await (adapters.notify || notifyCodex)(config, task, async () => {
        await transaction(config, db => {
          const t = db.tasks[id];
          if (t.round !== task.round || t.state !== 'AWAITING_REVIEW' || !['PENDING', 'RETRY'].includes(t.notification.state)) throw Error('STALE_NOTIFICATION');
          t.notification.state = 'UNKNOWN'; t.notification.attempts++;
        });
        sent = true;
      });
      await transaction(config, db => {
        const t = db.tasks[id]; if (t?.round === task.round && t.notification.state === 'UNKNOWN') t.notification = { ...t.notification, state: 'ACKNOWLEDGED', turnId: ack.turnId };
      });
      results.push({ taskId: id, notified: true });
    } catch (e) {
      await transaction(config, db => {
        const t = db.tasks[id]; if (!t || t.round !== task.round) return;
        if (!sent && !['PENDING', 'RETRY'].includes(t.notification.state)) return;
        if (sent) { t.notification.state = 'UNKNOWN'; return; }
        t.notification.attempts += sent ? 0 : 1;
        t.notification.state = t.notification.attempts >= 5 ? 'BLOCKED' : 'RETRY';
        t.notification.nextAttempt = Date.now() + Math.min(300000, 5000 * 2 ** t.notification.attempts);
      });
      results.push({ taskId: id, notified: false, unknown: sent });
    }
  }
  return results;
}
