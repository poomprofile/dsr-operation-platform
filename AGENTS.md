# Auth Architecture Notes — DSR Portal

## Login Flow (OAuth Authorization Code)

```
User visits /exec
  → doGet() → serveLoginPage_() → login.html
  → user clicks button → window.top.location.href = oauthUrl
  → Google OAuth consent
  → Google redirects to /exec?code=XXX&state=YYY
  → doGet() → handleOAuthCallback_()
  → verifies code, creates session token
  → serves index.html directly (no redirect page)
```

## Critical Rules

### Login button must use window.top.location.href

```html
<!-- CORRECT -->
<button onclick="window.top.location.href='<?= oauthUrl ?>'">เข้าสู่ระบบ</button>

<!-- WRONG — blocked by Apps Script iframe sandbox -->
<a href="<?= oauthUrl ?>">เข้าสู่ระบบ</a>
<button onclick="window.location.href='...'">เข้าสู่ระบบ</button>
```

`window.top` breaks out of the GAS iframe wrapper and navigates the real browser window.
`window.location` and `<a href>` navigate within the sandboxed iframe → blocked/403.

### OAuth callback must serve index.html directly

```javascript
// CORRECT — handleOAuthCallback_() serves index.html directly
var tmpl = HtmlService.createTemplateFromFile('index');
tmpl.userToken   = sessionToken;
tmpl.userProfile = JSON.stringify(user);
return tmpl.evaluate()
  .setTitle('...')
  .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

// WRONG — intermediate pages lose the session token window
return HtmlService.createHtmlOutput('<meta http-equiv="refresh" content="0;url=...">');
return HtmlService.createHtmlOutput('<a href="...">คลิกที่นี่</a>');
```

index.html is **only ever served when authenticated** — it reads session data directly from
template variables (`_sessionToken`, `_initialProfile`) injected server-side.

## Template Variables (index.html)

| Variable         | Template syntax            | Value |
|------------------|---------------------------|-------|
| `_sessionToken`  | `var _sessionToken = '<?= userToken ?>';`    | UUID session key |
| `_initialProfile`| `var _initialProfile = <?!= userProfile ?>;` | JSON user object |

`<?= ... ?>` = HTML-escaped output (safe for strings)
`<?!= ... ?>` = unescaped output (required for JSON objects)

**Do NOT redeclare these with `let`** — `var` declaration must remain at top of script block,
above the `// ─── STATE ───` block.
