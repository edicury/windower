import { describe, expect, it } from "vitest";
import { REDACTION_MARKER, createRedactedLogger, createRedactor } from "./redaction.js";
import { referencedPlaceholders, substituteSecrets } from "./secrets.js";

const SECRET = "hunter2-Sup3rSecret-Value";

describe("redactor", () => {
  it("replaces a known secret value with its placeholder, anywhere in a string", () => {
    const redactor = createRedactor([{ name: "password", value: SECRET }]);
    expect(redactor.redactString(`typed ${SECRET} into the field`)).toBe(
      "typed {{password}} into the field",
    );
  });

  it("is case-insensitive", () => {
    const redactor = createRedactor([{ name: "password", value: SECRET }]);
    expect(redactor.redactString(SECRET.toUpperCase())).toBe("{{password}}");
  });

  it("catches high-entropy near-matches of a secret", () => {
    const redactor = createRedactor([{ name: "token", value: "sk-a1b2c3d4e5f6g7h8" }]);
    const mangled = "sk-a1b2c3d4e5f6g7h9";
    expect(redactor.redactString(`Authorization: ${mangled}`)).toContain("{{token}}");
    expect(redactor.redactString(`Authorization: ${mangled}`)).not.toContain(mangled);
  });

  it("uses a fixed marker when the secret has no resolvable name", () => {
    const redactor = createRedactor([{ name: "", value: SECRET }]);
    expect(redactor.redactString(SECRET)).toBe(REDACTION_MARKER);
  });

  it("deep-redacts nested objects, arrays, and object keys", () => {
    const redactor = createRedactor([{ name: "password", value: SECRET }]);
    const redacted = redactor.redact({
      steps: [{ toolCalls: [{ name: "type_text", args: { text: SECRET } }] }],
      [SECRET]: "key position",
    });
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(JSON.stringify(redacted)).toContain("{{password}}");
  });

  it("prefers the longest secret when one value contains another", () => {
    const redactor = createRedactor([
      { name: "short", value: "abcd1234" },
      { name: "long", value: "abcd1234efgh5678" },
    ]);
    expect(redactor.redactString("abcd1234efgh5678")).toBe("{{long}}");
  });

  it("reports whether a value still contains a secret", () => {
    const redactor = createRedactor([{ name: "password", value: SECRET }]);
    expect(redactor.isClean({ a: SECRET })).toBe(false);
    expect(redactor.isClean(redactor.redact({ a: SECRET }))).toBe(true);
  });
});

describe("redacted logger", () => {
  it("redacts both the message and the structured fields before the sink sees them", () => {
    const lines: string[] = [];
    const redactor = createRedactor([{ name: "password", value: SECRET }]);
    const logger = createRedactedLogger(redactor, (line) => lines.push(line));
    logger.log(`typing ${SECRET}`, { text: SECRET, nested: { value: SECRET } });
    expect(lines.join("\n")).not.toContain(SECRET);
    expect(lines.join("\n")).toContain("{{password}}");
  });
});

describe("secret substitution", () => {
  it("substitutes only known placeholders and leaves unknown ones verbatim", () => {
    const secrets = [{ name: "password", value: SECRET }];
    expect(substituteSecrets("{{password}}", secrets)).toBe(SECRET);
    expect(substituteSecrets("{{unknown}}", secrets)).toBe("{{unknown}}");
    expect(substituteSecrets("pre {{password}} post", secrets)).toBe(`pre ${SECRET} post`);
  });

  it("lists the placeholders referenced by a string", () => {
    expect(referencedPlaceholders("{{user}} and {{password}} and {{user}}")).toEqual([
      "user",
      "password",
    ]);
  });
});
