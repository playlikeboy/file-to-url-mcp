import { describe, expect, test } from "vitest";
import {
  ID_PATTERN,
  UserError,
  assertPublicHttpUrl,
  bareMimeType,
  contentDisposition,
  decodeBase64,
  extensionForType,
  filenameFromContentDisposition,
  filenameFromUrl,
  formatBytes,
  formatDuration,
  generateId,
  guessContentType,
  isInlineSafe,
  parseExpiry,
  sanitizeFilename,
  splitDataUrl,
} from "../src/util";

describe("parseExpiry", () => {
  test.each([
    ["10m", 600],
    ["1h", 3600],
    ["1d", 86400],
    ["1w", 604800],
    ["30 days", 2592000],
    ["2 Weeks", 1209600],
    ["90s", 90],
    ["1.5h", 5400],
    ["3600", 3600],
    [7200, 7200],
  ])("parses %s as %d seconds", (input, expected) => {
    expect(parseExpiry(input, "1d")).toBe(expected);
  });

  test.each(["never", "none", "forever", "0", "NEVER"])("treats %s as no expiry", (input) => {
    expect(parseExpiry(input, "1d")).toBeNull();
  });

  test.each([undefined, null, ""])("falls back to the default when given %s", (input) => {
    expect(parseExpiry(input, "1w")).toBe(604800);
  });

  test("rejects unparseable values with a helpful message", () => {
    expect(() => parseExpiry("banana", "1d")).toThrow(/Invalid expires_in "banana"/);
  });

  test("rejects lifetimes under one minute", () => {
    expect(() => parseExpiry("30s", "1d")).toThrow(/at least 60 seconds/);
  });

  test("rejects lifetimes over a year", () => {
    expect(() => parseExpiry("400d", "1d")).toThrow(/cannot exceed 365 days/);
  });
});

describe("generateId", () => {
  test("returns 7 base62 characters", () => {
    expect(generateId()).toMatch(ID_PATTERN);
  });

  test("does not repeat across many calls", () => {
    const ids = new Set(Array.from({ length: 500 }, () => generateId()));
    expect(ids.size).toBe(500);
  });

  test("honours a custom length", () => {
    expect(generateId(12)).toHaveLength(12);
  });
});

describe("sanitizeFilename", () => {
  test("strips directories from unix and windows paths", () => {
    expect(sanitizeFilename("/etc/passwd")).toBe("passwd");
    expect(sanitizeFilename("C:\\Users\\me\\photo.png")).toBe("photo.png");
  });

  test("removes control characters and reserved symbols", () => {
    expect(sanitizeFilename('re\r\nport<1>:"x"|?*.pdf')).toBe("report1x.pdf");
  });

  test("drops leading dots so the result is never hidden or relative", () => {
    expect(sanitizeFilename("../..")).toBe("file");
    expect(sanitizeFilename(".env")).toBe("env");
  });

  test.each([null, undefined, "", "   "])("falls back when given %s", (input) => {
    expect(sanitizeFilename(input, "download")).toBe("download");
  });

  test("truncates long names but keeps the extension", () => {
    const result = sanitizeFilename(`${"a".repeat(300)}.mp4`);
    expect(result).toHaveLength(180);
    expect(result.endsWith(".mp4")).toBe(true);
  });

  test("removes invisible characters that can disguise the real extension", () => {
    expect(sanitizeFilename("invoice\u202efdp.exe")).toBe("invoicefdp.exe");
    expect(sanitizeFilename("a\u200bb\ufeff.txt")).toBe("ab.txt");
  });

  test("drops lone surrogates so the name can always be URL-encoded", () => {
    const name = sanitizeFilename("bad\ud800name.txt");

    expect(name).toBe("badname.txt");
    expect(() => encodeURIComponent(name)).not.toThrow();
  });

  test("never splits an emoji when truncating", () => {
    const name = sanitizeFilename("\u{1F600}".repeat(200));

    expect([...name]).toHaveLength(180);
    expect(() => encodeURIComponent(name)).not.toThrow();
  });

  test("truncates long names that have no extension", () => {
    expect(sanitizeFilename("b".repeat(300))).toHaveLength(180);
  });
});

describe("content types", () => {
  test.each([
    ["photo.PNG", "image/png"],
    ["clip.mp4", "video/mp4"],
    ["song.mp3", "audio/mpeg"],
    ["doc.pdf", "application/pdf"],
    ["data.csv", "text/csv"],
    ["archive.zip", "application/zip"],
    ["mystery.xyz", "application/octet-stream"],
    ["noextension", "application/octet-stream"],
  ])("guesses %s as %s", (name, expected) => {
    expect(guessContentType(name)).toBe(expected);
  });

  test("bareMimeType strips parameters and rejects junk", () => {
    expect(bareMimeType("Text/HTML; charset=utf-8")).toBe("text/html");
    expect(bareMimeType("not a mime")).toBeNull();
    expect(bareMimeType(null)).toBeNull();
  });

  test("extensionForType prefers common extensions", () => {
    expect(extensionForType("image/jpeg")).toBe("jpg");
    expect(extensionForType("application/pdf")).toBe("pdf");
    expect(extensionForType("application/x-unknown")).toBeNull();
  });

  test.each(["image/png", "video/mp4", "audio/mpeg", "application/pdf", "text/plain", "application/json"])(
    "isInlineSafe allows %s to render in the browser",
    (mime) => {
      expect(isInlineSafe(mime)).toBe(true);
    },
  );

  test.each(["text/html", "image/svg+xml", "application/atom+xml", "application/xhtml+xml", "text/javascript", "application/octet-stream"])(
    "isInlineSafe forces %s to download",
    (mime) => {
      expect(isInlineSafe(mime)).toBe(false);
    },
  );
});

describe("filename extraction", () => {
  test("reads RFC 5987 encoded names first", () => {
    expect(filenameFromContentDisposition("attachment; filename=\"a.txt\"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf")).toBe("résumé.pdf");
  });

  test("reads quoted and bare names", () => {
    expect(filenameFromContentDisposition('attachment; filename="my file.zip"')).toBe("my file.zip");
    expect(filenameFromContentDisposition("attachment; filename=plain.bin")).toBe("plain.bin");
  });

  test("falls back to the plain name when the encoded one is malformed", () => {
    expect(filenameFromContentDisposition("attachment; filename=ok.txt; filename*=UTF-8''%E0%A4%A")).toBe("ok.txt");
  });

  test("returns null without a usable header", () => {
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition("inline")).toBeNull();
  });

  test("filenameFromUrl decodes the last path segment", () => {
    expect(filenameFromUrl(new URL("https://x.test/a/b/my%20pic.png?x=1"))).toBe("my pic.png");
    expect(filenameFromUrl(new URL("https://x.test/"))).toBeNull();
    expect(filenameFromUrl(new URL("https://x.test/bad%E0%A4%A"))).toBe("bad%E0%A4%A");
  });
});

describe("contentDisposition", () => {
  test("emits an ASCII fallback and a UTF-8 name", () => {
    expect(contentDisposition("attachment", 'résumé "v2".pdf')).toBe(
      "attachment; filename=\"r_sum_ _v2_.pdf\"; filename*=UTF-8''r%C3%A9sum%C3%A9%20%22v2%22.pdf",
    );
  });

  test("cannot be used to inject header lines", () => {
    expect(contentDisposition("inline", "a\r\nSet-Cookie: x=1")).not.toMatch(/[\r\n]/);
  });
});

describe("assertPublicHttpUrl", () => {
  test("accepts public http and https URLs", () => {
    expect(assertPublicHttpUrl("https://example.com/a.png").hostname).toBe("example.com");
    expect(assertPublicHttpUrl("http://93.184.216.34/x").hostname).toBe("93.184.216.34");
  });

  test.each([
    "http://localhost/x",
    "http://app.localhost/x",
    "http://127.0.0.1:8080/",
    "http://10.1.2.3/",
    "http://192.168.1.1/",
    "http://172.16.0.5/",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/",
    "http://[fd00::1]/",
    "http://printer.local/",
    "http://db.internal/",
  ])("rejects private address %s", (url) => {
    expect(() => assertPublicHttpUrl(url)).toThrow(/private or loopback/);
  });

  test("rejects non-http schemes and garbage", () => {
    expect(() => assertPublicHttpUrl("file:///etc/passwd")).toThrow(/Only http/);
    expect(() => assertPublicHttpUrl("not a url")).toThrow(UserError);
  });
});

describe("formatting", () => {
  test.each([
    [0, "0 B"],
    [17, "17 B"],
    [1536, "1.50 KB"],
    [12 * 1024 * 1024, "12.0 MB"],
    [512 * 1024 * 1024, "512 MB"],
    [2 * 1024 ** 3, "2.00 GB"],
  ])("formatBytes(%d) is %s", (bytes, expected) => {
    expect(formatBytes(bytes)).toBe(expected);
  });

  test.each([
    [0, "expired"],
    [45, "45s"],
    [600, "10m"],
    [3600, "1h"],
    [5400, "1h 30m"],
    [86400, "1d"],
    [90000, "1d 1h"],
  ])("formatDuration(%d) is %s", (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });
});

describe("base64", () => {
  test("decodes standard, url-safe and whitespace-wrapped input", () => {
    expect(new TextDecoder().decode(decodeBase64("aGVsbG8="))).toBe("hello");
    expect(new TextDecoder().decode(decodeBase64("aGVs\nbG8="))).toBe("hello");
    expect([...decodeBase64("-_8=")]).toEqual([251, 255]);
  });

  test.each(["", "@@@@", "a"])("rejects invalid input %j", (input) => {
    expect(() => decodeBase64(input)).toThrow(/not valid base64/);
  });

  test("splitDataUrl separates the mime type from the payload", () => {
    expect(splitDataUrl("data:image/png;base64,AAAA")).toEqual({ mime: "image/png", payload: "AAAA" });
    expect(splitDataUrl("AAAA")).toEqual({ mime: null, payload: "AAAA" });
    expect(splitDataUrl("data:;base64,AAAA")).toEqual({ mime: null, payload: "AAAA" });
  });
});
