// Voice-recording upload endpoint for /record.
// Self-contained: depends only on @vercel/blob and these env vars:
//   BLOB_READ_WRITE_TOKEN      storage (set by Vercel when the Blob store is linked)
//   RECORD_ACCESS_CODES        who may upload: comma-separated "label=code" pairs, e.g. "arvis=abc123,carl=def456"
//   RESEND_API_KEY             optional, for alert emails
//   RECORD_ALERT_TO            optional, where alert emails go
//   RECORD_ALERT_FROM          optional, sender (must be on a domain verified in Resend)
//   RECORD_MAX_STARTS_PER_DAY  optional, default 10
//   RECORD_MAX_TOTAL_MB        optional, default 250
//
// Protocol (all POST, same origin, every call carries &k=<code>):
//   ?check=1                            is this link valid and is the page accepting recordings?
//   ?id=<uuid>&part=<n>&parts=<total>   body: raw bytes (application/octet-stream), up to 3 MB
//   ?id=<uuid>&done=1                   body: JSON { name, consent, consentText, mime, bytes, parts, durationSec }
// On "done" the parts are joined into one audio file and stored with a permission record:
//   recordings/<date>_<name>_<id8>/voice-<random>.<ext>
//   recordings/<date>_<name>_<id8>/permission-<random>.json
//
// Abuse limits: a valid code is required; new uploads stop for the day after RECORD_MAX_STARTS_PER_DAY
// starts or once the store holds RECORD_MAX_TOTAL_MB; unfinished uploads older than a day are removed
// whenever the page is opened or an upload starts; an email goes out on each new recording and
// once a day if a limit closes the page.
const crypto = require('crypto');
const { put, list, del } = require('@vercel/blob');

const MAX_PART_BYTES = 3 * 1024 * 1024;
const MAX_PARTS = 16;
const STALE_MS = 24 * 60 * 60 * 1000;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXT_BY_MIME = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };

const maxStartsPerDay = () => Number(process.env.RECORD_MAX_STARTS_PER_DAY) || 10;
const maxTotalBytes = () => (Number(process.env.RECORD_MAX_TOTAL_MB) || 250) * 1024 * 1024;

function readStream(req) {
  return new Promise((resolve, reject) => {
    const bufs = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_PART_BYTES + 1024) { reject(new Error('too large')); req.destroy(); return; }
      bufs.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(bufs)));
    req.on('error', reject);
  });
}

async function rawBody(req) {
  const b = req.body;
  if (Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') return Buffer.from(b);
  if (b && typeof b === 'object') return Buffer.from(JSON.stringify(b));
  return readStream(req);
}

function getQuery(req) {
  if (req.query && Object.keys(req.query).length) return req.query;
  const u = new URL(req.url, 'http://x');
  return Object.fromEntries(u.searchParams.entries());
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

function slug(s) {
  return String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'unnamed';
}

// Returns the label of the matching access code, or null. With no codes configured, nobody gets in.
function accessLabel(k) {
  const given = Buffer.from(String(k || ''));
  if (given.length < 6 || given.length > 64) return null;
  let found = null;
  for (const entry of String(process.env.RECORD_ACCESS_CODES || '').split(',')) {
    const t = entry.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    const label = eq > 0 ? t.slice(0, eq).trim() : 'link';
    const code = Buffer.from(eq > 0 ? t.slice(eq + 1).trim() : t);
    if (code.length === given.length && crypto.timingSafeEqual(code, given)) found = label;
  }
  return found;
}

async function listAll(prefix) {
  const out = [];
  let cursor;
  do {
    const r = await list(prefix ? { prefix, cursor, limit: 1000 } : { cursor, limit: 1000 });
    out.push(...r.blobs);
    cursor = r.hasMore ? r.cursor : undefined;
  } while (cursor);
  return out;
}

// One pass over the store: remove stale unfinished uploads, then report how full it is and how busy today was.
async function inventory() {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  const blobs = await listAll('');
  const stale = blobs.filter((b) => b.pathname.startsWith('incoming/') && now - new Date(b.uploadedAt).getTime() > STALE_MS);
  if (stale.length) { try { await del(stale.map((b) => b.url)); } catch (e) { /* try again next time */ } }
  const staleUrls = new Set(stale.map((b) => b.url));
  let totalBytes = 0;
  const startsToday = new Set();
  for (const b of blobs) {
    if (staleUrls.has(b.url)) continue;
    totalBytes += Number(b.size) || 0;
    let m = b.pathname.match(/^incoming\/([0-9a-f-]{36})\//);
    if (m && new Date(b.uploadedAt).toISOString().slice(0, 10) === today) startsToday.add(m[1].slice(0, 8));
    m = b.pathname.match(/^recordings\/(\d{4}-\d{2}-\d{2})_.*_([0-9a-f]{8})\//);
    if (m && m[1] === today) startsToday.add(m[2]);
  }
  return { today, totalBytes, startsToday: startsToday.size, staleRemoved: stale.length };
}

function closedReason(inv) {
  if (inv.totalBytes >= maxTotalBytes()) return 'storage';
  if (inv.startsToday >= maxStartsPerDay()) return 'daily';
  return null;
}

async function email(subject, text) {
  const key = process.env.RESEND_API_KEY, to = process.env.RECORD_ALERT_TO;
  if (!key || !to) return false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(process.env.RECORD_EMAIL_API || 'https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.RECORD_ALERT_FROM || 'Voice Recordings <notifications@farringtondevelopment.com>', to: [to], subject, text }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!r.ok) console.error('alert email failed', r.status, (await r.text()).slice(0, 200));
    return r.ok;
  } catch (e) {
    console.error('alert email error', e && e.message);
    return false;
  }
}

// Tell the owner, at most once a day per reason, that a limit closed the page.
async function alertClosed(reason, inv, host) {
  try {
    await put(`alerts/${inv.today}-${reason}.txt`, `closed: ${reason}`, { access: 'public', addRandomSuffix: false, allowOverwrite: false, contentType: 'text/plain' });
  } catch (e) { return; } // already alerted today
  const mb = (inv.totalBytes / 1048576).toFixed(1);
  await email(
    reason === 'storage' ? 'Voice recording page closed itself: storage limit reached' : 'Voice recording page closed itself: daily limit reached',
    `The recording page on ${host} has stopped accepting new recordings.\n\n` +
    (reason === 'storage'
      ? `Reason: storage holds ${mb} MB, at or over the ${maxTotalBytes() / 1048576} MB limit. It reopens when recordings are removed from storage.\n`
      : `Reason: ${inv.startsToday} recordings were started today, the daily limit is ${maxStartsPerDay()}. It reopens at midnight UTC.\n`) +
    `\nStorage in use: ${mb} MB. Started today: ${inv.startsToday}.\n`
  );
}

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
    const q = getQuery(req);
    const host = String(req.headers.host || 'the site');
    const label = accessLabel(q.k);
    if (!label) return send(res, 403, { ok: false, error: 'code' });

    // ---- page load: is this link good and is the page open? ----
    if (q.check !== undefined) {
      const inv = await inventory();
      const reason = closedReason(inv);
      if (reason) { await alertClosed(reason, inv, host); return send(res, 429, { ok: false, error: 'closed' }); }
      return send(res, 200, { ok: true });
    }

    const id = String(q.id || '').toLowerCase();
    if (!ID_RE.test(id)) return send(res, 400, { ok: false, error: 'bad id' });

    // ---- one part of the recording ----
    if (q.part !== undefined) {
      const part = Number(q.part);
      const parts = Number(q.parts);
      if (!Number.isInteger(part) || !Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS || part < 0 || part >= parts) {
        return send(res, 400, { ok: false, error: 'bad part' });
      }
      const buf = await rawBody(req);
      if (!buf.length) return send(res, 400, { ok: false, error: 'empty part' });
      if (buf.length > MAX_PART_BYTES) return send(res, 413, { ok: false, error: 'part too large' });
      const first = `incoming/${id}/part-000`;
      const started = (await list({ prefix: first, limit: 1 })).blobs.length > 0;
      if (part === 0 && !started) {
        const inv = await inventory();
        const reason = closedReason(inv);
        if (reason) { await alertClosed(reason, inv, host); return send(res, 429, { ok: false, error: 'closed' }); }
      } else if (part > 0 && !started) {
        return send(res, 409, { ok: false, error: 'start with part 0' });
      }
      await put(`incoming/${id}/part-${String(part).padStart(3, '0')}`, buf, {
        access: 'public',
        addRandomSuffix: false,
        allowOverwrite: true,
        contentType: 'application/octet-stream',
      });
      return send(res, 200, { ok: true, part, bytes: buf.length });
    }

    // ---- finish: join the parts, store the audio and the permission record ----
    if (q.done !== undefined) {
      const raw = await rawBody(req);
      let meta;
      try { meta = JSON.parse(raw.toString('utf8')); } catch (e) { return send(res, 400, { ok: false, error: 'bad json' }); }
      const name = String(meta.name || '').trim().slice(0, 120);
      if (!name) return send(res, 400, { ok: false, error: 'name required' });
      if (meta.consent !== true) return send(res, 400, { ok: false, error: 'permission required' });
      const parts = Number(meta.parts);
      if (!Number.isInteger(parts) || parts < 1 || parts > MAX_PARTS) return send(res, 400, { ok: false, error: 'bad parts' });

      const found = (await list({ prefix: `incoming/${id}/` })).blobs
        .filter((b) => /\/part-\d{3}$/.test(b.pathname))
        .sort((a, b) => a.pathname.localeCompare(b.pathname));
      if (found.length !== parts) return send(res, 409, { ok: false, error: `expected ${parts} parts, have ${found.length}` });

      const bufs = [];
      for (const b of found) {
        const r = await fetch(b.url, { cache: 'no-store' });
        if (!r.ok) throw new Error('could not read part ' + b.pathname);
        bufs.push(Buffer.from(await r.arrayBuffer()));
      }
      const audio = Buffer.concat(bufs);
      if (Number(meta.bytes) !== audio.length) {
        return send(res, 409, { ok: false, error: `size mismatch: expected ${meta.bytes}, have ${audio.length}` });
      }

      const baseMime = String(meta.mime || '').split(';')[0].trim().toLowerCase();
      const ext = EXT_BY_MIME[baseMime] || 'webm';
      const now = new Date();
      const folder = `recordings/${now.toISOString().slice(0, 10)}_${slug(name)}_${id.slice(0, 8)}`;

      const audioBlob = await put(`${folder}/voice.${ext}`, audio, {
        access: 'public',
        addRandomSuffix: true,
        contentType: EXT_BY_MIME[baseMime] ? baseMime : 'audio/webm',
      });
      const record = {
        name,
        permissionGiven: true,
        permissionText: String(meta.consentText || '').slice(0, 600),
        receivedAt: now.toISOString(),
        recordingId: id,
        link: label,
        audioPath: audioBlob.pathname,
        audioUrl: audioBlob.url,
        bytes: audio.length,
        mime: String(meta.mime || '').slice(0, 80),
        durationSec: Number(meta.durationSec) || null,
        page: String(req.headers.referer || '').replace(/([?&]k=)[^&]*/, '$1…').slice(0, 300),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      };
      await put(`${folder}/permission.json`, JSON.stringify(record, null, 2), {
        access: 'public',
        addRandomSuffix: true,
        contentType: 'application/json',
      });
      try { await del(found.map((b) => b.url)); } catch (e) { /* leftover parts are removed after a day */ }

      const d = record.durationSec;
      await email(
        `New voice recording: ${name}`,
        `A voice recording was sent from the recording page on ${host}.\n\n` +
        `Name: ${name}\n` +
        `Length: ${d ? Math.floor(d / 60) + ':' + String(d % 60).padStart(2, '0') : 'unknown'}\n` +
        `Size: ${(audio.length / 1048576).toFixed(1)} MB\n` +
        `Link used: ${label}\n` +
        `Received: ${now.toISOString()}\n\n` +
        `Permission given: "${record.permissionText}"\n\n` +
        `Listen: ${audioBlob.url}\n`
      );
      return send(res, 200, { ok: true });
    }

    return send(res, 400, { ok: false, error: 'nothing to do' });
  } catch (err) {
    console.error('record-upload error', err);
    return send(res, 500, { ok: false, error: 'server error' });
  }
};
