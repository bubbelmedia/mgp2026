// Cloudflare Worker: mgp2026 admin proxy.
//
// Endpoints (POST, JSON body):
//   /verify  { password }            -> 200 ok / 401
//   /apply   { password, prompt }    -> Claude rewrites index.html, commits to GitHub
//
// Required secrets (wrangler secret put <NAME>):
//   ANTHROPIC_API_KEY  - Anthropic API key
//   ADMIN_PASSWORD     - shared admin password
//   GITHUB_TOKEN       - fine-grained PAT with Contents: read+write on the repo
//
// Required vars (in wrangler.toml [vars]):
//   GITHUB_OWNER, GITHUB_REPO, GITHUB_BRANCH, GITHUB_FILE_PATH, CLAUDE_MODEL

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

    const url = new URL(request.url);
    const body = await request.json().catch(() => ({}));

    if (!body.password || body.password !== env.ADMIN_PASSWORD) {
      return json({ error: 'Invalid password' }, 401);
    }

    if (url.pathname === '/verify') return json({ ok: true }, 200);

    if (url.pathname === '/apply') {
      if (!body.prompt || typeof body.prompt !== 'string') {
        return json({ error: 'Missing prompt' }, 400);
      }
      try {
        const result = await applyChange(body.prompt, env);
        return json(result, 200);
      } catch (err) {
        return json({ error: String(err.message || err) }, 500);
      }
    }

    return json({ error: 'Not found' }, 404);
  },
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

async function applyChange(prompt, env) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  const filePath = env.GITHUB_FILE_PATH || 'index.html';
  const model = env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  const ghBase = `https://api.github.com/repos/${owner}/${repo}/contents/${filePath}`;
  const ghHeaders = {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'mgp2026-admin-worker',
  };

  const fileRes = await fetch(`${ghBase}?ref=${encodeURIComponent(branch)}`, { headers: ghHeaders });
  if (!fileRes.ok) throw new Error(`GitHub fetch ${fileRes.status}: ${await fileRes.text()}`);
  const fileData = await fileRes.json();
  const sha = fileData.sha;
  const currentHTML = decodeBase64Utf8(fileData.content);

  const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: 64000,
      messages: [{
        role: 'user',
        content:
          'You are an expert front-end developer. Below is the full source of a self-contained single-file MotoGP dashboard web app.\n\n' +
          `Apply this change request exactly, and only this change: "${prompt}"\n\n` +
          'Rules:\n' +
          '- Return ONLY the complete modified HTML file. No explanation, no markdown, no code fences.\n' +
          '- The very first character of your response MUST be < (the start of <!DOCTYPE html> or <html).\n' +
          '- Preserve all unrelated content, structure, styles, scripts, and data exactly.\n' +
          '- Keep the file self-contained (no new external dependencies unless explicitly requested).\n\n' +
          'SOURCE:\n' + currentHTML,
      }],
    }),
  });
  if (!claudeRes.ok) throw new Error(`Claude ${claudeRes.status}: ${await claudeRes.text()}`);
  const claudeData = await claudeRes.json();
  const newHTML = (claudeData.content?.[0]?.text || '').trim();
  if (!newHTML.startsWith('<')) {
    throw new Error('Claude returned non-HTML output (first 200 chars: ' + newHTML.slice(0, 200) + ')');
  }

  const commitMsg = 'admin: ' + prompt.replace(/\s+/g, ' ').trim().slice(0, 72);
  const putRes = await fetch(ghBase, {
    method: 'PUT',
    headers: { ...ghHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: commitMsg,
      content: encodeBase64Utf8(newHTML),
      sha,
      branch,
    }),
  });
  if (!putRes.ok) throw new Error(`GitHub commit ${putRes.status}: ${await putRes.text()}`);
  const putData = await putRes.json();
  return { ok: true, commit: putData.commit?.sha, message: commitMsg };
}

function decodeBase64Utf8(b64) {
  const binary = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function encodeBase64Utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
