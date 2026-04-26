import "@testing-library/jest-dom/vitest";

Object.defineProperty(globalThis, "crypto", {
  value: globalThis.crypto,
  writable: true
});
