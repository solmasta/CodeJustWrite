# Run CodeJustWrite on your Android phone (free)

The whole app runs on your phone inside Termux, with no hosting account and no bill. After a
one-time setup, **one tap on a home-screen icon** starts the server and opens the app, already
signed in.

The AI models still run online (OpenRouter's free models work). Only the server runs on the
phone, so switching between Wi-Fi and cellular can't break the app's connection to it.

---

## 1. Install three apps from F-Droid

Termux on the Play Store is outdated and won't work. Get these from **F-Droid** instead:

1. Install F-Droid from **https://f-droid.org** (tap *Download F-Droid*, then open the file and
   allow installing from your browser when Android asks).
2. In F-Droid, search for and install:
   - **Termux**
   - **Termux:Widget** (the home-screen icon)
   - **Termux:Boot** (optional: starts the server automatically when the phone turns on)

## 2. Run the installer (once)

Open **Termux** and paste this line, then press Enter:

```
curl -fsSL https://raw.githubusercontent.com/solmasta/CodeJustWrite/main/scripts/termux/install.sh | bash
```

It takes a few minutes. It asks for two things:

- **OpenRouter API key**: get a free one at https://openrouter.ai/keys
- **GitHub token**: lets the AI push, open PRs and merge. Create one at
  https://github.com/settings/tokens (press Enter to skip for now)

When it finishes, the app opens in your browser.

## 3. Stop Android from killing it

Android shuts down background apps to save battery. Do both of these once:

- **Settings → Apps → Termux → Battery → Unrestricted**
- Open Termux:Boot once (if you installed it) so Android lets it run at startup.

## 4. Add the one-tap icon

1. Long-press an empty spot on your home screen → **Widgets**.
2. Find **Termux:Widget** and drag it onto the home screen (or use its **Termux shortcut** option
   to place just the single **CodeJustWrite** icon).
3. Tap **CodeJustWrite**. That's it from now on.

Tip: once the app is open in Chrome, **⋮ → Add to Home screen** gives it a full-screen app icon
too. The Termux icon *starts* the server; the Chrome icon just opens the app.

---

## The shortcuts

| Shortcut | What it does |
|---|---|
| **CodeJustWrite** | Starts the server if it isn't running and opens the app, signed in |
| **CJW Stop** | Stops the server and lets the phone sleep normally |
| **CJW Restart** | Restarts the server (after changing settings) |
| **CJW Update** | Downloads the latest version, rebuilds and restarts |
| **CJW Logs** | Shows the server's output, for when something's wrong |

## Changing settings

Your keys live in `~/.cjw/env`. To change one, open Termux and run:

```
nano ~/.cjw/env
```

Save with Ctrl+O then Enter, exit with Ctrl+X, then tap **CJW Restart**.

## Good to know

- **Headless-browser checks (`browser_check`) don't work on a phone.** Everything else does: git,
  commits, pushes, PRs, merges, shell commands and tests.
- **The server stops if the phone kills Termux**, and that ends open sessions. Tap the icon to start it
  again and start a new session. Step 3 prevents most of this.
- **It uses battery while the AI is working** (especially npm installs and tests). Tap
  **CJW Stop** when you're done for the day.
- **The AI's commands run inside Termux**, which is walled off from your photos and files. The setup
  never grants it storage access.
- **The server only listens on the phone itself** (`127.0.0.1`). Other devices on your Wi-Fi can't
  reach it.
