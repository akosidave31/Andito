# Andito — Termux → GitHub → APK

Everything that needs Android SDK / Gradle runs on GitHub's servers, not
your phone. Termux only needs Node, npm, and git — which you already have.

## 0. Unzip into place

```bash
cd ~/
unzip ~/storage/downloads/andito-app.zip -d andito-app
cd andito-app
```

## 1. Create the repo on GitHub (if you haven't already)

Go to github.com → New repository → name it (e.g. `andito`) → **do not**
initialize with a README (you already have files) → Create.

## 2. Push what's here

```bash
git init
git add .
git commit -m "Initial commit: Andito web app"
git branch -M main
git remote add origin https://github.com/<your-username>/<repo-name>.git
git push -u origin main
```

This alone gets the code on GitHub, but the Actions workflow will fail at
this point — it expects an `android/` folder that doesn't exist yet. That's
step 3.

## 3. Add the Android platform (one-time, local)

```bash
npm install
npx cap init "Andito" "com.dapu.andito" --web-dir=dist
npx cap add android
```

`cap init` may ask to overwrite `capacitor.config.json` — say yes, it'll
just regenerate the same values already in this project. This creates a real
`android/` folder full of Gradle project files. You are **not** compiling
anything here — just generating files. No Android SDK required for this step.

Commit and push that folder:

```bash
git add android
git commit -m "Add Android platform"
git push
```

## 4. Let GitHub build the APK

Push triggers the workflow automatically. To watch it or trigger it by hand:

1. Open your repo on github.com → **Actions** tab.
2. Click "Build APK" → if it didn't start automatically, click **Run workflow**.
3. Wait for the green check (first run takes a few minutes — downloading the
   Android SDK on GitHub's runner takes most of that time).
4. Click into the finished run → under **Artifacts**, download
   `andito-debug-apk`. It's a zip containing `app-debug.apk`.

## 5. Install on your phone

Unzip the artifact, move `app-debug.apk` somewhere accessible, and open it.
Android will ask to allow installs from this source the first time — allow
it, then install.

This is a **debug-signed** APK — fine for your own testing and for handing
to a few pilot stores, but Android will flag it as unverified since it isn't
signed with a real release key. When you're ready to distribute more
broadly, that's a signing-key step to add later, not something to worry
about yet.

## Every change after this

Once steps 1–3 are done, going forward is just:

```bash
git add .
git commit -m "whatever you changed"
git push
```

Push → GitHub Actions rebuilds → new APK waiting in Artifacts. No Gradle,
no Android Studio, ever touches your phone.

## Known limitation: the "live demand signal" won't be live

`window.storage` (Claude.ai's built-in key-value store) doesn't exist
outside claude.ai, so `src/storagePolyfill.js` recreates it using
`localStorage` instead. Everything that's *personal* data (your store,
inventory, sales, settings) works exactly the same.

The one feature this changes: the shared "customers search for something
you don't stock" signal was designed to be visible across every device using
the app. With `localStorage`, it's only visible on the one device it was
written on — a customer searching on their phone won't reach a seller's
dashboard on a different phone. Fixing that for real needs an actual
backend (Firebase/Firestore fits the existing data shapes well) — a bigger
step than this setup, and worth doing once you're validating this with real
stores rather than before.
