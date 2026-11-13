// Types for window.nova, the bridge preload.js builds from src/main/ipc-contract.js.
// Keep the two in step: a channel added there needs its method here.

interface NovaFoundServer {
  base: string;
  info: { Id: string; ServerName: string; Version: string };
  encrypted: boolean;
  privateHost: boolean;
  error?: undefined;
}

type NovaSignInResult =
  | { ok: true; user: { Id: string; Name: string; PrimaryImageTag?: string }; tokenSaved: boolean }
  | { ok: false; status?: number; message: string };

interface NovaBridge {
  getStore(): Promise<Record<string, any> & { signedIn: boolean; tokenSaved: boolean; serverInsecure: boolean }>;
  set(key: string, value: unknown): void;

  findServer(input: string): Promise<NovaFoundServer | { error: string }>;
  signIn(req: { base: string; username: string; password: string } | { base: string; secret: string }): Promise<NovaSignInResult>;
  signOut(): Promise<boolean>;

  keepAwake(on: boolean): void;
  setFullscreen(value?: boolean): Promise<boolean>;
  setDarkOverlay(dark: boolean): void;
  setMini(on: boolean): Promise<boolean>;
  setZoom(factor: number): void;
  accentColor(): Promise<string | null>;
  discoverServers(): Promise<{ id: string; name: string; url: string }[]>;
  openExternal(url: string): void;
  saveScreenshot(bytes: ArrayBuffer | ArrayBufferView, name: string): Promise<string>;
  showInFolder(file: string): void;

  appInfo(): Promise<{ version: string; homepage: string; mica: boolean }>;
  closeReady(): void;
  updateState(): Promise<Record<string, unknown>>;
  checkForUpdates(): Promise<Record<string, unknown>>;
  installUpdate(): void;

  onFullscreen(cb: (value: boolean) => void): () => void;
  onUpdate(cb: (state: Record<string, unknown>) => void): () => void;
  onBeforeClose(cb: () => void): () => void;
}

interface Window {
  nova: NovaBridge;
}
