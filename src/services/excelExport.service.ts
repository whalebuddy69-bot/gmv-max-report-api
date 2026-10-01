import ExcelJS from "exceljs";
import {
  BuiltReport,
  CampaignRow,
  CreativeRow,
  ProductByCampaignRow,
} from "./reportBuilder.service";

// Rate metrics from TikTok are already percentages ("12.34" = 12.34%), so they are
// written as plain numbers, not Excel percent cells.

const HEADER_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FF1F3864" },
};

const CARD_FILL: ExcelJS.Fill = {
  type: "pattern",
  pattern: "solid",
  fgColor: { argb: "FFFFF2CC" },
};

interface ColumnSpec<T> {
  header: string;
  width: number;
  value: (row: T) => string | number | null;
  numFmt?: string;
}

const MONEY = "#,##0.00";
const INT = "#,##0";
const RATE = "0.00";
const RATIO = "0.00";

const CAMPAIGN_COLUMNS: ColumnSpec<CampaignRow>[] = [
  { header: "Campaign ID", width: 20, value: (r) => r.campaignId },
  { header: "Campaign Name", width: 40, value: (r) => r.campaignName },
  { header: "Status", width: 12, value: (r) => r.status },
  { header: "Bid Type", width: 12, value: (r) => r.bidType },
  { header: "ROI Target", width: 12, value: (r) => r.roiTarget, numFmt: RATIO },
  { header: "Target ROI Budget", width: 18, value: (r) => r.targetRoiBudget, numFmt: MONEY },
  { header: "Max Delivery Budget", width: 19, value: (r) => r.maxDeliveryBudget, numFmt: MONEY },
  { header: "Schedule Start (UTC)", width: 20, value: (r) => r.scheduleStart },
  { header: "Cost", width: 14, value: (r) => r.cost, numFmt: MONEY },
  { header: "Net Cost", width: 14, value: (r) => r.netCost, numFmt: MONEY },
  { header: "Orders", width: 10, value: (r) => r.orders, numFmt: INT },
  { header: "Cost per Order", width: 16, value: (r) => r.costPerOrder, numFmt: MONEY },
  { header: "Gross Revenue", width: 16, value: (r) => r.grossRevenue, numFmt: MONEY },
  { header: "ROI", width: 10, value: (r) => r.roi, numFmt: RATIO },
];

const PRODUCT_COLUMNS: ColumnSpec<ProductByCampaignRow>[] = [
  { header: "Campaign ID", width: 20, value: (r) => r.campaignId },
  { header: "Campaign Name", width: 32, value: (r) => r.campaignName },
  { header: "Product ID", width: 22, value: (r) => r.productId },
  { header: "Product Name", width: 46, value: (r) => r.productName },
  { header: "Product Status", width: 15, value: (r) => r.productStatus },
  { header: "Cost", width: 14, value: (r) => r.cost, numFmt: MONEY },
  { header: "Orders", width: 10, value: (r) => r.orders, numFmt: INT },
  { header: "Cost per Order", width: 16, value: (r) => r.costPerOrder, numFmt: MONEY },
  { header: "Gross Revenue", width: 16, value: (r) => r.grossRevenue, numFmt: MONEY },
  { header: "ROI", width: 10, value: (r) => r.roi, numFmt: RATIO },
];

const CREATIVE_COLUMNS: ColumnSpec<CreativeRow>[] = [
  { header: "Campaign ID", width: 20, value: (r) => r.campaignId },
  { header: "Campaign Name", width: 28, value: (r) => r.campaignName },
  { header: "Product ID", width: 22, value: (r) => r.productId },
  { header: "Product Name", width: 36, value: (r) => r.productName },
  { header: "ประเภทชิ้นงาน", width: 15, value: (r) => r.creativeType },
  { header: "Video ID", width: 22, value: (r) => r.videoId },
  { header: "บัญชี TikTok", width: 26, value: (r) => r.tiktokAccount },
  { header: "ประเภทการอนุญาต", width: 18, value: (r) => r.authorizationType },
  { header: "สถานะการสำรวจ", width: 20, value: (r) => r.deliveryStatus },
  { header: "ชิ้นงานโฆษณา", width: 40, value: (r) => r.title },
  { header: "Cost", width: 13, value: (r) => r.cost, numFmt: MONEY },
  { header: "Orders", width: 9, value: (r) => r.orders, numFmt: INT },
  { header: "Cost per Order", width: 15, value: (r) => r.costPerOrder, numFmt: MONEY },
  { header: "Gross Revenue", width: 15, value: (r) => r.grossRevenue, numFmt: MONEY },
  { header: "ROI", width: 9, value: (r) => r.roi, numFmt: RATIO },
  { header: "Product Impressions", width: 19, value: (r) => r.productImpressions, numFmt: INT },
  { header: "Product Clicks", width: 15, value: (r) => r.productClicks, numFmt: INT },
  { header: "Product Click Rate (%)", width: 20, value: (r) => r.productClickRate, numFmt: RATE },
  { header: "Ad Click Rate (%)", width: 17, value: (r) => r.adClickRate, numFmt: RATE },
  { header: "Ad Conversion Rate (%)", width: 20, value: (r) => r.adConversionRate, numFmt: RATE },
  { header: "View Rate 2s (%)", width: 16, value: (r) => r.viewRate2s, numFmt: RATE },
  { header: "View Rate 6s (%)", width: 16, value: (r) => r.viewRate6s, numFmt: RATE },
  { header: "View Rate 25% (%)", width: 17, value: (r) => r.viewRateP25, numFmt: RATE },
  { header: "View Rate 50% (%)", width: 17, value: (r) => r.viewRateP50, numFmt: RATE },
  { header: "View Rate 75% (%)", width: 17, value: (r) => r.viewRateP75, numFmt: RATE },
  { header: "View Rate 100% (%)", width: 18, value: (r) => r.viewRateP100, numFmt: RATE },
];

// --- Live rooms (rows from analytics.liveRooms) ---

const LIVE_ROOM_COLUMNS: ColumnSpec<Record<string, unknown>>[] = [
  { header: "Store ID", width: 20, value: (r) => (r.store_id as string) ?? null },
  { header: "Campaign ID", width: 20, value: (r) => (r.campaign_id as string) ?? null },
  { header: "Room ID", width: 22, value: (r) => (r.room_id as string) ?? null },
  { header: "Live Name", width: 40, value: (r) => (r.live_name as string) ?? null },
  { header: "Status", width: 12, value: (r) => (r.live_status as string) ?? null },
  { header: "Launched Time", width: 20, value: (r) => (r.live_launched_time as string) ?? null },
  { header: "Duration", width: 12, value: (r) => (r.live_duration as string) ?? null },
  { header: "Start Date", width: 13, value: (r) => (r.start_date as string) ?? null },
  { header: "Start Time", width: 12, value: (r) => (r.start_time as string) ?? null },
  { header: "End Time", width: 20, value: (r) => (r.end_time as string) ?? null },
  { header: "Duration (seconds)", width: 16, value: (r) => (r.duration_seconds as number) ?? null, numFmt: INT },
  { header: "Cost", width: 14, value: (r) => (r.cost as number) ?? null, numFmt: MONEY },
  { header: "Net Cost", width: 14, value: (r) => (r.net_cost as number) ?? null, numFmt: MONEY },
  { header: "Orders", width: 10, value: (r) => (r.orders as number) ?? null, numFmt: INT },
  { header: "Cost per Order", width: 16, value: (r) => (r.cost_per_order as number) ?? null, numFmt: MONEY },
  { header: "Gross Revenue", width: 16, value: (r) => (r.gross_revenue as number) ?? null, numFmt: MONEY },
  { header: "ROI", width: 10, value: (r) => (r.roi as number) ?? null, numFmt: RATIO },
  { header: "Live Views", width: 14, value: (r) => (r.live_views as number) ?? null, numFmt: INT },
  { header: "Live Views 10s", width: 16, value: (r) => (r.live_views_10s as number) ?? null, numFmt: INT },
  {
    header: "Cost per Live View",
    width: 18,
    value: (r) => (r.cost_per_live_view as number) ?? null,
    numFmt: MONEY,
  },
  {
    header: "Cost per Live View 10s",
    width: 20,
    value: (r) => (r.cost_per_live_view_10s as number) ?? null,
    numFmt: MONEY,
  },
  { header: "Live Follows", width: 14, value: (r) => (r.live_follows as number) ?? null, numFmt: INT },
];

export async function writeLiveRoomsWorkbook(rows: Record<string, unknown>[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  workbook.creator = "gmv-max-report";

  addSheet(workbook, "Live Rooms", LIVE_ROOM_COLUMNS, rows);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

// --- "All" sheet (rows from analytics.dailyAllMetrics), one row per day ---

const ALL_METRICS_COLUMNS: ColumnSpec<Record<string, unknown>>[] = [
  { header: "Date", width: 14, value: (r) => (r.stat_date as string) ?? null },
  { header: "Cost", width: 14, value: (r) => (r.cost as number) ?? null, numFmt: MONEY },
  { header: "Orders", width: 10, value: (r) => (r.orders as number) ?? null, numFmt: INT },
  { header: "Gross Revenue", width: 16, value: (r) => (r.gross_revenue as number) ?? null, numFmt: MONEY },
  { header: "ROI", width: 10, value: (r) => (r.roi as number) ?? null, numFmt: RATIO },
  { header: "Total Videos", width: 14, value: (r) => (r.total_videos as number) ?? null, numFmt: INT },
  {
    header: "Videos with Sales",
    width: 16,
    value: (r) => (r.videos_with_sales as number) ?? null,
    numFmt: INT,
  },
  {
    header: "Creators with Sales",
    width: 18,
    value: (r) => (r.creators_with_sales as number) ?? null,
    numFmt: INT,
  },
];

export async function writeAllMetricsWorkbook(rows: Record<string, unknown>[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = new Date();
  workbook.creator = "gmv-max-report";

  addSheet(workbook, "All", ALL_METRICS_COLUMNS, rows);

  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

export interface WorkbookMeta {
  advertiserId: string;
  storeId: string;
  storeName?: string;
  startDate: string;
  endDate: string;
  generatedAt: Date;
}

export async function writeReportWorkbook(
  report: BuiltReport,
  meta: WorkbookMeta,
  filePath: string
): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  workbook.created = meta.generatedAt;
  workbook.creator = "gmv-max-report";

  addSheet(workbook, "Campaign", CAMPAIGN_COLUMNS, report.campaigns);
  addSheet(workbook, "Product by Campaign", PRODUCT_COLUMNS, report.productsByCampaign);
  addSheet(workbook, "Creative by Product", CREATIVE_COLUMNS, report.creatives, (row, excelRow) => {
    if (row.creativeType === "การ์ดสินค้า") {
      excelRow.eachCell((cell) => {
        cell.fill = CARD_FILL;
      });
    }
  });
  addInfoSheet(workbook, report, meta);

  await workbook.xlsx.writeFile(filePath);
}

function addSheet<T>(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: ColumnSpec<T>[],
  rows: T[],
  decorate?: (row: T, excelRow: ExcelJS.Row) => void
): void {
  const sheet = workbook.addWorksheet(name, {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = columns.map((col) => ({ header: col.header, width: col.width }));

  const headerRow = sheet.getRow(1);
  headerRow.font = { bold: true, color: { argb: "FFFFFFFF" } };
  headerRow.fill = HEADER_FILL;
  headerRow.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  headerRow.height = 30;

  for (const row of rows) {
    const excelRow = sheet.addRow(columns.map((col) => col.value(row)));
    decorate?.(row, excelRow);
  }

  columns.forEach((col, index) => {
    if (col.numFmt) sheet.getColumn(index + 1).numFmt = col.numFmt;
  });

  if (rows.length > 0) {
    sheet.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1, column: columns.length },
    };
  }
}

/** Provenance + anything the run wants the reader to know before trusting the numbers. */
function addInfoSheet(workbook: ExcelJS.Workbook, report: BuiltReport, meta: WorkbookMeta): void {
  const sheet = workbook.addWorksheet("Run Info");
  sheet.columns = [
    { header: "Field", width: 36 },
    { header: "Value", width: 100 },
  ];
  sheet.getRow(1).font = { bold: true };

  const entries: [string, string | number][] = [
    ["Advertiser ID", meta.advertiserId],
    ["Store", meta.storeName ?? "-"],
    ["Store ID", meta.storeId],
    ["Date range", `${meta.startDate} → ${meta.endDate}`],
    ["Generated at", meta.generatedAt.toISOString()],
    ["Currency", report.currency || "-"],
    ["Campaigns in store", report.stats.campaignsTotal],
    ["Campaigns reported", report.stats.campaignsReported],
    ["Product rows", report.stats.products],
    ["Creative rows", report.stats.creatives],
    ["  of which product cards", report.stats.productCards],
    ["  video rows with TikTok account", report.stats.rowsWithAccountName],
    ["Creatives hidden (no cost/orders)", report.stats.creativesDroppedZero],
    ["TikTok API calls", report.stats.apiCalls],
  ];

  for (const [field, value] of entries) {
    sheet.addRow([field, value]);
  }

  sheet.addRow([]);
  sheet.addRow(["หมายเหตุ", ""]).font = { bold: true };
  for (const note of [
    'sheet "Creative by Product" แถวพื้นเหลือง = การ์ดสินค้า (ไม่มี Video ID เพราะไม่ใช่โพสต์)',
    "ยอดรวม Cost ใน sheet Campaign เท่ากับ Account totals ด้านล่าง, ใช้ตรวจความถูกต้องของไฟล์ได้",
    "คอลัมน์ที่ลงท้าย (%) เป็นเปอร์เซ็นต์อยู่แล้ว ไม่ต้องคูณ 100 ซ้ำ",
    'ช่อง "บัญชี TikTok" ว่าง = access token ไม่มีสิทธิ์เข้าถึงบัญชีนั้น (API ส่ง "0" หรือ "-1" มา)',
  ]) {
    sheet.addRow(["", note]).getCell(2).alignment = { wrapText: true };
  }

  const totals = Object.entries(report.accountTotals).filter(([key]) => key !== "currency");
  if (totals.length > 0) {
    sheet.addRow([]);
    sheet.addRow(["Account totals (cross-check)", ""]).font = { bold: true };
    for (const [key, value] of totals) {
      sheet.addRow([`  ${key}`, value === null ? "" : String(value)]);
    }
  }

  if (report.warnings.length > 0) {
    sheet.addRow([]);
    sheet.addRow(["Warnings", ""]).font = { bold: true };
    for (const warning of report.warnings) {
      sheet.addRow(["", warning]).getCell(2).alignment = { wrapText: true };
    }
  }
}
