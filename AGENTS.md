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

---

## Session Management (Updated)

### Session TTL = 28800 seconds (8 hours)
- `CONFIG.SESSION_TTL_SEC = 28800` — session lasts 8 hours
- TTL is refreshed on every call via `getSessionUser()` and `getUserEmailFromToken()`
- No need for client-side keepalive pings

### Session expired → auto-redirect to login
```javascript
// CORRECT — all withFailureHandler must use handleSessionError
.withFailureHandler(function(err) {
  handleSessionError(err);  // redirects if "Session expired", shows toast otherwise
})

// WRONG — shows confusing toast instead of redirecting
.withFailureHandler(function(err) {
  showToast('⚠️ ' + err.message, 'error');
})
```

### Direct server functions (bypass handleApiCall)
Use `getUserEmailFromToken(sessionToken)` as the first call in any new direct GAS function:
```javascript
// CORRECT
function saveExpenses(sessionToken, weekStart, expenses) {
  var email = getUserEmailFromToken(sessionToken); // throws 'Session expired' if invalid
  // ...
}

// WRONG — Session.getActiveUser() returns empty in web app context
function saveExpenses(weekStart, expenses) {
  var email = Session.getActiveUser().getEmail(); // always empty!
}
```

### Never use Session.getActiveUser()
`Session.getActiveUser()` returns empty string in web apps deployed as "Execute as: Me".
Always authenticate via `getUserEmailFromToken(token)` or `getSessionUser(token)`.

### window.open() for print pages
Must happen inside `withSuccessHandler` callback (after getting HTML from server):
```javascript
// CORRECT — window.open after async call completes
google.script.run
  .withSuccessHandler(function(htmlContent) {
    var w = window.open('', '_blank');
    if (!w) { showToast('กรุณา allow popup แล้วลองใหม่', 'error'); return; }
    w.document.write(htmlContent);
    w.document.close();
    w.focus();
  })
  .getCoverSheetHtml(...);

// WRONG — window.open before getting HTML (opens blank tab)
var w = window.open('', '_blank');
google.script.run.withSuccessHandler(function(html) { w.document.write(html); })...
```
