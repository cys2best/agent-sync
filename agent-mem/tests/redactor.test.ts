import { describe, expect, it } from "bun:test";
import { redactPrivateTags, maskSecrets, sanitizePayload } from "../src/privacy/redactor";

describe("privacy redactor", () => {
  it("strips single-line and multi-line <private> tags", () => {
    const raw = "Public info\n<private>Secret internal password123</private>\nMore public info";
    const res = redactPrivateTags(raw);
    expect(res.sanitized).toContain("[REDACTED_PRIVATE]");
    expect(res.sanitized).not.toContain("password123");
    expect(res.count).toBe(1);
  });

  it("strips case-insensitive and whitespace-spaced <private> tags", () => {
    const raw = "Start <PRIVATE>\nConfidential key\n</PRIVATE> End";
    const res = redactPrivateTags(raw);
    expect(res.sanitized).toBe("Start [REDACTED_PRIVATE] End");
    expect(res.count).toBe(1);
  });

  it("masks known secret patterns like API keys", () => {
    const raw = "Connecting with sk-ant-api03-abcdef1234567890abcdef1234567890 and ghp_1234567890abcdefghijklmnopqrstuv";
    const res = maskSecrets(raw);
    expect(res.sanitized).not.toContain("sk-ant-api03");
    expect(res.sanitized).not.toContain("ghp_1234");
    expect(res.count).toBe(2);
  });

  it("performs complete sanitization in sanitizePayload", () => {
    const raw = "Note <private>sk-ant-testsecret1234567890</private> and bearer token Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9";
    const result = sanitizePayload(raw);
    expect(result.sanitized).toContain("[REDACTED_PRIVATE]");
    expect(result.sanitized).not.toContain("eyJhbGciOiJIUzI1Ni");
    expect(result.privateBlocksRemoved).toBe(1);
    expect(result.secretsMasked).toBe(1);
  });

  it("handles custom secret patterns", () => {
    const raw = "My custom token CUSTOM_1234567890abcdef";
    const customPattern = /CUSTOM_[a-zA-Z0-9]{10,}/g;
    const res = maskSecrets(raw, [customPattern]);
    expect(res.sanitized).toBe("My custom token [REDACTED_SECRET]");
    expect(res.count).toBe(1);
  });

  it("handles strings without private tags or secrets gracefully", () => {
    const raw = "Normal text without any sensitive data";
    const result = sanitizePayload(raw);
    expect(result.sanitized).toBe(raw);
    expect(result.privateBlocksRemoved).toBe(0);
    expect(result.secretsMasked).toBe(0);
  });
});
