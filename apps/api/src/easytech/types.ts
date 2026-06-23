/**
 * EasyTech Prepaid API — TypeScript shapes aligned with vendor documentation.
 */

/** §1 POST /login — request body */
export interface EasyTechLoginRequest {
  username: string;
  /** MD5 hex digest of plain password (vendor requirement). */
  password: string;
}

/** §1 POST /login — success / failure envelope (success is Integer) */
export interface EasyTechLoginResponse {
  success: 0 | 1;
  userToken?: string;
  adminToken?: string;
  errorMsg?: string;
  errorCode?: number;
}

/** §2 GET /getMeterList — data[] item (success is String in vendor doc) */
export interface EasyTechMeterListItem {
  meterID: string;
  roomNo: string;
  balance: number;
  epi: number;
  togetherMoney: number;
  oweMoney: boolean;
  controlMode: boolean;
  switchSta: number;
  unConnect: number;
  together: boolean;
  credit: number;
}

export interface EasyTechMeterListResponse {
  success: string;
  data: EasyTechMeterListItem[];
  errorMsg?: string;
  errorCode?: string;
}

/** §3 POST /getMeterInfo — request body */
export interface EasyTechMeterInfoRequest {
  roomNo: string;
}

/** §3 POST /getMeterInfo — data object */
export interface EasyTechMeterInfoData {
  meterID: string;
  roomNo: string;
  startMoney: number;
  totalMoney: number;
  buyTimes: number;
  alarmA: number;
  alarmB: number;
  priceSharp: number;
  pricePeak: number;
  priceFlat: number;
  priceValley: number;
  model: string;
  balance: number;
  togetherMoney: number;
  p: number;
  epi: number;
  oweMoney: boolean;
  userStatus: number;
  controlMode: string;
  switchSta: string;
  unConnect: number;
  ct: number;
  createTime: string;
  ub: number;
  uc: number;
  Ia: number;
  Ib: number;
  Ic: number;
  ua: number;
}

export interface EasyTechMeterInfoResponse {
  success: string;
  data: EasyTechMeterInfoData | null;
  errorMsg?: string;
  errorCode?: string;
}

/** §4 POST /meterControl — request body */
export interface EasyTechMeterControlRequest {
  gatewaySn: string;
  meterSn: string;
  method: "FORCESWITCH";
  value: { ForceSwitch: 0 | 1 };
}

/** §4 POST /meterControl — response (success is Integer: 1 ok, 2 failed) */
export interface EasyTechMeterControlResponse {
  success: 1 | 2;
  errorMsg?: string;
  errorCode?: string;
  data?: {
    msgid: string;
    addr: string;
  };
}

export type EasyTechScope = "read" | "control";

export interface EasyTechAuth {
  userId: string;
  customerId: string;
  username: string;
  scope: EasyTechScope;
}

export interface EasyTechRouteDeps {
  pool: import("@communication/db").Pool;
  jwtSecret: Buffer;
  setDesiredSwitch: (
    sn: string,
    value: 0 | 1,
    setBy: string | null
  ) => Promise<{ row: unknown } | null>;
  findDeviceByRoom: (customerId: string, roomNo: string) => Promise<string | null>;
}
