const { serializeCookie } = require("../_lib/cookies");
const { STATE_COOKIE, makeStateToken } = require("../_lib/session");

module.exports = async (req, res) => {
  const clientId = process.env.DISCORD_CLIENT_ID;
  const redirectUri = process.env.DISCORD_REDIRECT_URI;
  const sessionSecret = process.env.SESSION_SECRET;

  if (!clientId || !redirectUri || !sessionSecret) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: "missing_env",
        need: ["DISCORD_CLIENT_ID", "DISCORD_REDIRECT_URI", "SESSION_SECRET"],
      })
    );
    return;
  }

  const stateToken = makeStateToken(sessionSecret);
  res.setHeader(
    "Set-Cookie",
    serializeCookie(STATE_COOKIE, stateToken, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 10 * 60,
    })
  );

  const u = new URL("https://discord.com/api/oauth2/authorize");
  u.searchParams.set("client_id", clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("scope", "identify");
  u.searchParams.set("state", stateToken);

  res.statusCode = 302;
  res.setHeader("Location", u.toString());
  res.end();
};

