import type { Request } from "express";
import type { Pool } from "@communication/db";
import { insertIntegrationApiLog, type IntegrationApiDirection } from "@communication/db";
import type { EasyTechAuth } from "./types.js";

export const clientIpFromRequest = (req: Request): string | null => {
  const fwd = req.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]?.trim() || null;
  return req.socket.remoteAddress ?? null;
};

export const logEasyTechCall = (
  pool: Pool,
  req: Request,
  input: {
    auth?: EasyTechAuth | null;
    username?: string | null;
    customerId?: string | null;
    panelUserId?: string | null;
    direction: IntegrationApiDirection;
    endpoint: string;
    httpMethod: string;
    roomNo?: string | null;
    sn?: string | null;
    switchValue?: 0 | 1 | null;
    success: boolean;
    errorMsg?: string | null;
    durationMs: number;
  }
): void => {
  void insertIntegrationApiLog(pool, {
    customerId: input.customerId ?? input.auth?.customerId ?? null,
    panelUserId: input.panelUserId ?? input.auth?.userId ?? null,
    username: input.username ?? input.auth?.username ?? null,
    apiFamily: "easytech",
    direction: input.direction,
    endpoint: input.endpoint,
    httpMethod: input.httpMethod,
    roomNo: input.roomNo ?? null,
    sn: input.sn ?? null,
    switchValue: input.switchValue ?? null,
    success: input.success,
    errorMsg: input.errorMsg ?? null,
    durationMs: input.durationMs,
    clientIp: clientIpFromRequest(req)
  });
};
