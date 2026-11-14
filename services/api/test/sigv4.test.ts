import { describe, expect, it } from "vitest";
import { signV4 } from "../src/areas/models/sigv4.js";

// AWS Signature Version 4 test suite, "get-vanilla" and "get-vanilla-query-order-key-case" (published with the AWS documentation).
const CREDS = { region: "us-east-1", service: "service", accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", date: new Date("2015-08-30T12:36:00Z") };

describe("SigV4", () => {
  it("matches AWS's get-vanilla vector", () => {
    const h = signV4({ method: "GET", url: "https://example.amazonaws.com/", ...CREDS });
    expect(h.authorization).toBe("AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31");
    expect(h["x-amz-date"]).toBe("20150830T123600Z");
  });
  it("matches AWS's get-vanilla-query-order-key-case vector (query sorted)", () => {
    const h = signV4({ method: "GET", url: "https://example.amazonaws.com/?Param2=value2&Param1=value1", ...CREDS });
    expect(h.authorization).toContain("Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500");
  });
  it("signs a session token as a header", () => {
    const h = signV4({ method: "GET", url: "https://example.amazonaws.com/", ...CREDS, sessionToken: "tok" });
    expect(h.authorization).toContain("SignedHeaders=host;x-amz-date;x-amz-security-token");
    expect(h["x-amz-security-token"]).toBe("tok");
  });
});
