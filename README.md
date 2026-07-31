# ROE Userscript — Installation Guide

ROE is a Tampermonkey userscript that adds spawn tracking, an inventory/quickbar sync, a minimap overlay, and other tools on top of the Embervault (Rise of Empires) browser game. This build auto-loads a pre-explored minimap (maze, mines, mines lower, forest) from this repo the first time it runs.

## Quick install (one click)

If you already have Tampermonkey installed, just click the link below — Tampermonkey will detect the `.user.js` file and open its install prompt automatically:

**[➡️ Install ROE](https://raw.githubusercontent.com/MrSnorch/RoE-Tracker/main/ROE-7.44.0_user.js)**

If you don't have Tampermonkey yet, follow the steps below first.

## Requirements

- A desktop browser: Chrome, Firefox, Edge, or Brave
- The [Tampermonkey](https://www.tampermonkey.net/) browser extension installed

## 1. Install Tampermonkey

1. Go to the [Tampermonkey downloads page](https://www.tampermonkey.net/) and install the extension for your browser.
2. Pin the Tampermonkey icon to your toolbar (optional, but convenient).

## 2. Install the script

**Easiest way:** just use the one-click link at the top of this page.

**Manual way** (if the link above doesn't trigger the install prompt for some reason):

1. In this repository, open `ROE-7.44.0_user.js`.
2. Click the **Raw** button on GitHub to open the raw file.
3. Tampermonkey should automatically detect the `.user.js` file and open its installation prompt.
   - If it doesn't open automatically, copy the raw URL and paste it into a new browser tab.
4. Click **Install** (or **Reinstall** if you're updating an existing copy) in the Tampermonkey prompt.

## 3. Confirm it's active

1. Click the Tampermonkey icon in your toolbar and confirm **ROE** is listed and enabled.
2. Open the game at `https://embervault.ruyui.com/`.
3. The ROE toolbar/panels should appear on the page. On first load, the script silently fetches `maps.json` from this repo and seeds the minimap — the page will reload once automatically to apply it. This only happens once.

## Updating

- If the script has `@downloadURL` / `@updateURL` configured, Tampermonkey will check for updates automatically (Tampermonkey Dashboard → Utilities → **Check for userscript updates**).
- Otherwise, repeat step 2 above with the latest raw file whenever a new version is released.

## Notes

- The minimap seed data only fills in trail/entry data for zones you haven't explored yet — it never overwrites your own recorded trail.
- If the auto-seed doesn't apply (e.g. no internet on first load), it will simply retry on your next page reload.
- Uninstall anytime from the Tampermonkey Dashboard by removing the ROE script.
