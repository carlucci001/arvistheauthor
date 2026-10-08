// Voice-recording upload endpoint for /record.
// Self-contained: the only dependency is @vercel/blob and the BLOB_READ_WRITE_TOKEN env var.
//
// Protocol (all POST, same origin):
//   ?id=<uuid>&part=<n>&parts=<total>   body: raw bytes (application/octet-stream), up to 3 MB
//   ?id=<uuid>&done=1                   body: JSON { name, consent, consentText, mime, bytes, parts, durationSec }
// On "done" the parts are joined into one audio file and stored with a permission record:
//   recordings/<date>_<name>_<id8>/voice-<random>.<ext>
//   recordings/<date>_<name>_<id8>/permission-<random>.json
const { put, list, del } = require('@vercel/blob');

const MAX_PART_BYTES = 3 * 1024 * 1024;
const MAX_PARTS = 16;
const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EXT_BY_MIME = { 'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/mpeg': 'mp3' };

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

module.exports = async function handler(req, res) {
  try {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: 'POST only' });
    const q = getQuery(req);
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
        audioPath: audioBlob.pathname,
        audioUrl: audioBlob.url,
        bytes: audio.length,
        mime: String(meta.mime || '').slice(0, 80),
        durationSec: Number(meta.durationSec) || null,
        page: String(req.headers.referer || '').slice(0, 300),
        userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      };
      await put(`${folder}/permission.json`, JSON.stringify(record, null, 2), {
        access: 'public',
        addRandomSuffix: true,
        contentType: 'application/json',
      });
      try { await del(found.map((b) => b.url)); } catch (e) { /* leftover parts are harmless */ }
      return send(res, 200, { ok: true });
    }

    return send(res, 400, { ok: false, error: 'nothing to do' });
  } catch (err) {
    console.error('record-upload error', err);
    return send(res, 500, { ok: false, error: 'server error' });
  }
};
