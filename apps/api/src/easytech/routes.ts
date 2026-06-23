/**
 * EasyTech Prepaid API — HTTP routes (vendor path layout).
 */
import crypto from "node:crypto";
import type { Express } from "express";
import {
  getDeviceTelemetry,
  listFleetDevices,
  resolveDeviceOnline
} from "@communication/db";
import { logEasyTechCall } from "./audit.js";
import { performEasyTechLogin, parseEasyTechAuth } from "./auth.js";
import { emptyTelemetrySnapshot, toMeterInfoData, toMeterListItem } from "./mappers.js";
import {
  loginFail,
  meterControlFail,
  meterControlOk,
  meterInfoFail,
  meterInfoOk,
  meterListFail,
  meterListOk
} from "./responses.js";
import { EASYTECH_CONTROL_METHOD, EASYTECH_PATHS } from "./spec.js";
import type { EasyTechRouteDeps } from "./types.js";

export const registerEasyTechRoutes = (app: Express, deps: EasyTechRouteDeps): void => {
  app.post(EASYTECH_PATHS.login, async (req, res) => {
    const started = Date.now();
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password.trim() : "";
    if (!username || !password) {
      const response = loginFail("missing_credentials", 400);
      logEasyTechCall(deps.pool, req, {
        username: username || null,
        direction: "auth",
        endpoint: EASYTECH_PATHS.login,
        httpMethod: "POST",
        success: false,
        errorMsg: response.errorMsg ?? "missing_credentials",
        durationMs: Date.now() - started
      });
      res.status(200).json(response);
      return;
    }
    try {
      const { response, audit } = await performEasyTechLogin(deps.pool, deps.jwtSecret, username, password);
      logEasyTechCall(deps.pool, req, {
        username: audit.username,
        customerId: audit.customerId,
        panelUserId: audit.panelUserId,
        direction: "auth",
        endpoint: EASYTECH_PATHS.login,
        httpMethod: "POST",
        success: response.success === 1,
        errorMsg: response.errorMsg ?? null,
        durationMs: Date.now() - started
      });
      res.status(200).json(response);
    } catch (error) {
      console.error("[easytech] login failed", {
        username,
        message: error instanceof Error ? error.message : error
      });
      logEasyTechCall(deps.pool, req, {
        username,
        direction: "auth",
        endpoint: EASYTECH_PATHS.login,
        httpMethod: "POST",
        success: false,
        errorMsg: "login_failed",
        durationMs: Date.now() - started
      });
      res.status(200).json(loginFail("login_failed", 500));
    }
  });

  app.get(EASYTECH_PATHS.getMeterList, async (req, res) => {
    const started = Date.now();
    const auth = parseEasyTechAuth(deps, req, "read");
    if (!auth) {
      logEasyTechCall(deps.pool, req, {
        direction: "read",
        endpoint: EASYTECH_PATHS.getMeterList,
        httpMethod: "GET",
        success: false,
        errorMsg: "unauthorized",
        durationMs: Date.now() - started
      });
      res.status(200).json(meterListFail("unauthorized"));
      return;
    }
    try {
      const result = await listFleetDevices(deps.pool, {
        customerId: auth.customerId,
        limit: 500,
        offset: 0
      });
      logEasyTechCall(deps.pool, req, {
        auth,
        direction: "read",
        endpoint: EASYTECH_PATHS.getMeterList,
        httpMethod: "GET",
        success: true,
        durationMs: Date.now() - started
      });
      res.status(200).json(meterListOk(result.items.map(toMeterListItem)));
    } catch (error) {
      console.error("[easytech] getMeterList failed", {
        customerId: auth.customerId,
        message: error instanceof Error ? error.message : error
      });
      logEasyTechCall(deps.pool, req, {
        auth,
        direction: "read",
        endpoint: EASYTECH_PATHS.getMeterList,
        httpMethod: "GET",
        success: false,
        errorMsg: "failed_to_list",
        durationMs: Date.now() - started
      });
      res.status(200).json(meterListFail("failed_to_list"));
    }
  });

  app.post(EASYTECH_PATHS.getMeterInfo, async (req, res) => {
    const started = Date.now();
    const auth = parseEasyTechAuth(deps, req, "read");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const roomNo = typeof body.roomNo === "string" ? body.roomNo.trim() : "";
    if (!auth) {
      logEasyTechCall(deps.pool, req, {
        direction: "read",
        endpoint: EASYTECH_PATHS.getMeterInfo,
        httpMethod: "POST",
        roomNo: roomNo || null,
        success: false,
        errorMsg: "unauthorized",
        durationMs: Date.now() - started
      });
      res.status(200).json(meterInfoFail("unauthorized"));
      return;
    }
    if (!roomNo) {
      logEasyTechCall(deps.pool, req, {
        auth,
        direction: "read",
        endpoint: EASYTECH_PATHS.getMeterInfo,
        httpMethod: "POST",
        success: false,
        errorMsg: "missing_roomNo",
        durationMs: Date.now() - started
      });
      res.status(200).json(meterInfoFail("missing_roomNo"));
      return;
    }
    try {
      const sn = await deps.findDeviceByRoom(auth.customerId, roomNo);
      if (!sn) {
        logEasyTechCall(deps.pool, req, {
          auth,
          direction: "read",
          endpoint: EASYTECH_PATHS.getMeterInfo,
          httpMethod: "POST",
          roomNo,
          success: false,
          errorMsg: "meter_not_found",
          durationMs: Date.now() - started
        });
        res.status(200).json(meterInfoFail("meter_not_found"));
        return;
      }
      const devRes = await deps.pool.query<{ meter_usage: string; model: string | null }>(
        "SELECT meter_usage, model FROM devices WHERE sn = $1 AND customer_id = $2",
        [sn, auth.customerId]
      );
      const dev = devRes.rows[0];
      if (!dev) {
        logEasyTechCall(deps.pool, req, {
          auth,
          direction: "read",
          endpoint: EASYTECH_PATHS.getMeterInfo,
          httpMethod: "POST",
          roomNo,
          sn,
          success: false,
          errorMsg: "meter_not_found",
          durationMs: Date.now() - started
        });
        res.status(200).json(meterInfoFail("meter_not_found"));
        return;
      }
      const tel = (await getDeviceTelemetry(deps.pool, sn)) ?? emptyTelemetrySnapshot(sn);
      const online = await resolveDeviceOnline(deps.pool, sn, 300);
      logEasyTechCall(deps.pool, req, {
        auth,
        direction: "read",
        endpoint: EASYTECH_PATHS.getMeterInfo,
        httpMethod: "POST",
        roomNo,
        sn,
        success: true,
        durationMs: Date.now() - started
      });
      res.status(200).json(
        meterInfoOk(
          toMeterInfoData({
            sn,
            roomNo,
            meterUsage: String(dev.meter_usage ?? "prepaid"),
            model: dev.model ?? null,
            telemetry: tel,
            online
          })
        )
      );
    } catch (error) {
      console.error("[easytech] getMeterInfo failed", {
        customerId: auth.customerId,
        roomNo,
        message: error instanceof Error ? error.message : error
      });
      logEasyTechCall(deps.pool, req, {
        auth,
        direction: "read",
        endpoint: EASYTECH_PATHS.getMeterInfo,
        httpMethod: "POST",
        roomNo,
        success: false,
        errorMsg: "failed_to_get_meter",
        durationMs: Date.now() - started
      });
      res.status(200).json(meterInfoFail("failed_to_get_meter"));
    }
  });

  app.post(EASYTECH_PATHS.meterControl, async (req, res) => {
    const started = Date.now();
    const auth = parseEasyTechAuth(deps, req, "control");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const gatewaySn = typeof body.gatewaySn === "string" ? body.gatewaySn.trim() : "";
    const meterSn = typeof body.meterSn === "string" ? body.meterSn.trim() : "";
    const method = typeof body.method === "string" ? body.method.trim() : "";
    const value = (body.value && typeof body.value === "object" ? body.value : {}) as Record<
      string,
      unknown
    >;
    const sn = meterSn || gatewaySn;
    const rawSwitch = value.ForceSwitch;
    const switchVal: 0 | 1 | null =
      rawSwitch === 0 || rawSwitch === "0" ? 0 : rawSwitch === 1 || rawSwitch === "1" ? 1 : null;

    const logControl = (success: boolean, errorMsg: string | null, snVal?: string | null) => {
      logEasyTechCall(deps.pool, req, {
        auth: auth ?? null,
        direction: "control",
        endpoint: EASYTECH_PATHS.meterControl,
        httpMethod: "POST",
        sn: snVal ?? sn ?? null,
        switchValue: switchVal,
        success,
        errorMsg,
        durationMs: Date.now() - started
      });
    };

    if (!auth) {
      logControl(false, "unauthorized");
      res.status(200).json(meterControlFail("unauthorized"));
      return;
    }
    if (!sn || method !== EASYTECH_CONTROL_METHOD) {
      logControl(false, "invalid_request");
      res.status(200).json(meterControlFail("invalid_request"));
      return;
    }
    if (switchVal === null) {
      logControl(false, "invalid_ForceSwitch", sn);
      res.status(200).json(meterControlFail("invalid_ForceSwitch"));
      return;
    }
    try {
      const owned = await deps.pool.query("SELECT 1 FROM devices WHERE sn = $1 AND customer_id = $2", [
        sn,
        auth.customerId
      ]);
      if (!owned.rows[0]) {
        logControl(false, "meter_not_found", sn);
        res.status(200).json(meterControlFail("meter_not_found"));
        return;
      }
      const msgid = crypto.randomBytes(8).toString("hex");
      const setBy = `easytech:${auth.username}`;
      const result = await deps.setDesiredSwitch(sn, switchVal, setBy);
      if (!result) {
        logControl(false, "device_not_found", sn);
        res.status(200).json(meterControlFail("device_not_found"));
        return;
      }
      logControl(true, null, sn);
      res.status(200).json(meterControlOk(msgid, sn));
    } catch (error) {
      const message = error instanceof Error ? error.message : "control_failed";
      if (message === "device_not_registered") {
        logControl(false, "device_not_registered", sn);
        res.status(200).json(meterControlFail("device_not_registered"));
        return;
      }
      console.error("[easytech] meterControl failed", { sn, switchVal, message });
      logControl(false, message, sn);
      res.status(200).json(meterControlFail(message));
    }
  });
};
