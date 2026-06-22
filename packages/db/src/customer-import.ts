import type { Pool } from "pg";
import { getDeviceRegistry, registerDevice } from "./device-registry.js";
import { createCustomerWithAccount, type CreateCustomerAccountInput } from "./customers.js";

export const CUSTOMER_IMPORT_TEMPLATE = [
  "musteri_adi,telefon,eposta,baglanti,kullanici,parola,seri_no,daire_dukkan,usage,not",
  "Örnek Müşteri A,05551234567,ornek@mail.com,panel,ornek.kullanici,Sifre123!,24042809890001,A-12,prepaid,",
  "Örnek Müşteri A,05551234567,ornek@mail.com,panel,ornek.kullanici,Sifre123!,24042809890002,B-03,prepaid,",
  "Örnek Müşteri B,05559876543,,api,,,24042809890003,Dükkan 1,prepaid,3. parti yazılım"
].join("\r\n");

const pick = (row: Record<string, string>, ...keys: string[]): string => {
  for (const k of keys) {
    const v = row[k]?.trim();
    if (v) return v;
  }
  // Case-insensitive / Turkish header fallback (Excel export as CSV)
  const lower = Object.fromEntries(
    Object.entries(row).map(([k, v]) => [k.trim().toLowerCase().replace(/\*+$/, "").trim(), v])
  );
  for (const k of keys) {
    const v = lower[k.trim().toLowerCase().replace(/\*+$/, "").trim()];
    if (v?.trim()) return v.trim();
  }
  return "";
};

export interface ParsedCustomerImportMeter {
  rowNum: number;
  sn: string;
  unitNo: string | null;
  meterUsage: MeterUsage;
}

export interface ParsedCustomerImportGroup {
  key: string;
  rowNums: number[];
  name: string;
  phone: string;
  email: string | null;
  notes: string | null;
  integrationMode: "panel" | "api";
  username: string;
  password: string;
  meters: ParsedCustomerImportMeter[];
}

export interface CustomerImportParseError {
  rowNum: number;
  message: string;
}

export interface QuarantineMatchInfo {
  sn: string;
  model: string | null;
  last_seen_at: string | null;
  matchType: "exact" | "suffix";
}

export interface CustomerImportMeterPreview extends ParsedCustomerImportMeter {
  quarantineMatch: QuarantineMatchInfo | null;
  quarantineOptions: QuarantineMatchInfo[];
}

export interface CustomerImportPreviewGroup {
  key: string;
  name: string;
  phone: string;
  email: string | null;
  notes: string | null;
  integrationMode: "panel" | "api";
  username: string;
  hasPassword: boolean;
  password: string;
  meters: CustomerImportMeterPreview[];
  errors: string[];
}

export interface CustomerImportPreviewResult {
  customers: CustomerImportPreviewGroup[];
  errors: CustomerImportParseError[];
  totalRows: number;
}

export interface CustomerImportConfirmCustomer {
  name: string;
  phone: string;
  email?: string | null;
  notes?: string | null;
  integrationMode: "panel" | "api";
  username?: string;
  password?: string;
  passwordHash?: string;
  meters: Array<{
    sn: string;
    unitNo?: string | null;
    meterUsage?: MeterUsage;
    linkQuarantine?: boolean;
    quarantineSn?: string | null;
  }>;
}

export interface CustomerImportApplyResult {
  customersCreated: number;
  metersRegistered: number;
  quarantineLinked: number;
  failed: Array<{ name: string; error: string }>;
}

const normalizeIntegration = (raw: string): "panel" | "api" => {
  const t = raw.trim().toLowerCase();
  if (!t || t === "panel / api" || t === "panel veya api" || t === "panel,api") return "panel";
  if (t === "api" || t === "3. parti" || t === "3.parti" || t === "3parti") return "api";
  return "panel";
};

export type MeterUsage = "prepaid" | "analysis";

/** Normalize SN from Excel/CSV (scientific notation, trailing .0, spaces). */
export const normalizeImportSn = (raw: string): string => {
  let s = String(raw ?? "").trim().replace(/\s/g, "");
  if (!s) return "";
  if (/^[\d.]+e[+-]?\d+$/i.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) s = String(Math.trunc(n));
  }
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
  if (typeof raw === "number" || /^\d+$/.test(s)) {
    s = s.replace(/\D/g, "");
  }
  return s;
};

const normalizeUsage = (raw: string): MeterUsage => {
  const t = raw.trim().toLowerCase();
  if (t === "analiz" || t === "analysis" || t === "postpaid") return "analysis";
  return "prepaid";
};

export const parseCustomerImportRows = (
  rows: Array<Record<string, string>>
): { groups: ParsedCustomerImportGroup[]; errors: CustomerImportParseError[] } => {
  const errors: CustomerImportParseError[] = [];
  const map = new Map<string, ParsedCustomerImportGroup>();
  const meterSeen = new Set<string>();

  rows.forEach((row, idx) => {
    const rowNum = idx + 2;
    const name = pick(row, "musteri_adi", "customer_name", "name", "ad_unvan", "müşteri adı", "musteri adi");
    const phone = pick(row, "telefon", "phone", "iletisim");
    const sn = pick(row, "seri_no", "meter_sn", "sn", "seri", "sayaç seri no", "sayac seri no");
    if (!name && !phone && !sn) return;

    if (!name) {
      errors.push({ rowNum, message: "musteri_adi zorunlu" });
      return;
    }
    if (!phone) {
      errors.push({ rowNum, message: "telefon zorunlu" });
      return;
    }
    const phoneNorm = phone.replace(/\s/g, "");
    if (!/^\+?\d{10,15}$/.test(phoneNorm)) {
      errors.push({ rowNum, message: "geçersiz telefon" });
      return;
    }

    const key = `${name.toLowerCase()}|${phoneNorm}`;
    let group = map.get(key);
    if (!group) {
      group = {
        key,
        rowNums: [],
        name,
        phone,
        email: pick(row, "eposta", "email") || null,
        notes: pick(row, "not", "notes") || null,
        integrationMode: normalizeIntegration(pick(row, "baglanti", "integration_mode", "integrationMode", "bağlantı tipi", "baglanti tipi")),
        username: pick(row, "kullanici", "username", "kullanici_adi", "giriş kullanıcı adı", "giris kullanici adi", "panel kullanıcı", "panel kullanici"),
        password: pick(row, "parola", "password", "sifre"),
        meters: []
      };
      map.set(key, group);
    } else {
      const email = pick(row, "eposta", "email");
      const notes = pick(row, "not", "notes");
      if (email) group.email = email;
      if (notes) group.notes = notes;
      const user = pick(row, "kullanici", "username");
      const pass = pick(row, "parola", "password");
      if (user) group.username = user;
      if (pass) group.password = pass;
    }
    group.rowNums.push(rowNum);

    if (sn) {
      const snNorm = normalizeImportSn(sn);
      if (!snNorm) return;
      const snKey = snNorm.toLowerCase();
      if (meterSeen.has(snKey)) {
        errors.push({ rowNum, message: `tekrarlayan seri no: ${snNorm}` });
        return;
      }
      meterSeen.add(snKey);
      group.meters.push({
        rowNum,
        sn: snNorm,
        unitNo: pick(row, "daire_dukkan", "unit_no", "unitNo", "daire", "daire / dükkan", "daire / dukkan") || null,
        meterUsage: normalizeUsage(pick(row, "usage", "meter_usage", "meterUsage") || "prepaid")
      });
    }
  });

  return { groups: [...map.values()], errors };
};

const toMatchInfo = (row: { sn: string; model?: string | null; last_seen_at?: string | null }, matchType: "exact" | "suffix"): QuarantineMatchInfo => ({
  sn: row.sn,
  model: row.model ?? null,
  last_seen_at: row.last_seen_at ?? null,
  matchType
});

/** Unassigned devices in the registry that can be linked to a customer meter. */
const LINKABLE_FIELD_DEVICE_SQL = `d.customer_id IS NULL`;

export const isLinkableFieldDevice = (row: {
  registry_status?: string | null;
  customer_id?: string | null;
} | null | undefined): boolean => !!row && !row.customer_id;

export const findQuarantineMatchesForSn = async (
  pool: Pool,
  sn: string
): Promise<{ best: QuarantineMatchInfo | null; options: QuarantineMatchInfo[] }> => {
  const trimmed = normalizeImportSn(sn);
  if (!trimmed) return { best: null, options: [] };

  const pickBest = (rows: Array<{ sn: string; model: string | null; last_seen_at: string | null }>) => {
    const options = rows.map((r) =>
      toMatchInfo(r, r.sn === trimmed || normalizeImportSn(r.sn) === trimmed ? "exact" : "suffix")
    );
    const exactIn = options.find((o) => o.sn === trimmed || normalizeImportSn(o.sn) === trimmed);
    if (exactIn) return { best: exactIn, options };
    if (options.length === 1) return { best: options[0]!, options };
    return { best: null, options };
  };

  // 1) Exact linkable field SN (no row cap — one SN = one row)
  const exactQ = await pool.query<{ sn: string; model: string | null; last_seen_at: string | null }>(
    `SELECT d.sn, d.model, d.last_seen_at
     FROM devices d
     WHERE ${LINKABLE_FIELD_DEVICE_SQL} AND d.sn = $1`,
    [trimmed]
  );
  if (exactQ.rows[0]) {
    const info = toMatchInfo(exactQ.rows[0], "exact");
    return { best: info, options: [info] };
  }

  // 2) Digit-normalized exact (handles formatting differences)
  const digits = trimmed.replace(/\D/g, "");
  if (digits) {
    const digitQ = await pool.query<{ sn: string; model: string | null; last_seen_at: string | null }>(
      `SELECT d.sn, d.model, d.last_seen_at
       FROM devices d
       WHERE ${LINKABLE_FIELD_DEVICE_SQL}
         AND regexp_replace(d.sn, '[^0-9]', '', 'g') = $1
       ORDER BY (d.sn = $2) DESC, d.last_seen_at DESC NULLS LAST`,
      [digits, trimmed]
    );
    if (digitQ.rows.length) return pickBest(digitQ.rows);
  }

  // 3) Suffix fallback — only for short / partial SN (not full meter serials)
  if (trimmed.length >= 10) return { best: null, options: [] };

  const tailLen = trimmed.length >= 6 ? 4 : 2;
  const tail = trimmed.slice(-tailLen);
  if (tail.length < 2) return { best: null, options: [] };

  const res = await pool.query<{ sn: string; model: string | null; last_seen_at: string | null }>(
    `SELECT d.sn, d.model, d.last_seen_at
     FROM devices d
     WHERE ${LINKABLE_FIELD_DEVICE_SQL} AND d.sn LIKE $1
     ORDER BY
       CASE WHEN d.sn = $2 THEN 0 ELSE 1 END,
       d.last_seen_at DESC NULLS LAST`,
    [`%${tail}`, trimmed]
  );
  const suffixRows = res.rows.filter((r) => r.sn.toLowerCase().endsWith(tail.toLowerCase()));
  return pickBest(suffixRows);
};

export const previewCustomerImport = async (
  pool: Pool,
  rows: Array<Record<string, string>>
): Promise<CustomerImportPreviewResult> => {
  const { groups, errors } = parseCustomerImportRows(rows);
  const customers: CustomerImportPreviewGroup[] = [];

  for (const g of groups) {
    const groupErrors: string[] = [];
    if (g.integrationMode === "panel") {
      if (!g.username || g.username.length < 3) groupErrors.push("panel modu: kullanici en az 3 karakter");
      if (!g.password || g.password.length < 8) groupErrors.push("panel modu: parola en az 8 karakter");
    }

    const meters: CustomerImportMeterPreview[] = [];
    for (const m of g.meters) {
      const { best, options } = await findQuarantineMatchesForSn(pool, m.sn);
      meters.push({ ...m, quarantineMatch: best, quarantineOptions: options });
    }

    customers.push({
      key: g.key,
      name: g.name,
      phone: g.phone,
      email: g.email,
      notes: g.notes,
      integrationMode: g.integrationMode,
      username: g.username,
      hasPassword: g.password.length >= 8,
      password: g.password,
      meters,
      errors: groupErrors
    });
  }

  return { customers, errors, totalRows: rows.length };
};

export const applyCustomerImport = async (
  pool: Pool,
  customers: CustomerImportConfirmCustomer[],
  hashPassword: (pw: string) => string
): Promise<CustomerImportApplyResult> => {
  let customersCreated = 0;
  let metersRegistered = 0;
  let quarantineLinked = 0;
  const failed: Array<{ name: string; error: string }> = [];

  for (const c of customers) {
    try {
      const integrationMode = c.integrationMode === "api" ? "api" : "panel";
      const panelOn = integrationMode === "panel";
      const metersInput: CreateCustomerAccountInput["meters"] = [];

      for (const m of c.meters ?? []) {
        const sn = m.sn.trim();
        if (!sn) continue;
        let registerSn = sn;
        if (m.linkQuarantine && m.quarantineSn) registerSn = m.quarantineSn.trim();
        else if (m.linkQuarantine) registerSn = sn;

        if (m.linkQuarantine) {
          const ex = await getDeviceRegistry(pool, registerSn);
          if (isLinkableFieldDevice(ex)) quarantineLinked += 1;
        }

        metersInput.push({
          sn: registerSn,
          unitNo: m.unitNo?.trim() || null,
          meterUsage: m.meterUsage === "analysis" ? "analysis" : "prepaid"
        });
      }

      const result = await createCustomerWithAccount(pool, {
        name: c.name.trim(),
        phone: c.phone.trim(),
        email: c.email ?? null,
        notes: c.notes ?? null,
        integrationMode,
        panelEnabled: panelOn,
        username: panelOn ? (c.username || "").trim() : "",
        passwordHash: panelOn
          ? (c.passwordHash || (c.password ? hashPassword(c.password) : ""))
          : "",
        meters: metersInput
      });

      customersCreated += 1;
      metersRegistered += result.metersRegistered;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failed.push({ name: c.name, error: msg });
    }
  }

  return { customersCreated, metersRegistered, quarantineLinked, failed };
};

export interface CustomerPendingLinkRow {
  expectedSn: string;
  unitNo: string | null;
  meterUsage: string;
  quarantineMatch: QuarantineMatchInfo | null;
  quarantineOptions: QuarantineMatchInfo[];
}

/** All pending (never seen) customer meters with quarantine match hints. */
export const listCustomerQuarantineLinkCandidates = async (
  pool: Pool,
  customerId: string
): Promise<CustomerPendingLinkRow[]> => {
  const pending = await pool.query<{ sn: string; unit_no: string | null; meter_usage: string; registry_status: string }>(
    `SELECT d.sn, d.unit_no, d.meter_usage, d.registry_status
     FROM devices d
     WHERE d.customer_id = $1 AND d.last_seen_at IS NULL
     ORDER BY d.sn`,
    [customerId]
  );

  const out: CustomerPendingLinkRow[] = [];
  for (const row of pending.rows) {
    if (row.registry_status === "quarantined") continue;
    const { best, options } = await findQuarantineMatchesForSn(pool, row.sn);
    out.push({
      expectedSn: row.sn,
      unitNo: row.unit_no,
      meterUsage: row.meter_usage,
      quarantineMatch: best,
      quarantineOptions: options
    });
  }
  return out;
};

export const linkCustomerQuarantineMeters = async (
  pool: Pool,
  customerId: string,
  links: Array<{ expectedSn: string; quarantineSn: string }>
): Promise<{ linked: number; failed: Array<{ sn: string; error: string }> }> => {
  let linked = 0;
  const failed: Array<{ sn: string; error: string }> = [];

  for (const link of links) {
    try {
      const pending = await pool.query<{ unit_no: string | null; meter_usage: string }>(
        `SELECT unit_no, meter_usage FROM devices WHERE customer_id = $1 AND sn = $2`,
        [customerId, link.expectedSn]
      );
      const meta = pending.rows[0];
      if (!meta) {
        failed.push({ sn: link.expectedSn, error: "pending_meter_not_found" });
        continue;
      }
      const q = await getDeviceRegistry(pool, link.quarantineSn);
      if (!isLinkableFieldDevice(q)) {
        failed.push({ sn: link.quarantineSn, error: "not_linkable" });
        continue;
      }
      await registerDevice(pool, {
        sn: link.quarantineSn,
        customerId,
        unitNo: meta.unit_no,
        label: meta.unit_no,
        meterUsage: meta.meter_usage === "analysis" ? "analysis" : "prepaid"
      });
      if (link.expectedSn !== link.quarantineSn) {
        await pool.query(
          `DELETE FROM devices WHERE sn = $1 AND customer_id = $2 AND last_seen_at IS NULL`,
          [link.expectedSn, customerId]
        );
      }
      linked += 1;
    } catch (e) {
      failed.push({ sn: link.quarantineSn, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return { linked, failed };
};
