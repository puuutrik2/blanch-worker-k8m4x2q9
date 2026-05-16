const COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULTS = {
  DISCORD_CHANNEL_ID: "1504600279432302735",
  DISCORD_CLIENT_ID: "1504600409971363860",
  DISCORD_REDIRECT_URI: "https://blanch-worker-k8m4x2q9.rodionpytra.workers.dev/auth/discord/callback",
  SITE_URL: "https://blanch.monster",
};

function envText(env, key) {
  return String(env[key] || DEFAULTS[key] || "").trim();
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    },
  });
}

function corsHeaders(request, env) {
  const origin = request.headers.get("origin");
  const siteUrl = envText(env, "SITE_URL");
  const allowed = new Set([siteUrl, "http://127.0.0.1:4183", "http://localhost:4183"].filter(Boolean));
  return {
    "access-control-allow-origin": allowed.has(origin) ? origin : siteUrl,
    "access-control-allow-credentials": "true",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
  };
}

function redirect(location, headers = {}) {
  return new Response(null, { status: 302, headers: { location, ...headers } });
}

function parseCookies(request) {
  const header = request.headers.get("cookie") || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const separator = part.indexOf("=");
        return [part.slice(0, separator), decodeURIComponent(part.slice(separator + 1))];
      }),
  );
}

function setCookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${maxAge}`;
}

function clean(value) {
  return String(value || "").trim().slice(0, 900);
}

function discordTag(user) {
  if (!user) return "-";
  return user.discriminator && user.discriminator !== "0"
    ? `${user.username}#${user.discriminator}`
    : user.username;
}

async function sign(payload, secret) {
  const data = new TextEncoder().encode(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, data);
  return btoa(String.fromCharCode(...new Uint8Array(signature))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function createSession(user, env) {
  const body = btoa(JSON.stringify({ user, exp: Date.now() + 7 * 24 * 60 * 60 * 1000 }));
  return `${body}.${await sign(body, env.SESSION_SECRET)}`;
}

async function readSession(request, env) {
  const authorization = request.headers.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const token = bearer || parseCookies(request).blanch_sid;
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  if ((await sign(body, env.SESSION_SECRET)) !== signature) return null;

  const session = JSON.parse(atob(body));
  if (session.exp < Date.now()) return null;
  return session.user;
}

async function exchangeDiscordCode(code, env) {
  const body = new URLSearchParams({
    client_id: envText(env, "DISCORD_CLIENT_ID"),
    client_secret: envText(env, "DISCORD_CLIENT_SECRET"),
    grant_type: "authorization_code",
    code,
    redirect_uri: envText(env, "DISCORD_REDIRECT_URI"),
  });

  const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!tokenResponse.ok) {
    throw new Error(`Discord OAuth token error ${tokenResponse.status}: ${await tokenResponse.text()}`);
  }

  const token = await tokenResponse.json();
  const userResponse = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { authorization: `Bearer ${token.access_token}` },
  });

  if (!userResponse.ok) {
    throw new Error(`Discord user error ${userResponse.status}: ${await userResponse.text()}`);
  }

  return userResponse.json();
}

function buildDiscordMessage(data, user, env) {
  const siteUrl = envText(env, "SITE_URL").replace(/\/$/, "");

  return {
    content: "РќРѕРІР°СЏ Р·Р°СЏРІРєР° РІ BLANCH",
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: "Р—Р°СЏРІРєР° РІ СЃРµРјСЊСЋ BLANCH",
        color: 0xa70f18,
        image: siteUrl ? { url: `${siteUrl}/blanch-title.gif` } : undefined,
        fields: [
          { name: "Discord login", value: `${discordTag(user)} (${user.id})`, inline: false },
          { name: "РРјСЏ Р¤Р°РјРёР»РёСЏ IC | Р’РѕР·СЂР°СЃС‚ OOC", value: clean(data.identity) || "-", inline: false },
          { name: "РћРЅР»Р°Р№РЅ РІ РґРµРЅСЊ | Р§Р°СЃРѕРІРѕР№ РїРѕСЏСЃ", value: clean(data.online) || "-", inline: false },
          { name: "Р’ РєР°РєРёС… СЃРµРјСЊСЏС… Р±С‹Р»Рё", value: clean(data.families) || "-", inline: false },
          { name: "РџРѕС‡РµРјСѓ BLANCH", value: clean(data.reason) || "-", inline: false },
          { name: "РћРїС‹С‚ РЅР° РІС‹СЃРѕРєРёС… РґРѕР»Р¶РЅРѕСЃС‚СЏС…", value: clean(data.experience) || "-", inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

async function sendToDiscord(data, user, env) {
  const response = await fetch(`https://discord.com/api/v10/channels/${envText(env, "DISCORD_CHANNEL_ID")}/messages`, {
    method: "POST",
    headers: {
      authorization: `Bot ${envText(env, "DISCORD_BOT_TOKEN")}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(buildDiscordMessage(data, user, env)),
  });

  if (!response.ok) {
    throw new Error(`Discord returned ${response.status}: ${await response.text()}`);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return json(
          {
            ok: true,
            discordBotToken: Boolean(envText(env, "DISCORD_BOT_TOKEN")),
            discordChannelId: Boolean(envText(env, "DISCORD_CHANNEL_ID")),
            discordClientId: Boolean(envText(env, "DISCORD_CLIENT_ID")),
            discordClientSecret: Boolean(envText(env, "DISCORD_CLIENT_SECRET")),
            discordRedirectUri: envText(env, "DISCORD_REDIRECT_URI"),
            siteUrl: envText(env, "SITE_URL"),
            sessionSecret: Boolean(envText(env, "SESSION_SECRET")),
          },
          200,
          cors,
        );
      }

      if (request.method === "GET" && url.pathname === "/api/me") {
        const user = await readSession(request, env);
        if (!user) return json({ ok: true, user: null, cooldownLeft: 0 }, 200, cors);
        const last = Number(await env.BLANCH_KV?.get(`cooldown:${user.id}`)) || 0;
        return json({ ok: true, user, cooldownLeft: Math.max(0, COOLDOWN_MS - (Date.now() - last)) }, 200, cors);
      }

      if (request.method === "GET" && url.pathname === "/auth/discord") {
        const state = crypto.randomUUID();
        const params = new URLSearchParams({
          client_id: envText(env, "DISCORD_CLIENT_ID"),
          redirect_uri: envText(env, "DISCORD_REDIRECT_URI"),
          response_type: "code",
          scope: "identify",
          state,
        });
        return redirect(`https://discord.com/oauth2/authorize?${params}`, {
          "set-cookie": setCookie("blanch_oauth_state", state, 600),
        });
      }

      if (request.method === "GET" && url.pathname === "/auth/discord/callback") {
        const state = url.searchParams.get("state");
        const code = url.searchParams.get("code");
        const cookies = parseCookies(request);
        if (!state || !code || cookies.blanch_oauth_state !== state) {
          return redirect(`${envText(env, "SITE_URL")}/?login=failed`, { "set-cookie": setCookie("blanch_oauth_state", "", 0) });
        }

        const discordUser = await exchangeDiscordCode(code, env);
        const user = {
          id: discordUser.id,
          username: discordUser.username,
          globalName: discordUser.global_name,
          discriminator: discordUser.discriminator,
          avatar: discordUser.avatar,
        };
        const session = await createSession(user, env);
        return redirect(`${envText(env, "SITE_URL")}/?login=ok#session=${encodeURIComponent(session)}`, {
          "set-cookie": [setCookie("blanch_oauth_state", "", 0), setCookie("blanch_sid", session, 7 * 24 * 60 * 60)].join(", "),
        });
      }

      if (request.method === "POST" && url.pathname === "/auth/logout") {
        return json({ ok: true }, 200, { ...cors, "set-cookie": setCookie("blanch_sid", "", 0) });
      }

      if (request.method === "POST" && url.pathname === "/api/apply") {
        const user = await readSession(request, env);
        if (!user) return json({ ok: false, message: "РЎРЅР°С‡Р°Р»Р° РІРѕР№РґРёС‚Рµ С‡РµСЂРµР· Discord." }, 401, cors);

        const last = Number(await env.BLANCH_KV?.get(`cooldown:${user.id}`)) || 0;
        const left = Math.max(0, COOLDOWN_MS - (Date.now() - last));
        if (left > 0) {
          return json({ ok: false, message: "Повторную заявку можно отправить позже.", cooldownLeft: left }, 429, cors);
        }

        const data = await request.json();
        for (const field of ["identity", "online", "families", "reason", "experience"]) {
          if (!clean(data[field])) return json({ ok: false, message: "Р—Р°РїРѕР»РЅРёС‚Рµ РІСЃРµ РїРѕР»СЏ." }, 400, cors);
        }

        await sendToDiscord(data, user, env);
        await env.BLANCH_KV?.put(`cooldown:${user.id}`, String(Date.now()), { expirationTtl: 3600 });
        return json({ ok: true, message: "Р—Р°СЏРІРєР° РѕС‚РїСЂР°РІР»РµРЅР°.", cooldownLeft: COOLDOWN_MS }, 200, cors);
      }

      return json({ ok: false, message: "Not found" }, 404, cors);
    } catch (error) {
      return json({ ok: false, message: error.message }, 500, cors);
    }
  },
};

