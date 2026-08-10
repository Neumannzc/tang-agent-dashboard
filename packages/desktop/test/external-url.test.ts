import assert from "node:assert/strict";
import test from "node:test";

import { isSafeExternalUrl } from "../src/external-url.js";

test("isSafeExternalUrl accepts HTTP and HTTPS URLs", () => {
  // Given: representative absolute HTTP(S) destinations
  const urls = [
    "https://example.com",
    "http://127.0.0.1:8080/path?q=1#frag",
    "http://example.com",
  ];

  // When: each destination is validated for external opening
  const results = urls.map(isSafeExternalUrl);

  // Then: every supported URL is allowed
  assert.deepEqual(results, [true, true, true]);
});

test("isSafeExternalUrl rejects unsafe and malformed URLs", () => {
  // Given: unsupported schemes and invalid absolute URL forms
  const urls = [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,x",
    "blob:https://example.com/id",
    "mailto:a@b.com",
    "not a url",
    "://bad",
    "//example.com",
    "///etc/passwd",
  ];

  // When: each destination is validated for external opening
  const results = urls.map(isSafeExternalUrl);

  // Then: none can be delegated to the system shell
  assert.deepEqual(results, [false, false, false, false, false, false, false, false, false]);
});
