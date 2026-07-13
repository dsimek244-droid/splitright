#!/usr/bin/env bash
# prepare-ios.sh
# Runs on Codemagic (macOS) after npm install. Assembles the native web
# bundle, adds the iOS platform if it's missing, injects required
# Info.plist permission strings, then syncs Capacitor.
#
# Env vars this script expects Codemagic to set:
#   API_BASE   — https URL of the deployed Cloudflare Pages backend.
#                Defaults to https://splitright.pages.dev if unset.

set -euo pipefail

echo "▸ Building native web bundle (API_BASE=${API_BASE:-https://splitright.pages.dev})"
API_BASE="${API_BASE:-https://splitright.pages.dev}" npm run build:native

# Add the iOS platform on the very first build. On subsequent builds the
# ios/ directory already exists (Codemagic caches the workspace).
if [ ! -d "ios" ]; then
  echo "▸ ios/ missing — running: npx cap add ios"
  npx cap add ios
fi

# Inject camera + photo library permission strings so the App Store review
# doesn't reject the build. These strings are shown by iOS in the
# permission prompt — keep them user-friendly.
INFO_PLIST="ios/App/App/Info.plist"
if [ -f "$INFO_PLIST" ]; then
  echo "▸ Injecting Info.plist permissions"
  # Use PlistBuddy which is standard on macOS.
  /usr/libexec/PlistBuddy -c "Delete :NSCameraUsageDescription"       "$INFO_PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Delete :NSPhotoLibraryUsageDescription" "$INFO_PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Delete :NSPhotoLibraryAddUsageDescription" "$INFO_PLIST" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :NSCameraUsageDescription string 'SplitRight uses the camera to scan receipt photos so you can split bills quickly. Photos are processed only for splitting and are not stored on our servers.'" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :NSPhotoLibraryUsageDescription string 'SplitRight reads receipt photos from your library so you can split bills from photos you already took. Photos are processed only for splitting and are not stored on our servers.'" "$INFO_PLIST"
  /usr/libexec/PlistBuddy -c "Add :NSPhotoLibraryAddUsageDescription string 'SplitRight saves a split summary image to your photos when you choose Share as image.'" "$INFO_PLIST"

  # Set the display name shown under the icon on the Home Screen.
  /usr/libexec/PlistBuddy -c "Set :CFBundleDisplayName SplitRight" "$INFO_PLIST" 2>/dev/null || \
    /usr/libexec/PlistBuddy -c "Add :CFBundleDisplayName string SplitRight" "$INFO_PLIST"
else
  echo "⚠ Info.plist not found at $INFO_PLIST — did cap add ios succeed?"
  exit 1
fi

echo "▸ npx cap sync ios"
npx cap sync ios

echo "✓ iOS project ready in ios/App"
