import type { CapacitorConfig } from '@capacitor/cli';

/*
 * Capacitor config for SplitRight.
 *
 * How the two builds relate:
 *   • Web build   (Cloudflare Pages) → `npm run build`
 *                  Hono renders the HTML shell at /  + serves /api/* endpoints.
 *
 *   • Native build (iOS via Codemagic) → `npm run build:native`
 *                  Emits a static SPA into ./native/, which Capacitor bundles
 *                  inside the iOS binary. The native app calls /api/* against
 *                  the deployed Cloudflare Pages backend (see API_BASE in
 *                  public/static/app.jsx — set at runtime via
 *                  window.__SPLITRIGHT_API_BASE__).
 *
 * webDir must point at the folder that contains the static index.html.
 */
const config: CapacitorConfig = {
  appId: 'com.splitright.app',
  appName: 'SplitRight',
  webDir: 'native',
  bundledWebRuntime: false,
  server: {
    // Bundle offline; no live-reload URL. Change this to an https URL
    // during dev if you want the native app to load the web preview.
    androidScheme: 'https',
    iosScheme: 'https',
    // Allow calls to your deployed backend. Update once the Cloudflare
    // Pages URL is known.
    allowNavigation: [
      '*.pages.dev',
      'splitright.pages.dev',
      'api.openrouter.ai',
      'openrouter.ai'
    ]
  },
  ios: {
    // Match iOS status bar to our brand colors.
    contentInset: 'always',
    // Modern behavior for iOS 13+: system decides light/dark background.
    backgroundColor: '#FFFFFF',
    // Speed up cold-start: keep the native splash until React mounts.
    // We hide it manually from JS once the root renders.
    limitsNavigationsToAppBoundDomains: false
  },
  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: false, // we hide it after React paints
      backgroundColor: '#0B1220',
      androidSplashResourceName: 'splash',
      androidScaleType: 'CENTER_CROP',
      showSpinner: false,
      splashFullScreen: true,
      splashImmersive: true
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#0B1220'
    },
    Camera: {
      // Permission strings live in ios/App/App/Info.plist —
      // see capacitor-camera docs. We also inject them via codemagic.yaml.
    }
  }
};

export default config;
