import ExcelJS from "exceljs";

const SHEET_NAME = "Müşteri Kayıt";
const HEADER_ROW = 4;
const DATA_START = 5;
const DATA_END = 502;

/** Machine keys used by the import parser (row ${HEADER_ROW} stores these in hidden-style second row — we use display headers mapped on read). */
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

const EXAMPLE_ROWS: Array<Record<string, string>> = [
  {
    musteri_adi: "Örnek Müşteri A",
    telefon: "05551234567",
    eposta: "ornek@mail.com",
    baglanti: "panel",
    kullanici: "ornek.kullanici",
    parola: "Sifre123!",
    seri_no: "24042809890001",
    daire_dukkan: "A-12",
    usage: "prepaid",
    not: ""
  },
  {
    musteri_adi: "Örnek Müşteri A",
    telefon: "05551234567",
    eposta: "ornek@mail.com",
    baglanti: "panel",
    kullanici: "ornek.kullanici",
    parola: "Sifre123!",
    seri_no: "24042809890002",
    daire_dukkan: "B-03",
    usage: "prepaid",
    not: ""
  },
  {
    musteri_adi: "Örnek Müşteri B",
    telefon: "05559876543",
    eposta: "",
    baglanti: "api",
    kullanici: "",
    parola: "",
    seri_no: "24042809890003",
    daire_dukkan: "Dükkan 1",
    usage: "prepaid",
    not: "3. parti yazılım"
  }
];

const COLORS = {
  titleBg: "FF1F4E79",
  titleFg: "FFFFFFFF",
  headerBg: "FF2F5496",
  headerFg: "FFFFFFFF",
  hintBg: "FFEEF3FA",
  hintFg: "FF334155",
  exampleBg: "FFF8FAFC",
  border: "FFB8C4CE",
  zebra: "FFF5F8FC"
};

const thinBorder: Partial<ExcelJS.Borders> = {
  top: { style: "thin", color: { argb: COLORS.border } },
  left: { style: "thin", color: { argb: COLORS.border } },
  bottom: { style: "thin", color: { argb: COLORS.border } },
  right: { style: "thin", color: { argb: COLORS.border } }
};

const headerLabel = (c: (typeof IMPORT_COLUMNS)[number]) =>
  c.required ? `${c.header} *` : c.header;

/** Build a styled .xlsx template for field customer + meter onboarding. */
export const buildCustomerImportTemplate = async (): Promise<Buffer> => {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Volt4Amper";
  wb.created = new Date();

  const ws = wb.addWorksheet(SHEET_NAME, {
    views: [{ state: "frozen", ySplit: HEADER_ROW, activeCell: "A5" }]
  });

  IMPORT_COLUMNS.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.width;
    if (col.text) ws.getColumn(i + 1).numFmt = "@";
  });

  ws.mergeCells(1, 1, 1, IMPORT_COLUMNS.length);
  const title = ws.getCell(1, 1);
  title.value = "Volt4Amper — Müşteri & Sayaç Kayıt Şablonu";
  title.font = { name: "Calibri", size: 16, bold: true, color: { argb: COLORS.titleFg } };
  title.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.titleBg } };
  title.alignment = { vertical: "middle", horizontal: "left", indent: 1 };
  ws.getRow(1).height = 34;

  ws.mergeCells(2, 1, 2, IMPORT_COLUMNS.length);
  const hint = ws.getCell(2, 1);
  hint.value =
    "Her sayaç için ayrı satır doldurun (aynı müşteri bilgileri tekrarlanır). " +
    "Bağlantı Tipi: panel veya api · Usage: prepaid veya postpaid · " +
    "Telefon ve Seri No hücrelerini metin olarak bırakın (başına 0 yazın). " +
    "Doldurduktan sonra bu dosyayı panelden “Toplu yükle” ile yükleyin.";
  hint.font = { name: "Calibri", size: 11, color: { argb: COLORS.hintFg } };
  hint.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.hintBg } };
  hint.alignment = { vertical: "middle", horizontal: "left", wrapText: true, indent: 1 };
  ws.getRow(2).height = 48;

  ws.getRow(3).height = 8;

  const headerRow = ws.getRow(HEADER_ROW);
  headerRow.height = 28;
  IMPORT_COLUMNS.forEach((col, i) => {
    const cell = headerRow.getCell(i + 1);
    cell.value = headerLabel(col);
    cell.font = { name: "Calibri", size: 11, bold: true, color: { argb: COLORS.headerFg } };
    cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.headerBg } };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
    cell.border = thinBorder;
  });

  const firstDataRow = DATA_START;
  for (let r = firstDataRow; r <= DATA_END; r += 1) {
    const row = ws.getRow(r);
    row.height = 20;
    const zebra = r % 2 === 0 ? COLORS.zebra : "FFFFFFFF";
    IMPORT_COLUMNS.forEach((col, ci) => {
      const cell = row.getCell(ci + 1);
      cell.border = thinBorder;
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: zebra } };
      cell.font = { name: "Calibri", size: 11 };
      cell.alignment = { vertical: "middle", horizontal: "left" };
      if (col.text) cell.numFmt = "@";
    });
  }

  const bagCol = IMPORT_COLUMNS.findIndex((c) => c.key === "baglanti") + 1;
  const usageCol = IMPORT_COLUMNS.findIndex((c) => c.key === "usage") + 1;
  const bagLetter = ws.getColumn(bagCol).letter;
  const usageLetter = ws.getColumn(usageCol).letter;

  for (let r = firstDataRow; r <= DATA_END; r += 1) {
    ws.getCell(`${bagLetter}${r}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"panel,api"'],
      showErrorMessage: true,
      errorTitle: "Geçersiz değer",
      error: "panel veya api yazın"
    };
    ws.getCell(`${usageLetter}${r}`).dataValidation = {
      type: "list",
      allowBlank: true,
      formulae: ['"prepaid,postpaid"'],
      showErrorMessage: true,
      errorTitle: "Geçersiz değer",
      error: "prepaid veya postpaid yazın"
    };
  }

  ws.autoFilter = {
    from: { row: HEADER_ROW, column: 1 },
    to: { row: DATA_END, column: IMPORT_COLUMNS.length }
  };

  const help = wb.addWorksheet("Açıklama", { properties: { tabColor: { argb: "FF2F5496" } } });
  help.getColumn(1).width = 22;
  help.getColumn(2).width = 72;
  help.mergeCells("A1:B1");
  help.getCell("A1").value = "Sütun açıklamaları";
  help.getCell("A1").font = { name: "Calibri", size: 14, bold: true, color: { argb: COLORS.titleFg } };
  help.getCell("A1").fill = { type: "pattern", pattern: "solid", fgColor: { argb: COLORS.headerBg } };
  help.getRow(1).height = 28;

  const docs: Array<[string, string]> = [
    ["Müşteri Adı *", "Ad veya unvan. Aynı müşterinin tüm sayaç satırlarında aynı olmalı."],
    ["Telefon *", "10–15 hane. Başında 0 ile metin olarak yazın (0555…)."],
    ["E-posta", "Opsiyonel iletişim e-postası."],
    ["Bağlantı Tipi *", "panel = yerel panel girişi · api = 3. parti yazılım entegrasyonu"],
    ["Panel Kullanıcı", "panel modunda zorunlu — müşteri giriş kullanıcı adı"],
    ["Parola", "panel modunda zorunlu — en az 8 karakter"],
    ["Sayaç Seri No", "Cihaz seri numarası. Karantinada varsa import sırasında eşleştirilir."],
    ["Daire / Dükkan", "Bağımsız bölüm numarası veya dükkan adı"],
    ["Usage", "prepaid (varsayılan) veya postpaid"],
    ["Not", "Serbest not alanı"]
  ];
  docs.forEach(([col, desc], i) => {
    const row = help.getRow(i + 3);
    row.getCell(1).value = col;
    row.getCell(1).font = { name: "Calibri", size: 11, bold: true };
    row.getCell(2).value = desc;
    row.getCell(2).font = { name: "Calibri", size: 11 };
    row.getCell(2).alignment = { wrapText: true, vertical: "top" };
    row.height = 28;
  });

  help.getCell("A15").value = "Örnek satırlar";
  help.getCell("A15").font = { name: "Calibri", size: 12, bold: true };
  EXAMPLE_ROWS.forEach((ex, i) => {
    const row = help.getRow(16 + i);
    IMPORT_COLUMNS.forEach((col, ci) => {
      const cell = row.getCell(ci + 1);
      cell.value = ex[col.key] ?? "";
      cell.font = { name: "Calibri", size: 10, color: { argb: "FF64748B" } };
      if (col.text) cell.numFmt = "@";
    });
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
};

const HEADER_TO_KEY: Record<string, string> = {};
for (const col of IMPORT_COLUMNS) {
  HEADER_TO_KEY[col.header.toLowerCase()] = col.key;
  HEADER_TO_KEY[headerLabel(col).toLowerCase()] = col.key;
  HEADER_TO_KEY[col.key] = col.key;
}

const cellText = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (typeof v === "object" && "richText" in (v as ExcelJS.CellRichTextValue)) {
    return (v as ExcelJS.CellRichTextValue).richText.map((t) => t.text).join("").trim();
  }
  if (typeof v === "object" && "text" in (v as ExcelJS.CellHyperlinkValue)) {
    return String((v as ExcelJS.CellHyperlinkValue).text ?? "").trim();
  }
  if (v instanceof Date) return v.toISOString();
  return String(v).trim();
};

const resolveHeaderKey = (label: string): string | null => {
  const t = label.trim().toLowerCase().replace(/\*+$/, "").trim();
  if (HEADER_TO_KEY[t]) return HEADER_TO_KEY[t]!;
  if (HEADER_TO_KEY[`${t} *`]) return HEADER_TO_KEY[`${t} *`]!;
  return null;
};

/** Parse uploaded .xlsx into flat row objects keyed for customer-import.ts. */
export const parseCustomerImportXlsx = async (buffer: Buffer): Promise<Array<Record<string, string>>> => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(new Uint8Array(buffer) as unknown as ExcelJS.Buffer);
  const ws = wb.getWorksheet(SHEET_NAME) ?? wb.worksheets[0];
  if (!ws) return [];

  let headerRowNum = HEADER_ROW;
  let keyByCol = new Map<number, string>();

  const tryHeaderRow = (rowNum: number): boolean => {
    const row = ws.getRow(rowNum);
    const map = new Map<number, string>();
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      const key = resolveHeaderKey(cellText(cell.value));
      if (key) map.set(col, key);
    });
    if (map.size >= 4) {
      keyByCol = map;
      headerRowNum = rowNum;
      return true;
    }
    return false;
  };

  if (!tryHeaderRow(HEADER_ROW)) {
    for (let r = 1; r <= Math.min(15, ws.rowCount); r += 1) {
      if (tryHeaderRow(r)) break;
    }
  }
  if (keyByCol.size === 0) return [];

  const out: Array<Record<string, string>> = [];
  for (let r = headerRowNum + 1; r <= ws.rowCount; r += 1) {
    const row = ws.getRow(r);
    const obj: Record<string, string> = {};
    let nonEmpty = false;
    keyByCol.forEach((key, col) => {
      const cell = row.getCell(col);
      let val = cellText(cell.value);
      if (cell.numFmt === "@" || key === "telefon" || key === "seri_no") {
        val = val.replace(/\.0+$/, "");
      }
      if (val) nonEmpty = true;
      obj[key] = val;
    });
    if (nonEmpty) out.push(obj);
  }
  return out;
};
