import { describe, expect, it } from "vitest";
import { forbiddenVendorName, validLanCidr, vendorAddressRefusal } from "./netguard.js";

describe("S-68 vendor address guard", () => {
  it("refuses loopback, link-local, metadata and the control network even when a LAN range is listed", () => {
    for (const a of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "::1", "fe80::1", "::ffff:127.0.0.1", "10.89.17.2"]) expect(vendorAddressRefusal(a, ["10.0.0.0/8", "192.168.0.0/16"]), a).not.toBeNull();
  });
  it("refuses private space unless it is inside a listed range", () => {
    expect(vendorAddressRefusal("10.0.0.5")).not.toBeNull();
    expect(vendorAddressRefusal("10.0.0.5", ["10.0.0.0/24"])).toBeNull();
    expect(vendorAddressRefusal("10.0.1.5", ["10.0.0.0/24"])).not.toBeNull();
    expect(vendorAddressRefusal("93.184.216.34")).toBeNull();
  });
  it("names: localhost always, service names unless a LAN range is listed", () => {
    expect(forbiddenVendorName("localhost", true)).toBe(true);
    expect(forbiddenVendorName("gantry-api")).toBe(true);
    expect(forbiddenVendorName("gantry-api", true)).toBe(false);
    expect(forbiddenVendorName("llm.example.com")).toBe(false);
  });
  it("a LAN range is IPv4 private space only", () => {
    expect(validLanCidr("192.168.10.0/24")).toBe(true);
    expect(validLanCidr("10.0.0.0/8")).toBe(true);
    for (const c of ["0.0.0.0/0", "8.8.8.0/24", "127.0.0.0/8", "169.254.0.0/16", "10.0.0.0/4", "nope"]) expect(validLanCidr(c), c).toBe(false);
  });
});
