/**
 * EasyTech Prepaid API — HTTP routes (vendor path layout).
 *
 *   POST /login
 *   GET  /getMeterList       header: token = userToken
 *   POST /getMeterInfo       header: token = userToken, body: { roomNo }
 *   POST /meterControl       header: token = adminToken, body: FORCESWITCH
 */
import crypto from "node:crypto";
import type { Express } from "express";
import {
  getDeviceTelemetry,
  listFleetDevices,
  resolveDeviceOnline
} from "@communication/db";
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
import { EASYTECH_CONTROL_METHOD } from "./spec.js";
import type { EasyTechRouteDeps } from "./types.js";

export const registerEasyTechRoutes = (app: Express, deps: EasyTechRouteDeps): void => {
  // §1 Users login
  app.post("/login", async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const password = typeof body.password === "string" ? body.password.trim() : "";
    if (!username || !password) {
      res.status(200).json(loginFail("missing_credentials", 400));
      return;
    }
    try {
      const result = await performEasyTechLogin(deps.pool, deps.jwtSecret, username, password);
      res.status(200).json(result);
    } catch (error) {
      console.error("[easytech] login failed", {
        username,
        message: error instanceof Error ? error.message : error
      });
      res.status(200).json(loginFail("login_failed", 500));
    }
  });

  // §2 Get all meters assigned to the user
  app.get("/getMeterList", async (req, res) => {
    const auth = parseEasyTechAuth(deps, req, "read");
    if (!auth) {
      res.status(200).json(meterListFail("unauthorized"));
      return;
    }
    try {
      const result = await listFleetDevices(deps.pool, {
        customerId: auth.customerId,
        limit: 500,
        offset: 0
      });
      res.status(200).json(meterListOk(result.items.map(toMeterListItem)));
    } catch (error) {
      console.error("[easytech] getMeterList failed", {
        customerId: auth.customerId,
        message: error instanceof Error ? error.message : error
      });
      res.status(200).json(meterListFail("failed_to_list"));
    }
  });

  // §3 Obtain meter data (search by roomNo)
  app.post("/getMeterInfo", async (req, res) => {
    const auth = parseEasyTechAuth(deps, req, "read");
    if (!auth) {
      res.status(200).json(meterInfoFail("unauthorized"));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const roomNo = typeof body.roomNo === "string" ? body.roomNo.trim() : "";
    if (!roomNo) {
      res.status(200).json(meterInfoFail("missing_roomNo"));
      return;
    }
    try {
      const sn = await deps.findDeviceByRoom(auth.customerId, roomNo);
      if (!sn) {
        res.status(200).json(meterInfoFail("meter_not_found"));
        return;
      }
      const devRes = await deps.pool.query<{ meter_usage: string; model: string | null }>(
        "SELECT meter_usage, model FROM devices WHERE sn = $1 AND customer_id = $2",
        [sn, auth.customerId]
      );
      const dev = devRes.rows[0];
      if (!dev) {
        res.status(200).json(meterInfoFail("meter_not_found"));
        return;
      }
      const tel = (await getDeviceTelemetry(deps.pool, sn)) ?? emptyTelemetrySnapshot(sn);
      const online = await resolveDeviceOnline(deps.pool, sn, 300);
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
      res.status(200).json(meterInfoFail("failed_to_get_meter"));
    }
  });

  // §4 Control meter switch (FORCESWITCH → MQTT pipeline)
  app.post("/meterControl", async (req, res) => {
    const auth = parseEasyTechAuth(deps, req, "control");
    if (!auth) {
      res.status(200).json(meterControlFail("unauthorized"));
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const gatewaySn = typeof body.gatewaySn === "string" ? body.gatewaySn.trim() : "";
    const meterSn = typeof body.meterSn === "string" ? body.meterSn.trim() : "";
    const method = typeof body.method === "string" ? body.method.trim() : "";
    const value = (body.value && typeof body.value === "object" ? body.value : {}) as Record<
      string,
      unknown
    >;
    const sn = meterSn || gatewaySn;
    if (!sn || method !== EASYTECH_CONTROL_METHOD) {
      res.status(200).json(meterControlFail("invalid_request"));
      return;
    }
    const rawSwitch = value.ForceSwitch;
    const switchVal: 0 | 1 | null =
      rawSwitch === 0 || rawSwitch === "0" ? 0 : rawSwitch === 1 || rawSwitch === "1" ? 1 : null;
    if (switchVal === null) {
      res.status(200).json(meterControlFail("invalid_ForceSwitch"));
      return;
    }
    try {
      const owned = await deps.pool.query("SELECT 1 FROM devices WHERE sn = $1 AND customer_id = $2", [
        sn,
        auth.customerId
      ]);
      if (!owned.rows[0]) {
        res.status(200).json(meterControlFail("meter_not_found"));
        return;
      }
      const msgid = crypto.randomBytes(8).toString("hex");
      const setBy = `easytech:${auth.username}`;
      const result = await deps.setDesiredSwitch(sn, switchVal, setBy);
      if (!result) {
        res.status(200).json(meterControlFail("device_not_found"));
        return;
      }
      res.status(200).json(meterControlOk(msgid, sn));
    } catch (error) {
      const message = error instanceof Error ? error.message : "control_failed";
      if (message === "device_not_registered") {
        res.status(200).json(meterControlFail("device_not_registered"));
        return;
      }
      console.error("[easytech] meterControl failed", { sn, switchVal, message });
      res.status(200).json(meterControlFail(message));
    }
  });
};
