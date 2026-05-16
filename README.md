# BLANCH Worker

Cloudflare Worker backend for BLANCH site Discord login and applications.

## Cloudflare env vars

Required variables:

```text
DISCORD_BOT_TOKEN=
DISCORD_CHANNEL_ID=
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=https://your-worker-url/auth/discord/callback
SITE_URL=https://blanch.monster
SESSION_SECRET=random-long-text
```

Deploy command:

```text
npx wrangler deploy
```

Build command can be empty.
