import ExcelJS from "exceljs";

const FORM_SHEET = "Kayıt Formu";
const BULK_SHEET = "Toplu Kayıt";

const METER_ROWS = 55;
const BLOCK_GAP = 4;
const BLOCK_BODY = 8 + METER_ROWS;

export const IMPORT_COLUMNS: Array<{
  key: string;
  header: string;
  width: number;
  required: boolean;
  text?: boolean;
}> = [
  { key: "musteri_adi", header: "Müşteri Adı", width: 26, required: true },
  { key: "telefon", header: "Telefon", width: 16, required: true, text: true },
  { key: "eposta", header: "E-posta", width: 28, required: false },
  { key: "baglanti", header: "Bağlantı Tipi", width: 14, required: true },
  { key: "kullanici", header: "Panel Kullanıcı", width: 18, required: false },
  { key: "parola", header: "Parola", width: 16, required: false },
  { key: "seri_no", header: "Sayaç Seri No", width: 22, required: false, text: true },
  { key: "daire_dukkan", header: "Daire / Dükkan", width: 16, required: false },
  { key: "usage", header: "Usage", width: 12, required: false },
  { key: "not", header: "Not", width: 32, required: false }
];

const C = {
  titleBg: "FF1F4E79",
  titleFg: "FFFFFFFF",
  sectionBg: "FF2F5496",
  sectionFg: "FFFFFFFF",
  labelBg: "FFE8EEF4",
  labelFg: "FF1E293B",
  tableHeadBg: "FF1F4E79",
  tableHeadFg: "FFFFFFFF",
  border: "FF94A3B8",
  borderDark: "FF64748B",
  zebra: "FFF8FAFC",
  metaBg: "FFF1F5F9"
};

const borderAll = (style: "thin" | "medium" = "thin"): Partial<ExcelJS.Borders> => ({
  top: { style, color: { argb: C.border } },
  left: { style, color: { argb: C.border } },
  bottom: { style, color: { argb: C.border } },
  right: { style, color: { argb: C.border } }
});

const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (typeof v === "object" && "richText" in (v as ExcelJS.CellRichTextValue)) {
    return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("").trim();
  }
  if (typeof v === "object" && "text" in (v as ExcelJS.CellHyperlinkValue)) {
    return String((v as ExcelJS.CellHyperlinkValue).text ?? "").trim();
  }
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  let s = String(v).trim();
  if (/^\d+\.0+$/.test(s)) s = s.replace(/\.0+$/, "");
  return s;
};

const fmtText = (cell: ExcelJS.Cell) => {
  cell.numFmt = "@";
};

/** Fixed positions relative to "MÜŞTERİ BİLGİLERİ" banner row. */
const CUSTOMER_OFFSET = {
  musteri_adi: { r: 2, c: 3, mergeTo: { r: 2, c: 8 } },
  telefon: { r: 3, c: 3, mergeTo: { r: 3, c: 4 } },
  baglanti: { r: 3, c: 7, mergeTo: { r: 3, c: 8 } },
  eposta: { r: 4, c: 3, mergeTo: { r: 4, c: 4 } },
  kullanici: { r: 4, c: 7, mergeTo: { r: 4, c: 8 } },
  parola: { r: 5, c: 3, mergeTo: { r: 5, c: 4 } },
  not: { r: 5, c: 7, mergeTo: { r: 5, c: 8 } },
  sayaclarBanner: { r: 7, c: 1 },
  meterHeader: { r: 8, c: 1 },
  meterDataStart: { r: 9, c: 1 }
};

const METER_COL = { no: 1, sn: 2, unit: 3, usage: 4, note: 5 };

const styleLabel = (cell: ExcelJS.Cell, text: string) => {
  cell.value = text;
  cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: C.labelFg } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.labelBg } };
  cell.alignment = { vertical: "middle", horizontal: "right", wrapText: true };
  cell.border = borderAll();
};

const styleValue = (cell: ExcelJS.Cell, textFormat = false) => {
  cell.font = { name: "Calibri", size: 11, color: { argb: C.labelFg } };
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFFFF" } };
  cell.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  cell.border = borderAll();
  if (textFormat) fmtText(cell);
};

const mergeStyle = (
  ws: ExcelJS.Worksheet,
  r1: number,
  c1: number,
  r2: number,
  c2: number,
  textFormat = false
) => {
  ws.mergeCells(r1, c1, r2, c2);
  const cell = ws.getCell(r1, c1);
  styleValue(cell, textFormat);
  return cell;
};

const writeCustomerBlock = (ws: ExcelJS.Worksheet, startRow: number, blockNo: number) => {
  const R = startRow;

  ws.mergeCells(R, 1, R, 8);
  const banner = ws.getCell(R, 1);
  banner.value = blockNo > 1 ? `MÜŞTERİ BİLGİLERİ (${blockNo})` : "MÜŞTERİ BİLGİLERİ";
  banner.font = { name: "Calibri", size: 11, bold: true, color: { argb: C.sectionFg } };
  banner.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.sectionBg } };
  banner.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  banner.border = borderAll("medium");
  ws.getRow(R).height = 24;

  styleLabel(ws.getCell(R + 2, 1), "Müşteri Adı *");
  ws.mergeCells(R + 2, 1, R + 2, 2);
  mergeStyle(ws, R + 2, 3, R + 2, 8, false);

  styleLabel(ws.getCell(R + 3, 1), "Telefon *");
  ws.mergeCells(R + 3, 1, R + 3, 2);
  mergeStyle(ws, R + 3, 3, R + 3, 4, true);
  styleLabel(ws.getCell(R + 3, 5), "Bağlantı Tipi *");
  ws.mergeCells(R + 3, 5, R + 3, 6);
  const bagCell = mergeStyle(ws, R + 3, 7, R + 3, 8, false);
  bagCell.dataValidation = {
    type: "list",
    allowBlank: true,
    formulae: ['"panel,api"'],
    showErrorMessage: true,
    errorTitle: "Geçersiz",
    error: "panel veya api"
  };

  styleLabel(ws.getCell(R + 4, 1), "E-posta");
  ws.mergeCells(R + 4, 1, R + 4, 2);
  mergeStyle(ws, R + 4, 3, R + 4, 4, false);
  styleLabel(ws.getCell(R + 4, 5), "Panel Kullanıcı");
  ws.mergeCells(R + 4, 5, R + 4, 6);
  mergeStyle(ws, R + 4, 7, R + 4, 8, false);

  styleLabel(ws.getCell(R + 5, 1), "Parola");
  ws.mergeCells(R + 5, 1, R + 5, 2);
  mergeStyle(ws, R + 5, 3, R + 5, 4, false);
  styleLabel(ws.getCell(R + 5, 5), "Müşteri Notu");
  ws.mergeCells(R + 5, 5, R + 5, 6);
  mergeStyle(ws, R + 5, 7, R + 5, 8, false);

  [R + 2, R + 3, R + 4, R + 5].forEach((r) => { ws.getRow(r).height = 24; });

  ws.mergeCells(R + 7, 1, R + 7, 8);
  const mBanner = ws.getCell(R + 7, 1);
  mBanner.value = "SAYAÇLAR";
  mBanner.font = { name: "Calibri", size: 11, bold: true, color: { argb: C.sectionFg } };
  mBanner.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.tableHeadBg } };
  mBanner.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  mBanner.border = borderAll("medium");
  ws.getRow(R + 7).height = 22;

  const mh = R + 8;
  const heads = ["#", "Sayaç Seri No", "Daire / Dükkan", "Usage", "Sayaç Notu"];
  heads.forEach((h, i) => {
    const cell = ws.getCell(mh, i + 1);
    cell.value = h;
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: C.tableHeadFg } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.tableHeadBg } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = borderAll();
  });
  ws.getRow(mh).height = 26;

  for (let i = 0; i < METER_ROWS; i += 1) {
    const r = R + 9 + i;
    const row = ws.getRow(r);
    row.height = 21;
    const zebra = i % 2 === 0 ? "FFFFFFFF" : C.zebra;
    const noCell = ws.getCell(r, METER_COL.no);
    noCell.value = i + 1;
    noCell.font = { name: "Calibri", size: 10, color: { argb: "FF64748B" } };
    noCell.alignment = { vertical: "middle", horizontal: "center" };
    noCell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: zebra } };
    noCell.border = borderAll();

    [METER_COL.sn, METER_COL.unit, METER_COL.usage, METER_COL.note].forEach((col) => {
      const cell = ws.getCell(r, col);
      styleValue(cell, col === METER_COL.sn);
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: zebra } };
    });

    ws.getCell(r, METER_COL.usage).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"prepaid,postpaid"'],
      showErrorMessage: true,
      errorTitle: "Geçersiz",
      error: "prepaid veya postpaid"
    };
  }
};

const writeDocumentHeader = (ws: ExcelJS.Worksheet) => {
  ws.mergeCells(1, 1, 2, 4);
  const brand = ws.getCell(1, 1);
  brand.value = "Volt4Amper\nEnerji İzleme Platformu";
  brand.font = { name: "Calibri", size: 14, bold: true, color: { argb: C.titleFg } };
  brand.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.titleBg } };
  brand.alignment = { vertical: "middle", horizontal: "left", wrapText: true, indent: 1 };
  brand.border = borderAll("medium");

  const meta: Array<[string, string]> = [
    ["Tarih", ""],
    ["Form No", "AUTO"]
  ];
  meta.forEach(([label], i) => {
    const r = i + 1;
    styleLabel(ws.getCell(r, 5), label);
    ws.mergeCells(r, 5, r, 6);
    const val = mergeStyle(ws, r, 7, r, 8, false);
    if (label === "Tarih") val.value = { formula: "TODAY()", result: new Date() };
    if (label === "Form No") val.value = "V4A-MST-001";
  });

  ws.mergeCells(3, 1, 3, 8);
  const docTitle = ws.getCell(3, 1);
  docTitle.value = "MÜŞTERİ & SAYAÇ KAYIT FORMU";
  docTitle.font = { name: "Calibri", size: 15, bold: true, color: { argb: C.titleFg } };
  docTitle.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.titleBg } };
  docTitle.alignment = { vertical: "middle", horizontal: "center" };
  docTitle.border = borderAll("medium");
  ws.getRow(3).height = 32;
  ws.getRow(1).height = 28;
  ws.getRow(2).height = 28;
};

const buildBulkSheet = (ws: ExcelJS.Worksheet) => {
  ws.getColumn(1).width = 26;
  ws.getColumn(2).width = 16;
  ws.getColumn(3).width = 28;
  ws.getColumn(4).width = 14;
  ws.getColumn(5).width = 18;
  ws.getColumn(6).width = 16;
  ws.getColumn(7).width = 22;
  ws.getColumn(8).width = 16;
  ws.getColumn(9).width = 12;
  ws.getColumn(10).width = 32;
  ws.getColumn(2).numFmt = "@";
  ws.getColumn(7).numFmt = "@";

  ws.mergeCells(1, 1, 1, 10);
  const t = ws.getCell(1, 1);
  t.value = "Toplu Kayıt — birden fazla müşteri (her sayaç = 1 satır)";
  t.font = { name: "Calibri", size: 12, bold: true, color: { argb: C.sectionFg } };
  t.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.sectionBg } };

  const headers = [
    "Müşteri Adı *", "Telefon *", "E-posta", "Bağlantı Tipi *", "Panel Kullanıcı", "Parola",
    "Sayaç Seri No", "Daire / Dükkan", "Usage", "Not"
  ];
  headers.forEach((h, i) => {
    const cell = ws.getCell(2, i + 1);
    cell.value = h;
    cell.font = { name: "Calibri", size: 10, bold: true, color: { argb: C.tableHeadFg } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.tableHeadBg } };
    cell.border = borderAll();
  });

  for (let r = 3; r <= 200; r += 1) {
    for (let c = 1; c <= 10; c += 1) {
      const cell = ws.getCell(r, c);
      cell.border = borderAll();
      cell.font = { name: "Calibri", size: 11 };
      if (c === 2 || c === 7) fmtText(cell);
    }
  }
};

/** Quotation-style form: customer details on top, meter table below. */
export const buildCustomerImportTemplate = async (): Promise<Buffer> => {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Volt4Amper";
  wb.created = new Date();

  const ws = wb.addWorksheet(FORM_SHEET, {
    views: [{ state: "frozen", ySplit: 4, activeCell: "C10" }],
    pageSetup: { orientation: "portrait", fitToPage: true, fitToWidth: 1 }
  });

  [14, 14, 14, 14, 14, 14, 14, 22].forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  writeDocumentHeader(ws);
  writeCustomerBlock(ws, 5, 1);
  writeCustomerBlock(ws, 5 + BLOCK_BODY + BLOCK_GAP, 2);

  ws.mergeCells(5 + BLOCK_BODY * 2 + BLOCK_GAP + 2, 1, 5 + BLOCK_BODY * 2 + BLOCK_GAP + 2, 8);
  const hint = ws.getCell(5 + BLOCK_BODY * 2 + BLOCK_GAP + 2, 1);
  hint.value =
    "İpucu: İkinci müşteri için yukarıdaki ikinci blok kullanılır. Daha fazla müşteri için bloğu kopyalayın veya “Toplu Kayıt” sekmesini kullanın.";
  hint.font = { name: "Calibri", size: 10, italic: true, color: { argb: "FF64748B" } };
  hint.alignment = { wrapText: true, vertical: "middle" };

  const bulk = wb.addWorksheet(BULK_SHEET, { properties: { tabColor: { argb: "FF64748B" } } });
  buildBulkSheet(bulk);

  const help = wb.addWorksheet("Açıklama", { properties: { tabColor: { argb: "FF2F5496" } } });
  help.getColumn(1).width = 24;
  help.getColumn(2).width = 70;
  help.mergeCells("A1:B1");
  help.getCell("A1").value = "Kullanım kılavuzu";
  help.getCell("A1").font = { name: "Calibri", size: 14, bold: true, color: { argb: C.titleFg } };
  help.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: C.titleBg } };
  const lines = [
    ["Kayıt Formu", "Tek müşteri için üst bölüm müşteri bilgileri, alt tablo sayaçlar. İki müşteri bloğu vardır."],
    ["Toplu Kayıt", "Çok müşteri / çok sayaç için klasik satır listesi (her sayaç ayrı satır)."],
    ["Bağlantı Tipi", "panel = yerel panel · api = 3. parti yazılım"],
    ["Usage", "prepaid (varsayılan) veya postpaid"],
    ["Telefon / SN", "Metin olarak yazın (0555…, 24042809890001)."],
    ["Yükleme", "Panel → Müşteriler → Toplu yükle → .xlsx dosyasını seçin."]
  ];
  lines.forEach(([t, d], i) => {
    help.getRow(i + 3).getCell(1).value = t;
    help.getRow(i + 3).getCell(1).font = { bold: true };
    help.getRow(i + 3).getCell(2).value = d;
    help.getRow(i + 3).getCell(2).alignment = { wrapText: true };
    help.getRow(i + 3).height = 26;
  });

  return Buffer.from(await wb.xlsx.writeBuffer());
};

const readMerged = (ws: ExcelJS.Worksheet, r: number, c: number): string =>
  cellText(ws.getCell(r, c).value);

const readCustomerBlock = (ws: ExcelJS.Worksheet, bannerRow: number): Record<string, string> | null => {
  const R = bannerRow;
  const o: Record<string, string> = {
    musteri_adi: readMerged(ws, R + CUSTOMER_OFFSET.musteri_adi.r, CUSTOMER_OFFSET.musteri_adi.c),
    telefon: readMerged(ws, R + CUSTOMER_OFFSET.telefon.r, CUSTOMER_OFFSET.telefon.c),
    baglanti: readMerged(ws, R + CUSTOMER_OFFSET.baglanti.r, CUSTOMER_OFFSET.baglanti.c),
    eposta: readMerged(ws, R + CUSTOMER_OFFSET.eposta.r, CUSTOMER_OFFSET.eposta.c),
    kullanici: readMerged(ws, R + CUSTOMER_OFFSET.kullanici.r, CUSTOMER_OFFSET.kullanici.c),
    parola: readMerged(ws, R + CUSTOMER_OFFSET.parola.r, CUSTOMER_OFFSET.parola.c),
    not: readMerged(ws, R + CUSTOMER_OFFSET.not.r, CUSTOMER_OFFSET.not.c)
  };
  if (!o.musteri_adi && !o.telefon) return null;
  return o;
};

const readMetersForBlock = (ws: ExcelJS.Worksheet, bannerRow: number): Array<Record<string, string>> => {
  const start = bannerRow + CUSTOMER_OFFSET.meterDataStart.r;
  const out: Array<Record<string, string>> = [];
  let emptyStreak = 0;
  for (let i = 0; i < METER_ROWS + 20; i += 1) {
    const r = start + i;
    const sn = readMerged(ws, r, METER_COL.sn);
    const unit = readMerged(ws, r, METER_COL.unit);
    const usage = readMerged(ws, r, METER_COL.usage);
    const note = readMerged(ws, r, METER_COL.note);
    if (!sn && !unit) {
      emptyStreak += 1;
      if (emptyStreak >= 3) break;
      continue;
    }
    emptyStreak = 0;
    if (!sn) continue;
    out.push({
      seri_no: sn,
      daire_dukkan: unit,
      usage: usage || "prepaid",
      not: note
    });
  }
  return out;
};

const parseFormSheet = (ws: ExcelJS.Worksheet): Array<Record<string, string>> => {
  const out: Array<Record<string, string>> = [];
  const banners: number[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const a = cellText(row.getCell(1).value).toUpperCase();
    if (a.includes("MÜŞTERİ BİLGİLERİ") || a.includes("MUSTERI BILGILERI")) banners.push(rowNumber);
  });

  for (const bannerRow of banners) {
    const cust = readCustomerBlock(ws, bannerRow);
    if (!cust) continue;
    const meters = readMetersForBlock(ws, bannerRow);
    if (!meters.length) {
      out.push({ ...cust, seri_no: "", daire_dukkan: "", usage: "prepaid" });
      continue;
    }
    for (const m of meters) {
      out.push({ ...cust, ...m });
    }
  }
  return out;
};

const BULK_HEADER_MAP: Record<string, string> = {
  "müşteri adı": "musteri_adi",
  "musteri adi": "musteri_adi",
  "telefon": "telefon",
  "e-posta": "eposta",
  "eposta": "eposta",
  "bağlantı tipi": "baglanti",
  "baglanti tipi": "baglanti",
  "panel kullanıcı": "kullanici",
  "panel kullanici": "kullanici",
  "parola": "parola",
  "sayaç seri no": "seri_no",
  "sayac seri no": "seri_no",
  "daire / dükkan": "daire_dukkan",
  "daire / dukkan": "daire_dukkan",
  "usage": "usage",
  "not": "not"
};

const parseBulkSheet = (ws: ExcelJS.Worksheet): Array<Record<string, string>> => {
  const headerRow = ws.getRow(2);
  const keyByCol = new Map<number, string>();
  headerRow.eachCell({ includeEmpty: true }, (cell, col) => {
    const k = cellText(cell.value).toLowerCase().replace(/\*+$/, "").trim();
    if (BULK_HEADER_MAP[k]) keyByCol.set(col, BULK_HEADER_MAP[k]!);
  });
  if (keyByCol.size === 0) return [];

  const out: Array<Record<string, string>> = [];
  for (let r = 3; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const obj: Record<string, string> = {};
    let any = false;
    keyByCol.forEach((key, col) => {
      const v = cellText(row.getCell(col).value);
      if (v) any = true;
      obj[key] = v;
    });
    if (any) out.push(obj);
  }
  return out;
};

/** Parse uploaded .xlsx — form layout + optional bulk sheet. */
export const parseCustomerImportXlsx = async (buffer: Buffer): Promise<Array<Record<string, string>>> => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(new Uint8Array(buffer) as unknown as ExcelJS.Buffer);

  const formWs = wb.getWorksheet(FORM_SHEET);
  const bulkWs = wb.getWorksheet(BULK_SHEET);

  const formRows = formWs ? parseFormSheet(formWs) : [];
  const bulkRows = bulkWs ? parseBulkSheet(bulkWs) : [];

  if (formRows.length) return formRows;
  if (bulkRows.length) return bulkRows;

  const fallback = wb.worksheets[0];
  return fallback ? parseFormSheet(fallback) : [];
};
