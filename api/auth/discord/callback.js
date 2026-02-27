const { parseCookies, serializeCookie } = require("../../_lib/cookies");
const {
  SESSION_COOKIE,
  STATE_COOKIE,
  makeSessionToken,
  verifyStateToken,
} = require("../../_lib/session");
const { getTier } = require("../../_lib/tiers");

async function exchangeCodeForToken({ code, redirectUri, clientId, clientSecret }) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const r = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`token_exchange_failed: ${r.status} ${t}`);
  }
  return await r.json();
}

async function fetchDiscordMe(accessToken) {
  const r = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`fetch_me_failed: ${r.status} ${t}`);
  }
  return await r.json();
}

module.exports = async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  const clientId = process.env.DISCORD_CLIENT_ID;
  const clientSecret = process.env.DISCORD_CLIENT_SECRET;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;
  const sessionSecret = process.env.SESSION_SECRET;
  const appBaseUrl = process.env.APP_BASE_URL || "/";

  if (!clientId || !clientSecret || !redirectUri || !sessionSecret) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: "missing_env",
        need: ["DISCORD_CLIENT_ID", "DISCORD_CLIENT_SECRET", "DISCORD_REDIRECT_URI", "SESSION_SECRET"],
      })
    );
    return;
  }

  if (!code || !state) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "missing_code_or_state" }));
    return;
  }

  // Verify state against cookie
  const cookies = parseCookies(req.headers.cookie || "");
  const stateCookie = cookies[STATE_COOKIE];
  if (!stateCookie || stateCookie !== state) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "state_mismatch" }));
    return;
  }

  if (!verifyStateToken(state, sessionSecret)) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "state_invalid_or_expired" }));
    return;
  }

  try {
    const tokenObj = await exchangeCodeForToken({ code, redirectUri, clientId, clientSecret });
    const me = await fetchDiscordMe(tokenObj.access_token);
    const discord_user_id = me.id;

    const tier = await getTier(discord_user_id);
    const sessionToken = makeSessionToken({ discord_user_id, tier }, sessionSecret);

    // Set session cookie, clear state cookie
    res.setHeader("Set-Cookie", [
      serializeCookie(STATE_COOKIE, "", { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 0 }),
      serializeCookie(SESSION_COOKIE, sessionToken, { httpOnly: true, secure: true, sameSite: "Lax", path: "/", maxAge: 60 * 60 * 24 * 7 }),
    ]);

    res.statusCode = 302;
    res.setHeader("Location", appBaseUrl);
    res.end();
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ error: "oauth_callback_failed", detail: String(e && e.message ? e.message : e) }));
  }
};

