# NCO DSR Portal — Mileage Bot Module

## Project Context
NCO DSR Portal is a Google Apps Script web app for Nice Center Oil (Castrol 
distributor, Thailand). Portal is stable. Now adding Mileage Bot as a new module.

Existing files (do not modify unless asked):
- Code.gs — Portal backend
- index.html — Portal frontend
- Code_LineBot.gs — Slip2Go LINE Bot (keep intact)

New file to create:
- Code_MileageBot.gs — Mileage LINE Bot

## Mileage Bot Spec

### Overview
New LINE OA deployed in a group chat with 6 DSRs.
DSR sends odometer photo → Vision API reads mileage → silent append to Sheet "Mileage"
Bot never replies to group under any circumstance.

### Session Detection
Timestamp before 13:00 = "morning", after 13:00 = "evening"

### Google Vision API Integration
- Use TEXT_DETECTION feature
- API key stored in Script Properties: GOOGLE_VISION_API_KEY
- Parse result: extract all numeric strings
- Filter: 5-6 digit numbers only
- Pick largest candidate (odometer is always biggest number on display)
- Ignore: temperature (2 digits), time (has colon), trip meter (3-4 digits)

### Fallback Logic (silent, no reply)
- morning Vision fail → use previous day's evening confirmedMile as startMile, sourceFlag = "prevDay"
- evening Vision fail → leave null, pendingFill = true
- No fallback available → leave null

### Validation (flag only, never reply)
- evening < morning → errorFlag = "eve<morn"
- distance > 500km → errorFlag = "long_dist" (note only)
- no morning record when evening arrives → errorFlag = "no_morning"

### Sheet "Mileage" Schema
id | dsrEmail | date | session | rawMile | confirmedMile |
startMile | endMile | distance | vehicleId | vehicleType |
confidence | sourceFlag | errorFlag | errorMsg | imageUrl | timestamp

sourceFlag: "vision" | "prevDay" | "manual"
errorFlag: "eve<morn" | "long_dist" | "no_morning" | null

### Sheet "USERS" — add columns if not present
lineUserId | dsrName | dsrEmail | defaultVehicleType | vehicleId | depreciation_rate

DSR config:
- แอน, นา, มะปราง → vehicleType: personal, depreciation_rate: 2.5
- นุช, มัดหมี่, กร → vehicleType: company, vehicleId: กท8821, depreciation_rate: 0

### Script Properties Required
- GOOGLE_VISION_API_KEY (already set)
- SPREADSHEET_ID (shared with portal)
- LINE_MILEAGE_CHANNEL_ACCESS_TOKEN (new OA — to be set after LINE OA created)

## Portal Extension (Code.gs + index.html)
Extend existing portal after bot is done.

### Backend functions to add in Code.gs
getMileageSummary(weekStart)
- All DSR mileage for the week, grouped by DSR, one row per day
- Include: date, morning, evening, distance, vehicleType, depreciationCost, sourceFlag, errorFlag

updateMileageRecord(id, confirmedMile)
- DSR edits own records only, Admin edits anyone
- Sets confirmedMile, sourceFlag = "manual"
- Recalculates distance if both sessions exist

getMileageWeeklySummary(dsrEmail, weekStart)
- Returns: totalDistance, totalDepreciationCost, workDays, incompleteDays

submitWeeklySummary(dsrEmail, weekStart)
- Marks week as submitted → admin sees in dashboard

### Frontend (index.html) — page "บันทึกไมล์"
Cell color rules:
- ✅ white = sourceFlag "vision"
- 🟡 yellow = sourceFlag "prevDay" or pendingFill
- ⬜ empty = null → DSR taps to enter manually
- 🔴 red = errorFlag "eve<morn"

Each cell: tap to view odometer photo + edit number

DSR flow: review week → fix yellow/empty → tap "ส่งสรุปสัปดาห์"
Admin flow: see all DSR submitted weeks in dashboard

### Integration with existing pages
- ยอดนำส่ง page: depreciationCost feeds into B.5 section automatically
- Week = Monday to Sunday
- Thai date format throughout (พ.ศ.)

## Implementation Order
1. Code_MileageBot.gs (bot logic + Vision API)
2. Code.gs mileage functions
3. index.html mileage page
4. Integration with ยอดนำส่ง B.5

Ask before modifying Code_LineBot.gs.
