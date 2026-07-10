Confirmed. The website matches `%-Beta%`, `%-Alpha%`, `%-RC%` (capitalized, case-sensitive in SQLite's default `LIKE` for ASCII — actually SQLite `LIKE` is case-insensitive for ASCII by default, but I'll normalize to be safe and explicit). I have enough to write a complete, grounded design.

---

# Versioning Strategy + Tag-Driven CD for HearthShelf-Mobile

Everything below is grounded in the actual files: `app.config.js` (version `'0.0.1'`, `versionCode` from `EXPO_ANDROID_VERSION_CODE`, `iosBuildNumber` from `EXPO_IOS_BUILD_NUMBER`, `runtimeVersion.policy = 'appVersion'`), `build-android-release.yml` (manual-dispatch signed `.aab`, stamps `EXPO_ANDROID_VERSION_CODE=github.run_number`), and the website's `buildChangelogWhere` (`LIKE '%-Beta%'`/`'%-Alpha%'`/`'%-RC%'`).

## 1. Can the git tag be the single source of version truth? Yes.

`app.config.js` is already a dynamic config that reads `process.env` and derives `versionCode`/`iosBuildNumber` from env. The version string is the only remaining hardcoded value. Because the release workflow runs `expo prebuild` (which evaluates `app.config.js` fresh on the runner), whatever env the workflow sets is what gets baked into `AndroidManifest.xml`, `Info.plist`, and the OTA `runtimeVersion`. So the dev does **not** hand-edit `app.config.js` per release.

**Mechanism:** GitHub provides `GITHUB_REF_NAME` (for a `refs/tags/v0.1.0` push, that's `v0.1.0`). The workflow strips the leading `v` and exports it as a new env var `EXPO_PUBLIC_APP_VERSION`; `app.config.js` reads it with a fallback to `'0.0.1'`.

**Why changing `version` per real-release tag is correct for `runtimeVersion.policy: 'appVersion'`:** the OTA runtime version is derived from `version`. Two builds share OTA compatibility iff their `version` strings match. A real release almost always contains native changes (that's why you cut a store build rather than an OTA), so its `version` MUST differ from the previous release's — otherwise an OTA bundle could land on an incompatible binary. Tag-derived version guarantees this: every release tag is a distinct semver, so every store build gets a distinct `runtimeVersion`. This is exactly the invariant the config's own comment (lines 59-62) demands. It also means **plain OTA-only JS pushes must NOT get a new tag** — they ship under the current release's `version`/`runtimeVersion` via `eas update`, unchanged. Tags are reserved for native/store releases.

## 2. `versionCode` decision — recommendation: **keep `run_number`** (monotonic, decoupled from semver).

The two options:

| Option | Pro | Con |
|---|---|---|
| **`run_number`** (current) | Guaranteed strictly-increasing (Play's hard requirement); zero encoding logic; already wired end-to-end in both build workflows | Not human-readable from the number; two builds of the same tag get different codes (fine — Play wants each upload distinct anyway) |
| **semver-derived** (`MAJOR*1000000+MINOR*10000+PATCH*100+build`) | Readable; embeds the version | Fragile: a re-run of the same tag collides unless you add a build component; pre-release ordering (`-beta.1`) has no clean numeric slot; must never let two tags produce the same code; you now own an encoding scheme forever |

**Recommendation: keep `run_number`.** Play Store only cares that `versionCode` strictly increases across uploads; it does not need to correlate with the user-facing version. `github.run_number` is monotonic across the whole repo's Actions history and is already what both `build-android.yml` and `build-android-release.yml` stamp — a semver-derived scheme would be a regression toward fragility for no store-side benefit. The user-facing `version` (`0.1.0`) is the human-readable identity; `versionCode` is just the opaque monotonic counter. Keep them decoupled.

**iOS `buildNumber`:** same logic — keep it fed by `EXPO_IOS_BUILD_NUMBER` (stamped with `run_number` in the iOS workflows). App Store Connect requires the build number to increase within a given `CFBundleShortVersionString`; `run_number` satisfies that too.

## 3. Exact `app.config.js` diff (version + versionCode + iosBuildNumber)

Only the version string changes behavior; `versionCode`/`iosBuildNumber` already read env, so I add clarifying comments and keep their logic. Replace the two comment-block/const sections and the `version:` line.

**a. Add the version resolver next to the existing `versionCode`/`iosBuildNumber` block (lines 39-48):**

```js
// The release tag is the single source of version truth. The tag-driven CD
// workflow exports EXPO_PUBLIC_APP_VERSION from GITHUB_REF_NAME (leading "v"
// stripped, e.g. v0.1.0 -> 0.1.0). runtimeVersion.policy is `appVersion`, so
// this value keys OTA compatibility: it MUST change on every native/store
// release, which a distinct release tag guarantees. Locally / off-tag it falls
// back to the static value below so `expo start` and debug builds keep working.
const appVersion = process.env.EXPO_PUBLIC_APP_VERSION || '0.0.1'

// CI stamps the run number as the Android versionCode (EXPO_ANDROID_VERSION_CODE)
// so every build is distinguishable on-device and strictly monotonic (Play's
// hard requirement). It is deliberately decoupled from the semver `version` -
// Play only needs versionCode to increase, not to encode the version. Locally /
// when unset, fall back to the static value below.
const versionCode = process.env.EXPO_ANDROID_VERSION_CODE
  ? Number(process.env.EXPO_ANDROID_VERSION_CODE)
  : 1

// iOS build numbers are strings in Expo/Apple tooling. CI stamps this with its
// run number (monotonic within a CFBundleShortVersionString); local builds fall
// back to the static value.
const iosBuildNumber = process.env.EXPO_IOS_BUILD_NUMBER || '1'
```

**b. Change the hardcoded `version` (line 54):**

```js
  version: appVersion,
```

That's the whole config change. `ios.buildNumber: iosBuildNumber` (line 70) and `android.versionCode` (line 85) already reference the constants — no edit needed there.

**Verification hook:** the existing CI step `npx expo config --type public > /dev/null` (ci.yml:30) already proves the config resolves. Add a release-time assertion so a mistagged build fails fast (see §4).

## 4. Trigger: **add a `push: tags` trigger to `build-android-release.yml`** (do not create a new workflow).

Rationale: that workflow already owns the signed-`.aab` path, the keystore-decode step, the prebuild-with-signing, and the Gradle memory tuning. Duplicating all of that in a new file would fork the release logic and drift. Keep one release workflow; add the tag trigger alongside the existing `workflow_dispatch` (so you keep the manual escape hatch). Guard the "publish + changelog" steps to only run on the tag event, so a manual dispatch still just produces an artifact.

The one addition the tag path needs over dispatch: it must set `EXPO_PUBLIC_APP_VERSION` from the tag during prebuild, and gate the version normalization + changelog upload on `github.ref_type == 'tag'`.

**Trigger + env-stamping YAML** (the shape of the amended `build-android-release.yml`; unchanged steps abbreviated):

```yaml
name: Build Android Release

on:
  push:
    tags: ['v*']          # tag-driven CD: cutting v0.1.0 releases
  workflow_dispatch:       # kept: manual artifact builds, no publish/changelog
    inputs:
      artifact_kind:
        description: 'Bundle for Play (.aab) or a signed APK for sideload testing'
        type: choice
        default: aab
        options: [aab, apk]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
        with:
          submodules: recursive
          fetch-depth: 0          # NEW: changelog needs full history + tags

      # ... setup-node / setup-java 21 / setup-android / npm ci (unchanged) ...

      # NEW: normalize the tag into the version string used everywhere.
      # Runs only on a tag push; dispatch builds skip it and use the 0.0.1 default.
      - name: Resolve release version from tag
        if: github.ref_type == 'tag'
        id: version
        run: |
          RAW="${GITHUB_REF_NAME#v}"                 # v0.1.0-beta.1 -> 0.1.0-beta.1
          # Normalize pre-release label to the website's channel tokens:
          #   -beta.N / -b.N   -> -BetaN     (matches LIKE '%-Beta%')
          #   -alpha.N / -a.N  -> -AlphaN    (matches LIKE '%-Alpha%')
          #   -rc.N            -> -RCN       (matches LIKE '%-RC%')
          VER=$(printf '%s' "$RAW" \
            | sed -E 's/-(beta|b)\.?([0-9]+)/-Beta\2/I' \
            | sed -E 's/-(alpha|a)\.?([0-9]+)/-Alpha\2/I' \
            | sed -E 's/-rc\.?([0-9]+)/-RC\1/I')
          echo "raw=$RAW"   >> "$GITHUB_OUTPUT"
          echo "version=$VER" >> "$GITHUB_OUTPUT"
          echo "Tag $GITHUB_REF_NAME -> app version $VER"

      - name: Decode upload keystore
        # ... unchanged ...

      - name: Prebuild (runs config plugins, incl. release signing)
        env:
          HEARTHSHELF_RELEASE_SIGNING: '1'
          HEARTHSHELF_RELEASE_KEYSTORE_PATH: ${{ runner.temp }}/upload.jks
          HEARTHSHELF_RELEASE_KEYSTORE_PASSWORD: ${{ secrets.ANDROID_KEYSTORE_PASSWORD }}
          HEARTHSHELF_RELEASE_KEY_ALIAS: ${{ secrets.ANDROID_KEY_ALIAS }}
          HEARTHSHELF_RELEASE_KEY_PASSWORD: ${{ secrets.ANDROID_KEY_PASSWORD }}
          EXPO_ANDROID_VERSION_CODE: ${{ github.run_number }}
          # NEW: on a tag build this is the normalized semver; on dispatch it is
          # empty, so app.config.js falls back to '0.0.1'.
          EXPO_PUBLIC_APP_VERSION: ${{ steps.version.outputs.version }}
        run: npx expo prebuild --platform android --no-install

      # NEW: fail fast if the baked version doesn't match the tag (catches a
      # broken resolver before we ship an mis-versioned OTA runtime).
      - name: Assert baked version matches tag
        if: github.ref_type == 'tag'
        env:
          EXPO_PUBLIC_APP_VERSION: ${{ steps.version.outputs.version }}
        run: |
          BAKED=$(npx expo config --type public --json | node -e 'process.stdin.on("data",d=>{try{console.log(JSON.parse(d).version)}catch(e){}})')
          test "$BAKED" = "${{ steps.version.outputs.version }}" \
            || { echo "::error::baked version $BAKED != tag ${{ steps.version.outputs.version }}"; exit 1; }

      - name: Build signed artifact
        # ... unchanged; on a tag push inputs.artifact_kind is empty, so default to aab ...
        run: |
          KIND="${{ inputs.artifact_kind }}"; KIND="${KIND:-aab}"
          if [ "$KIND" = "apk" ]; then ./gradlew :app:assembleRelease --stacktrace
          else ./gradlew :app:bundleRelease --stacktrace; fi
        working-directory: android
        # (env block unchanged)

      - name: Upload .aab
        if: github.ref_type == 'tag' || inputs.artifact_kind == 'aab'
        uses: actions/upload-artifact@v4
        # ... unchanged ...

      # ---- tag-only publish + changelog steps (all gated on ref_type == tag) ----

      # LATER (user adds): publish to the Play internal track.
      - name: Publish to Play (internal)
        if: github.ref_type == 'tag'
        uses: r0adkll/upload-google-play@v1
        with:
          serviceAccountJsonPlainText: ${{ secrets.PLAY_SERVICE_ACCOUNT_JSON }}
          packageName: com.hearthshelf.mobile
          releaseFiles: android/app/build/outputs/bundle/release/app-release.aab
          track: internal
          status: draft

      - name: Generate changelog
        if: github.ref_type == 'tag'
        run: bash .github/scripts/generate-changelog.sh CHANGELOG.md
        env:
          GITHUB_REF: ${{ github.ref }}
          ADDON_NAME: HearthShelf-Mobile

      - name: Upload changelog to website
        if: github.ref_type == 'tag'
        run: bash .github/scripts/upload-changelog.sh CHANGELOG.md
        env:
          CHANGELOG_API_KEY: ${{ secrets.CHANGELOG_API_KEY }}
          GITHUB_REF: ${{ github.ref }}
          RELEASE_VERSION: ${{ steps.version.outputs.version }}   # normalized string
          PRODUCT: HearthShelf-Mobile
```

Two required knock-on details for the tag path:
- **`fetch-depth: 0`** on checkout — the changelog script (`git describe --tags`, `PREV_TAG..TAG` ranges) needs full history and all tags; the default shallow checkout would break it.
- The **changelog upload script must send `version` = the normalized string** (from `steps.version.outputs.version`), not the raw `${GITHUB_REF#v}`. The ported `upload-changelog.sh` currently derives version itself from `GITHUB_REF` — it must be changed to prefer `RELEASE_VERSION` when set (this is the one-line reconciliation in §4 below and belongs to the "port the scripts" sub-problem, but the workflow must pass it).

## 5. Tag format convention + `-beta.1` → `-Beta` normalization

**Convention:** `v<MAJOR>.<MINOR>.<PATCH>` for releases (`v0.1.0`), `v<MAJOR>.<MINOR>.<PATCH>-<beta|rc|alpha>.<N>` for pre-releases (`v0.1.0-beta.1`, `v1.0.0-rc.2`). Lowercase, dot-separated pre-release counter — this is standard semver and sorts correctly, and it's what a developer naturally types.

**The mismatch:** the website's channel filter (`helpers.ts:42-45`) matches `LIKE '%-Beta%'` / `'%-Alpha%'` / `'%-RC%'` — capitalized, no dot. A raw `0.1.0-beta.1` would land in the **Releases** tab (it doesn't contain `-Beta`), which is wrong.

**Exact normalization (tag → uploaded version string):** applied **once, in the workflow's `Resolve release version from tag` step** (the sed in §3, reproduced as the contract):

| Tag (`GITHUB_REF_NAME`) | Uploaded `version` | Website channel |
|---|---|---|
| `v0.1.0` | `0.1.0` | Releases |
| `v0.1.0-beta.1` | `0.1.0-Beta1` | Beta |
| `v0.2.0-rc.2` | `0.2.0-RC2` | Beta |
| `v0.1.0-alpha.3` | `0.1.0-Alpha3` | Beta |

Transform: strip leading `v`; then `-(beta|b).?N → -BetaN`, `-(alpha|a).?N → -AlphaN`, `-rc.?N → -RCN` (case-insensitive). Result contains the exact `-Beta`/`-Alpha`/`-RC` substring the SQL `LIKE` needs.

**Where it happens (single point of truth):** the workflow step, and the workflow passes the normalized string to *both* `EXPO_PUBLIC_APP_VERSION` (so the baked app version and OTA `runtimeVersion` match what's on the changelog page) **and** `RELEASE_VERSION` (so the changelog record's `version` column matches). Do the normalization in exactly one place — the workflow — so the app binary, the OTA runtime, and the website row never disagree. Do **not** normalize inside `app.config.js` (it must stay a pure env passthrough) or separately inside `upload-changelog.sh` (that would risk two implementations drifting).

One consequence to accept: the baked user-facing `version` becomes `0.1.0-Beta1` (not `0.1.0-beta.1`). That's fine — it's still a valid, distinct `runtimeVersion` string, it's the same string shown on the website, and pre-release store builds are internal-track anyway. If you'd rather keep the pretty `-beta.1` on-device, you'd need two strings (display vs. changelog-key) and lose the "one string everywhere" guarantee — not worth it for internal betas.

## 6. First-tag behavior (no previous tag)

The current SUI `generate-changelog.sh` (lines 639-643) **skips** a tag with no predecessor to avoid dumping years of history — correct for a mature 10-year addon, but **wrong for HearthShelf-Mobile's first real tag**, where "years of history" is exactly the release you want to announce (the whole extracted-from-`spike/android-auto-rn` app).

**Recommendation for the first tag:** on the first-ever tag, **include the full history from the repo root**, not skip it. Concretely, when there is no previous tag, set the range to `<root>..<TAG>` (`$(git rev-list --max-parents=0 HEAD | tail -1)..$TAG`) instead of emitting an empty section. This produces one large "0.1.0" entry — which is precisely why the website enhancement (per-line-item records with section + tags, filterable/sortable) exists: a big first changelog is browsable instead of an unreadable wall. After the first tag, every subsequent tag has a predecessor and the normal `PREV_TAG..TAG` range keeps entries scoped. So: **first tag = full history (opt-in override of SUI's skip), subsequent tags = diff-since-previous.** Implement it as a flag the workflow can pass (e.g. `CHANGELOG_INCLUDE_INITIAL=1`) that flips the "no previous tag" branch from "skip" to "root..TAG", defaulting to the SUI skip behavior so the change is explicit and one-time.

---

### Summary of deliverables for this sub-problem
- **`app.config.js`**: add `const appVersion = process.env.EXPO_PUBLIC_APP_VERSION || '0.0.1'`; change `version: '0.0.1'` → `version: appVersion`. `versionCode`/`iosBuildNumber` unchanged (already env-driven). File: `C:\code\HearthShelf-Mobile\app.config.js`.
- **`.github/workflows/build-android-release.yml`**: add `on.push.tags: ['v*']`; add `fetch-depth: 0`; add the "Resolve release version from tag" step; pass `EXPO_PUBLIC_APP_VERSION` into prebuild; add version-assert; gate publish/changelog steps on `github.ref_type == 'tag'`. File: `C:\code\HearthShelf-Mobile\.github\workflows\build-android-release.yml`.
- **Versioning decision**: tag is source of truth for the user-facing `version` (drives OTA `runtimeVersion`); **`versionCode` stays `github.run_number`** (monotonic, decoupled). Tags are only cut for native/store releases; OTA-only JS ships under the current tag's version via `eas update`.
- **Tag/channel reconciliation**: normalize `v0.1.0-beta.1` → `0.1.0-Beta1` in the workflow step, feeding both the baked version and the changelog `version` so binary, OTA runtime, and website agree.
- **First tag**: override SUI's skip — include full `root..TAG` history once, then diff-since-previous thereafter.

Note: the corresponding one-line change to make `upload-changelog.sh` prefer `RELEASE_VERSION`/`PRODUCT` over its self-derived `addon_name`+`GITHUB_REF` version belongs to the "port the scripts" sub-problem, but this workflow depends on it and passes those env vars.