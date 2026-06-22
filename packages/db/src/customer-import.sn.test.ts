import test from "node:test";
import assert from "node:assert/strict";
import { normalizeImportSn } from "./customer-import.js";

test("normalizeImportSn handles Excel scientific notation", () => {
  assert.equal(normalizeImportSn("2.4042809890002E+13"), "24042809890002");
  assert.equal(normalizeImportSn("24042809890002.0"), "24042809890002");
  assert.equal(normalizeImportSn(" 25033106593193 "), "25033106593193");
});
