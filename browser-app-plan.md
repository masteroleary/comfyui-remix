# ComfyRemix Browser — a native shell for the front end

> **Plan, not yet built.** A sibling project to this one: `comfyui-remix-browser`,
> checked out alongside this repo. Downloaded from our own site, not from the app
> stores.
>
> Install specifics — the tailnet host, the server and client certificate files,
> their expiries, the `.p12` password location — stay in the gitignored
> `CLAUDE.local.md`, as they do for everything else here. This file names them
> and does not repeat them.

## Why there is an app at all

The privacy settings in Settings → Privacy are requests made of someone else's
browser, and the gap they cannot close is named in CLAUDE.md: logout sends
`Clear-Site-Data`, and **Safari does not implement it**, so on iOS the cache
outlives the logout.

That gap is narrower than it first looks. On the default `mediaCachePolicy`
(`nostore`) Safari honours `no-store` like everyone else, writes nothing, and
there is nothing left for `Clear-Site-Data` to fail to purge. So the cache story
is *already* closed, at the cost of re-downloading every thumbnail on every view.

What a shell buys is the set of leaks no response header can reach — all of them
outside the page, inside Safari itself.

| Data | In Safari today | In the shell |
|---|---|---|
| Tab-switcher snapshot | Safari's own store, and it goes into the device backup | None — the view is blanked before the OS photographs it |
| Browsing history | Safari history, synced to every signed-in device via iCloud | None — one URL, no history store |
| Client cert + private key | System profile store, device-wide, needs the trust toggle | App keychain, `ThisDeviceOnly`, non-syncable |
| Media bytes | Disk cache — unless `nostore`, which costs all the speed | App sandbox, purged on background, never in a backup |
| Session cookie | Shared Safari jar, lives until expiry | App store, wiped on lock and on logout |
| Job history (IndexedDB) | Safari's store, inside the device backup | App sandbox, kept, excluded from backup |
| Any of the above, in a backup | Yes, and not excludable | Never, on either platform |

**Threat model.** In scope: someone holding the unlocked phone; someone holding a
device backup or a forensic extraction of one; a shoulder or a screenshot; and
cross-device bleed through iCloud sync. Out of scope, stated so it is not quietly
assumed: a jailbroken or rooted device, and anyone who already has the server.

## Phase 0 — the spike, before any UI exists

**Half a day, and a go/no-go.** WKWebView runs its networking in a separate
process. `didReceive challenge` is well documented for main-frame navigations and
much less certain for subresource loads and — the one that matters here — the
WebSocket upgrade. `RemixDialog.js` opens `wss://` + `location.host` +
`/comfy-ws` for job progress, so that handshake has to present the client
certificate or the run list goes dead while every page around it works fine.
That failure is silent and would be blamed on the server.

Prove four legs in a throwaway Xcode project, against the real mTLS listener:

- the main document;
- `fetch` to `/api/*` — a subresource challenge, a different code path;
- Range requests on `/file/*`, by scrubbing a video;
- the `wss://` upgrade, by starting a run and watching the progress hairline move.

If a leg fails, in order of preference:

1. **A loopback mTLS relay.** A tiny in-process listener on `127.0.0.1` speaking
   plain HTTP to the WebView and mTLS upstream. It is a byte relay, so Range and
   WebSocket semantics survive untouched, and the cleartext hop never leaves the
   device.
2. **`WKURLSchemeHandler` over `URLSession`.** Total control, but Range streaming
   and cookie handling are re-implemented by hand, and it does not cover
   WebSocket at all. Only if the relay is somehow blocked.

## Phase 1 — the iOS shell

**2–3 days.** One `WKWebView`, one URL, no chrome.

- `allowsBackForwardNavigationGestures = true`. The front end is a router app and
  `/jobs` → `/view/…` → back is a real trip (it is why the run list is a route
  and not a dialog); edge-swipe should complete it, and `scrollBehavior` hands
  the position back as it does in any browser.
- `allowsInlineMediaPlayback = true` with
  `mediaTypesRequiringUserActionForPlayback = []`. It is a media library.
- `decidePolicyFor` permits the configured host and cancels everything else. A
  link out of a private library is not a feature, and it must not be able to turn
  the shell into a general browser with none of the guarantees below.
- `uiDelegate` returns `nil` from `createWebViewWith`, so `target="_blank"`
  cannot spawn a view outside that policy.
- No `WKDownloadDelegate` at all — no download path to audit.
- A `customUserAgent` suffix, `ComfyRemixBrowser/<version>`. See *The one optional
  server change* below.

**The entitlement list is empty, and that is checkable.** There is no
`<input type="file">` anywhere in `app/`: the only `FormData` is built from a blob
already fetched off the server (`RemixDialog.js`), and the 🖼 Browse picker
browses the *server's* library through `MediaBrowser.js`, not the phone's. So the
app declares no photo library, no camera, and no documents access beyond the
one-shot certificate import. **Re-check this if a file input ever lands in the
front end** — it is exactly the kind of change that silently adds a permission
prompt to a build nobody thought was asking for one.

## Phase 2 — identity, both directions

**1 day, and the real reason to build this.** Today a phone needs
`ComfyRemix-iPhone.mobileconfig` installed *and* the Certificate Trust Settings
toggle flipped, because iOS never grants full trust to a manually installed root.
The combined profile exists only because iOS holds one pending downloaded profile
at a time and shipping the root and the `.p12` separately yields neither.

The app deletes that whole dance.

**Trusting the server.** Embed the server certificate as a trust anchor via
`SecTrustSetAnchorCertificates` and check the hostname. No root installed on the
device, no trust toggle, and the trust is scoped to this one app rather than the
whole system — strictly better than what the profile achieves.

> **Worth changing while we are here.** Pinning the server leaf means an app
> rebuild whenever that certificate rotates. Issue the server certificate from
> the existing client CA — which outlives it by years — and pin *that* instead,
> and server rotation stops being an app release. Expiries and file names are in
> `CLAUDE.local.md`; note the 825-day ceiling Apple clients impose on server
> certs, which is why the current one is dated as it is.

**Presenting the client.** Enrollment becomes: Taildrop the `.p12` as we already
do, share it into the app, type the password once. `SecPKCS12Import` yields a
`SecIdentity`, stored with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly` and
`kSecAttrSynchronizable = false` — protected by a key that never leaves the
Secure Enclave, so it cannot be restored onto another device even out of an
encrypted local backup, and never enters iCloud Keychain.

There is still **no revocation** — that is a property of the client CA, not of
the app — so cutting off a lost device still means reissuing the CA and
redistributing. The app does not change that; it does mean a lost device's
identity cannot be lifted out of a backup.

## Phase 3 — storage: caged, not absent

The obvious move is `WKWebsiteDataStore.nonPersistent()`, and **it is wrong
here.** Two things in the front end depend on durable storage: the job list in
IndexedDB as `comfyJobs`, and the WebSocket client id in `localStorage` as
`comfyRemixClientId`, both owned by `RemixDialog.js`.

### A — fully ephemeral. Not this.

The strongest possible guarantee: nothing touches disk, nothing to exclude from a
backup. But the job list resets on every cold launch, and the client id
regenerates with it — so a run queued before a relaunch keeps rendering happily
while the app, now subscribed under a new id, shows nothing. The reconciler can
recover the *rows* from ComfyUI's history; it cannot recover progress for a
prompt submitted under an id this client no longer has.

### B — persistent, sandboxed, purged. Recommended.

The default data store, inside the app sandbox, with three rules on top:

- **Mark the WebKit container `isExcludedFromBackup`**, so nothing in it reaches
  iCloud or a desktop backup. It is an extended attribute on the inode, so set it
  on the containing directory rather than per file, or a recreated file loses it.
- **On background, `removeData(ofTypes:)` scoped to the cache types** — disk,
  fetch and memory — so media bytes go while IndexedDB and `localStorage` stay.
- **On logout or biometric timeout, wipe every type.**

Jobs survive, the client id is stable, and no media outlives the session.

**And this is what finally makes the fast cache modes safe.** Media held inside a
backup-excluded sandbox that empties every time the app backgrounds is a better
position than `nostore` over Safari — so `mediaCachePolicy` can go to `day` on
the phone and the library gets quick, with nothing surviving the session. The
privacy setting stops being one global compromise.

## Phase 4 — hardening

**1 day.** The things no header reaches.

| Concern | iOS | Android |
|---|---|---|
| App-switcher snapshot | Opaque overlay on `sceneWillResignActive`, removed on `sceneDidBecomeActive` | `FLAG_SECURE` |
| Screenshots | Not preventable | Blocked outright by `FLAG_SECURE` |
| Cloud backup | `isExcludedFromBackup`; keychain `ThisDeviceOnly` | `allowBackup="false"` |
| Device-to-device transfer | Covered by the same exclusion | Needs `dataExtractionRules` as well — see below |
| App lock | `LAContext`, passcode fallback | `BiometricPrompt` |
| Idle wipe | Tear down the WebView and its store past the timeout | `WebStorage`, `CookieManager`, `clearCache(true)` |

> **The Android 12 trap.** `android:allowBackup="false"` stops backup to Google
> Drive but **does not stop device-to-device transfer** on API 31+. It also needs
> `android:dataExtractionRules` pointing at an XML that excludes
> `domain="root" path="."` under *both* `<cloud-backup>` and `<device-transfer>`.
> Setting only `allowBackup` and calling it done is the usual mistake.

## Phase 5 — Android

**1–2 days, the easier half.**

- Server trust goes in `network_security_config.xml` as a `<trust-anchors>`
  entry — declarative, applies to the WebView, and avoids the
  `onReceivedSslError { proceed() }` antipattern, which accepts *any* bad
  certificate rather than the one we meant.
- Client identity through `WebViewClient.onReceivedClientCertRequest`, calling
  `request.proceed(key, chain)` with a key imported into **AndroidKeyStore** —
  non-exportable, so it cannot appear in a backup or a transfer regardless of
  what the manifest says.
- Android has no in-memory WebView profile, so storage is clear-on-teardown
  rather than never-persist: the same shape as option B, arrived at from the
  other direction.

## Phase 6 — distribution

**1 day, and where the constraint bites.**

### Android works exactly as we want

Sign a release APK, host it on the site, allow installs from that browser once.
Play Protect shows a warning on first install — unavoidable, not fixable. Keep
the signing keystore offline and backed up; losing it means every user must
uninstall to upgrade.

### iOS cannot be self-hosted freely

Read this the right way round: **the EU is the only jurisdiction where Apple
permits self-hosting at all**, under the DMA, and even there the bar is aimed at
large publishers. Everywhere else the App Store is the only public route and the
rows below are developer and testing channels rather than distribution channels.

| Route | Cost | Reach | Catch |
|---|---|---|---|
| **Ad-hoc, self-hosted** | $99/yr | 100 devices/yr | Each device's UDID baked into the profile; profile expires annually |
| TestFlight public link | $99/yr | 10,000 | Builds expire every 90 days; external testing needs Beta App Review |
| Enterprise | $299/yr | Unlimited | Needs a company with a D-U-N-S; distributing to non-employees breaches the agreement and gets certificates revoked |
| EU Web Distribution | — | EU only | The only true self-hosting route. Developer incorporated in the EU as an organization, two years' standing, plus a million-install history or a €1M letter of credit — and the user has to be in the EU too |

**The App Store is not the fallback, and not the plan.** Guideline 4.2 (Minimum
Functionality) exists to reject apps that are a web view pointed at a single URL,
which is precisely what this is. Beyond that, review has to *run* it, against a
server behind mutual TLS on a tailnet that no reviewer can reach — so getting
through would mean standing up a public demo instance with a demo certificate.
Real work, a new exposure, and a public listing that announces the service
exists.

### What ad-hoc actually looks like

It *is* download-from-our-site, and less exotic than the name suggests:

1. Enroll in the Apple Developer Program, $99/yr.
2. Add each device's UDID in the portal — once per device, from the same list we
   already keep for issuing client certs.
3. Build with the ad-hoc profile and export `ComfyRemixBrowser.ipa`.
4. Host it beside a `manifest.plist` and an install page, linked with
   `itms-services://?action=download-manifest&url=…`.
5. On the phone: open that page in Safari, tap the link, done. No Xcode, no
   cable, no TestFlight.

Once a year the provisioning profile expires; rebuild, re-host, reinstall from
the same page. That is the whole tax.

> **One detail that will waste an afternoon.** The manifest must be served over a
> **publicly trusted** HTTPS certificate. Host it on the public site, not on the
> tailnet — that certificate is self-signed, and iOS refuses the install with no
> useful error.

The UDID step is less friction than it first looks: we already issue a per-device
`.p12`, so registering a device is one more line in a ritual that exists — and
the app makes that ritual one step *shorter* by killing the `.mobileconfig`.

### Updates, with no store to push them

Serve a `latest.json` on the public site with a version and a URL; check it at
launch and show a quiet banner when it is ahead. Twenty minutes of work, and
without it a shipped bug lives on every device forever.

## Framework: two native apps, not React Native

To give React Native its due: `react-native-webview`'s `incognito` prop genuinely
does map to `nonPersistent()` on iOS. That is a real advantage — except option B
deliberately does not want an ephemeral store, which removes it.

**What decides it is the client certificate.** `react-native-webview` exposes no
hook for `didReceive challenge` on iOS or `onReceivedClientCertRequest` on
Android, so mTLS means patching the library or writing a native module *on both
platforms* — the single hardest piece stays native either way. Set against a UI
that is one full-screen WebView with no navigation, RN adds a JS runtime, Metro
and a patched dependency to save nothing.

**Swift with UIKit, not SwiftUI; Kotlin with plain Views, not Compose.** There is
no native SwiftUI web view, so `WKWebView` arrives through `UIViewRepresentable`
regardless, and every privacy-critical hook here is a delegate callback or a
lifecycle moment — `decidePolicyFor`, `didReceive challenge`,
`createWebViewWith`, and the `sceneWillResignActive` window that must add the
blanking overlay before the OS takes its snapshot. At this size the abstraction
costs more than it returns. The same argument holds verbatim on Android:
`WebView` in Compose is `AndroidView { }`, and `FLAG_SECURE` is a window flag.

Concretely: one `UIViewController`, one scene delegate and a few helpers on iOS;
one `Activity` on Android. Roughly 200–300 lines each.

**Zero dependencies is the target, not an aspiration** — which matches how the
rest of this is built: a server with no npm dependencies and an SPA with no build
step. On iOS nothing here needs a package: `SecPKCS12Import`,
`SecTrustSetAnchorCertificates` and `LAContext` are all system frameworks. On
Android, `minSdk 31` gets the framework `BiometricPrompt` without
`androidx.biometric`, and it also makes `dataExtractionRules` the only backup
config to write — below 31 we would carry `fullBackupContent` alongside it.

**No single-codebase option is the runner-up, Kotlin Multiplatform included.**
Strip out the certificate handling, the data-store lifecycle, the snapshot
blanking and the backup exclusion, and what remains in common is a URL and a
version check. The entire app *is* the platform-specific privacy plumbing, so a
cross-platform layer would abstract the fifty lines that do not matter and hand
back the four hundred that do.

## Repo shape

```
comfyui-remix-browser/
  ios/                Xcode project, Swift — shell, identity, hardening
  android/            Gradle project, Kotlin — the same shape
  docs/               enrollment guide, device register, cert rotation runbook
  site/               manifest.plist template, latest.json, install page
  CLAUDE.md           architecture notes, in this house style
  CLAUDE.local.md     gitignored — UDIDs, team id, keystore location
```

Signing material never enters the repo: the Android keystore, the iOS
provisioning profiles and every client `.p12` stay out, on the same terms as
`certs/` here. Run the pre-push history pass before the first push, not after it.

## The one optional server change

Set the `customUserAgent` suffix on the WebView and `mediaCacheHeader()` can pick
the policy per client: the fast mode for the shell, which cages and purges it,
and `nostore` for any ordinary browser, which cannot. A handful of lines in
`server.js`, and `mediaCachePolicy` stops being one setting that has to be safe
for the worst client that will ever connect.

Nothing else on the server needs to change. The shell is a client.

## Effort

| Phase | Days |
|---|---|
| 0 — Spike | 0.5, and stop here if it fails |
| 1 — iOS shell | 2–3 |
| 2 — Identity | 1 |
| 3–4 — Storage & hardening | 1.5 |
| 5 — Android | 1–2 |
| 6 — Distribution | 1 |
| Docs | 0.5 |

---

Verified against the front end on 2026-10-01: no file inputs anywhere in `app/`,
`wss://` on the same origin via `location.host`, jobs in IndexedDB as
`comfyJobs`, client id in `localStorage` as `comfyRemixClientId`, and no service
worker — so the WebView is the only cache layer to reason about.
