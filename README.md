# ROE Userscript — Installation Guide

ROE is a Tampermonkey userscript that adds spawn tracking, an inventory/quickbar sync, a minimap overlay, and other tools on top of the Roots of Embervault browser game. This build auto-loads a pre-explored minimap (maze, mines, mines lower, forest) from this repo the first time it runs.

## Requirements

- A desktop browser: Chrome, Firefox, Edge, or Brave
- The [Tampermonkey](https://www.tampermonkey.net/) browser extension installed

## 1. Install Tampermonkey

1. Go to the [Tampermonkey downloads page](https://www.tampermonkey.net/) and install the extension for your browser.
2. Pin the Tampermonkey icon to your toolbar (optional, but convenient).

## 2. Install the script

Clicking the raw link on GitHub directly will usually just **download** the file instead of installing it — that's normal, it just means the browser downloaded it before Tampermonkey could intercept it. Use one of the two methods below instead.

### Method A — Create a new script and paste the code (most reliable)

1. On GitHub, open `ROE-7.44.0_user.js`, click **Raw**, then select all the text and copy it (**Ctrl+A**, **Ctrl+C** / **Cmd+A**, **Cmd+C**).
   - If the raw page downloaded instead of showing text, open the downloaded file in any text editor, select all, and copy.
2. Click the Tampermonkey icon in your browser toolbar.
3. Click **Dashboard**.
4. Click the **+** tab (or **Create a new script...**).
5. Select all the placeholder code Tampermonkey put in the editor (**Ctrl+A**) and delete it.
6. Paste the script you copied in step 1 (**Ctrl+V**).
7. Press **Ctrl+S** (or **Cmd+S**) to save, or use the editor's **File → Save** menu.
8. The script now appears in your Tampermonkey Dashboard as **ROE**, enabled by default.

### Method B — Install from the downloaded file (drag & drop)

1. On GitHub, open `ROE-7.44.0_user.js` and click **Raw** — this downloads the file to your computer (e.g. into your Downloads folder).
2. Open the Tampermonkey **Dashboard** (click the Tampermonkey icon → **Dashboard**).
3. Drag the downloaded `.user.js` file from your file explorer/Finder and drop it directly onto the Dashboard page.
4. Tampermonkey will open the install prompt — click **Install** to confirm.

Either method installs the same script — pick whichever works smoothly in your browser.

## 3. Confirm it's active

1. Click the Tampermonkey icon in your toolbar and confirm **ROE** is listed and enabled.
2. Open the game at `https://embervault.ruyui.com/`.
3. The ROE toolbar/panels should appear on the page. On first load, the script silently fetches `maps.json` from this repo and seeds the minimap — the page will reload once automatically to apply it. This only happens once.

## Updating

- If the script has `@downloadURL` / `@updateURL` configured, Tampermonkey will check for updates automatically (Tampermonkey Dashboard → the script's **Check for userscript updates** option, or **Utilities → Check for userscript updates** if available in your version).
- Otherwise, repeat step 2 above (Method A or B) with the latest code/file whenever a new version is released — installing over an existing script with the same `@name`/`@namespace` will update it in place.

## Notes

- The minimap seed data only fills in trail/entry data for zones you haven't explored yet — it never overwrites your own recorded trail.
- If the auto-seed doesn't apply (e.g. no internet on first load), it will simply retry on your next page reload.
- Uninstall anytime from the Tampermonkey Dashboard by removing the ROE script.
