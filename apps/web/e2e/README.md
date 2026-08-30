# E2E Tests

Playwright-based end-to-end tests for the CodeJustWrite web app.

## Setup

```bash
cd apps/web
npm install
npx playwright install
```

## Run Tests

```bash
# Run all tests
npm test

# Run with UI (visual test runner)
npm run test:ui

# Run headed (see browser)
npm run test:headed

# Debug tests
npm run test:debug
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `TEST_SERVER` | `http://localhost:8787` | Server URL |
| `TEST_TOKEN` | `test-token` | Server auth token |

## Test Coverage

- **Sign-in Flow**: Form validation, server connection, auth errors
- **Repository Selection**: Search, browse, select, start session
- **Chat Interface**: Send messages, receive responses, clear chat
- **Settings Modal**: Provider selection, model input, auto-approve toggle
- **Keyboard Shortcuts**: Enter to send, Escape to clear, Ctrl+K to focus
- **Responsive Design**: Mobile, tablet, desktop layouts
- **Accessibility**: Heading structure, labels, keyboard navigation
- **Visual Regression**: Screenshots for comparison (optional)

## Debugging

```bash
# Show traces
npx playwright show-trace test-results/<trace-id>/trace.zip

# Show report
npx playwright show-report
```