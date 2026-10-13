# Browser regressions

Use Node.js 24. Install the pinned dependencies and Chromium once:

```sh
npm ci
npx playwright install --with-deps chromium
npm run test:browser
```

To use an existing Chromium installation:

```sh
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/absolute/path/to/chromium npm run test:browser
```

Each test runs its own panel HTTP server, temporary SQLite data directory, and local
Cloudflare HTTP mock. No credentials, services, or secrets are required. The restart
fixture reopens the same persisted database and HTTP port, preserving browser cookies.
Fixture controls are test functions; no test control routes are added to the application.

Specs use `.spec.js` so `npm test` continues running only the existing Node tests.
Failure traces and screenshots go to `/tmp/network-playwright-results`; set
`PLAYWRIGHT_OUTPUT_DIR` to override that location.
