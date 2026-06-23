/**
 * EasyTech response envelopes — success types match vendor doc per endpoint.
 */
import type {
  EasyTechLoginResponse,
  EasyTechMeterControlResponse,
  EasyTechMeterInfoData,
  EasyTechMeterInfoResponse,
  EasyTechMeterListItem,
  EasyTechMeterListResponse
} from "./types.js";

export const loginOk = (userToken: string, adminToken: string): EasyTechLoginResponse => ({
  success: 1,
  userToken,
  adminToken
});

export const loginFail = (errorMsg: string, errorCode = 401): EasyTechLoginResponse => ({
  success: 0,
  errorMsg,
  errorCode
});

export const meterListOk = (items: EasyTechMeterListItem[]): EasyTechMeterListResponse => ({
  success: "1",
  data: items
});

export const meterListFail = (
  errorMsg: string,
  errorCode = "401"
): EasyTechMeterListResponse => ({
  success: "0",
  errorMsg,
  errorCode,
  data: []
});

export const meterInfoOk = (data: EasyTechMeterInfoData): EasyTechMeterInfoResponse => ({
  success: "1",
  data
});

export const meterInfoFail = (errorMsg: string, errorCode?: string): EasyTechMeterInfoResponse => {
  const body: EasyTechMeterInfoResponse = { success: "0", errorMsg, data: null };
  if (errorCode !== undefined) body.errorCode = errorCode;
  return body;
};

export const meterControlOk = (msgid: string, addr: string): EasyTechMeterControlResponse => ({
  success: 1,
  data: { msgid, addr }
});

export const meterControlFail = (errorMsg: string, errorCode?: string): EasyTechMeterControlResponse => {
  const body: EasyTechMeterControlResponse = { success: 2, errorMsg };
  if (errorCode !== undefined) body.errorCode = errorCode;
  return body;
};
