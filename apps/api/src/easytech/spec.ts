/**
 * EasyTech Prepaid API — canonical contract (from vendor documentation).
 *
 * Base URL (vendor): https://api.energy-easytech.com
 * Notes: paths are case-sensitive; tokens expire after 2 hours.
 *
 * Our gateway exposes the same paths on the Volt4Amper API host when
 * customers.integration_mode = 'api'.
 */

export const EASYTECH_TOKEN_TTL_SEC = 2 * 60 * 60;

/** Paths registered by the gateway (case-sensitive). */
export const EASYTECH_PATHS = {
  login: "/login",
  getMeterList: "/getMeterList",
  getMeterInfo: "/getMeterInfo",
  meterControl: "/meterControl"
} as const;

export const EASYTECH_PATH_SET = new Set<string>(Object.values(EASYTECH_PATHS));

/** Vendor control method name (only method in the document). */
export const EASYTECH_CONTROL_METHOD = "FORCESWITCH";

/**
 * Field inventory — grouped exactly as in the PDF sections.
 * Used by mappers to ensure every documented response key is present.
 */

/** §1 POST /login — response */
export const LOGIN_RESPONSE_FIELDS = [
  "success",
  "userToken",
  "adminToken",
  "errorMsg",
  "errorCode"
] as const;

/** §2 GET /getMeterList — data[] item fields */
export const METER_LIST_ITEM_FIELDS = [
  "meterID",
  "roomNo",
  "balance",
  "epi",
  "togetherMoney",
  "oweMoney",
  "controlMode",
  "switchSta",
  "unConnect",
  "together",
  "credit"
] as const;

/** §3 POST /getMeterInfo — data object fields */
export const METER_INFO_FIELDS = [
  "meterID",
  "roomNo",
  "startMoney",
  "totalMoney",
  "buyTimes",
  "alarmA",
  "alarmB",
  "priceSharp",
  "pricePeak",
  "priceFlat",
  "priceValley",
  "model",
  "balance",
  "togetherMoney",
  "p",
  "epi",
  "oweMoney",
  "userStatus",
  "controlMode",
  "switchSta",
  "unConnect",
  "ct",
  "createTime",
  "ub",
  "uc",
  "Ia",
  "Ib",
  "Ic",
  "ua"
] as const;

/** §4 POST /meterControl — response data */
export const METER_CONTROL_DATA_FIELDS = ["msgid", "addr"] as const;

/** switchSta semantics (document): 0 = off (opening), 1 = on (closing) */
export const SWITCH_OFF = 0 as const;
export const SWITCH_ON = 1 as const;

/** unConnect semantics (document): 0 = online, 1 = offline */
export const UNCONNECT_ONLINE = 0 as const;
export const UNCONNECT_OFFLINE = 1 as const;

/** userStatus (document): 0 = account opened, 1 = not opened */
export const USER_STATUS_OPEN = 0 as const;

/** controlMode in getMeterInfo (document): "0" prepaid, "1" forced/postpaid */
export const CONTROL_MODE_PREPAID = "0" as const;
export const CONTROL_MODE_FORCED = "1" as const;
