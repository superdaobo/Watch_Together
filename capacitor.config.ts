import type { CapacitorConfig } from "@capacitor/cli";

const mobileWebUrl = String(process.env.MOBILE_WEB_URL || "https://mini-hbut-video-online.hf.space").trim();
const allowHttp = mobileWebUrl.startsWith("http://");

const config: CapacitorConfig = {
  appId: "com.superdaobo.watchtogether",
  appName: "Watch Together",
  webDir: "public",
  bundledWebRuntime: false,
  server: {
    url: mobileWebUrl,
    cleartext: allowHttp
  },
  android: {
    allowMixedContent: true,
    captureInput: true
  },
  ios: {
    contentInset: "always"
  }
};

export default config;
