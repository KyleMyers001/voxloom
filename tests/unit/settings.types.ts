import type { AppAction } from "../../src/app/state";

const validSetting: AppAction = {
  key: "startAtLogin",
  type: "set-setting",
  value: true,
};

const invalidSetting: AppAction = {
  key: "startAtLogin",
  type: "set-setting",
  // @ts-expect-error Boolean settings reject string values.
  value: "yes",
};

void invalidSetting;
void validSetting;
