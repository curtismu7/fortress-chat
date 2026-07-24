const { notarize } = require('@electron/notarize');

exports.default = async function notarizeApp(context) {
  if (process.platform !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.log('[notarize] Skipping notarization (missing APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID).');
    return;
  }

  const { appOutDir, packager } = context;
  const appName = packager.appInfo.productFilename;

  console.log(`[notarize] Notarizing ${appName}.app`);
  await notarize({
    appBundleId: 'com.fortresschat.desktop',
    appPath: `${appOutDir}/${appName}.app`,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });
  console.log('[notarize] Notarization complete.');
};
