/** Pure helpers: expiry parsing, ids, filenames, content types, URL safety. */

export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "UserError";
  }
}

const SECONDS_PER_UNIT: Readonly<Record<string, number>> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

export const MIN_EXPIRY_SECONDS = 60;
export const MAX_EXPIRY_SECONDS = 365 * 86400;
const NEVER_WORDS = new Set(["never", "none", "permanent", "forever", "0"]);

/**
 * Parses "10m" / "1h" / "1d" / "1w" / "never" / a number of seconds.
 * Returns seconds until expiry, or null for "never expires".
 */
export function parseExpiry(input: string | number | null | undefined, fallback: string): number | null {
  const raw = input === undefined || input === null || input === "" ? fallback : input;
  const text = String(raw).trim().toLowerCase();
  if (NEVER_WORDS.has(text)) return null;

  const match = /^(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wk|wks|weeks?)?$/.exec(text);
  if (!match) {
    throw new UserError(`Invalid expires_in "${raw}". Use e.g. "10m", "1h", "1d", "1w", "30d" or "never".`);
  }
  const unit = (match[2] ?? "s").charAt(0);
  const seconds = Math.round(Number(match[1]) * SECONDS_PER_UNIT[unit]);
  if (seconds < MIN_EXPIRY_SECONDS) {
    throw new UserError(`expires_in must be at least ${MIN_EXPIRY_SECONDS} seconds (or "never").`);
  }
  if (seconds > MAX_EXPIRY_SECONDS) {
    throw new UserError('expires_in cannot exceed 365 days. Use "never" for a permanent file.');
  }
  return seconds;
}

const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const ID_LENGTH = 7;
export const ID_PATTERN = /^[0-9A-Za-z]{7}$/;

/** Random base62 id (rejection sampling keeps the distribution uniform). */
export function generateId(length = ID_LENGTH): string {
  const limit = 256 - (256 % ID_ALPHABET.length);
  const chars: string[] = [];
  while (chars.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2));
    for (const byte of bytes) {
      if (byte < limit && chars.length < length) chars.push(ID_ALPHABET[byte % ID_ALPHABET.length]);
    }
  }
  return chars.join("");
}

const MAX_FILENAME_LENGTH = 180;

/** Control characters, reserved symbols, and invisible bidi/zero-width characters that can disguise an extension. */
// eslint-disable-next-line no-control-regex
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f<>:"|?*​-‏‪-‮⁦-⁩﻿�]/g;

/** Strips directories and unsafe characters; never returns an empty name. */
export function sanitizeFilename(name: string | null | undefined, fallback = "file"): string {
  const base = (name ?? "").split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .toWellFormed() // lone surrogates would make encodeURIComponent throw later
    .replace(UNSAFE_FILENAME_CHARS, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  if (!cleaned) return fallback;
  const characters = [...cleaned]; // by code point, so truncation never splits a surrogate pair
  if (characters.length <= MAX_FILENAME_LENGTH) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
  return characters.slice(0, MAX_FILENAME_LENGTH - ext.length).join("") + ext;
}

const TYPE_BY_EXTENSION: Readonly<Record<string, string>> = {
  // images
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon", bmp: "image/bmp", tiff: "image/tiff",
  heic: "image/heic",
  // video
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  avi: "video/x-msvideo", m4v: "video/x-m4v",
  // audio
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac",
  aac: "audio/aac", opus: "audio/opus",
  // documents
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  epub: "application/epub+zip", rtf: "application/rtf",
  // text & code
  txt: "text/plain", md: "text/markdown", csv: "text/csv", tsv: "text/tab-separated-values",
  html: "text/html", htm: "text/html", css: "text/css", js: "text/javascript", mjs: "text/javascript",
  ts: "text/plain", tsx: "text/plain", jsx: "text/plain", py: "text/plain", sh: "text/plain",
  sql: "text/plain", log: "text/plain", yaml: "text/yaml", yml: "text/yaml", toml: "text/plain",
  json: "application/json", xml: "application/xml", ics: "text/calendar",
  // archives & binaries
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", "7z": "application/x-7z-compressed",
  rar: "application/vnd.rar", wasm: "application/wasm", apk: "application/vnd.android.package-archive",
  exe: "application/octet-stream", dmg: "application/octet-stream", bin: "application/octet-stream",
  // fonts
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};

export const DEFAULT_CONTENT_TYPE = "application/octet-stream";

export function guessContentType(filename: string): string {
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  return TYPE_BY_EXTENSION[ext] ?? DEFAULT_CONTENT_TYPE;
}

/** Normalises a Content-Type header value to its bare mime type ("text/html; charset=x" -> "text/html"). */
export function bareMimeType(value: string | null | undefined): string | null {
  const mime = (value ?? "").split(";")[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : null;
}

const PREFERRED_EXTENSION: Readonly<Record<string, string>> = {
  "image/jpeg": "jpg", "text/plain": "txt", "text/html": "html", "text/javascript": "js",
  "audio/mpeg": "mp3", "audio/mp4": "m4a", "text/yaml": "yaml", "application/octet-stream": "bin",
};

export function extensionForType(mime: string): string | null {
  if (PREFERRED_EXTENSION[mime]) return PREFERRED_EXTENSION[mime];
  const found = Object.entries(TYPE_BY_EXTENSION).find(([, type]) => type === mime);
  return found ? found[0] : null;
}

const INLINE_SAFE_TYPES = new Set(["application/pdf", "application/json", "text/plain", "text/markdown", "text/csv"]);

/**
 * Whether a type may be rendered in the browser. Everything else (HTML, SVG, any XML, scripts,
 * unknown types) is always sent as a download, so an upload can never run as a page.
 */
export function isInlineSafe(mime: string): boolean {
  if (INLINE_SAFE_TYPES.has(mime)) return true;
  return /^(image|audio|video)\//.test(mime) && !mime.includes("xml");
}

/** Pulls a filename out of a Content-Disposition header, if present. */
export function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const extended = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      // malformed percent-encoding: fall through to the plain filename
    }
  }
  const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/.exec(header);
  return plain ? (plain[1] ?? plain[2]).trim() : null;
}

export function filenameFromUrl(url: URL): string | null {
  const last = url.pathname.split("/").filter(Boolean).pop();
  if (!last) return null;
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** RFC 6266 Content-Disposition value with an ASCII fallback and a UTF-8 name. */
export function contentDisposition(kind: "inline" | "attachment", filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

const PRIVATE_HOST_PATTERNS: readonly RegExp[] = [
  /^localhost$/i,
  /\.localhost$/i,
  /\.local$/i,
  /\.internal$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
  /^0\./,
  /^\[?::1\]?$/,
  /^\[?f[cd][0-9a-f]{2}:/i,
  /^\[?fe80:/i,
];

/** Validates a user-supplied source URL: http(s) only, no loopback/private hosts. */
export function assertPublicHttpUrl(input: string): URL {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new UserError(`"${input}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UserError("Only http:// and https:// URLs can be fetched.");
  }
  if (PRIVATE_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname))) {
    throw new UserError("URLs pointing at private or loopback addresses are not allowed.");
  }
  return url;
}

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

/** Human-readable remaining time, e.g. "23h 59m". */
export function formatDuration(totalSeconds: number): string {
  if (totalSeconds <= 0) return "expired";
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return minutes > 0 ? `${minutes}m` : `${totalSeconds}s`;
}

export function decodeBase64(data: string): Uint8Array {
  const cleaned = data.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!cleaned || /[^A-Za-z0-9+/=]/.test(cleaned)) {
    throw new UserError("data is not valid base64.");
  }
  try {
    const binary = atob(cleaned);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    throw new UserError("data is not valid base64.");
  }
}

/** Splits an optional "data:<mime>;base64,<payload>" prefix off a base64 string. */
export function splitDataUrl(data: string): { mime: string | null; payload: string } {
  const match = /^data:([^;,]*)(?:;[^,]*)?,/.exec(data);
  if (!match) return { mime: null, payload: data };
  return { mime: bareMimeType(match[1]), payload: data.slice(match[0].length) };
}
