function ok(res, data, meta = {}) {
  return res.status(200).json({ ok: true, data, meta });
}

function created(res, data, meta = {}) {
  return res.status(201).json({ ok: true, data, meta });
}

function fail(res, status, message, details = null) {
  return res.status(status).json({ ok: false, error: { message, details } });
}

module.exports = { ok, created, fail };
