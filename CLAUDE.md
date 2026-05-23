# NCO DSR Platform — Project Bible

> Nice Center Oil · Google Apps Script · Google Sheets as DB · Bangkok timezone
> See MILEAGE_SPEC.md for Mileage Bot module spec.

---

## 1. Project Overview

### dsr-operation-platform
พอร์ทัลหลักสำหรับทีม DSR (Daily Sales Representative) บริษัท Nice Center Oil
- DSR แต่ละคนล็อกอินด้วย Google Account
- บันทึกไมล์รถ, เติมน้ำมัน, ซ่อมบำรุง, ค้างคืน, เบี้ยเลี้ยง
- ดูรายการบิลค้างชำระ (Debt) และบันทึกการเก็บเงิน (Collection)
- คำนวณยอดนำส่งบริษัท (Settlement) อัตโนมัติ
- Admin ดูภาพรวมทีม, สร้าง Cover Sheet PDF, สั่ง print ใบสรุป

### nco-slip2go
LINE Bot + Slip2Go OCR สำหรับรับสลิปโอนเงินจาก DSR ผ่าน LINE
- DSR ถ่ายรูปสลิปส่งใน LINE → ระบบ OCR ผ่าน Slip2Go API
- จับคู่สลิปกับบิลค้างชำระอัตโนมัติ (fuzzy matching)
- DSR พิมพ์รหัสลูกค้า / เลขบิลใน LINE เพื่อระบุว่าจ่ายบิลไหน
- มีหน้า Portal สำหรับตรวจสอบและแก้ไขข้อมูลสลิปรายสัปดาห์

### การเชื่อมต่อกัน
```
LINE Message → nco-slip2go (webhook)
                    ↓ write
             Slip2Go Spreadsheet (SPREADSHEET_ID_SLIP)
                    ↓ read
             dsr-operation-platform (Code_SlipMapping.js)
                    ↓ display
             DSR Portal → ใบสรุปใบโอน
```
- **nco-slip2go** อ่าน-เขียน Slip2Go SS และอ่าน DSR Ops SS (สำหรับหน้า DSR Review)
- **dsr-operation-platform** อ่าน Slip2Go SS เพื่อ mapping และสร้างรายงาน
- **Store SS** (hardcoded ID: `1ADwKdbF8Eo1ZuTXRRKUdgD-9NXvbphuA49PvB5sWGeY`) sheet `Pay` — แหล่งบิลจากร้านค้า

---

## 2. Architecture

### Script IDs (clasp)
| Project | Script ID |
|---|---|
| dsr-operation-platform | `1XhKsu9JOUn4PhAtlpIyZQt_YCD4YCS7XQAmAHNESSK97NVf5xWe7Yh0-` |
| nco-slip2go | `1cZKoN34xPRI6_dTRLNhQuxDPOVb_Fx7mXk4HyNrHdOD2m4f7JRLZwsu0` |

### Spreadsheet IDs
ทั้งหมดเก็บใน **Script Properties** (ไม่ hardcode ในโค้ด)

| Property Key | ใช้ใน | คืออะไร |
|---|---|---|
| `SPREADSHEET_ID` | ทั้งสอง project | DSR Operations spreadsheet |
| `SPREADSHEET_ID_SLIP` | ทั้งสอง project | Slip2Go spreadsheet |
| `DRIVE_FOLDER_ID` | dsr-operation-platform | Google Drive folder สำหรับ Cover Sheets |
| `PORTAL_URL` | nco-slip2go | Web App URL หลัง deploy (ต้องอัปเดตทุกครั้ง) |
| `ALLOWED_EMAILS` | dsr-operation-platform | whitelist emails คั่นด้วย comma |
| `LINE_CHANNEL_TOKEN` | nco-slip2go | LINE Bot token |
| `LINE_CHANNEL_SECRET` | nco-slip2go | LINE Bot secret |
| `SLIP2GO_API_KEY` | nco-slip2go | Slip2Go OCR API key |

Store SS ID (hardcoded): `1ADwKdbF8Eo1ZuTXRRKUdgD-9NXvbphuA49PvB5sWGeY`

### Sheet Names

**DSR Operations SS (SPREADSHEET_ID):**
```
USERS            — ข้อมูลผู้ใช้ (email, display_name, role, province_zone, active)
VEHICLES         — ทะเบียนรถ DSR
MILEAGE_LOG      — บันทึกไมล์รถ (เช้า/เย็น)
FUEL_LOG         — บันทึกเติมน้ำมัน
MAINTENANCE_LOG  — บันทึกซ่อมบำรุง
ALLOWANCE_LOG    — บันทึกค้างคืน + เบี้ยเลี้ยง
DEBT_MASTER      — รายการบิลค้างชำระ (import จาก BCAccount)
COLLECTION_LOG   — บันทึกการเก็บเงิน
AUDIT_LOG        — ทุก write action ถูก log ที่นี่
SETTINGS         — ค่าตั้งค่า (max_accommodation, daily_allowance, submit_day)
```

**Slip2Go SS (SPREADSHEET_ID_SLIP):**
```
Slip2Go          — ข้อมูลสลิป (email, amount, sender, receiver, date, invoice_no, status...)
PENDING_SLIPS    — สลิปที่รอจับคู่บิล (pending queue)
บิลค้างจ่าย      — นำเข้าจาก BCAccount CSV (windows-874 encoding)
USERS            — ข้อมูล DSR สำหรับ LINE Bot lookup
LINE_USER_MAP    — map LINE userId ↔ email
```

### Deploy URLs
เก็บใน Script Properties (`PORTAL_URL`) — **ต้องอัปเดตทุกครั้งที่สร้าง version ใหม่**

- dsr-operation-platform: Execute as **Me**, Access: **Anyone with Google**
- nco-slip2go: Execute as **Me** (USER_DEPLOYING), Access: **Anyone** (anonymous, สำหรับ LINE webhook)

### Version
dsr-operation-platform ปัจจุบัน: **v2.1.0**

---

## 3. DSR Team

| ชื่อ | Role | จังหวัด/โซน | หมายเหตุ |
|---|---|---|---|
| ภูมิ | admin | ทุกจังหวัด | |
| เฟิร์น | admin | ทุกจังหวัด | |
| นุช | dsr | สุพรรณบุรี | |
| นา | dsr | สิงห์บุรี | |
| แอน | dsr | อ่างทอง | |
| กร | dsr | ชัยนาท | |
| มัดหมี่ | dsr | อุทัยธานี, นครสวรรค์ | 2 จังหวัด |
| มาพราง | specialist | ทุกจังหวัด | เห็นข้อมูลทุกคน |

> **หมายเหตุ:** email จริงอยู่ใน USERS sheet (Script Properties `ALLOWED_EMAILS`)
> seed data ในโค้ดเป็น placeholder (`nuch.real@gmail.com` ฯลฯ) ไม่ใช่ email จริง

### รอบสรุป
- **วันจันทร์ → วันอาทิตย์** (Bangkok timezone) = 1 สัปดาห์
- **วันส่ง = วันเสาร์** (`SETTINGS.submit_day = saturday`)
- week number คำนวณโดย `weekNum()` / `getWeekRangeBKK()`

---

## 4. Business Rules

### ค่าใช้จ่าย
| Rule | ค่า | โค้ด |
|---|---|---|
| Cap ค้างคืน | **฿500 / คืน** | `CONFIG.MAX_ACCOMMODATION = 500` |
| เบี้ยเลี้ยงต่างจังหวัด | **฿200 / วัน** | `CONFIG.DAILY_ALLOWANCE = 200` |
| ส่วนเกิน cap | DSR รับผิดชอบเอง | `over_cap = actual > 500` |
| เบี้ยเลี้ยงจะได้ | เฉพาะวันที่ `is_provincial = true` | |

**สูตร Settlement (ยอดนำส่ง):**
```
Net Remittance = เงินสดรับ − ค่าเชื้อเพลิง − ค่าซ่อมบำรุง − ค่าที่พัก (ที่ claim ได้) − เบี้ยเลี้ยง
```

### การตรวจสอบเช็ค
- เลขที่เช็คต้องเป็น **ตัวเลข 8 หลักพอดี** — regex: `/^\d{8}$/`
- validate ฝั่ง frontend (`cash_entry.html:684`) ก่อน submit

### Invoice Normalization
ทั้งสอง project ใช้ `normalizeInvoice()` เหมือนกัน:
```
CA66050-2467  →  050-2467   (ตัด prefix จนเหลือ suffix หลัง -)
034-1666      →  034-1666   (ไม่เปลี่ยน ถ้าไม่มี prefix ยาว)
```
ใช้สำหรับ fuzzy match เพื่อรองรับ format ที่ต่างกันระหว่าง Slip2Go และ BCAccount

### Slip Matching Scenarios (LINE Bot)
| Scenario | เงื่อนไข | การจัดการ |
|---|---|---|
| A | 1 slip + 1 บิล | จับคู่อัตโนมัติ |
| B | 1 slip + หลายบิล | ให้ DSR เลือก |
| C | หลาย slip + 1 บิล | batch รวม |
| D | หลาย slip + หลายบิล | ambiguous → ส่ง link portal |
| E | รหัสลูกค้าอย่างเดียว | pending จนกว่าจะระบุบิล |

### Security / Rate Limit
- Session TTL: 3600 วินาที (1 ชั่วโมง)
- Rate limit: 60 requests / นาที / user
- Role-based access: admin เห็นทุกคน, dsr เห็นแค่ตัวเอง, specialist เห็นทั้งทีม

---

## 5. What's Done

- **Authentication:** Google login, token cache, roles (admin/specialist/dsr), rate limiting, audit log
- **DSR Portal (index.html):** หน้าหลัก dashboard, ไมล์รถ & ยานพาหนะ, เติมน้ำมัน, ซ่อมบำรุง, ค้างคืน/เบี้ยเลี้ยง, รายการบิล, ยอดนำส่ง
- **Cash/Cheque Entry (cash_entry.html):** บันทึกเงินสด/เช็คพร้อม validate เลข 8 หลัก, bank/branch selector
- **DSR Review (dsr_review.html):** ตรวจสอบ/แก้ไขสลิปรายสัปดาห์, ส่ง Cover Sheet
- **Print Templates:** `print_cash_cheque.html` (ใบสรุปเงินสด/โอน/เช็ค), `print_transfer.html` (ใบสรุปใบโอนพร้อมสถานะ matched/unmatched)
- **Slip Mapping (Code_SlipMapping.js):** fuzzy match, normalizeInvoice, writeWeeklySummarySheet, auto trigger 01:00 BKK, manual override, dry run test
- **LINE Bot (Code_LineBot.js):** webhook, OCR ผ่าน Slip2Go API (retry 3 ครั้ง), 5 scenarios, pending queue (cache + sheet)
- **Cover Sheet PDF:** buildCoverSheetHtmlV15 (latest), บันทึกใน Drive folder `NCO_CoverSheets`
- **Settlement Calculation:** คำนวณอัตโนมัติต่อสัปดาห์, confirmSettlement()
- **Import CSV:** BCAccount CSV (windows-874 / Thai encoding) → sheet `บิลค้างจ่าย`
- **Admin Dashboard:** ภาพรวมทีม DSR, getAllDSRSummary(), notification email
- **Vehicle Tracking:** MILEAGE_LOG, FUEL_LOG, MAINTENANCE_LOG พร้อม alert เมื่อถึงกำหนด
- **DSR Registration:** map LINE userId ↔ email ผ่านคำสั่ง `/register`
- **Audit Trail:** ทุก write action → AUDIT_LOG

---

## 6. What's Next (Gap List)

- **Seed emails ยังเป็น placeholder** — ต้องใส่ Gmail จริงของแต่ละ DSR ใน USERS sheet
  (ปัจจุบันโค้ดใส่ `nuch.real@gmail.com`, `na.real@gmail.com` ฯลฯ)
- **Export Excel** — ปุ่มมีแล้วใน Admin page (`"Export Excel"`) แต่ยังไม่มี handler
- **PORTAL_URL ต้องอัปเดตทุกครั้ง** — หลัง deploy version ใหม่ใน nco-slip2go ต้องไปอัปเดต Script Property `PORTAL_URL` ด้วย
- **Consolidate buildCoverSheetHtml versions** — มีทั้ง V1, V4, V5, V15 ใน Code.js → ควรเหลือแค่ V15
- **Duplicate DSR Review functions** — Code.js มีฟังก์ชัน serveDsrReviewPage / getDsrWeekSlips / saveDsrEdits ซ้ำกันหลายรอบ (comment ว่า "ย้ายมาจาก LineBot") → ควรเก็บไว้รอบเดียว
- **Real Gmail accounts** — `ALLOWED_EMAILS` Script Property ต้องมี email จริงของทีม DSR ทั้งหมด

---

## 7. Coding Rules

1. **อย่าแตะ/refactor function เดิมที่ทำงานอยู่แล้ว** — เพิ่มใหม่ข้างๆ หรือต่อท้าย แทนที่จะแก้ของเดิม
2. **ไม่ hardcode credentials** — ทุกอย่างผ่าน `Script Properties` (`prop('KEY')`)
3. **ทุกครั้งที่แก้โค้ด ต้อง `clasp push`** ก่อน deploy version ใหม่
4. **Deploy new version** หลัง push ทุกครั้ง (Manage Deployments → New Version)
5. **`git push`** หลังเสร็จทุกครั้ง เพื่อ sync โค้ดใน repo
6. **ไม่ใช้ `git add -A`** — add เฉพาะไฟล์ที่แก้
7. **Bangkok timezone เสมอ** — `Asia/Bangkok` ทั้งใน `appsscript.json` และ trigger
8. **ไม่ mock database ใน test** — ใช้ `testMappingDryRun()` / `runSmokeTest()` แทน
9. **ชื่อ function ภาษาอังกฤษ, comment ภาษาไทย** ได้เลย
10. **Invoice normalization ต้องใช้ `normalizeInvoice()`** เดียวกันทั้งสอง project (อย่าเขียนใหม่)

---

## 8. Workflow

### ทุกครั้งที่แก้โค้ด:
```bash
# 1. แก้ไขไฟล์ใน local
# 2. Push ไป Google Apps Script
clasp push

# 3. ไป Apps Script Editor → Deploy → Manage deployments → New version
#    (ทำใน browser)

# 4. ถ้า URL เปลี่ยน → อัปเดต Script Property PORTAL_URL ใน nco-slip2go

# 5. Commit + push git
git add <files>
git commit -m "feat/fix: ..."
git push
```

### Directory Structure
```
E:/Projects/
├── dsr-operation-platform/
│   ├── Code.js              ← backend หลัก (3400+ บรรทัด)
│   ├── Code_CashCheque.js   ← module เงินสด/เช็ค
│   ├── Code_SlipMapping.js  ← module จับคู่สลิป-บิล
│   ├── index.html           ← DSR Portal main UI
│   ├── cash_entry.html      ← หน้ากรอกเงินสด/เช็ค
│   ├── dsr_review.html      ← หน้าตรวจสอบสลิป
│   ├── print_cash_cheque.html  ← template print
│   ├── print_transfer.html     ← template print ใบโอน
│   └── appsscript.json
│
├── nco-slip2go/
│   ├── Code.js              ← CSV import + PDF download
│   ├── Code_LineBot.js      ← LINE Bot + Slip2Go (1180 บรรทัด)
│   └── appsscript.json
│
└── CLAUDE.md                ← ไฟล์นี้
```

### Useful Functions for Debugging
```javascript
// dsr-operation-platform
runSmokeTest()          // ทดสอบ DB connections ทั้งหมด
setupAll()              // สร้าง sheets + seed users (ทำครั้งเดียว)
testMappingDryRun()     // ทดสอบ slip mapping ไม่เขียน DB
debugNormalize()        // ทดสอบ invoice format normalization

// nco-slip2go
testConfig()            // ตรวจสอบ Script Properties ครบไหม
setProps()              // แสดง list properties ที่ยังไม่ตั้งค่า
clearAllCaches()        // ล้าง cache ทั้งหมด
setupAll()              // สร้าง PENDING_SLIPS sheet + columns
```
