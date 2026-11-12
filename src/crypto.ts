/** Authenticated encryption (AES-256-GCM) for values kept in D1 and for upload tickets. */

const IV_BYTES = 12;

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export class Sealer {
  private readonly key: Promise<CryptoKey>;

  /** `secret` is any high-entropy string; it is hashed into the AES key. */
  constructor(secret: string) {
    this.key = crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(secret))
      .then((digest) => crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]));
  }

  /**
   * `context` says what the value is for (e.g. "upload-ticket"). It is authenticated but not stored,
   * so a value sealed for one purpose can never be opened as another.
   */
  async seal(plain: string, context: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const encoder = new TextEncoder();
    const cipher = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: encoder.encode(context) },
      await this.key,
      encoder.encode(plain),
    );
    const sealed = new Uint8Array(IV_BYTES + cipher.byteLength);
    sealed.set(iv, 0);
    sealed.set(new Uint8Array(cipher), IV_BYTES);
    return toBase64Url(sealed);
  }

  /** Returns null for anything not sealed with this key and context (tampered, truncated, wrong key or purpose). */
  async open(sealed: string, context: string): Promise<string | null> {
    try {
      const bytes = fromBase64Url(sealed);
      if (bytes.byteLength <= IV_BYTES) return null;
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES), additionalData: new TextEncoder().encode(context) },
        await this.key,
        bytes.slice(IV_BYTES),
      );
      return new TextDecoder().decode(plain);
    } catch {
      return null;
    }
  }
}
