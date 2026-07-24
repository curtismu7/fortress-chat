# FortressChat Release Checklist

## 1. Preflight

- Ensure clean working tree: `git status --short`
- Confirm versions are bumped:
  - `packages/extension/package.json`
  - `packages/desktop/package.json`
- Run repo build: `npm run build`

## 2. Desktop Packaging

- Build unpacked app: `npm run desktop:pack`
- Build DMG: `npm run desktop:dist`
- Confirm expected artifacts in `packages/desktop/dist`

## 3. Optional Signing + Notarization

- Export signing credentials:
  - `APPLE_ID`
  - `APPLE_APP_SPECIFIC_PASSWORD`
  - `APPLE_TEAM_ID`
- Re-run: `npm run desktop:dist`
- Verify notarization logs show success

For GitHub Actions workflow `.github/workflows/desktop-release.yml`, set repository secrets:

- `MACOS_CERT_P12_BASE64` (base64-encoded Developer ID Application certificate `.p12`)
- `MACOS_CERT_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

## 4. Manual Smoke Test (macOS)

- Install/open DMG app
- Verify Google sign-in appears first
- Verify only `@pingidentity.com` account can proceed
- Verify chat window opens after successful login

## 5. Release Metadata

- Update release notes file under `docs/releases/`
- Include:
  - version numbers
  - key features/fixes
  - known limitations

## 6. Git + GitHub

- Commit with release message
- Push to `main`
- Tag release (example): `git tag v0.1.15 && git push origin v0.1.15`
- Create GitHub Release and attach DMG
