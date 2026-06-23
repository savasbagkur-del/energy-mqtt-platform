import crypto from "node:crypto";
import type { Request } from "express";
import type { Pool } from "@communication/db";
import { getPanelUserByUsername, markPanelUserLogin } from "@communication/db";
import { EASYTECH_TOKEN_TTL_SEC } from "./spec.js";
import type { EasyTechAuth, EasyTechLoginResponse, EasyTechRouteDeps, EasyTechScope } from "./types.js";

export const md5Hex = (value: string): string =>
  crypto.createHash("md5").update(value, "utf8").digest("hex");

const safeEqualText = (a: string, b: string): boolean => {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
};

export const signEasyTechToken = (
  secret: Buffer,
  payload: { sub: string; customerId: string; username: string; scope: EasyTechScope }
): string => {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(
    JSON.stringify({
      ...payload,
      iss: "easytech-gateway",
      iat: now,
      exp: now + EASYTECH_TOKEN_TTL_SEC
    })
  ).toString("base64url");
  const data = `${header}.${body}`;
  const sig = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${sig}`;
};

export const verifyEasyTechToken = (secret: Buffer, token: string): Record<string, unknown> | null => {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts as [string, string, string];
  const expected = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  let claims: Record<string, unknown>;
  try {
    claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const exp = typeof claims.exp === "number" ? claims.exp : 0;
  if (exp <= Math.floor(Date.now() / 1000)) return null;
  if (claims.iss !== "easytech-gateway") return null;
  return claims;
};

export const readEasyTechToken = (req: Request): string | null => req.get("token")?.trim() || null;

export const parseEasyTechAuth = (
  deps: EasyTechRouteDeps,
  req: Request,
  scope: EasyTechScope
): EasyTechAuth | null => {
  const token = readEasyTechToken(req);
  if (!token) return null;
  const claims = verifyEasyTechToken(deps.jwtSecret, token);
  if (!claims || claims.scope !== scope) return null;
  const userId = typeof claims.sub === "string" ? claims.sub : "";
  const customerId = typeof claims.customerId === "string" ? claims.customerId : "";
  const username = typeof claims.username === "string" ? claims.username : "";
  if (!userId || !customerId) return null;
  return { userId, customerId, username, scope };
};

export const performEasyTechLogin = async (
  pool: Pool,
  jwtSecret: Buffer,
  username: string,
  passwordMd5: string
): Promise<EasyTechLoginResponse> => {
  const user = await getPanelUserByUsername(pool, username);
  if (!user || !user.is_active || !user.customer_id) {
    return { success: 0, errorMsg: "invalid_credentials", errorCode: 401 };
  }
  const custRes = await pool.query<{ integration_mode: string }>(
    "SELECT integration_mode FROM customers WHERE id = $1",
    [user.customer_id]
  );
  if (custRes.rows[0]?.integration_mode !== "api") {
    return { success: 0, errorMsg: "integration_mode_not_api", errorCode: 403 };
  }
  const storedMd5 = user.password_md5?.toLowerCase() ?? "";
  const presented = passwordMd5.toLowerCase();
  if (!storedMd5 || !safeEqualText(presented, storedMd5)) {
    return { success: 0, errorMsg: "invalid_credentials", errorCode: 401 };
  }
  const base = {
    sub: user.id,
    customerId: String(user.customer_id),
    username: user.username
  };
  void markPanelUserLogin(pool, user.id).catch(() => undefined);
  return {
    success: 1,
    userToken: signEasyTechToken(jwtSecret, { ...base, scope: "read" }),
    adminToken: signEasyTechToken(jwtSecret, { ...base, scope: "control" })
  };
};
