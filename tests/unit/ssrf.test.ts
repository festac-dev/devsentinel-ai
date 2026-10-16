import { describe, it, expect } from "vitest";
import { validateMonitorUrl, resolveRedirect, isForbiddenIp, normalizeIPv4, ALLOWED_PORTS } from "@/modules/monitoring/ssrf";

describe("URL validation", () => {
  it("accepts normal public URLs", () => {
    expect(validateMonitorUrl("https://example.com/health").ok).toBe(true);
    expect(validateMonitorUrl("http://example.com:80/x").ok).toBe(true);
    expect(validateMonitorUrl("https://example.com:8443/x").ok).toBe(true);
  });

  it("rejects non-http protocols", () => {
    for (const url of ["ftp://example.com", "file:///etc/passwd", "gopher://x", "javascript:alert(1)"]) {
      expect(validateMonitorUrl(url).ok).toBe(false);
    }
  });

  it("rejects credentials in URLs", () => {
    expect(validateMonitorUrl("https://user:pass@example.com").ok).toBe(false);
  });

  it("rejects disallowed ports", () => {
    expect(validateMonitorUrl("https://example.com:22").ok).toBe(false);
    expect(validateMonitorUrl("http://example.com:1337").ok).toBe(false);
    expect(validateMonitorUrl("http://example.com:9090").ok).toBe(false);
    for (const p of ALLOWED_PORTS) expect(validateMonitorUrl(`http://example.com:${p}`).ok).toBe(true);
  });

  it("rejects literal loopback and private addresses (all encodings)", () => {
    const blocked = [
      "http://127.0.0.1",
      "http://127.1", // short form → 127.0.0.1
      "http://2130706433", // decimal encoding of 127.0.0.1
      "http://0x7f.0.0.1", // hex encoding
      "http://0177.0.0.1", // octal encoding
      "http://10.0.0.5",
      "http://172.16.0.9",
      "http://172.31.255.255",
      "http://192.168.1.1",
      "http://100.64.0.1",
      "http://169.254.169.254", // cloud metadata
      "http://0.0.0.0",
      "http://224.0.0.1",
      "http://[::1]",
      "http://[::]",
      "http://[fc00::1]",
      "http://[fe80::1]",
      "http://[::ffff:127.0.0.1]", // IPv4-mapped IPv6
      "http://[::ffff:a00:1]", // mapped 10.0.0.1 in hex
      "http://[0:0:0:0:0:ffff:7f00:1]", // mapped 127.0.0.1, fully expanded hex
      "http://[::1.2.3.4]", // reserved ::/8 via embedded dotted-quad (crashed validation before)
    ];
    for (const url of blocked) {
      expect(validateMonitorUrl(url).ok).toBe(false);
    }
  });

  it("rejects internal hostnames", () => {
    for (const host of ["localhost", "db.internal", "printer.local", "metadata.google.internal"]) {
      expect(validateMonitorUrl(`http://${host}`).ok).toBe(false);
    }
  });

  it("allows hostnames (resolved+validated at check time)", () => {
    expect(validateMonitorUrl("https://example.com").ok).toBe(true);
  });
});

describe("isForbiddenIp()", () => {
  const forbidden = [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.9.9", "192.168.0.1", "100.64.0.1",
    "169.254.169.254", "0.0.0.0", "224.0.0.5", "240.0.0.1", "255.255.255.255",
    "::1", "::", "::1.2.3.4", "::102:304", "0:0:0:0:0:ffff:7f00:1", "fe80::1%eth0",
    "fc00::1", "fd12:3456::1", "fe80::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "::ffff:169.254.169.254",
    "64:ff9b::192.0.2.1", // NAT64 synthesis via embedded dotted-quad (crashed validation before)
  ];
  const allowed = ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "172.32.0.1", "100.128.0.1",
    "::ffff:8.8.8.8"];
  it("blocks every forbidden class", () => {
    for (const ip of forbidden) expect(isForbiddenIp(ip), ip).toBe(true);
  });
  it("allows public addresses", () => {
    for (const ip of allowed) expect(isForbiddenIp(ip), ip).toBe(false);
  });
});

describe("normalizeIPv4()", () => {
  it("decodes alternate encodings", () => {
    expect(normalizeIPv4("2130706433")).toBe("127.0.0.1");
    expect(normalizeIPv4("0x7f000001")).toBe("127.0.0.1");
    expect(normalizeIPv4("0177.0.0.1")).toBe("127.0.0.1");
    expect(normalizeIPv4("127.1")).toBe("127.0.0.1");
    expect(normalizeIPv4("10.1")).toBe("10.0.0.1");
    expect(normalizeIPv4("example")).toBeNull();
  });
});

describe("redirect resolution", () => {
  it("revalidates redirect targets with the same rules", () => {
    const base = new URL("https://example.com/start");
    expect(resolveRedirect(base, "/next").ok).toBe(true);
    expect(resolveRedirect(base, "http://127.0.0.1/").ok).toBe(false);
    expect(resolveRedirect(base, "ftp://example.com/").ok).toBe(false);
    expect(resolveRedirect(base, "https://user:pass@example.com/").ok).toBe(false);
    expect(resolveRedirect(base, "http://169.254.169.254/latest/meta-data/").ok).toBe(false);
  });
});
