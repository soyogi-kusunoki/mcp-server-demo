/**
 * ログイン画面と同意画面 (依存なしの素の HTML + JS)。
 *
 * better-auth の oauth-provider は認可リクエスト時に、署名付きのクエリ
 * (`sig` / `ba_param` など) を付けてこれらのページへリダイレクトする。
 * ページ側はそのクエリを `oauth_query` としてそのまま API に渡すことで、
 * ログイン完了後・同意後に認可フローを再開できる。
 * (better-auth のクライアント SDK `oauthProviderClient()` が行う処理と同等)
 */

const layout = (title: string, body: string) => `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | Demo Auth Server</title>
<style>
  :root { color-scheme: light dark; --accent: #4f46e5; }
  body { font-family: system-ui, sans-serif; display: grid; place-items: center; min-height: 100vh; margin: 0; background: Canvas; }
  main { width: min(400px, calc(100% - 32px)); padding: 32px; border: 1px solid #8884; border-radius: 12px; }
  h1 { font-size: 1.3rem; margin-top: 0; }
  label { display: block; margin: 12px 0 4px; font-size: .9rem; }
  input { width: 100%; box-sizing: border-box; padding: 8px; font-size: 1rem; }
  button { margin-top: 16px; padding: 10px 16px; font-size: 1rem; border-radius: 6px; border: 1px solid var(--accent); cursor: pointer; }
  .primary { background: var(--accent); color: white; }
  .secondary { background: transparent; color: inherit; }
  .row { display: flex; gap: 8px; }
  .row button { flex: 1; }
  .hint { font-size: .85rem; opacity: .75; }
  .error { color: #dc2626; min-height: 1.2em; }
  code { word-break: break-all; }
  ul { padding-left: 1.2em; }
</style>
</head>
<body><main>${body}</main>
<script>
  // 署名付き OAuth クエリを取り出す (better-auth の buildSignedOAuthQuery と同等)
  function signedOAuthQuery() {
    const params = new URLSearchParams(location.search);
    if (!params.has("sig")) return undefined;
    const signed = new Set(params.getAll("ba_param"));
    const out = new URLSearchParams();
    for (const [k, v] of params) {
      if (k === "sig" || k === "ba_param" || signed.has(k)) out.append(k, v);
    }
    return out.toString();
  }
  async function post(path, body) {
    const res = await fetch("/api/auth" + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ ...body, oauth_query: signedOAuthQuery() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error_description || data.error || res.statusText);
    if (data.url) location.href = data.url;
    return data;
  }
</script>
</body>
</html>`;

export const loginPage = () =>
  layout(
    "ログイン",
    `<h1>Demo Auth Server にログイン</h1>
<p class="hint">デモ用アカウント: <code>demo@example.com</code> / <code>password1234</code></p>
<form id="form">
  <label for="email">メールアドレス</label>
  <input id="email" name="email" type="email" value="demo@example.com" required>
  <label for="password">パスワード</label>
  <input id="password" name="password" type="password" value="password1234" required>
  <button class="primary" type="submit">ログイン</button>
  <p class="error" id="error"></p>
</form>
<script>
  document.getElementById("form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    try {
      await post("/sign-in/email", { email: f.get("email"), password: f.get("password") });
    } catch (err) {
      document.getElementById("error").textContent = err.message;
    }
  });
</script>`,
  );

export const consentPage = () =>
  layout(
    "アクセスの許可",
    `<h1>アクセスを許可しますか？</h1>
<p>次のクライアントがあなたのアカウントへのアクセスを求めています。</p>
<p><strong id="client-name">読み込み中…</strong><br><span class="hint">client_id: <code id="client-id"></code></span></p>
<p>要求されたスコープ:</p>
<ul id="scopes"></ul>
<div class="row">
  <button class="secondary" id="deny">拒否</button>
  <button class="primary" id="accept">許可</button>
</div>
<p class="error" id="error"></p>
<script>
  const params = new URLSearchParams(location.search);
  const clientId = params.get("client_id") ?? "";
  document.getElementById("client-id").textContent = clientId;
  for (const s of (params.get("scope") ?? "").split(" ").filter(Boolean)) {
    const li = document.createElement("li");
    li.textContent = s;
    document.getElementById("scopes").append(li);
  }
  // CIMD で登録されたクライアントの表示名 (client_name) を取得
  fetch("/api/auth/oauth2/public-client?client_id=" + encodeURIComponent(clientId), { credentials: "include" })
    .then((r) => (r.ok ? r.json() : {}))
    .then((c) => { document.getElementById("client-name").textContent = c.client_name ?? clientId; })
    .catch(() => {});
  const decide = (accept) => post("/oauth2/consent", { accept })
    .catch((err) => { document.getElementById("error").textContent = err.message; });
  document.getElementById("accept").onclick = () => decide(true);
  document.getElementById("deny").onclick = () => decide(false);
</script>`,
  );
