const DEFAULT_PATH = "/";

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  let raw = header;
  if (typeof raw === "object") {
    raw = raw.headers && raw.headers.cookie ? raw.headers.cookie : "";
  }
  if (Array.isArray(raw)) raw = raw.join("; ");
  if (typeof raw !== "string") raw = String(raw || "");
  if (!raw) return out;
  const parts = raw.split(";");
  for (const p of parts) {
    const idx = p.indexOf("=");
    if (idx === -1) continue;
    const k = p.slice(0, idx).trim();
    const v = p.slice(idx + 1).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(v);
  }
  return out;
}

function serializeCookie(name, value, opts = {}) {
  const o = {
    path: DEFAULT_PATH,
    httpOnly: true,
    sameSite: "Lax",
    secure: true,
    ...opts,
  };

  let s = `${name}=${encodeURIComponent(value)}`;
  if (o.maxAge != null) s += `; Max-Age=${o.maxAge}`;
  if (o.path) s += `; Path=${o.path}`;
  if (o.domain) s += `; Domain=${o.domain}`;
  if (o.httpOnly) s += `; HttpOnly`;
  if (o.secure) s += `; Secure`;
  if (o.sameSite) s += `; SameSite=${o.sameSite}`;
  return s;
}

module.exports = { parseCookies, serializeCookie };

