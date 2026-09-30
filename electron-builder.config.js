'use strict';
// ── electron-builder ──────────────────────────────────────────────────────
// A .js config rather than .yml because three things here depend on the
// environment the build runs in, and YAML cannot ask.
//
// Packages dist/stage and nothing else. That folder is built by desktop/build.js
// from an allowlist and holds minified, obfuscated copies, so the repository's own
// files — readable source, and on a machine that runs the server, config.json,
// certs/ and the app-*.json stores — have no route into the installer. With
// `files` naming only a mapping out of dist/stage, electron-builder does not add
// its default "**/*" of the project root; it still adds the production
// node_modules (electron-updater and its dependencies) on its own. The afterPack
// hook then opens the app.asar it actually produced and fails the build if either
// of those claims stopped being true.

// Where installed copies look for updates. A GitHub release on this repository by
// default, which works because the repository is public: a private one would make
// electron-updater carry a token that can read the source, which defeats the point.
// Point these at a separate public, releases-only repository to keep the source
// private and the updates flowing.
const OWNER = process.env.COMFYREMIX_RELEASE_OWNER || 'masteroleary';
const REPO = process.env.COMFYREMIX_RELEASE_REPO || 'comfyui-remix';
// Build-time only, and never set in CI: bakes a plain HTTP feed into the build
// instead of GitHub, so the whole update path — check, download, checksum,
// notification, install prompt — can be exercised against a local folder
// without publishing anything. A build made with it updates from nowhere else.
const TEST_FEED = process.env.COMFYREMIX_UPDATE_URL || '';

// macOS: with no Developer ID certificate electron-builder skips signing entirely,
// and an unsigned arm64 binary will not launch at all once the fuses below have
// changed it. An ad-hoc signature ('-') is the least that runs. It does not satisfy
// Gatekeeper (first launch needs right-click → Open) and Squirrel.Mac will not
// install updates over it — mac auto-update needs the real certificate (CSC_LINK),
// which switches this to the normal signing path. Notarization turns itself on
// when the APPLE_* variables are present.
const MAC_SIGNED = !!process.env.CSC_LINK || !!process.env.CSC_NAME;

module.exports = {
  appId: 'com.masteroleary.comfyremix',
  productName: 'ComfyRemix',
  copyright: 'ComfyRemix contributors — CC BY-NC 4.0',

  directories: {
    output: 'dist/release',
    // Its own folder, not desktop/: electron-builder leaves buildResources out of
    // the app, and desktop/ is where the staged main process lives.
    buildResources: 'desktop/resources',
  },

  files: [{ from: 'dist/stage', to: '.', filter: ['**/*'] }],
  extraMetadata: { main: 'desktop/main.js' },
  asar: true,

  // ── Electron fuses ──────────────────────────────────────────────────────
  // Compiled-in switches, flipped once in the binary, that close the ways an
  // installed Electron app is usually talked into running something else:
  //   runAsNode off            ELECTRON_RUN_AS_NODE turns the exe into a plain Node
  //                            that will run any script, the app's included.
  //   NODE_OPTIONS / --inspect off   no preloading code or attaching a debugger to
  //                            the main process through the environment or the
  //                            command line. (Chromium's --remote-debugging-port is
  //                            not a fuse; desktop/main.js refuses to start with it.)
  //   onlyLoadAppFromAsar      ignores a loose app/ folder dropped beside the archive.
  //   asar integrity           the exe carries a hash of app.asar and refuses to run
  //                            an archive that was edited after the build.
  //   cookie encryption        cookies at rest go through the OS keystore.
  //   file protocol privileges off   file:// gets no more power than a web page; the
  //                            app never loads from file:// anyway.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    loadBrowserProcessSpecificV8Snapshot: false,
    grantFileProtocolExtraPrivileges: false,
  },

  // Read-only: on Windows the asar integrity hash is embedded in the exe before this
  // hook runs, so a check that touched app.asar would brick the build it approved.
  afterPack: './desktop/verify-package.js',

  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
  },
  // Per-user and one-click: no admin rights to install, and so none to update —
  // electron-updater can then install a new version silently on quit.
  nsis: {
    // No spaces: GitHub rewrites them in asset names, and an installer whose uploaded
    // name differs from the one latest.yml points at is an update nobody can download.
    artifactName: '${productName}-Setup-${version}.${ext}',
    oneClick: true,
    perMachine: false,
    deleteAppDataOnUninstall: false,
  },

  mac: {
    // zip is not optional: it is what Squirrel.Mac updates from; dmg is only the
    // first install.
    target: [
      { target: 'dmg', arch: ['x64', 'arm64'] },
      { target: 'zip', arch: ['x64', 'arm64'] },
    ],
    // Arch always in the name: two dmgs that differ only by an arch the name leaves
    // out for one of them is how someone installs the Intel build on Apple Silicon.
    artifactName: '${productName}-${version}-${arch}.${ext}',
    category: 'public.app-category.photography',
    hardenedRuntime: true,
    ...(MAC_SIGNED ? {} : { identity: '-' }),
  },

  // AppImage is the Linux format electron-updater can replace in place.
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }],
    artifactName: '${productName}-${version}.${ext}',
    category: 'Graphics',
  },

  // releaseType 'draft': CI creates the draft, all three platforms upload into it,
  // and a final job publishes it once every one succeeded. electron-updater never
  // sees a draft, so no client is offered a release that is still missing its
  // platform's files. (.github/workflows/desktop-release.yml)
  publish: TEST_FEED
    ? [{ provider: 'generic', url: TEST_FEED }]
    : [{ provider: 'github', owner: OWNER, repo: REPO, releaseType: 'draft' }],
};
