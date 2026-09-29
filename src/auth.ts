// Auth surface — typed wrappers over the device-flow Tauri commands.

import { invoke } from "@tauri-apps/api/core";

export interface DeviceStart {
  userCode: string;
  verifyUrl: string;
  deviceCode: string;
  intervalSecs: number;
  expiresInSecs: number;
}

export interface SessionInfo {
  signedIn: boolean;
  username: string | null;
  email: string | null;
  plan: string | null;
  creditBalanceCents: number | null;
}

export interface CatalogModel {
  id: string;
  name?: string;
  reasoning_levels?: string[] | null;
}

export function deviceStart(): Promise<DeviceStart> {
  return invoke<DeviceStart>("device_start");
}

export function devicePoll(deviceCode: string): Promise<{ status: string }> {
  return invoke<{ status: string }>("device_poll", { deviceCode });
}

export function sessionInfo(): Promise<SessionInfo> {
  return invoke<SessionInfo>("session_info");
}

export function signOut(): Promise<boolean> {
  return invoke<boolean>("sign_out");
}

export function modelCatalog(): Promise<CatalogModel[]> {
  return invoke<CatalogModel[]>("model_catalog");
}

/** Open the verify URL in the user's default browser. */
export async function openInBrowser(url: string): Promise<void> {
  // tauri-plugin-opener v2; fall back to shell open for older setups.
  try {
    const mod = await import("@tauri-apps/plugin-opener");
    await mod.openUrl(url);
  } catch {
    window.open(url, "_blank");
  }
}
