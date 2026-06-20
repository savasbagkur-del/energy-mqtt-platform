import assert from "node:assert/strict";
import { test } from "node:test";
import { buildMeterName, METER_NAME_PLACEHOLDER } from "./meter-name.js";

test("buildMeterName joins project, model and sn", () => {
  assert.equal(
    buildMeterName("SavasEvi", "ADL300", "25033106593193"),
    "SavasEvi-ADL300-25033106593193"
  );
});

test("buildMeterName trims surrounding whitespace on parts", () => {
  assert.equal(buildMeterName("  VeliEvi ", " ADL200 ", "123"), "VeliEvi-ADL200-123");
});

test("buildMeterName uses placeholder for a blank project name", () => {
  assert.equal(buildMeterName("", "ADL300", "123"), `${METER_NAME_PLACEHOLDER}-ADL300-123`);
  assert.equal(buildMeterName("   ", "ADL300", "123"), `${METER_NAME_PLACEHOLDER}-ADL300-123`);
});

test("buildMeterName uses placeholder for null/undefined parts", () => {
  assert.equal(buildMeterName(null, null, "123"), "NA-NA-123");
  assert.equal(buildMeterName(undefined, "ADL200", "123"), "NA-ADL200-123");
});

test("buildMeterName uses placeholder for a missing model", () => {
  assert.equal(buildMeterName("SavasEvi", null, "123"), "SavasEvi-NA-123");
});
