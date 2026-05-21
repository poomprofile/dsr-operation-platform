// ╔══════════════════════════════════════════════════════════════════╗
// ║  Nice Center Oil — DSR Portal                                    ║
// ║  Google Apps Script Backend  •  Code.gs  •  v2.0                ║
// ║  Deploy → Web App → Execute as: Me → Access: Anyone w/ Google   ║
// ╚══════════════════════════════════════════════════════════════════╝

'use strict';

// ─────────────────────────────────────────────────────────────────────
//  SECTION 1 │ CONFIG & CONSTANTS
// ─────────────────────────────────────────────────────────────────────

const CONFIG = {
  SPREADSHEET_ID:     prop('SPREADSHEET_ID'),
  DRIVE_FOLDER_ID:    prop('DRIVE_FOLDER_ID'),
  // ── Email whitelist — อ่านจาก Script Properties (ALLOWED_EMAILS) ──
  // ตั้งค่าใน Apps Script Editor → Project Settings → Script Properties
  // รูปแบบ: email1@gmail.com,email2@gmail.com (คั่นด้วย comma)
  // ระบบตรวจจาก USERS sheet เป็นหลัก — list นี้เป็นด่านแรกก่อน DB
  ALLOWED_EMAILS:     prop('ALLOWED_EMAILS')
                        .split(',')
                        .map(function(e){ return e.trim().toLowerCase(); })
                        .filter(Boolean),
  MAX_ACCOMMODATION:  500,    // ฿/night cap
  DAILY_ALLOWANCE:    200,    // ฿/provincial overnight
  SESSION_TTL_SEC:    3600,   // token cache TTL
  RATE_LIMIT_PER_MIN: 60,
  VERSION:            '2.1.0',
};

const SH = {
  USERS:       'USERS',
  VEHICLES:    'VEHICLES',
  MILEAGE:     'MILEAGE_LOG',
  FUEL:        'FUEL_LOG',
  MAINTENANCE: 'MAINTENANCE_LOG',
  ALLOWANCE:   'ALLOWANCE_LOG',
  DEBT:        'DEBT_MASTER',
  COLLECTION:  'COLLECTION_LOG',
  AUDIT:       'AUDIT_LOG',
  SETTINGS:    'SETTINGS',
  SETTLE_EXP:  'SettlementExpenses',
  CASH_LOG:    'CASH_LOG',
  CHEQUE_LOG:  'CHEQUE_LOG',
  // Slip2Go sheets (อยู่ใน SPREADSHEET_ID_SLIP)
  SLIPS:       'Slip2Go',
  PENDING:     'PENDING_SLIPS',
};

const ROLES = { ADMIN: 'admin', SPECIALIST: 'specialist', DSR: 'dsr' };
const MAINT_TYPES = ['oil', 'fluid', 'repair', 'tire', 'tax', 'act', 'other'];

function prop(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 2 │ WEB APP ENTRY POINTS
// ─────────────────────────────────────────────────────────────────────

function doGet(e) {
  if (e && e.parameter) {
    var page = e.parameter.page;
    // Route: ?page=dsr-review&email=xxx
    if (page === 'dsr-review')         return serveDsrReviewPage(e.parameter.email || '');
    // Route: ?page=cash-entry
    if (page === 'cash-entry')         return serveCashEntryPage();
    // Route: ?page=print-cash-cheque&email=xxx&week=YY
    if (page === 'print-cash-cheque')  return servePrintCashChequePage(e.parameter.email || '', e.parameter.week || '');
    // Route: ?page=print-transfer&email=xxx&week=YY
    if (page === 'print-transfer')     return servePrintTransferPage(e.parameter.email || '', e.parameter.week || '');
  }
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('DSR Portal — Nice Center Oil')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function doPost(e) {
  const start = Date.now();
  let payload, user;
  try {
    if (!e.postData || !e.postData.contents) return err400('Empty request body');
    try { payload = JSON.parse(e.postData.contents); }
    catch (_) { return err400('Invalid JSON'); }

    if (!payload.action) return err400('Missing action');

    user = authenticateRequest(payload.token);
    if (!user) return err401('Unauthorized — invalid or expired token');

    if (!checkRateLimit(user.email)) return err429('Rate limit exceeded');

    const result = routeAction(payload.action, payload, user);

    if (isWriteAction(payload.action)) writeAudit(user.email, payload.action, payload.data || {});

    return ok({ result, meta: { ms: Date.now() - start, v: CONFIG.VERSION } });

  } catch (ex) {
    console.error('[doPost] action=%s err=%s', payload && payload.action, ex.message);
    writeAudit(user ? user.email : 'unknown', payload ? payload.action : '?', { error: ex.message });
    return err500(ex.message);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 3 │ AUTHENTICATION
// ─────────────────────────────────────────────────────────────────────

function authenticateRequest(idToken) {
  if (!idToken) return null;

  // Cache keyed on token hash
  const cache    = CacheService.getScriptCache();
  const cacheKey = 'tok_' + md5(idToken);
  const cached   = cache.get(cacheKey);
  if (cached) { try { return JSON.parse(cached); } catch (_) {} }

  // Verify with Google
  let info;
  try {
    const res = UrlFetchApp.fetch(
      'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(idToken),
      { muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) return null;
    info = JSON.parse(res.getContentText());
  } catch (_) { return null; }

  const now = Math.floor(Date.now() / 1000);
  if (!info.email)                                         return null;
  if (!isAllowedEmail(info.email))                         return null;
  if (String(info.email_verified) !== 'true')              return null;
  if (parseInt(info.exp) < now)                            return null;

  const profile = findUserByEmail(info.email);
  if (!profile || profile.active.toUpperCase() !== 'TRUE')               return null;

  const user = {
    email:         info.email,
    display_name:  profile.display_name,
    role:          profile.role,
    user_id:       profile.user_id,
    province_zone: profile.province_zone,
  };

  const ttl = Math.min(CONFIG.SESSION_TTL_SEC, parseInt(info.exp) - now - 60);
  if (ttl > 0) cache.put(cacheKey, JSON.stringify(user), ttl);
  return user;
}

// Called from client via google.script.run (no token needed)
function getUserProfile() {
  const email = Session.getActiveUser().getEmail();
  if (!email || !isAllowedEmail(email))
    throw new Error('Email not allowed: ' + email);
  const p = findUserByEmail(email);
  if (!p)                throw new Error('User not found — ติดต่อ Admin เพื่อเพิ่มสิทธิ์');
  if (p.active.toUpperCase() !== 'TRUE') throw new Error('Account disabled');
  return { email, display_name: p.display_name, role: p.role,
           user_id: p.user_id, province_zone: p.province_zone };
}
// ─── PUBLIC API HANDLER — เรียกจาก google.script.run ────────
// ใช้แทน doPost เพราะ google.script.run ไม่มีปัญหา CORS
function handleApiCall(action, payload) {
  payload = payload || {};
  var user = getUserProfile();
  // ถ้า Admin บันทึกข้อมูลของตัวเอง ให้ inject dsr_id อัตโนมัติ
  if (payload.data && !payload.data.dsr_id) {
    payload.data.dsr_id = user.email;
  }
  var result = routeAction(action, payload, user);
  if (isWriteAction(action)) writeAudit(user.email, action, payload.data || {});
  return result;
}


// ── Email whitelist check ──────────────────────────────────────────
// ตรวจสองชั้น: (1) อยู่ใน ALLOWED_EMAILS หรือไม่, (2) อยู่ใน USERS sheet หรือไม่
// Admin สามารถเพิ่ม email ใหม่ได้สองที่: CONFIG.ALLOWED_EMAILS + USERS sheet
function isAllowedEmail(email) {
  if (!email) return false;
  // ถ้าอยู่ใน hardcoded list → ผ่านด่านแรก
  if (CONFIG.ALLOWED_EMAILS.includes(email.toLowerCase())) return true;
  // fallback: ถ้าอยู่ใน USERS sheet และ active → ก็ผ่าน (Admin เพิ่มทีหลังได้)
  try {
    const u = findUserByEmail(email);
    return u && u.active.toUpperCase() === 'TRUE';
  } catch (_) { return false; }
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 4 │ RATE LIMITER
// ─────────────────────────────────────────────────────────────────────

function checkRateLimit(email) {
  const cache = CacheService.getScriptCache();
  const key   = 'rl_' + email + '_' + Math.floor(Date.now() / 60000);
  const count = parseInt(cache.get(key) || '0');
  if (count >= CONFIG.RATE_LIMIT_PER_MIN) return false;
  cache.put(key, String(count + 1), 60);
  return true;
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 5 │ ROUTER
// ─────────────────────────────────────────────────────────────────────

function routeAction(action, payload, user) {
  const d = payload.data || {};

  const routes = {
    // Users
    GET_USERS:              () => guard(ROLES.ADMIN, user, getUsers),
    GET_USER_PROFILE:       () => getUserByEmail(payload.email, user),
    UPSERT_USER:            () => guard(ROLES.ADMIN, user, () => upsertUser(d)),
    DEACTIVATE_USER:        () => guard(ROLES.ADMIN, user, () => deactivateUser(payload.email)),
    // Vehicles
    GET_VEHICLES:           () => getVehicles(user),
    UPSERT_VEHICLE:         () => upsertVehicle(d, user),
    DELETE_VEHICLE:         () => deleteVehicle(payload.vehicle_id, user),
    GET_MAINTENANCE_ALERTS: () => getMaintenanceAlerts(user),
    // Mileage (Module A)
    GET_MILEAGE:            () => getMileageLogs(user, payload.filters),
    SAVE_MILEAGE:           () => saveMileageLog(d, user),
    GET_TODAY_SESSIONS:     () => getTodaySessions(user),
    // Fuel (Module A)
    GET_FUEL:               () => getFuelLogs(user, payload.filters),
    SAVE_FUEL:              () => saveFuelLog(d, user),
    DELETE_FUEL:            () => ownerOrAdmin(user, payload.dsr_id, () => deleteRow(SH.FUEL, 'fuel_id', payload.fuel_id)),
    // Maintenance (Module A)
    GET_MAINTENANCE:        () => getMaintenanceLogs(user, payload.filters),
    SAVE_MAINTENANCE:       () => saveMaintenanceLog(d, user),
    // Allowance (Module B)
    GET_ALLOWANCE:          () => getAllowanceLogs(user, payload.filters),
    SAVE_ALLOWANCE:         () => saveAllowanceLog(d, user),
    DELETE_ALLOWANCE:       () => ownerOrAdmin(user, payload.dsr_id, () => deleteRow(SH.ALLOWANCE, 'allow_id', payload.allow_id)),
    // Debt (Module C)
    GET_DEBT:               () => getDebtList(user, payload.filters),
    IMPORT_DEBT_CSV:        () => guard(ROLES.ADMIN, user, () => importDebtCSV(payload.rows)),
    DELETE_DEBT_BATCH:      () => guard(ROLES.ADMIN, user, () => deleteDebtBatch(payload.batch_id)),
    // Collection (Module C)
    GET_COLLECTION:         () => getCollectionLogs(user, payload.filters),
    SAVE_COLLECTION:        () => saveCollectionLog(d, user),
    TOGGLE_COLLECTED:       () => toggleCollected(payload.debt_id, payload.collected, user),
    // Settlement (Module D)
    GET_SETTLEMENT:         () => getSettlement(user, payload.week_number),
    CONFIRM_SETTLEMENT:     () => confirmSettlement(payload.week_number, user),
    GET_WEEKLY_HISTORY:     () => getWeeklyHistory(user),
    // Admin
    GET_ALL_DSR_SUMMARY:    () => guardAdminOrSpec(user, () => getAllDSRSummary(payload.week_number)),
    GET_AUDIT_LOG:          () => guard(ROLES.ADMIN, user, () => getAuditLog(payload.filters)),
    GET_SETTINGS:           () => guard(ROLES.ADMIN, user, getSettings),
    SET_SETTING:            () => guard(ROLES.ADMIN, user, () => setSetting(payload.key, payload.value)),
    // Files
    UPLOAD_PHOTO:           () => uploadPhoto(payload.base64, payload.filename, payload.context, user),
    GENERATE_COVER_SHEET:   () => guardAdminOrSpec(user, () => generateCoverSheetDriveFile(payload.week_number, payload.dsr_id)),
    // Utility
    PING:                   () => ({ pong: true, email: user.email, role: user.role, v: CONFIG.VERSION }),
    // Cash / Cheque (Module E)
    SAVE_CASH:              () => saveCash(d, user),
    SAVE_CHEQUE:            () => saveCheque(d, user),
    GET_CASH_LOG:           () => normalizeDateFields(getCashLog(user, payload.filters), ['log_date']),
    GET_CHEQUE_LOG:         () => normalizeDateFields(getChequeLog(user, payload.filters), ['log_date']),
    GET_SUMMARY_DATA:       () => getSummaryData(user, payload.week_number, payload.dsr_email),
    SAVE_CASH_CHEQUE_BATCH: () => saveCashChequeBatch(payload.rows, user),
    GET_WEEKLY_SLIP_TOTAL:  () => {
      var em = (user.role === ROLES.DSR) ? user.email : (payload.dsrEmail || user.email);
      return getWeeklySlipTotal(payload.weekStart, em);
    },
    GET_DSR_SLIPS_WEEK:     () => {
      var em = (user.role === ROLES.DSR) ? user.email : (payload.dsrEmail || user.email);
      return getDsrWeekSlipsForWeek(payload.weekStart, em);
    },
    UPDATE_SLIP_BILL:       () => {
      var em = (user.role === ROLES.DSR) ? user.email : (payload.dsrEmail || user.email);
      return updateSlipBillMapping(payload.slipRowIndex, payload.newBillNo, em);
    },
    // Settlement Income / Expenses (Module F)
    GET_SETTLEMENT_INCOME:    () => {
      var em = (user.role === ROLES.DSR) ? user.email : (payload.dsrEmail || user.email);
      return getSettlementIncome(payload.weekStart, em);
    },
    GET_SETTLEMENT_EXPENSES:  () => {
      var em = (user.role === ROLES.DSR) ? user.email : (payload.dsrEmail || user.email);
      return getSettlementExpenses(payload.weekStart, em);
    },
    SAVE_SETTLEMENT_EXPENSES: () => saveSettlementExpenses(payload.data, user),
    // Mileage Summary (Module A extended)
    GET_MILEAGE_SUMMARY: () => {
      var em = (user.role === ROLES.DSR) ? user.email : (payload.dsrEmail || user.email);
      return getMileageSummary(payload.weekStart, em);
    },
  };

  if (!routes[action]) throw new Error('Unknown action: ' + action);
  return routes[action]();
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 6 │ ROLE GUARDS
// ─────────────────────────────────────────────────────────────────────

function guard(role, user, fn) {
  if (user.role !== role) throw new Error('Access denied — requires role: ' + role);
  return fn();
}
function guardAdminOrSpec(user, fn) {
  if (![ROLES.ADMIN, ROLES.SPECIALIST].includes(user.role))
    throw new Error('Access denied — admin or specialist only');
  return fn();
}
function ownerOrAdmin(user, targetEmail, fn) {
  if (user.role === ROLES.ADMIN || user.email === targetEmail) return fn();
  throw new Error('Access denied — not your record');
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 7 │ USERS
// ─────────────────────────────────────────────────────────────────────

function getUsers() { return sheetToObjects(SH.USERS); }

function getUserByEmail(email, requestingUser) {
  if (requestingUser.role === ROLES.DSR && email !== requestingUser.email)
    throw new Error('Access denied');
  const u = findUserByEmail(email);
  if (!u) throw new Error('User not found: ' + email);
  return u;
}

function upsertUser(data) {
  validate(data, ['email', 'display_name', 'role']);
  if (!Object.values(ROLES).includes(data.role))
    throw new Error('Invalid role: ' + data.role);
  const existing = findUserByEmail(data.email);
  if (existing) {
    bustUserCache(data.email);
    return updateSheetRow(SH.USERS, 'user_id', existing.user_id, data);
  }
  data.user_id = uuid(); data.created_at = ts(); data.active = data.active || 'TRUE';
  return appendSheetRow(SH.USERS, data);
}

function deactivateUser(email) {
  const u = findUserByEmail(email);
  if (!u) throw new Error('User not found');
  bustUserCache(email);
  return updateSheetRow(SH.USERS, 'user_id', u.user_id, { active: 'FALSE' });
}

function findUserByEmail(email) {
  const cache = CacheService.getScriptCache();
  const key   = 'usr_' + email;
  const hit   = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (_) {} }
  const u = sheetToObjects(SH.USERS).find(r => r.email === email) || null;
  if (u) cache.put(key, JSON.stringify(u), 300);
  return u;
}

function bustUserCache(email) { CacheService.getScriptCache().remove('usr_' + email); }

// ─────────────────────────────────────────────────────────────────────
//  SECTION 8 │ VEHICLES  (Module A)
// ─────────────────────────────────────────────────────────────────────

function getVehicles(user) {
  const all = sheetToObjects(SH.VEHICLES).filter(v => v.is_active.toUpperCase() === 'TRUE');
  return user.role === ROLES.DSR ? all.filter(v => v.dsr_id === user.email) : all;
}

function upsertVehicle(data, user) {
  validate(data, ['license_plate', 'vehicle_type', 'brand_model']);
  if (!['company_car', 'personal_car'].includes(data.vehicle_type))
    throw new Error('Invalid vehicle_type');
  if (user.role === ROLES.DSR) data.dsr_id = user.email;
  else validate(data, ['dsr_id']);
  if (!findUserByEmail(data.dsr_id)) throw new Error('DSR not found: ' + data.dsr_id);

  if (data.vehicle_id) {
    const existing = sheetToObjects(SH.VEHICLES).find(v => v.vehicle_id === data.vehicle_id);
    if (!existing) throw new Error('Vehicle not found');
    ownerOrAdmin(user, existing.dsr_id, () => {});
    return updateSheetRow(SH.VEHICLES, 'vehicle_id', data.vehicle_id, data);
  }
  data.vehicle_id = uuid(); data.is_active = 'TRUE'; data.created_at = ts();
  return appendSheetRow(SH.VEHICLES, data);
}

function deleteVehicle(vehicleId, user) {
  const v = sheetToObjects(SH.VEHICLES).find(x => x.vehicle_id === vehicleId);
  if (!v) throw new Error('Vehicle not found');
  ownerOrAdmin(user, v.dsr_id, () => {});
  return updateSheetRow(SH.VEHICLES, 'vehicle_id', vehicleId, { is_active: 'FALSE' });
}

function getMaintenanceAlerts(user) {
  const vehicles = getVehicles(user);
  const mileage  = sheetToObjects(SH.MILEAGE);
  const today    = new Date();
  const alerts   = [];

  vehicles.forEach(v => {
    const lastLog  = mileage
      .filter(m => m.vehicle_id === v.vehicle_id && m.end_km)
      .sort((a, b) => new Date(b.log_date) - new Date(a.log_date))[0];
    const curKm = lastLog ? parseInt(lastLog.end_km) : 0;

    if (v.oil_change_km) {
      const remain = parseInt(v.oil_change_km) - curKm;
      if (remain <= 3000) alerts.push({
        vehicle_id: v.vehicle_id, plate: v.license_plate, model: v.brand_model,
        type: 'oil', severity: remain <= 1000 ? 'urgent' : 'warning',
        message: 'น้ำมันเครื่องครบกำหนด — เหลือ ' + remain.toLocaleString() + ' km',
        current_km: curKm, due_km: parseInt(v.oil_change_km),
      });
    }

    ['tax_expiry_date', 'act_expiry_date', 'tire_change_date'].forEach(field => {
      if (!v[field]) return;
      const diff = daysDiff(today, new Date(v[field]));
      if (diff > 45) return;
      const typeMap = { tax_expiry_date:'tax', act_expiry_date:'act', tire_change_date:'tire' };
      const lblMap  = { tax_expiry_date:'ภาษีรถ', act_expiry_date:'พรบ.', tire_change_date:'ยาง' };
      alerts.push({
        vehicle_id: v.vehicle_id, plate: v.license_plate, model: v.brand_model,
        type: typeMap[field], severity: diff <= 14 ? 'urgent' : 'warning',
        message: lblMap[field] + (diff >= 0 ? ' หมดอายุอีก ' + diff + ' วัน' : ' หมดอายุแล้ว ' + Math.abs(diff) + ' วัน'),
        days_remaining: diff, due_date: v[field],
      });
    });
  });

  return alerts.sort((a) => a.severity === 'urgent' ? -1 : 1);
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 9 │ MILEAGE LOG  (Module A)
// ─────────────────────────────────────────────────────────────────────

function getMileageLogs(user, filters) {
  filters = filters || {};
  var rows = sheetToObjects(SH.MILEAGE);
  if (user.role === ROLES.DSR) rows = rows.filter(r => r.dsr_id === user.email);
  return applyFilters(rows, filters, ['log_date', 'vehicle_id', 'session', 'week_number']);
}

function getTodaySessions(user) {
  const today = todayStr();
  const logs  = getMileageLogs(user, { log_date: today });
  return {
    morning_done: logs.some(r => r.session === 'morning' && r.start_km),
    evening_done: logs.some(r => r.session === 'evening' && r.end_km),
    morning: logs.find(r => r.session === 'morning') || null,
    evening: logs.find(r => r.session === 'evening') || null,
  };
}

function saveMileageLog(data, user) {
  validate(data, ['vehicle_id', 'log_date', 'session']);
  if (!['morning', 'evening'].includes(data.session))
    throw new Error('session must be morning or evening');
  if (user.role === ROLES.DSR) data.dsr_id = user.email;
  else validate(data, ['dsr_id']);

  if (data.start_km && isNaN(parseInt(data.start_km))) throw new Error('start_km must be a number');
  if (data.end_km   && isNaN(parseInt(data.end_km)))   throw new Error('end_km must be a number');
  if (data.start_km && data.end_km && parseInt(data.end_km) < parseInt(data.start_km))
    throw new Error('end_km must be >= start_km');

  if (data.start_km && data.end_km)
    data.distance_km = parseInt(data.end_km) - parseInt(data.start_km);
  data.week_number = weekNum(new Date(data.log_date));

  // Upsert — 1 record per DSR × vehicle × session × date
  const existing = getMileageLogs(user, { log_date: data.log_date, session: data.session })
    .find(r => r.vehicle_id === data.vehicle_id);
  if (existing) return updateSheetRow(SH.MILEAGE, 'log_id', existing.log_id, data);

  data.log_id = uuid(); data.created_at = ts();
  return appendSheetRow(SH.MILEAGE, data);
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 10 │ FUEL LOG  (Module A)
// ─────────────────────────────────────────────────────────────────────

function getFuelLogs(user, filters) {
  filters = filters || {};
  var rows = sheetToObjects(SH.FUEL);
  if (user.role === ROLES.DSR) rows = rows.filter(r => r.dsr_id === user.email);
  return applyFilters(rows, filters, ['fuel_date', 'vehicle_id', 'week_number']);
}

function saveFuelLog(data, user) {
  validate(data, ['fuel_date', 'vehicle_id', 'price_per_liter', 'liters']);
  if (user.role === ROLES.DSR) data.dsr_id = user.email;
  else validate(data, ['dsr_id']);

  const price  = parseFloat(data.price_per_liter);
  const liters = parseFloat(data.liters);
  if (isNaN(price) || price <= 0)   throw new Error('Invalid price_per_liter');
  if (isNaN(liters) || liters <= 0) throw new Error('Invalid liters');

  data.total_cost  = r2(price * liters);
  data.week_number = weekNum(new Date(data.fuel_date));
  data.fuel_id     = uuid();
  data.created_at  = ts();
  return appendSheetRow(SH.FUEL, data);
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 11 │ MAINTENANCE LOG  (Module A)
// ─────────────────────────────────────────────────────────────────────

function getMaintenanceLogs(user, filters) {
  filters = filters || {};
  var rows = sheetToObjects(SH.MAINTENANCE);
  if (user.role === ROLES.DSR) rows = rows.filter(r => r.dsr_id === user.email);
  return applyFilters(rows, filters, ['maint_date', 'vehicle_id', 'maint_type']);
}

function saveMaintenanceLog(data, user) {
  validate(data, ['vehicle_id', 'maint_date', 'maint_type', 'cost']);
  if (!MAINT_TYPES.includes(data.maint_type)) throw new Error('Invalid maint_type: ' + data.maint_type);
  if (user.role === ROLES.DSR) data.dsr_id = user.email;
  else validate(data, ['dsr_id']);

  const cost = parseFloat(data.cost);
  if (isNaN(cost) || cost < 0) throw new Error('Invalid cost');
  data.cost = cost;
  data.maint_id   = uuid();
  data.created_at = ts();
  const result = appendSheetRow(SH.MAINTENANCE, data);
  syncVehicleDueDates(data);
  return result;
}

function syncVehicleDueDates(maint) {
  const up = {};
  if (maint.maint_type === 'oil'  && maint.next_due_km)   up.oil_change_km   = maint.next_due_km;
  if (maint.maint_type === 'tire' && maint.next_due_date)  up.tire_change_date = maint.next_due_date;
  if (maint.maint_type === 'tax'  && maint.next_due_date)  up.tax_expiry_date  = maint.next_due_date;
  if (maint.maint_type === 'act'  && maint.next_due_date)  up.act_expiry_date  = maint.next_due_date;
  if (Object.keys(up).length) updateSheetRow(SH.VEHICLES, 'vehicle_id', maint.vehicle_id, up);
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 12 │ ALLOWANCE LOG  (Module B)
// ─────────────────────────────────────────────────────────────────────

function getAllowanceLogs(user, filters) {
  filters = filters || {};
  var rows = sheetToObjects(SH.ALLOWANCE);
  if (user.role === ROLES.DSR) rows = rows.filter(r => r.dsr_id === user.email);
  return applyFilters(rows, filters, ['stay_date', 'province', 'week_number']);
}

function saveAllowanceLog(data, user) {
  validate(data, ['stay_date', 'province']);
  if (user.role === ROLES.DSR) data.dsr_id = user.email;
  else validate(data, ['dsr_id']);

  const actual  = parseFloat(data.accommodation_cost) || 0;
  if (actual < 0) throw new Error('accommodation_cost cannot be negative');
  const isProv  = data.is_provincial === 'true' || data.is_provincial === true || data.is_provincial === 'TRUE';
  const claimed = Math.min(actual, CONFIG.MAX_ACCOMMODATION);
  const daily   = isProv ? CONFIG.DAILY_ALLOWANCE : 0;

  data.accommodation_claimed = claimed;
  data.daily_allowance       = daily;
  data.is_provincial         = isProv ? 'TRUE' : 'FALSE';
  data.week_number           = weekNum(new Date(data.stay_date));
  data.allow_id              = uuid();
  data.created_at            = ts();

  const result = appendSheetRow(SH.ALLOWANCE, data);
  return { ...result, claimed, allowance: daily, over_cap: actual > CONFIG.MAX_ACCOMMODATION };
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 13 │ DEBT MASTER  (Module C)
// ─────────────────────────────────────────────────────────────────────

function getDebtList(user, filters) {
  filters = filters || {};
  var rows = sheetToObjects(SH.DEBT);
  if (user.role === ROLES.DSR) rows = rows.filter(r => r.assigned_dsr_id === user.email);
  return applyFilters(rows, filters, ['week_number', 'status', 'assigned_dsr_id']);
}

function importDebtCSV(rows) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('No rows to import');

  var batch   = ts();
  var count   = 0;
  var skipped = 0;
  var errors  = [];

  rows.forEach(function(r, i) {
    try {
      var mapped = mapDebtCSVRow(r, i);
      appendSheetRow(SH.DEBT, Object.assign({}, mapped, {
        debt_id: uuid(), status: 'pending', import_batch: batch,
      }));
      count++;
    } catch(e) {
      skipped++;
      errors.push('Row ' + (i+1) + ': ' + e.message);
    }
  });

  return { imported: count, skipped: skipped, errors: errors.slice(0,5), batch_id: batch };
}

// แปลง CSV row → debt record รองรับ format จาก export ระบบบริษัท
function mapDebtCSVRow(r, idx) {
  var invoice  = r['invoice_no'] || r['INVOICENO'] || r['invoiceno'] || r['DOCNO'] || r['docno'] || '';
  var customer = r['customer_name'] || r['SALE'] || r['sale'] || r['ชื่อลูกค้า'] || '';
  var code     = r['customer_code'] || r['TAXNO'] || r['taxno'] || r['รหัสลูกค้า'] || '';
  var amount   = parseFloat(r['amount'] || r['AMOUNT'] || r['ยอดหนี้'] || 0);
  var dsr      = r['assigned_dsr_id'] || r['dsr_id'] || r['DSR'] || '';
  var week     = r['week_number'] || r['WEEK'] || weekNum(new Date());
  var due      = r['due_date'] || r['DUEDATE'] || r['duedate'] || '';
  var invDate  = r['invoice_date'] || '';

  // สร้างวันที่จาก YEAR/MONTH/DAY ถ้ามี
  if (!invDate && r['YEAR'] && r['MONTH'] && r['DAY']) {
    var yr = parseInt(r['YEAR']);
    if (yr > 2400) yr = yr - 543; // แปลง พ.ศ. → ค.ศ.
    invDate = yr + '-' + String(r['MONTH']).padStart(2,'0') + '-' + String(r['DAY']).padStart(2,'0');
  }

  // แปลง DUEDATE format "18-May-2014 0:00:00" → "2014-05-18"
  if (due && due.toString().match(/\d{1,2}-[A-Za-z]{3}-\d{4}/)) {
    try { due = new Date(due).toISOString().split('T')[0]; } catch(e) {}
  }

  if (!invoice)  throw new Error('ไม่พบเลขที่ใบแจ้งหนี้ (INVOICENO/DOCNO)');
  if (!customer) throw new Error('ไม่พบชื่อลูกค้า (SALE/customer_name)');
  if (amount <= 0) throw new Error('ยอดหนี้ต้องมากกว่า 0');

  return {
    assigned_dsr_id: dsr,        // Admin assign ทีหลังได้ใน Sheet
    customer_name:   customer,
    customer_code:   code,
    invoice_no:      invoice,
    invoice_date:    invDate,
    due_date:        due,
    amount:          amount,
    week_number:     String(week),
    status:          'pending',
  };
}

function deleteDebtBatch(batchId) {
  if (!batchId) throw new Error('batch_id required');
  const sheet   = getSheet(SH.DEBT);
  const data    = sheet.getDataRange().getValues();
  const headers = data[0];
  const bIdx    = headers.indexOf('import_batch');
  var deleted = 0;
  for (var i = data.length - 1; i >= 1; i--) {
    if (data[i][bIdx] === batchId) { sheet.deleteRow(i + 1); deleted++; }
  }
  return { deleted: deleted, batch_id: batchId };
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 14 │ COLLECTION LOG  (Module C)
// ─────────────────────────────────────────────────────────────────────

function getCollectionLogs(user, filters) {
  filters = filters || {};
  var rows = sheetToObjects(SH.COLLECTION);
  if (user.role === ROLES.DSR) rows = rows.filter(r => r.dsr_id === user.email);
  return applyFilters(rows, filters, ['collect_date', 'debt_id', 'week_number']);
}

function saveCollectionLog(data, user) {
  validate(data, ['debt_id', 'collect_date', 'amount_collected', 'payment_method']);
  if (!['cash', 'transfer', 'cheque'].includes(data.payment_method))
    throw new Error('Invalid payment_method');
  if (user.role === ROLES.DSR) data.dsr_id = user.email;
  else validate(data, ['dsr_id']);

  const debt = getDebtList(user, {}).find(d => d.debt_id === data.debt_id);
  if (!debt) throw new Error('Debt not found or not assigned to you');
  if (debt.status === 'collected') throw new Error('Bill already collected');

  const amt = parseFloat(data.amount_collected);
  if (isNaN(amt) || amt <= 0) throw new Error('amount_collected must be positive');
  data.amount_collected = amt;
  data.week_number      = weekNum(new Date(data.collect_date));
  data.collect_id       = uuid();
  data.created_at       = ts();
  appendSheetRow(SH.COLLECTION, data);

  const newStatus = amt >= parseFloat(debt.amount) ? 'collected' : 'partial';
  updateSheetRow(SH.DEBT, 'debt_id', data.debt_id, { status: newStatus });
  return { collect_id: data.collect_id, new_debt_status: newStatus };
}

function toggleCollected(debtId, isCollected, user) {
  if (!debtId) throw new Error('debt_id required');
  const debt = sheetToObjects(SH.DEBT).find(d => d.debt_id === debtId);
  if (!debt) throw new Error('Debt not found');
  if (user.role === ROLES.DSR && debt.assigned_dsr_id !== user.email)
    throw new Error('Access denied — not your debt');

  const newStatus = isCollected ? 'collected' : 'pending';
  updateSheetRow(SH.DEBT, 'debt_id', debtId, { status: newStatus });

  if (!isCollected) {
    // Remove latest collection entry for this debt
    const sheet   = getSheet(SH.COLLECTION);
    const data    = sheet.getDataRange().getValues();
    const headers = data[0];
    const dIdx    = headers.indexOf('debt_id');
    for (var i = data.length - 1; i >= 1; i--) {
      if (data[i][dIdx] === debtId) { sheet.deleteRow(i + 1); break; }
    }
  }
  return { debt_id: debtId, new_status: newStatus };
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 15 │ SETTLEMENT  (Module D)
// ─────────────────────────────────────────────────────────────────────

function getSettlement(user, weekNumber) {
  const week = weekNumber || weekNum(new Date());

  const collections = getCollectionLogs(user, { week_number: String(week) });
  const totalCash   = sumField(collections, 'amount_collected');

  const fuel        = getFuelLogs(user, { week_number: String(week) });
  const totalFuel   = sumField(fuel, 'total_cost');

  const allow       = getAllowanceLogs(user, { week_number: String(week) });
  const totalAccom  = sumField(allow, 'accommodation_claimed');
  const totalDaily  = sumField(allow, 'daily_allowance');

  const allMaint    = getMaintenanceLogs(user, {});
  const weekMaint   = allMaint.filter(m => weekNum(new Date(m.maint_date)) === parseInt(week));
  const totalMaint  = sumField(weekMaint, 'cost');

  const totalExp    = r2(totalFuel + totalAccom + totalDaily + totalMaint);
  const netRemit    = r2(totalCash - totalExp);

  const allDebts    = getDebtList(user, { week_number: String(week) });
  const collected   = allDebts.filter(d => d.status === 'collected');

  return {
    week_number:     parseInt(week),
    dsr_email:       user.email,
    dsr_name:        user.display_name,
    total_cash:      r2(totalCash),
    bill_count:      allDebts.length,
    collected_count: collected.length,
    total_fuel:      r2(totalFuel),
    total_accom:     r2(totalAccom),
    total_allowance: r2(totalDaily),
    total_maint:     r2(totalMaint),
    total_expenses:  totalExp,
    net_remittance:  netRemit,
    is_positive:     netRemit >= 0,
  };
}

function confirmSettlement(weekNumber, user) {
  if (!weekNumber) throw new Error('week_number required');
  const settle = getSettlement(user, weekNumber);
  writeAudit(user.email, 'SETTLEMENT_CONFIRMED',
    { week: weekNumber, net: settle.net_remittance, cash: settle.total_cash });
  return { confirmed: true, week: weekNumber, settlement: settle };
}

function getWeeklyHistory(user) {
  const cur = weekNum(new Date());
  return [cur, cur-1, cur-2, cur-3].map(w => Object.assign({ week: w }, getSettlement(user, w)));
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 16 │ ADMIN SUMMARY
// ─────────────────────────────────────────────────────────────────────

function getAllDSRSummary(weekNumber) {
  const week  = weekNumber || weekNum(new Date());
  const users = getUsers().filter(u =>
    [ROLES.DSR, ROLES.SPECIALIST].includes(u.role) && u.active.toUpperCase() === 'TRUE'
  );
  return users.map(u => {
    const fu = { email: u.email, role: u.role, display_name: u.display_name, user_id: u.user_id };
    return Object.assign({}, u, {
      settlement:    getSettlement(fu, week),
      alert_count:   getMaintenanceAlerts(fu).filter(a => a.severity === 'urgent').length,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 17 │ SETTINGS
// ─────────────────────────────────────────────────────────────────────

function getSettings() {
  return sheetToObjects(SH.SETTINGS).reduce((m, r) => { m[r.key] = r.value; return m; }, {});
}

function setSetting(key, value) {
  if (!key) throw new Error('key required');
  const rows = sheetToObjects(SH.SETTINGS);
  if (rows.find(r => r.key === key))
    return updateSheetRow(SH.SETTINGS, 'key', key, { value: value, updated_at: ts() });
  return appendSheetRow(SH.SETTINGS, { key: key, value: value, updated_at: ts() });
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 18 │ PHOTO UPLOAD
// ─────────────────────────────────────────────────────────────────────

function uploadPhoto(base64Data, filename, context, user) {
  if (!base64Data) throw new Error('base64 data required');
  if (!filename)   throw new Error('filename required');
  if (base64Data.length > 7 * 1024 * 1024) throw new Error('File too large — max ~5 MB');

  const ext  = filename.split('.').pop().toLowerCase();
  const mime = ({ jpg:'image/jpeg', jpeg:'image/jpeg', png:'image/png', heic:'image/heic' })[ext] || 'image/jpeg';

  const root     = DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID);
  const dsrDir   = getOrMakeFolder(root, user.email);
  const ctxDir   = getOrMakeFolder(dsrDir, context || 'misc');
  const blob     = Utilities.newBlob(Utilities.base64Decode(base64Data), mime, filename);
  const file     = ctxDir.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return {
    file_id:      file.getId(),
    filename:     file.getName(),
    view_url:     'https://drive.google.com/file/d/' + file.getId() + '/view',
    download_url: file.getDownloadUrl(),
    size_bytes:   file.getSize(),
  };
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 19 │ COVER SHEET → GOOGLE DRIVE  (Module C)
// ─────────────────────────────────────────────────────────────────────

function generateCoverSheetDriveFile(weekNumber, dsrEmail) {
  const week    = weekNumber || weekNum(new Date());
  const profile = findUserByEmail(dsrEmail);
  if (!profile) throw new Error('DSR not found: ' + dsrEmail);

  const fu      = { email: dsrEmail, role: ROLES.DSR,
                    display_name: profile.display_name, user_id: profile.user_id };
  const debts   = getDebtList(fu, { week_number: String(week), status: 'collected' });
  const settle  = getSettlement(fu, week);
  const mileage = getMileageLogs(fu, { week_number: String(week) });
  const allow   = getAllowanceLogs(fu, { week_number: String(week) });

  const html  = buildCoverSheetHTML(profile, debts, settle, mileage, allow, week);
  const stamp = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyyMMdd_HHmm');
  const fname = 'CoverSheet_W' + week + '_' + profile.display_name + '_' + stamp + '.html';

  const folder = getOrMakeFolder(DriveApp.getFolderById(CONFIG.DRIVE_FOLDER_ID), 'cover_sheets');
  const file   = folder.createFile(fname, html, MimeType.HTML);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  return {
    filename:   fname,
    view_url:   'https://drive.google.com/file/d/' + file.getId() + '/view',
    week:       week,
    dsr:        profile.display_name,
    bill_count: debts.length,
    net:        settle.net_remittance,
  };
}

function buildCoverSheetHtmlV5(rows, dsrName, today, total, weekLabel) {
  var logoHtml = getLogoBase64Html();
 
  function trimInv(inv) {
    if (!inv) return '';
    var s = String(inv).trim();
    return /^[A-Za-z]{2}\d{2}/.test(s) ? s.slice(4) : s;
  }
 
  var tableRows = rows.map(function(r, i) {
    var amt     = parseMoneyCell(r['ยอดเงิน']);
    var note    = r['note'] || '';
    var dateStr = formatDateThai2(r['วันที่โอน']);
    if (!dateStr || dateStr.indexOf('1899')>=0 || dateStr.indexOf('1970')>=0) dateStr='';
    var invDisplay = trimInv(r['เลขที่บิล']||'');
 
    return '<tr>'+
      '<td class="c">'+(i+1)+'</td>'+
      '<td>'+escapeHtmlSrv(r['รหัสลูกค้า']||'')+
        (r['ชื่อร้าน']?'<br><small style="color:#555">'+escapeHtmlSrv(r['ชื่อร้าน'])+'</small>':'')+'</td>'+
      '<td class="c">'+escapeHtmlSrv(invDisplay)+'</td>'+
      '<td class="r">'+formatMoney(parseMoneyCell(r['ยอดบิล']||amt))+'</td>'+
      '<td></td>'+
      '<td class="r">'+formatMoney(amt)+'</td>'+
      '<td class="c">'+escapeHtmlSrv(dateStr)+'</td>'+
      '<td></td><td></td><td></td>'+
      '<td>'+escapeHtmlSrv(note)+'</td>'+
      '</tr>';
  }).join('');
 
  var empty = '';
  for (var i = rows.length; i < 15; i++) {
    empty += '<tr><td class="c">'+(i+1)+'</td><td></td><td></td><td></td>'+
             '<td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>';
  }
 
  var css = [
    '* { box-sizing: border-box; margin: 0; padding: 0; }',
    '@page { size: A4 landscape; margin: 15mm 10mm; }',
    'body { font-family: Tahoma, "Arial Unicode MS", Arial, sans-serif; font-size: 12px; color: #000; }',
    // screen preview (เปิด tab ใหม่ดูก่อน print)
    '@media screen {',
    '  body { background: #f5f5f5; display: flex; align-items: flex-start; justify-content: center; padding: 24px; }',
    '  .page-wrap { background: #fff; padding: 20mm 15mm; width: 297mm; min-height: 210mm; box-shadow: 0 4px 24px rgba(0,0,0,.15); }',
    '  .print-btn { position: fixed; top: 16px; right: 16px; background: #007B40; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit; box-shadow: 0 2px 8px rgba(0,0,0,.2); }',
    '  .print-btn:active { transform: scale(.97); }',
    '}',
    '@media print {',
    '  body { background: none; padding: 0; display: block; }',
    '  .page-wrap { box-shadow: none; padding: 0; width: 100%; }',
    '  .print-btn { display: none; }',
    '}',
    // layout
    '.top { display: flex; justify-content: space-between; align-items: center; border-bottom: 1.5px solid #000; padding-bottom: 5px; margin-bottom: 6px; }',
    '.title { font-size: 15px; font-weight: bold; }',
    '.meta-wrap { text-align: center; }',
    '.meta { font-size: 12px; }',
    '.meta span { margin: 0 10px; }',
    '.wrange { font-size: 13px; font-weight: bold; margin-top: 3px; color: #333; }',
    '.logo img { height: 38px; object-fit: contain; }',
    // table
    'table { width: 100%; border-collapse: collapse; table-layout: fixed; margin-top: 2px; }',
    'th { font-size: 11px; font-weight: bold; border: 1px solid #555; padding: 3px 2px; text-align: center; background: #f0f0f0; white-space: nowrap; }',
    'td { border: 1px solid #555; padding: 3px 4px; font-size: 11px; vertical-align: middle; overflow: hidden; }',
    'tr:nth-child(even) td { background: #fafafa; }',
    'col.no  { width: 4%; }',
    'col.cu  { width: 20%; }',
    'col.bi  { width: 9%; }',
    'col.am  { width: 8%; }',
    'col.eq  { width: 7%; }',
    'col.nt  { width: 14%; }',
    '.c { text-align: center; }',
    '.r { text-align: right; }',
    '.sub { display: flex; justify-content: flex-end; margin-top: 4px; gap: 0; }',
    '.box { border: 1px solid #555; padding: 3px 8px; font-size: 12px; font-weight: bold; min-width: 130px; text-align: right; }',
    '.foot { margin-top: 12px; display: flex; align-items: flex-end; gap: 20px; }',
    '.note-area { width: 44%; }',
    '.note-label { font-size: 11px; color: #555; }',
    '.note-line { border-bottom: 1px dotted #000; height: 20px; margin-top: 3px; }',
    '.sig { min-width: 200px; padding-left: 16px; text-align: center; }',
    '.sig-line { border-top: 1px solid #555; margin-top: 32px; padding-top: 4px; font-size: 12px; font-weight: bold; }',
  ].join('\n');
 
  return '<!DOCTYPE html><html lang="th"><head>'+
    '<meta charset="UTF-8">'+
    '<meta name="viewport" content="width=device-width,initial-scale=1">'+
    '<title>ใบสรุปเงิน — '+escapeHtmlSrv(dsrName)+'</title>'+
    '<style>'+css+'</style>'+
    '</head><body>'+
 
    '<button class="print-btn" onclick="window.print()">🖨️ พิมพ์ / บันทึก PDF</button>'+
 
    '<div class="page-wrap">'+
 
    '<div class="top">'+
    '<div class="title">ใบสรุปเงินสด / โอน / เช็ค</div>'+
    '<div class="meta-wrap">'+
      '<div class="meta">'+
        '<span>วันที่พิมพ์: <b>'+today+'</b></span>'+
        '<span>DSR: <b>'+escapeHtmlSrv(dsrName)+'</b></span>'+
      '</div>'+
      (weekLabel?'<div class="wrange">สัปดาห์ '+escapeHtmlSrv(weekLabel)+'</div>':'')+
    '</div>'+
    '<div class="logo">'+logoHtml+'</div>'+
    '</div>'+
 
    '<table><colgroup>'+
    '<col class="no"><col class="cu"><col class="bi"><col class="am">'+
    '<col class="eq"><col class="eq"><col class="eq">'+
    '<col class="eq"><col class="eq"><col class="eq"><col class="nt">'+
    '</colgroup><thead>'+
    '<tr>'+
    '<th rowspan="2">No.</th>'+
    '<th rowspan="2">รหัส - ชื่อ ลูกค้า</th>'+
    '<th rowspan="2">เลขที่บิล</th>'+
    '<th rowspan="2">ยอดบิล</th>'+
    '<th colspan="6">รายการเก็บ เงินสด / โอน / เช็ค</th>'+
    '<th rowspan="2">หมายเหตุ</th>'+
    '</tr>'+
    '<tr><th>เงินสด</th><th>ยอดโอน/เช็ค</th><th>วันที่โอน/เช็ค</th><th>เลขที่เช็ค</th><th>ธนาคาร</th><th>สาขา</th></tr>'+
    '</thead>'+
    '<tbody>'+tableRows+empty+'</tbody>'+
    '</table>'+
 
    '<div class="sub">'+
    '<div class="box">รวมยอดเงินสด: <b>0</b></div>'+
    '<div class="box">ยอดเก็บเงินรวม: <b>'+formatMoney(total)+'</b></div>'+
    '</div>'+
 
    '<div class="foot">'+
    '<div class="note-area">'+
      '<div class="note-label">Note :</div>'+
      '<div class="note-line"></div>'+
    '</div>'+
    '<div class="sig"><div class="sig-line">ลงชื่อผู้ส่งเงิน</div></div>'+
    '</div>'+
 
    '</div>'+ // end page-wrap
 
    // auto print เมื่อ resource โหลดครบ
    '<script>'+
    'window.addEventListener("load",function(){'+
    '  setTimeout(function(){window.print();},300);'+
    '});'+
    '<\/script>'+
    '</body></html>';
}
// ─────────────────────────────────────────────────────────────────────
//  SECTION 20 │ AUDIT LOG
// ─────────────────────────────────────────────────────────────────────

function writeAudit(email, action, data) {
  try {
    appendSheetRow(SH.AUDIT, {
      timestamp:  ts(),
      user_email: email,
      action:     action,
      detail:     typeof data === 'string' ? data : JSON.stringify(data),
    });
  } catch (e) {
    console.warn('[Audit] write failed:', e.message);
  }
}

function getAuditLog(filters) {
  filters = filters || {};
  var rows = sheetToObjects(SH.AUDIT);
  if (filters.email)  rows = rows.filter(function(r){ return r.user_email === filters.email; });
  if (filters.action) rows = rows.filter(function(r){ return r.action     === filters.action; });
  if (filters.date)   rows = rows.filter(function(r){ return r.timestamp && r.timestamp.startsWith(filters.date); });
  return rows.slice(-200);
}

function isWriteAction(action) {
  return /^(SAVE|UPSERT|CREATE|DELETE|IMPORT|TOGGLE|CONFIRM|SET|DEACTIVATE)/.test(action);
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 21 │ DAILY TRIGGER
// ─────────────────────────────────────────────────────────────────────

function dailyMaintenanceAlerts() {
  var users = getUsers().filter(function(u){ return u.role === ROLES.DSR && u.active.toUpperCase() === 'TRUE'; });
  users.forEach(function(u) {
    var fu     = { email: u.email, role: u.role, display_name: u.display_name, user_id: u.user_id };
    var alerts = getMaintenanceAlerts(fu).filter(function(a){ return a.severity === 'urgent'; });
    if (!alerts.length) return;
    var lines  = alerts.map(function(a){ return '• [' + a.plate + '] ' + a.message; }).join('\n');
    GmailApp.sendEmail(
      u.email,
      '[NCO แจ้งเตือน] รถต้องดูแล — ' + alerts.length + ' รายการ',
      'คุณ' + u.display_name + ',\n\nมีการแจ้งเตือนเร่งด่วน:\n\n' + lines + '\n\nกรุณาดำเนินการโดยเร็ว\n\n— ระบบ NCO DSR Portal'
    );
  });
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 22 │ SHEET UTILITIES
// ─────────────────────────────────────────────────────────────────────

function getSheet(name) {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sh = ss.getSheetByName(name);
  if (!sh) throw new Error('Sheet not found: ' + name);
  return sh;
}

function sheetToObjects(sheetName) {
  var sheet   = getSheet(sheetName);
  var vals    = sheet.getDataRange().getValues();
  if (vals.length < 2) return [];
  var headers = vals[0];
  return vals.slice(1)
    .map(function(row){ return rowToObj(headers, row); })
    .filter(function(r){ return headers[0] && r[headers[0]]; });
}

function rowToObj(headers, row) {
  var obj = {};
  headers.forEach(function(h, i){
    obj[h] = (row[i] === null || row[i] === undefined) ? '' : String(row[i]);
  });
  return obj;
}

function appendSheetRow(sheetName, obj) {
  var sheet   = getSheet(sheetName);
  var headers = sheet.getDataRange().getValues()[0];
  var row     = headers.map(function(h){ return obj[h] !== undefined ? obj[h] : ''; });
  sheet.appendRow(row);
  return { appended: true, id: obj[headers[0]] };
}

function updateSheetRow(sheetName, keyCol, keyVal, updates) {
  var sheet   = getSheet(sheetName);
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var keyIdx  = headers.indexOf(keyCol);
  if (keyIdx < 0) throw new Error('Column "' + keyCol + '" not found in ' + sheetName);
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][keyIdx]) === String(keyVal)) {
      var updated = headers.map(function(h, j){
        return updates[h] !== undefined ? updates[h] : data[i][j];
      });
      sheet.getRange(i + 1, 1, 1, headers.length).setValues([updated]);
      if (sheetName === SH.USERS && updates.email) bustUserCache(updates.email);
      return { updated: true, row: i + 1 };
    }
  }
  throw new Error('Record not found: ' + keyCol + '=' + keyVal + ' in ' + sheetName);
}

function deleteRow(sheetName, keyCol, keyVal) {
  var sheet   = getSheet(sheetName);
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var keyIdx  = headers.indexOf(keyCol);
  for (var i = data.length - 1; i >= 1; i--) {
    if (String(data[i][keyIdx]) === String(keyVal)) { sheet.deleteRow(i + 1); return { deleted: true }; }
  }
  throw new Error('Record not found: ' + keyCol + '=' + keyVal);
}

function applyFilters(rows, filters, allowedKeys) {
  allowedKeys.forEach(function(key){
    if (filters[key] !== undefined && filters[key] !== '') {
      rows = rows.filter(function(r){ return String(r[key]) === String(filters[key]); });
    }
  });
  return rows;
}

function getOrMakeFolder(parent, name) {
  var iter = parent.getFoldersByName(name);
  return iter.hasNext() ? iter.next() : parent.createFolder(name);
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 23 │ HELPERS
// ─────────────────────────────────────────────────────────────────────

function validate(obj, required) {
  required.forEach(function(key){
    if (obj[key] === undefined || obj[key] === null || obj[key] === '')
      throw new Error('Missing required field: "' + key + '"');
  });
}

function uuid() { return Utilities.getUuid().replace(/-/g,'').slice(0,16); }
function ts()   { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd HH:mm:ss'); }
function todayStr() { return Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd'); }

function weekNum(date) {
  var d      = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  var dayNo  = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dayNo + 3);
  var firstThu = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round((d - firstThu) / 604800000);
}

function daysDiff(from, to) { return Math.ceil((to - from) / 86400000); }
function sumField(arr, field) { return arr.reduce(function(s,r){ return s + (parseFloat(r[field])||0); }, 0); }
function r2(n) { return Math.round(n * 100) / 100; }

function md5(str) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, str)
    .map(function(b){ return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 24 │ HTTP HELPERS
// ─────────────────────────────────────────────────────────────────────

function ok(data)      { return jsonRes(Object.assign({ success: true }, data)); }
function err400(msg)   { return jsonRes({ success: false, code: 400, message: msg }); }
function err401(msg)   { return jsonRes({ success: false, code: 401, message: msg }); }
function err429(msg)   { return jsonRes({ success: false, code: 429, message: msg }); }
function err500(msg)   { return jsonRes({ success: false, code: 500, message: msg }); }
function jsonResponse(d){ return jsonRes(d); }

function jsonRes(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 25 │ ONE-TIME SETUP  ← run once from editor
// ─────────────────────────────────────────────────────────────────────

function setupSpreadsheet() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  var SCHEMA = {
    USERS:           ['user_id','email','display_name','role','province_zone','active','created_at'],
    VEHICLES:        ['vehicle_id','dsr_id','vehicle_type','license_plate','brand_model',
                      'tax_expiry_date','act_expiry_date','oil_change_km','tire_change_date',
                      'is_active','created_at'],
    MILEAGE_LOG:     ['log_id','dsr_id','vehicle_id','log_date','session',
                      'start_km','start_photo_url','end_km','end_photo_url',
                      'distance_km','week_number','created_at'],
    FUEL_LOG:        ['fuel_id','dsr_id','vehicle_id','fuel_date','odometer_km',
                      'price_per_liter','liters','total_cost','station_name',
                      'receipt_photo_url','week_number','created_at'],
    MAINTENANCE_LOG: ['maint_id','vehicle_id','dsr_id','maint_date','maint_type',
                      'description','cost','next_due_km','next_due_date',
                      'receipt_photo_url','created_at'],
    ALLOWANCE_LOG:   ['allow_id','dsr_id','stay_date','province','hotel_name',
                      'accommodation_cost','accommodation_claimed','daily_allowance',
                      'is_provincial','receipt_photo_url','week_number','created_at'],
    DEBT_MASTER:     ['debt_id','assigned_dsr_id','customer_name','customer_code',
                      'invoice_no','invoice_date','due_date','amount',
                      'week_number','status','import_batch'],
    COLLECTION_LOG:  ['collect_id','debt_id','dsr_id','collect_date','amount_collected',
                      'payment_method','receipt_no','week_number','note','created_at'],
    AUDIT_LOG:       ['timestamp','user_email','action','detail'],
    SETTINGS:        ['key','value','updated_at'],
  };

  Object.keys(SCHEMA).forEach(function(name) {
    var headers = SCHEMA[name];
    var sheet   = ss.getSheetByName(name);
    if (!sheet) { sheet = ss.insertSheet(name); Logger.log('Created: ' + name); }
    if (sheet.getLastRow() === 0) {
      sheet.getRange(1,1,1,headers.length).setValues([headers]);
    }
    sheet.getRange(1,1,1,headers.length)
      .setBackground('#E8631A').setFontColor('#FFFFFF').setFontWeight('bold').setFontSize(10);
    sheet.setFrozenRows(1);
  });

  // Seed users — ใช้ Gmail จริงของแต่ละคน ไม่ต้องมี domain บริษัท
  var userSheet = ss.getSheetByName('USERS');
  if (userSheet.getLastRow() <= 1) {
    var now   = ts();
    var users = [
      // Admins
      [uuid(),'poomprofile@gmail.com',   'ภูมิ',    'admin',      'ทุกจังหวัด',           'TRUE',now],
      [uuid(),'fernery11@gmail.com',     'เฟิร์น',  'admin',      'ทุกจังหวัด',           'TRUE',now],
      // DSRs — แทน placeholder ด้วย Gmail จริงของแต่ละคน
      [uuid(),'nuch.real@gmail.com',     'นุช',     'dsr',        'สุพรรณบุรี',            'TRUE',now],
      [uuid(),'na.real@gmail.com',       'นา',      'dsr',        'สิงห์บุรี',             'TRUE',now],
      [uuid(),'ann.real@gmail.com',      'แอน',     'dsr',        'อ่างทอง',               'TRUE',now],
      [uuid(),'korn.real@gmail.com',     'กร',      'dsr',        'ชัยนาท',                'TRUE',now],
      [uuid(),'madmee.real@gmail.com',   'มัดหมี่', 'dsr',        'อุทัยธานี,นครสวรรค์', 'TRUE',now],
      [uuid(),'maprang.real@gmail.com',  'มาพราง',  'specialist', 'ทุกจังหวัด',           'TRUE',now],
    ];
    userSheet.getRange(2,1,users.length,7).setValues(users);
    Logger.log('Seeded ' + users.length + ' users');
  }

  // Seed settings
  var setSheet = ss.getSheetByName('SETTINGS');
  if (setSheet.getLastRow() <= 1) {
    var now2 = ts();
    [['max_accommodation','500',now2],['daily_allowance','200',now2],
     ['version',CONFIG.VERSION,now2],['submit_day','saturday',now2]]
    .forEach(function(r){ setSheet.appendRow(r); });
  }

  // Daily trigger (idempotent)
  ScriptApp.getProjectTriggers()
    .filter(function(t){ return t.getHandlerFunction() === 'dailyMaintenanceAlerts'; })
    .forEach(function(t){ ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('dailyMaintenanceAlerts')
    .timeBased().everyDays(1).atHour(7).inTimezone('Asia/Bangkok').create();

  Logger.log('✅ Setup complete — v' + CONFIG.VERSION);
  return 'Setup complete — v' + CONFIG.VERSION;
}

// Quick smoke test — run from editor after setup
function runSmokeTest() {
  var admin = { email:'admin@nicecenteroil.com', role:'admin', display_name:'Admin', user_id:'test' };
  var r = {};
  try { r.users      = getUsers().length + ' users'; }      catch(e){ r.users = 'FAIL: '+e.message; }
  try { r.vehicles   = getVehicles(admin).length + ' vehicles'; } catch(e){ r.vehicles = 'FAIL: '+e.message; }
  try { r.debt       = getDebtList(admin,{}).length + ' debts'; } catch(e){ r.debt = 'FAIL: '+e.message; }
  try { r.settlement = 'net=' + getSettlement(admin, weekNum(new Date())).net_remittance; } catch(e){ r.settlement='FAIL:'+e.message; }
  try { r.week       = 'week=' + weekNum(new Date()); }     catch(e){ r.week = 'FAIL'; }
  Logger.log(JSON.stringify(r, null, 2));
  return r;
}

// ─── UTILITY: รันครั้งเดียวเพื่อล้าง cache ทั้งหมด ───────────
function clearAllCache() {
  CacheService.getScriptCache().removeAll([
    'usr_poomprofile@gmail.com',
    'usr_fernery11@gmail.com',
    'usr_admin@nicecenteroil.com',
  ]);
  // ล้าง cache token ทั้งหมด (ทำได้แค่นี้เพราะ key เป็น hash)
  Logger.log('Cache cleared for known users');
  Logger.log('Test getUserProfile:');
  try {
    const p = findUserByEmail('poomprofile@gmail.com');
    Logger.log('Found: ' + JSON.stringify(p));
  } catch(e) {
    Logger.log('Error: ' + e.message);
  }
}



// alias สำหรับ DSR Review (ใน LineBot ใช้ชื่อนี้)
function getUserDisplayName(email) {
  try {
    var u = findUserByEmail(email);
    return u ? (u.display_name || email) : email;
  } catch(e) { return email; }
}

// ═══ DSR REVIEW + COVER SHEET (ย้ายมาจาก Code_LineBot.gs) ══════

function getDsrWeekSlips(email) {
  try {
    if (!email) return { rows: [], total: 0, count: 0 };

    var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID_SLIP'));
    var sheet = ss.getSheetByName(SH.SLIPS);
    if (!sheet) return { rows: [], total: 0, count: 0, error: 'ไม่พบ Sheet: ' + SH.SLIPS };

    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { rows: [], total: 0, count: 0 };

    var h = data[0];

    function findCol(names) {
      for (var ni = 0; ni < names.length; ni++)
        for (var hi = 0; hi < h.length; hi++)
          if (String(h[hi]).trim().toLowerCase() === names[ni].toLowerCase()) return hi;
      return -1;
    }

    var eIdx  = findCol(['Email','email','DSR Email','dsr_email']);
    var dIdx  = findCol(['วันที่ส่งสลิป','วันที่ส่ง','created_at']);
    var stIdx = findCol(['สถานะ','status']);

    if (eIdx < 0) return { rows: [], total: 0, count: 0, error: 'ไม่พบ column Email' };

    // weekStart = วันจันทร์เวลา 00:00:00 Bangkok (ใช้ string เปรียบเทียบ)
    var weekStart = getMondayOfWeekBKK();
    var rows = [];

    for (var i = 1; i < data.length; i++) {
      var rowEmail = String(data[i][eIdx] || '').trim().toLowerCase();
      if (rowEmail !== email.toLowerCase()) continue;

      var st = stIdx >= 0 ? String(data[i][stIdx] || '') : '';
      if (st === 'ไม่ใช้') continue;

      // filter ตาม weekStart — แปลง Date object เป็น Bangkok date string
      if (dIdx >= 0 && data[i][dIdx]) {
        var rawDate = data[i][dIdx];
        var dt = rawDate instanceof Date ? rawDate : new Date(rawDate);
        if (!isNaN(dt.getTime())) {
          // เทียบ date ใน Bangkok timezone
          var dtBKK = new Date(dt.toLocaleString('en-US', {timeZone:'Asia/Bangkok'}));
          dtBKK.setHours(0,0,0,0);
          if (dtBKK < weekStart) continue;
        }
      }

      var obj = { _row: i + 1 };
      h.forEach(function(k, j) {
        var v = data[i][j];
        if (v instanceof Date) {
          // Date object จาก Sheets — ตรวจว่าเป็น epoch ว่างไหม (1899-12-30)
          if (isNaN(v.getTime()) || v.getFullYear() < 2000) {
            obj[k] = '';
          } else {
            obj[k] = v.toISOString();
          }
        } else if (typeof v === 'number' && k === 'เวลาโอน') {
          // เวลาใน Sheets เก็บเป็น decimal เช่น 0.8244 = 19:47:07
          if (v > 0 && v < 1) {
            var totalSec = Math.round(v * 86400);
            var hh = Math.floor(totalSec / 3600);
            var mm = Math.floor((totalSec % 3600) / 60);
            obj[k] = hh + ':' + (mm < 10 ? '0' : '') + mm;
          } else {
            obj[k] = '';
          }
        } else {
          obj[k] = v;
        }
      });
      rows.push(obj);
    }

    rows.sort(function(a, b) {
      return new Date(a['วันที่โอน'] || 0) - new Date(b['วันที่โอน'] || 0);
    });

    var total = rows.reduce(function(s, r) {
      return s + (parseFloat(r['ยอดเงิน']) || 0);
    }, 0);

    return { rows: rows, total: total, count: rows.length };

  } catch(err) {
    return { rows: [], total: 0, count: 0, error: err.message };
  }
}

// getMondayOfWeek ที่ใช้ Bangkok timezone จริงๆ
function getMondayOfWeekBKK() {
  var now = new Date();
  var bkk = new Date(now.toLocaleString('en-US', {timeZone:'Asia/Bangkok'}));
  var day = bkk.getDay(); // 0=Sun
  var diff = (day === 0) ? -6 : 1 - day;
  var mon = new Date(bkk);
  mon.setDate(bkk.getDate() + diff);
  mon.setHours(0, 0, 0, 0);
  return mon;
}

// ─── 1. getDsrWeekSlipsOffset ─────────────────────────────────────
// แทนที่ getDsrWeekSlips() — รองรับ offset (0=สัปดาห์นี้, -1=ก่อน)
// index.html เรียก: .getDsrWeekSlipsOffset(email, offset)
 
function getDsrWeekSlipsOffset(email, offset) {
  offset = parseInt(offset) || 0;
  try {
    if (!email) return { rows:[], total:0, count:0 };
 
    var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID_SLIP'));
    var sheet = ss.getSheetByName(SH.SLIPS);
    if (!sheet) return { rows:[], total:0, count:0, error:'ไม่พบ Sheet: ' + SH.SLIPS };
 
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { rows:[], total:0, count:0 };
 
    var h = data[0];
    function findCol(names) {
      for (var ni=0;ni<names.length;ni++) for (var hi=0;hi<h.length;hi++) if (String(h[hi]).trim().toLowerCase()===names[ni].toLowerCase()) return hi;
      return -1;
    }
 
    var eIdx  = findCol(['Email','email','DSR Email','dsr_email']);
    var dIdx  = findCol(['วันที่ส่งสลิป','วันที่ส่ง','created_at']);
    var stIdx = findCol(['สถานะ','status']);
    if (eIdx < 0) return { rows:[], total:0, count:0, error:'ไม่พบ column Email' };
 
    // คำนวณ weekStart / weekEnd ตาม offset
    var weekRange = getWeekRangeBKK(offset);
    var rows = [];
 
    for (var i = 1; i < data.length; i++) {
      var rowEmail = String(data[i][eIdx]||'').trim().toLowerCase();
      if (rowEmail !== email.toLowerCase()) continue;
      var st = stIdx>=0 ? String(data[i][stIdx]||'') : '';
      if (st === 'ไม่ใช้') continue;
 
      if (dIdx >= 0 && data[i][dIdx]) {
        var rawDate = data[i][dIdx];
        var dt = rawDate instanceof Date ? rawDate : new Date(rawDate);
        if (!isNaN(dt.getTime())) {
          var dtBKK = new Date(dt.toLocaleString('en-US',{timeZone:'Asia/Bangkok'}));
          dtBKK.setHours(0,0,0,0);
          if (dtBKK < weekRange.mon || dtBKK > weekRange.sun) continue;
        }
      }
 
      var obj = { _row: i+1 };
      h.forEach(function(k,j) {
        var v = data[i][j];
        if (v instanceof Date) { obj[k] = (isNaN(v.getTime())||v.getFullYear()<2000) ? '' : v.toISOString(); }
        else if (typeof v==='number' && k==='เวลาโอน') {
          if (v>0&&v<1) { var ts=Math.round(v*86400),hh=Math.floor(ts/3600),mm=Math.floor((ts%3600)/60); obj[k]=hh+':'+(mm<10?'0':'')+mm; }
          else obj[k]='';
        } else { obj[k]=v; }
      });
      rows.push(obj);
    }
 
    rows.sort(function(a,b){ return new Date(a['วันที่โอน']||0)-new Date(b['วันที่โอน']||0); });
    var total = rows.reduce(function(s,r){ return s+(parseFloat(r['ยอดเงิน'])||0); },0);
    return { rows:rows, total:total, count:rows.length, weekRange: {
      mon: weekRange.mon.toISOString(),
      sun: weekRange.sun.toISOString(),
    }};
  } catch(err) {
    return { rows:[], total:0, count:0, error:err.message };
  }
}
 
// คำนวณ Monday–Sunday ของสัปดาห์ (offset=0 = สัปดาห์ปัจจุบัน)
function getWeekRangeBKK(offset) {
  offset = parseInt(offset)||0;
  var now = new Date();
  var bkk = new Date(now.toLocaleString('en-US',{timeZone:'Asia/Bangkok'}));
  var day  = bkk.getDay(); // 0=Sun
  var diff = (day===0) ? -6 : 1-day;
  var mon  = new Date(bkk); mon.setDate(bkk.getDate()+diff+(offset*7)); mon.setHours(0,0,0,0);
  var sun  = new Date(mon);  sun.setDate(mon.getDate()+6);              sun.setHours(23,59,59,0);
  return { mon:mon, sun:sun };
}
 
// สร้าง label ช่วงสัปดาห์ภาษาไทย เช่น "21–27 เม.ย. 2568"
function formatWeekRangeThai(offset) {
  var r    = getWeekRangeBKK(offset||0);
  var mo   = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  var bkk  = function(d){ return new Date(d.toLocaleString('en-US',{timeZone:'Asia/Bangkok'})); };
  var mon  = bkk(r.mon);
  var sun  = bkk(r.sun);
  // ถ้าอยู่ในเดือนเดียวกัน → "21–27 เม.ย. 2568"
  if (mon.getMonth()===sun.getMonth()) {
    return mon.getDate()+'–'+sun.getDate()+' '+mo[mon.getMonth()+1]+' '+(mon.getFullYear()+543);
  }
  // ต่างเดือน → "28 เม.ย. – 4 พ.ค. 2568"
  return mon.getDate()+' '+mo[mon.getMonth()+1]+' – '+sun.getDate()+' '+mo[sun.getMonth()+1]+' '+(sun.getFullYear()+543);
}
 

// API: บันทึกการแก้ไขจาก DSR

// ╔══════════════════════════════════════════════════════════════════╗
// ║  แทนที่ฟังก์ชัน saveDsrEdits() ใน Code.gs                      ║
// ║  เพิ่ม 'สถานะ' และ 'เลขที่บิล' เข้า idxMap                    ║
// ╚══════════════════════════════════════════════════════════════════╝
 
// ─── 2. saveDsrEdits (แทนที่ก้อนเดิม) ────────────────────────────
// เพิ่ม: field สถานะ + เขียน REGCONSIGN sheet
 
function saveDsrEdits(edits) {
  if (!Array.isArray(edits)) throw new Error('edits must be array');
 
  var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID_SLIP'));
  var sheet = ss.getSheetByName(SH.SLIPS);
  var h     = sheet.getRange(1,1,1,sheet.getLastColumn()).getValues()[0];
 
  function colOf(name) { var idx=h.indexOf(name); return idx>=0?idx+1:0; }
 
  var idxMap = {
    'รหัสลูกค้า': colOf('รหัสลูกค้า'),
    'ชื่อร้าน':   colOf('ชื่อร้าน'),
    'เลขที่บิล':  colOf('เลขที่บิล'),
    'ยอดเงิน':    colOf('ยอดเงิน'),
    'สถานะ':      colOf('สถานะ'),
    'note':        colOf('note'),
  };
 
  // เพิ่ม column note ถ้ายังไม่มี
  if (!idxMap['note']) {
    var col = sheet.getLastColumn()+1;
    sheet.getRange(1,col).setValue('note');
    sheet.getRange(1,col).setBackground('#E8631A').setFontColor('#fff').setFontWeight('bold');
    idxMap['note'] = col;
  }
 
  var updated = 0;
  var snapshots = [];
 
  edits.forEach(function(e) {
    if (!e.row) return;
    // อ่าน snapshot ก่อน update
    var snapshot = {};
    h.forEach(function(k,i){ snapshot[k] = sheet.getRange(e.row, i+1).getValue(); });
 
    Object.keys(e.fields||{}).forEach(function(col) {
      var colNum = idxMap[col]; if (!colNum) return;
      sheet.getRange(e.row, colNum).setValue(e.fields[col]);
    });
 
    // เก็บ snapshot + fields ที่แก้
    snapshots.push({ row:e.row, before:snapshot, after:e.fields });
    updated++;
  });
 
  // เขียน REGCONSIGN
  if (snapshots.length) writeRegconsign(ss, snapshots);
 
  return { updated:updated };
}
 
// ─── 3. REGCONSIGN sheet ──────────────────────────────────────────
// บันทึกข้อมูลดิบทุก field ณ เวลาที่กด "บันทึก"
// columns: timestamp | edited_by_email | slip_row | field_changed | value_before | value_after | full_snapshot_json
 
function writeRegconsign(ss, snapshots) {
  try {
    var RC_NAME = 'REGCONSIGN';
    var rcSh    = ss.getSheetByName(RC_NAME);
    if (!rcSh) {
      rcSh = ss.insertSheet(RC_NAME);
      rcSh.getRange(1,1,1,7).setValues([[
        'timestamp','edited_row','fields_changed','before_json','after_json',
        'full_snapshot_json','week_range'
      ]]);
      rcSh.getRange(1,1,1,7)
        .setBackground('#1A1A1A').setFontColor('#fff').setFontWeight('bold');
      rcSh.setFrozenRows(1);
    }
 
    var now       = Utilities.formatDate(new Date(),'Asia/Bangkok','yyyy-MM-dd HH:mm:ss');
    var weekLabel = formatWeekRangeThai(0); // สัปดาห์ปัจจุบัน
 
    snapshots.forEach(function(s) {
      var fieldsChanged = Object.keys(s.after).join(', ');
      rcSh.appendRow([
        now,
        s.row,
        fieldsChanged,
        JSON.stringify(s.before).slice(0,1000),
        JSON.stringify(s.after).slice(0,500),
        JSON.stringify(s.before).slice(0,2000),  // full snapshot = before state
        weekLabel,
      ]);
    });
 
    // จำกัด 2000 แถว — ลบแถวเก่า
    if (rcSh.getLastRow() > 2001) {
      rcSh.deleteRows(2, rcSh.getLastRow()-2001);
    }
  } catch(e) {
    Logger.log('[REGCONSIGN] ' + e.message);
  }
}


// ─── 4. generateCoverSheetPdf (แทนที่ก้อนเดิม) ───────────────────
// เพิ่ม weekOffset parameter
 
function generateCoverSheetPdf(email, weekOffset) {
  if (!email) throw new Error('missing email');
  weekOffset = parseInt(weekOffset)||0;
 
  var data = getDsrWeekSlipsOffset(email, weekOffset);
  var rows = data.rows||[];
  if (rows.length===0) throw new Error('ไม่มีสลิปในช่วงนี้');
 
  var dsrName   = getUserDisplayName(email);
  var today     = Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yyyy');
  var weekLabel = formatWeekRangeThai(weekOffset);
  var html      = buildCoverSheetHtml(rows, dsrName, today, data.total, weekLabel);
  var filename  = 'ใบสรุปเงิน_'+dsrName+'_'+weekLabel.replace(/[–\s]/g,'-')+'.pdf';
 
  var blob    = Utilities.newBlob(html,'text/html','cover.html').getAs('application/pdf');
  blob.setName(filename);
  var folder  = ensureCoverSheetFolder();
  var pdfFile = folder.createFile(blob);
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
 
  return { url:pdfFile.getUrl(), filename:filename, count:rows.length, total:data.total };
}
 

function ensureCoverSheetFolder() {
  var folderName = 'NCO_CoverSheets';
  var folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(folderName);
}


// ═══ SARABUN FONT LOADER ════════════════════════════════════════
// อ่าน Sarabun .ttf จาก Drive แปลงเป็น base64 สำหรับ embed ใน PDF HTML
function getSarabunBase64() {
  var result = { regular: '', bold: '' };
  try {
    var folder = ensureCoverSheetFolder();
    var files = folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      var name = f.getName().toLowerCase();
      if (name === 'sarabun-regular.ttf') {
        result.regular = Utilities.base64Encode(f.getBlob().getBytes());
      } else if (name === 'sarabun-bold.ttf') {
        result.bold = Utilities.base64Encode(f.getBlob().getBytes());
      }
    }
    Logger.log('[font] regular=' + (result.regular ? 'OK' : 'MISSING') +
               ' bold=' + (result.bold ? 'OK' : 'MISSING'));
  } catch(e) {
    Logger.log('[font] ERROR: ' + e.message);
  }
  return result;
}

function buildCoverSheetHtml(rows, dsrName, today, total, weekLabel) {
  var logoHtml = getLogoBase64Html();
  var fonts    = getSarabunBase64();
  var fontCss  = '';
  if (fonts.regular) fontCss += '@font-face{font-family:"Sarabun";font-weight:400;src:url("data:font/truetype;base64,'+fonts.regular+'") format("truetype")}';
  if (fonts.bold)    fontCss += '@font-face{font-family:"Sarabun";font-weight:700;src:url("data:font/truetype;base64,'+fonts.bold+'") format("truetype")}';
  var bodyFont = fonts.regular ? '"Sarabun"' : 'Tahoma';
 
  // ตัด prefix invoice สำหรับ PDF ด้วย
  function pdfTrimInv(inv) {
    if (!inv) return '';
    var s = String(inv).trim();
    if (/^[A-Za-z]{2}\d{2}/.test(s)) return s.slice(4);
    return s;
  }
 
  var tableRows = rows.map(function(r,i) {
    var amt     = parseMoneyCell(r['ยอดเงิน']);
    var note    = r['note']||'';
    var dateStr = formatDateThai2(r['วันที่โอน']);
    if (!dateStr||dateStr.indexOf('1899')>=0||dateStr.indexOf('1970')>=0) dateStr='';
    var invDisplay = pdfTrimInv(r['เลขที่บิล']||'');
 
    // เวลาโอน
    var timeStr = '';
    var tv = String(r['เวลาโอน']||'').trim();
    if (tv&&tv!=='0'&&tv.indexOf('1899')<0&&tv.indexOf('1970')<0) {
      var parts=tv.split(':'); timeStr=parts.length>=2?parts[0]+':'+parts[1]:tv.slice(0,5);
    }
    var displayDate = dateStr + (timeStr?' '+timeStr:'');
 
    return '<tr>'+
      '<td class="c">'+(i+1)+'</td>'+
      '<td>'+escapeHtmlSrv(r['รหัสลูกค้า']||'')+' '+escapeHtmlSrv(r['ชื่อร้าน']||'')+'</td>'+
      '<td class="c">'+escapeHtmlSrv(invDisplay)+'</td>'+
      '<td class="r">'+formatMoney(parseMoneyCell(r['ยอดบิล']||amt))+'</td>'+
      '<td></td>'+
      '<td class="r">'+formatMoney(amt)+'</td>'+
      '<td class="c">'+escapeHtmlSrv(displayDate)+'</td>'+
      '<td></td><td></td><td></td>'+
      '<td>'+escapeHtmlSrv(note)+'</td>'+
      '</tr>';
  }).join('');
 
  var empty='';
  for (var i=rows.length;i<15;i++) {
    empty+='<tr><td class="c">'+(i+1)+'</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>';
  }
 
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>'+
    fontCss+
    '@page{size:A4 landscape;margin:18mm 10mm}'+
    'body,table,th,td,div,span{font-family:'+bodyFont+',Tahoma,Arial,sans-serif!important;font-size:13px;color:#000;margin:0}'+
    '.top{display:flex;justify-content:space-between;align-items:center;border-bottom:1.5px solid #000;padding-bottom:5px;margin-bottom:5px}'+
    '.title{font-size:16px;font-weight:bold}'+
    '.meta{font-size:12px;text-align:center}'+
    '.meta span{margin:0 10px}'+
    '.week-range{font-size:13px;font-weight:bold;text-align:center;color:#444;margin-top:2px}'+
    '.logo img{height:42px;object-fit:contain}'+
    'table{width:100%;border-collapse:collapse;table-layout:fixed}'+
    'th{font-size:11px;font-weight:bold;border:1px solid #555;padding:4px 2px;text-align:center;background:#f0f0f0;white-space:nowrap}'+
    'td{border:1px solid #555;padding:4px 4px;font-size:12px;vertical-align:middle;overflow:hidden;white-space:nowrap}'+
    'col.no{width:4%}col.cust{width:18%}col.bill{width:9%}col.amt{width:8%}'+
    'col.eq{width:7%}col.note{width:16%}'+
    '.c{text-align:center}.r{text-align:right}'+
    '.sub{display:flex;justify-content:flex-end;margin-top:4px}'+
    '.box{border:1px solid #555;padding:3px 8px;font-size:12px;font-weight:bold;min-width:120px;text-align:right}'+
    '.foot{margin-top:12px;display:flex;align-items:flex-end;gap:20px}'+
    '.note-area{width:42%}.note-label{font-size:12px}'+
    '.note-line{border-bottom:1px dotted #000;height:20px;margin-top:3px}'+
    '.sig{min-width:200px;padding-left:12px;text-align:center}'+
    '.sig-line{border-top:1px solid #555;margin-top:32px;padding-top:4px;font-size:13px;font-weight:bold}'+
    '</style></head><body>'+
 
    '<div class="top">'+
    '<div class="title">ใบสรุปเงินสด / โอน / เช็ค</div>'+
    '<div><div class="meta">'+
      '<span>วันที่พิมพ์: <b>'+today+'</b></span>'+
      '<span>DSR: <b>'+escapeHtmlSrv(dsrName)+'</b></span>'+
    '</div>'+
    (weekLabel?'<div class="week-range">สัปดาห์ '+escapeHtmlSrv(weekLabel)+'</div>':'')+
    '</div>'+
    '<div class="logo">'+logoHtml+'</div>'+
    '</div>'+
 
    '<table><colgroup>'+
    '<col class="no"><col class="cust"><col class="bill"><col class="amt">'+
    '<col class="eq"><col class="eq"><col class="eq">'+
    '<col class="eq"><col class="eq"><col class="eq"><col class="note">'+
    '</colgroup><thead>'+
    '<tr><th rowspan="2">No.</th><th rowspan="2">รหัส - ชื่อ ลูกค้า</th><th rowspan="2">เลขที่บิล</th>'+
    '<th rowspan="2">ยอดบิล</th><th colspan="6">รายการเก็บ เงินสด / โอน / เช็ค</th><th rowspan="2">หมายเหตุ</th></tr>'+
    '<tr><th>เงินสด</th><th>ยอดโอน/เช็ค</th><th>วันที่โอน/เช็ค</th><th>เลขที่เช็ค</th><th>ธนาคาร</th><th>สาขา</th></tr>'+
    '</thead><tbody>'+tableRows+empty+'</tbody></table>'+
 
    '<div class="sub">'+
    '<div class="box">รวมยอดเงินสด: <b>0</b></div>'+
    '<div class="box">ยอดเก็บเงินรวม: <b>'+formatMoney(total)+'</b></div>'+
    '</div>'+
 
    '<div class="foot">'+
    '<div class="note-area"><div class="note-label">Note :</div><div class="note-line"></div></div>'+
    '<div class="sig"><div class="sig-line">ลงชื่อผู้ส่งเงิน</div></div>'+
    '</div>'+
    '</body></html>';
}

// แปลงวันที่เป็น Thai short date: "22 เม.ย. 69 19:47"
// รับ ISO string (ที่แปลงมาจาก Date object ใน getDsrWeekSlips)

function formatDateThai2(v) {
  if (!v) return '';
  var thMonths = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
                  'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  try {
    var s  = String(v).trim();
    var dt;

    // dd/MM/yyyy HH:mm:ss (format ที่บันทึกจาก Bot)
    var m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\s,]+(\d{1,2}:\d{2}))?/);
    if (m1) {
      var be   = parseInt(m1[3]) + 543;
      var time = m1[4] ? ' ' + m1[4] : '';
      return parseInt(m1[1]) + ' ' + thMonths[parseInt(m1[2])] +
             ' ' + String(be).slice(-2) + time;
    }

    // ISO string: "2026-04-19T19:47:18+07:00" or "2026-04-19T12:47:18.000Z"
    dt = new Date(s);
    if (isNaN(dt.getTime())) return s;

    // แปลงเป็น Bangkok time
    var bkk  = new Date(dt.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    var d    = bkk.getDate();
    var mo   = bkk.getMonth() + 1;
    var yr   = bkk.getFullYear() + 543;
    var hh   = bkk.getHours();
    var mm   = String(bkk.getMinutes()).padStart(2, '0');
    var time = (hh !== 0 || bkk.getMinutes() !== 0) ? ' ' + hh + ':' + mm : '';
    return d + ' ' + thMonths[mo] + ' ' + String(yr).slice(-2) + time;

  } catch(e) { return String(v); }
}

// ดึง logo จาก Google Drive แล้วแปลงเป็น base64 img tag

function formatMoney(n) {
  var v = parseFloat(n) || 0;
  if (!v) return '';
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function escapeHtmlSrv(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


// ═══ HELPERS ═══════════════════════════════════════════════════════

function getLogoBase64Html() {
  try {
    // ค้นใน folder NCO_CoverSheets ก่อน แล้วค่อย fallback ทั้ง Drive
    var logoBlob = null;
    var logoName = 'Nice Center Oil x Castrol - Business Card ใส.png';

    var folders = DriveApp.getFoldersByName('NCO_CoverSheets');
    if (folders.hasNext()) {
      var folder = folders.next();
      var files  = folder.getFilesByName(logoName);
      if (files.hasNext()) logoBlob = files.next().getBlob();
    }

    // fallback: ค้นทั้ง Drive
    if (!logoBlob) {
      var allFiles = DriveApp.getFilesByName(logoName);
      if (allFiles.hasNext()) logoBlob = allFiles.next().getBlob();
    }

    if (!logoBlob) {
      return '<span style="font-size:15px;font-weight:700;color:#E8631A">NICE CENTER</span>' +
             '&nbsp;<span style="font-size:15px;font-weight:700;color:#E8212A">Castrol</span>';
    }

    var b64  = Utilities.base64Encode(logoBlob.getBytes());
    var mime = logoBlob.getContentType();
    return '<img src="data:' + mime + ';base64,' + b64 + '" style="height:44px;">';

  } catch(e) {
    return '<span style="font-size:15px;font-weight:700;color:#E8212A">Castrol</span>';
  }
}

function parseMoneyCell(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  // เอาเฉพาะตัวเลข จุดทศนิยม และ minus
  var cleaned = String(v).replace(/[^0-9.\-]/g, '');
  return parseFloat(cleaned) || 0;
}

// แปลง Slip2Go response → format ที่โค้ดเราใช้อยู่
// Slip2Go fields: transRef, dateTime (ISO 8601), amount,
//                 sender.account.name, sender.bank.name,
//                 receiver.account.name, receiver.bank.name



// ═══ PDF COVER SHEET GENERATOR ═════════════════════════════════════
// สร้าง HTML สวยๆ → convert เป็น PDF ด้วย Google Docs API

function serveDsrReviewPage(email) {
  if (!email) {
    return HtmlService.createHtmlOutput(
      '<div style="padding:40px;font-family:sans-serif;text-align:center">' +
      '<h2>กรุณาระบุ email ใน URL</h2>' +
      '<p>ตัวอย่าง: ?page=dsr-review&email=nuch@gmail.com</p></div>'
    );
  }
  var name = getUserDisplayName(email);
  var html = dsrReviewHtml()
               .replace(/__DSR_EMAIL__/g, escapeHtmlSrv(email))
               .replace(/__DSR_NAME__/g,  escapeHtmlSrv(name));
  return HtmlService.createHtmlOutput(html)
    .setTitle('DSR Review — NCO')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .setSandboxMode(HtmlService.SandboxMode.IFRAME);
}


function getDsrWeekSlipsWithRange(email, monISO, sunISO) {
  try {
    if (!email) return { rows:[], total:0, count:0 };
 
    var monDate = new Date(monISO); monDate.setHours(0,0,0,0);
    var sunDate = new Date(sunISO); sunDate.setHours(23,59,59,0);
 
    var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID_SLIP'));
    var sheet = ss.getSheetByName(SH.SLIPS);
    if (!sheet) return { rows:[], total:0, count:0, error:'ไม่พบ Sheet: '+SH.SLIPS };
 
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { rows:[], total:0, count:0 };
    var h = data[0];
 
    function findCol(names) {
      for (var ni=0;ni<names.length;ni++) for (var hi=0;hi<h.length;hi++) if (String(h[hi]).trim().toLowerCase()===names[ni].toLowerCase()) return hi;
      return -1;
    }
 
    var eIdx  = findCol(['Email','email','DSR Email','dsr_email']);
    var dIdx  = findCol(['วันที่ส่งสลิป','วันที่ส่ง','created_at']);
    var stIdx = findCol(['สถานะ','status']);
    if (eIdx < 0) return { rows:[], total:0, count:0, error:'ไม่พบ column Email' };
 
    var rows = [];
    for (var i = 1; i < data.length; i++) {
      var rowEmail = String(data[i][eIdx]||'').trim().toLowerCase();
      if (rowEmail !== email.toLowerCase()) continue;
      var st = stIdx>=0 ? String(data[i][stIdx]||'') : '';
      if (st === 'ไม่ใช้') continue;
 
      if (dIdx >= 0 && data[i][dIdx]) {
        var rawDate = data[i][dIdx];
        var dt = rawDate instanceof Date ? rawDate : new Date(rawDate);
        if (!isNaN(dt.getTime())) {
          var dtBKK = new Date(dt.toLocaleString('en-US',{timeZone:'Asia/Bangkok'}));
          dtBKK.setHours(0,0,0,0);
          if (dtBKK < monDate || dtBKK > sunDate) continue;
        }
      }
 
      var obj = { _row: i+1 };
      h.forEach(function(k,j) {
        var v = data[i][j];
        if (v instanceof Date) {
          obj[k] = (isNaN(v.getTime())||v.getFullYear()<2000) ? '' : v.toISOString();
        } else if (typeof v==='number' && k==='เวลาโอน') {
          if (v>0&&v<1) { var ts=Math.round(v*86400),hh=Math.floor(ts/3600),mm=Math.floor((ts%3600)/60); obj[k]=hh+':'+(mm<10?'0':'')+mm; }
          else obj[k]='';
        } else { obj[k]=v; }
      });
      rows.push(obj);
    }
 
    rows.sort(function(a,b){ return new Date(a['วันที่โอน']||0)-new Date(b['วันที่โอน']||0); });
    var total = rows.reduce(function(s,r){ return s+(parseFloat(r['ยอดเงิน'])||0); }, 0);
 
    // สร้าง label สำหรับ PDF header
    var weekLabel = formatDateRangeThai(monDate, sunDate);
    return { rows:rows, total:total, count:rows.length, weekLabel:weekLabel };
 
  } catch(err) {
    return { rows:[], total:0, count:0, error:err.message };
  }
}

// format วันที่ช่วง → Thai string
function formatDateRangeThai(monDate, sunDate) {
  var mo = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  function bkk(d){ return new Date(d.toLocaleString('en-US',{timeZone:'Asia/Bangkok'})); }
  var m = bkk(monDate), s = bkk(sunDate);
  if (m.getMonth()===s.getMonth()&&m.getFullYear()===s.getFullYear()) {
    return m.getDate()+'–'+s.getDate()+' '+mo[m.getMonth()+1]+' '+(m.getFullYear()+543);
  }
  return m.getDate()+' '+mo[m.getMonth()+1]+' – '+s.getDate()+' '+mo[s.getMonth()+1]+' '+(s.getFullYear()+543);
}
 

// HTML: หน้า DSR Review

function generateCoverSheetPdfRange(email, monISO, sunISO) {
  if (!email) throw new Error('missing email');
 
  var data = getDsrWeekSlipsWithRange(email, monISO, sunISO);
  var rows = data.rows || [];
  if (rows.length === 0) throw new Error('ไม่มีสลิปในช่วงนี้');
 
  var dsrName   = getUserDisplayName(email);
  var today     = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy');
  var weekLabel = data.weekLabel || '';
  var html      = buildCoverSheetHtmlV4(rows, dsrName, today, data.total, weekLabel);
  var filename  = 'ใบสรุปเงิน_'+dsrName+'_'+weekLabel.replace(/[–\s\/]/g,'-')+'.pdf';
 
  var blob = Utilities.newBlob(html, 'text/html', 'cover.html').getAs('application/pdf');
  blob.setName(filename);
  var folder  = ensureCoverSheetFolder();
  var pdfFile = folder.createFile(blob);
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
 
  return { url:pdfFile.getUrl(), filename:filename, count:rows.length, total:data.total };
}

function ensureCoverSheetFolder() {
  var folderName = 'NCO_CoverSheets';
  var folders = DriveApp.getFoldersByName(folderName);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(folderName);
}


// ═══ SARABUN FONT LOADER ════════════════════════════════════════
// อ่าน Sarabun .ttf จาก Drive แปลงเป็น base64 สำหรับ embed ใน PDF HTML
function getSarabunBase64() {
  var result = { regular: '', bold: '' };
  try {
    var folder = ensureCoverSheetFolder();
    var files = folder.getFiles();
    while (files.hasNext()) {
      var f = files.next();
      var name = f.getName().toLowerCase();
      if (name === 'sarabun-regular.ttf') {
        result.regular = Utilities.base64Encode(f.getBlob().getBytes());
      } else if (name === 'sarabun-bold.ttf') {
        result.bold = Utilities.base64Encode(f.getBlob().getBytes());
      }
    }
    Logger.log('[font] regular=' + (result.regular ? 'OK' : 'MISSING') +
               ' bold=' + (result.bold ? 'OK' : 'MISSING'));
  } catch(e) {
    Logger.log('[font] ERROR: ' + e.message);
  }
  return result;
}

// แปลงวันที่เป็น Thai short date: "22 เม.ย. 69 19:47"
// รับ ISO string (ที่แปลงมาจาก Date object ใน getDsrWeekSlips)

function formatDateThai2(v) {
  if (!v) return '';
  var thMonths = ['','ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.',
                  'ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  try {
    var s  = String(v).trim();
    var dt;

    // dd/MM/yyyy HH:mm:ss (format ที่บันทึกจาก Bot)
    var m1 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[\s,]+(\d{1,2}:\d{2}))?/);
    if (m1) {
      var be   = parseInt(m1[3]) + 543;
      var time = m1[4] ? ' ' + m1[4] : '';
      return parseInt(m1[1]) + ' ' + thMonths[parseInt(m1[2])] +
             ' ' + String(be).slice(-2) + time;
    }

    // ISO string: "2026-04-19T19:47:18+07:00" or "2026-04-19T12:47:18.000Z"
    dt = new Date(s);
    if (isNaN(dt.getTime())) return s;

    // แปลงเป็น Bangkok time
    var bkk  = new Date(dt.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    var d    = bkk.getDate();
    var mo   = bkk.getMonth() + 1;
    var yr   = bkk.getFullYear() + 543;
    var hh   = bkk.getHours();
    var mm   = String(bkk.getMinutes()).padStart(2, '0');
    var time = (hh !== 0 || bkk.getMinutes() !== 0) ? ' ' + hh + ':' + mm : '';
    return d + ' ' + thMonths[mo] + ' ' + String(yr).slice(-2) + time;

  } catch(e) { return String(v); }
}

// ดึง logo จาก Google Drive แล้วแปลงเป็น base64 img tag

function formatMoney(n) {
  var v = parseFloat(n) || 0;
  if (!v) return '';
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function escapeHtmlSrv(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}



// แปลง Slip2Go response → format ที่โค้ดเราใช้อยู่
// Slip2Go fields: transRef, dateTime (ISO 8601), amount,
//                 sender.account.name, sender.bank.name,
//                 receiver.account.name, receiver.bank.name

// ╔══════════════════════════════════════════════════════════════════╗
// ║  แทนที่ฟังก์ชัน dsrReviewHtml() ทั้งหมดใน Code.gs              ║
// ║  (มีสองก้อนซ้ำกันอยู่ — ลบทั้งสองออก แล้วใส่ก้อนนี้แทน)      ║
// ╚══════════════════════════════════════════════════════════════════╝

function dsrReviewHtml() {

  var CSS = [
    'body{font-family:Sarabun,sans-serif;margin:0;background:#F7F5F2;color:#1A1A1A}',
    '.hdr{background:#E8631A;color:#fff;padding:14px 20px;position:sticky;top:0;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,.12)}',
    '.hdr h1{font-size:17px;font-weight:700;margin:0}',
    '.hdr p{opacity:.9;font-size:12px;margin:2px 0 0}',
    '.wrap{padding:12px 16px;max-width:1100px;margin:0 auto}',
    '.stats{background:#fff;border-radius:10px;padding:14px 18px;margin-bottom:12px;border:1px solid rgba(0,0,0,.08);display:flex;gap:32px}',
    '.n{font-size:24px;font-weight:700;color:#E8631A}',
    '.l{font-size:11px;color:#888;letter-spacing:.06em;text-transform:uppercase}',
    'table{width:100%;background:#fff;border-collapse:collapse;border:1px solid rgba(0,0,0,.08);border-radius:8px;overflow:hidden;font-size:13px}',
    'th{background:#F1EEE9;padding:8px 6px;text-align:left;font-weight:600;font-size:11px;color:#555;border-bottom:2px solid #E8631A;white-space:nowrap}',
    'td{padding:5px 6px;border-bottom:1px solid rgba(0,0,0,.05);vertical-align:middle}',
    '.ro{color:#555;font-size:12px;white-space:nowrap}',
    'td input{width:100%;border:1px solid transparent;padding:3px 5px;border-radius:4px;font-family:Sarabun,sans-serif;font-size:13px;background:transparent;box-sizing:border-box}',
    'td input:focus{outline:none;background:#fff;border-color:#E8631A}',
    '.num{text-align:right}',
    '.tr-warn{background:#FEF6EE}',
    '.tr-e{background:#FFFDE7}',
    '.tr-ok{background:#fff}',
    '.st{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}',
    '.st-ok{background:#E2F4ED;color:#007B40}',
    '.st-wait{background:#FEF0E7;color:#C65410}',
    '.st-e{background:#FFF8E1;color:#F57F17}',
    '.st-na{background:#FEE9E9;color:#B61010}',
    '.act{position:sticky;bottom:0;background:#fff;padding:10px 16px;border-top:1px solid rgba(0,0,0,.1);display:flex;gap:8px;box-shadow:0 -4px 12px rgba(0,0,0,.06)}',
    '.btn{flex:1;padding:11px;border:none;border-radius:8px;font-size:14px;font-weight:600;font-family:Sarabun,sans-serif;cursor:pointer}',
    '.btn-g{background:#007B40;color:#fff}',
    '.btn-w{background:#fff;color:#666;border:1px solid #ddd}',
    '.toast{position:fixed;bottom:72px;left:50%;transform:translateX(-50%);background:#1A1A1A;color:#fff;padding:10px 18px;border-radius:20px;font-size:13px;opacity:0;transition:opacity .2s;pointer-events:none;white-space:nowrap}',
    '.toast.on{opacity:1}',
    // ── Bill Search Dropdown ──
    '.bw{position:relative;min-width:170px}',
    '.bi{width:100%;border:1px solid #ddd;padding:4px 22px 4px 7px;border-radius:6px;',
    '  font-family:Sarabun,sans-serif;font-size:13px;background:#fff;',
    '  box-sizing:border-box;cursor:pointer;color:#1A1A1A}',
    '.bi:focus{outline:none;border-color:#E8631A;box-shadow:0 0 0 2px rgba(232,99,26,.15)}',
    '.bi.sel{border-color:#007B40;background:#F0FAF5;font-weight:700;color:#007B40}',
    '.ba{position:absolute;right:6px;top:50%;transform:translateY(-50%);pointer-events:none;color:#aaa;font-size:10px}',
    '.bd{display:none;position:absolute;top:calc(100% + 3px);left:0;background:#fff;',
    '  border:1px solid #ddd;border-radius:8px;box-shadow:0 4px 20px rgba(0,0,0,.15);',
    '  z-index:999;min-width:270px;max-height:260px;overflow:hidden;flex-direction:column}',
    '.bd.open{display:flex}',
    '.bs-wrap{padding:7px 7px 4px;border-bottom:1px solid #f0f0f0}',
    '.bs{width:100%;border:1px solid #ddd;border-radius:6px;padding:5px 8px;',
    '  font-family:Sarabun,sans-serif;font-size:12px;box-sizing:border-box}',
    '.bs:focus{outline:none;border-color:#E8631A}',
    '.bl{overflow-y:auto;max-height:190px;padding:3px 0}',
    '.bo{padding:7px 11px;cursor:pointer;font-size:12px;display:flex;',
    '  justify-content:space-between;align-items:flex-start;gap:8px;',
    '  border-bottom:1px solid #f8f8f8;transition:background .1s}',
    '.bo:last-child{border-bottom:none}',
    '.bo:hover,.bo.act{background:#FEF6EE}',
    '.bo-inv{font-weight:700;font-size:13px;white-space:nowrap}',
    '.bo-r{text-align:right;flex-shrink:0}',
    '.bo-amt{font-weight:700;color:#E8631A;font-size:13px}',
    '.bo-due{font-size:11px;margin-top:1px}',
    '.d-ov{color:#C62828}.d-sn{color:#F57F17}.d-ok{color:#2E7D32}.d-no{color:#aaa}',
    '.bempty{padding:14px;text-align:center;color:#aaa;font-size:12px}',
    '.bfoot{padding:5px 8px;border-top:1px solid #f0f0f0;display:flex;justify-content:flex-end}',
    '.bb{background:#007B40;color:#fff;border:none;border-radius:6px;',
    '  padding:5px 14px;font-size:12px;font-weight:700;font-family:Sarabun,sans-serif;',
    '  cursor:pointer;white-space:nowrap}',
    '.bb:disabled{opacity:.4;cursor:not-allowed}',
  ].join('');

  // ── JavaScript (เขียนเป็น normal string ไม่ใช้ template literal) ──
  var JS = [
    'var EM="__DSR_EMAIL__";',
    'var rows=[];',
    'var edits={};',
    'var billCache={};',  // cache บิลต่อ customer ไม่โหลดซ้ำ
    'var dropSt={};',     // state ต่อ rowIndex: {bills, selected}

    // toast
    'function toast(m,d){',
    '  var e=document.getElementById("t");',
    '  e.textContent=m;e.className="toast on";',
    '  setTimeout(function(){e.className="toast"},d||2500);}',

    // reload
    'function doReload(){',
    '  if(Object.keys(edits).length&&!confirm("มีการแก้ไขที่ยังไม่ได้บันทึก — โหลดใหม่?"))return;',
    '  billCache={};dropSt={};load();}',

    // load
    'function load(){',
    '  document.getElementById("app").innerHTML=\'<div style="padding:40px;text-align:center;color:#888">กำลังโหลด...</div>\';',
    '  google.script.run',
    '    .withSuccessHandler(render)',
    '    .withFailureHandler(function(e){',
    '      document.getElementById("app").innerHTML=\'<div style="padding:24px;color:#c00">❌ \'+e.message+\'</div>\';',
    '    })',
    '    .getDsrWeekSlips(EM);}',

    // render
    'function render(d){',
    '  if(!d||d.error){',
    '    document.getElementById("app").innerHTML=\'<div style="padding:24px;color:#c00">❌ \'+(d?d.error:"ไม่ได้รับข้อมูล")+\'</div>\';',
    '    return;}',
    '  rows=d.rows||[];edits={};dropSt={};',
    '  document.getElementById("cnt").textContent=rows.length;',
    '  document.getElementById("sum").textContent=Number(d.total||0).toLocaleString("th-TH")+" ฿";',
    '  if(!rows.length){',
    '    document.getElementById("app").innerHTML=\'<div style="padding:40px;text-align:center;color:#888">ยังไม่มีสลิปสัปดาห์นี้</div>\';',
    '    return;}',

    '  var h="<table><thead><tr>"+',
    '    "<th style=\'width:3%\'>#</th>"+',
    '    "<th style=\'width:9%\'>วันที่โอน</th>"+',
    '    "<th style=\'width:6%\'>เวลาโอน</th>"+',
    '    "<th style=\'width:7%\'>รหัส</th>"+',
    '    "<th style=\'width:17%\'>ร้าน</th>"+',
    '    "<th style=\'width:11%\'>เลขบิล</th>"+',
    '    "<th style=\'width:7%;text-align:right\'>ยอด(฿)</th>"+',
    '    "<th style=\'width:8%\'>สถานะ</th>"+',
    '    "<th>หมายเหตุ</th>"+',
    '    "</tr></thead><tbody>";',

    '  rows.forEach(function(r,i){',
    '    var st=r["สถานะ"]||"";',
    '    var bill=String(r["เลขที่บิล"]||"").trim();',
    '    var empty=!bill;',
    '    var tc=empty?"tr-e":(st==="ยอดไม่ตรง"||st==="รอระบุ")?"tr-warn":"tr-ok";',
    '    var sc=empty?"st-e":st==="เรียบร้อย"?"st-ok":st==="รอระบุ"?"st-wait":"st-na";',
    '    var stLbl=empty?"รอระบุบิล":(st||"-");',
    '    var sd=fd(r["วันที่โอน"]);',
    '    var sv=r["เวลาโอน"]?String(r["เวลาโอน"]).slice(0,5):"";',
    '    var af=(parseFloat(r["ยอดเงิน"])||0).toLocaleString("th-TH");',
    '    var cust=esc(String(r["รหัสลูกค้า"]||"").trim());',
    '    var ri=r._row;',

    '    h+="<tr class=\'"+tc+"\' data-row=\'"+ri+"\'>";',
    '    h+="<td>"+(i+1)+"</td>";',
    '    h+="<td class=\'ro\'>"+sd+"</td>";',
    '    h+="<td class=\'ro\'>"+sv+"</td>";',
    '    h+=inp(r,"รหัสลูกค้า","ชื่อร้าน");',
    '    h+="<td class=\'ro\' id=\'shop-"+ri+"\'>"+esc(r["ชื่อร้าน"]||"")+"</td>";',

    // เลขบิล: dropdown ถ้าว่าง, input ปกติถ้ามีค่า
    '    if(empty){',
    '      h+="<td><div class=\'bw\' id=\'bw-"+ri+"\'>";',
    '      h+="<input class=\'bi\' id=\'bi-"+ri+"\' readonly placeholder=\'เลือกบิล...\' ";',
    '      h+="data-row=\'"+ri+"\' data-cust=\'"+cust+"\' onclick=\'openDrop(this)\'>";',
    '      h+="<span class=\'ba\'>▼</span>";',
    '      h+="<div class=\'bd\' id=\'bd-"+ri+"\'>";',
    '      h+="<div class=\'bs-wrap\'><input class=\'bs\' placeholder=\'🔍 พิมพ์เลขบิล...\' ";',
    '      h+="oninput=\'filterDrop(this,"+ri+")\' onclick=\'event.stopPropagation()\'></div>";',
    '      h+="<div class=\'bl\' id=\'bl-"+ri+"\'><div class=\'bempty\'>กำลังโหลด...</div></div>";',
    '      h+="<div class=\'bfoot\'>";',
    '      h+="<button class=\'bb\' id=\'bb-"+ri+"\' disabled onclick=\'saveBill("+ri+")\'>บันทึก</button>";',
    '      h+="</div></div></div></td>";',
    '    } else {',
    '      h+=inp(r,"เลขที่บิล");',
    '    }',

    '    h+="<td class=\'num\'>"+af+"</td>";',
    '    h+="<td><span class=\'st "+sc+"\' id=\'st-"+ri+"\'>"+stLbl+"</span></td>";',
    '    h+=inp(r,"note");',
    '    h+="</tr>";',
    '  });',

    '  h+="</tbody></table>";',
    '  document.getElementById("app").innerHTML=h;',

    // โหลด bill options ทุกแถวที่ว่าง
    '  rows.forEach(function(r){',
    '    if(!String(r["เลขที่บิล"]||"").trim() && r["รหัสลูกค้า"])',
    '      fetchBills(String(r["รหัสลูกค้า"]).trim(),r._row);',
    '  });',

    // ปิด dropdown เมื่อคลิกข้างนอก
    '  document.addEventListener("click",closeAllDrops,true);',
    '}',

    // ── fetchBills ──
    'function fetchBills(cust,ri){',
    '  if(!cust)return;',
    '  if(billCache[cust]){',
    '    dropSt[ri]={bills:billCache[cust],selected:null};',
    '    renderList(ri,billCache[cust],"");',
    '    return;}',
    '  google.script.run',
    '    .withSuccessHandler(function(res){',
    '      var bills=(res&&res.ok)?res.bills:[];',
    '      billCache[cust]=bills;',
    '      dropSt[ri]={bills:bills,selected:null};',
    '      renderList(ri,bills,"");',
    '    })',
    '    .withFailureHandler(function(){',
    '      dropSt[ri]={bills:[],selected:null};',
    '      renderList(ri,[],"");',
    '    })',
    '    .getBillsForPendingRow(cust);}',

    // ── renderList ──
    'function renderList(ri,bills,q){',
    '  var el=document.getElementById("bl-"+ri);',
    '  if(!el)return;',
    '  q=(q||"").toLowerCase().trim();',
    '  var filtered=bills.filter(function(b){',
    '    return !q||b.invoiceNo.toLowerCase().indexOf(q)!==-1;});',
    '  if(!filtered.length){',
    '    el.innerHTML="<div class=\'bempty\'>"+(q?"ไม่พบ \\""+q+"\\"":"ไม่มีบิลค้างชำระ")+"</div>";',
    '    return;}',
    '  var today=new Date();today.setHours(0,0,0,0);',
    '  var sel=dropSt[ri]&&dropSt[ri].selected;',
    '  el.innerHTML=filtered.map(function(b){',
    '    var dt="",dc="d-no";',
    '    if(b.dueDate){',
    '      var due=new Date(b.dueDate);',
    '      var diff=Math.round((due-today)/86400000);',
    '      if(diff<0){dt="⚠️ เกิน "+Math.abs(diff)+" วัน";dc="d-ov";}',
    '      else if(diff===0){dt="🔴 ครบวันนี้";dc="d-ov";}',
    '      else if(diff<=7){dt="🟡 อีก "+diff+" วัน";dc="d-sn";}',
    '      else{dt="🟢 "+fsd(b.dueDate);dc="d-ok";}}',
    '    var ac=(sel===b.invoiceNo)?" act":"";',
    '    return "<div class=\'bo"+ac+"\' onclick=\'selBill("+ri+",\\""+esc(b.invoiceNo)+"\\")\'>"',
    '      +"<span class=\'bo-inv\'>"+esc(b.invoiceNo)+"</span>"',
    '      +"<div class=\'bo-r\'>"',
    '      +"<div class=\'bo-amt\'>฿"+Number(b.amount).toLocaleString("th-TH")+"</div>"',
    '      +(dt?"<div class=\'bo-due "+dc+"\'>"+dt+"</div>":"")+"</div></div>";',
    '  }).join("");}',

    // ── openDrop ──
    'function openDrop(inp){',
    '  var ri=inp.dataset.row;',
    '  document.querySelectorAll(".bd.open").forEach(function(d){',
    '    if(d.id!=="bd-"+ri)d.classList.remove("open");});',
    '  var dd=document.getElementById("bd-"+ri);',
    '  if(!dd)return;',
    '  dd.classList.toggle("open");',
    '  if(dd.classList.contains("open")){',
    '    var s=dd.querySelector(".bs");',
    '    if(s){s.value="";setTimeout(function(){s.focus()},50);}}}',

    // ── filterDrop ──
    'function filterDrop(el,ri){',
    '  var st=dropSt[ri];',
    '  if(st)renderList(ri,st.bills,el.value);}',

    // ── selBill ──
    'function selBill(ri,inv){',
    '  if(!dropSt[ri])return;',
    '  dropSt[ri].selected=inv;',
    '  var inp=document.getElementById("bi-"+ri);',
    '  if(inp){inp.value=inv;inp.classList.add("sel");}',
    '  var btn=document.getElementById("bb-"+ri);',
    '  if(btn)btn.disabled=false;',
    '  var sq=document.querySelector("#bd-"+ri+" .bs");',
    '  renderList(ri,dropSt[ri].bills,sq?sq.value:"");}',

    // ── closeAllDrops ──
    'function closeAllDrops(e){',
    '  var t=e.target;',
    '  if(t.classList.contains("bi")||t.classList.contains("bs")||',
    '     t.classList.contains("bo")||(t.closest&&t.closest(".bd")))return;',
    '  document.querySelectorAll(".bd.open").forEach(function(d){d.classList.remove("open");});}',

    // ── saveBill ──
    'function saveBill(ri){',
    '  var st=dropSt[ri];',
    '  if(!st||!st.selected)return;',
    '  var btn=document.getElementById("bb-"+ri);',
    '  btn.disabled=true;btn.textContent="⏳";',
    '  google.script.run',
    '    .withSuccessHandler(function(res){',
    '      if(res&&res.ok){',
    '        var wrapEl=document.getElementById("bw-"+ri);',
    '        if(wrapEl)wrapEl.innerHTML="<span style=\'font-weight:700;color:#007B40\'>"+esc(st.selected)+"</span>";',
    '        var stEl=document.getElementById("st-"+ri);',
    '        if(stEl){stEl.className="st st-ok";stEl.textContent="เรียบร้อย";}',
    '        var tr=document.querySelector("tr[data-row=\'"+ri+"\']");',
    '        if(tr)tr.className="tr-ok";',
    '        document.getElementById("bd-"+ri)&&document.getElementById("bd-"+ri).classList.remove("open");',
    '        toast("✅ บันทึกเลขบิล "+st.selected);',
    '      }else{',
    '        btn.disabled=false;btn.textContent="บันทึก";',
    '        toast("❌ "+(res?res.error:"เกิดข้อผิดพลาด"));}',
    '    })',
    '    .withFailureHandler(function(e){',
    '      btn.disabled=false;btn.textContent="บันทึก";',
    '      toast("❌ "+e.message);})',
    '    .assignBillToSlipRow(parseInt(ri),st.selected);}',

    // ── inp (สำหรับ column อื่น) ──
    'function inp(r,k,lk){',
    '  var v=esc(String(r[k]||""));',
    '  var lu=lk?" data-lk=\'"+lk+"\'":\'\';',
    '  return "<td><input data-k=\'"+k+"\'"+lu+" value=\'"+v+"\' oninput=\'ed(this)\'></td>";}',

    // ── ed ──
    'function ed(el){',
    '  var tr=el.closest("tr");var row=tr.dataset.row;',
    '  var k=el.dataset.k;var lk=el.dataset.lk;',
    '  if(!edits[row])edits[row]={row:parseInt(row),fields:{}};',
    '  edits[row].fields[k]=el.value;',
    '  if(lk){',
    '    var m=rows.find(function(r){return r["รหัสลูกค้า"]===el.value.trim();});',
    '    if(m&&m[lk]){',
    '      var cell=document.getElementById("shop-"+row);',
    '      if(cell)cell.textContent=m[lk];',
    '      edits[row].fields[lk]=m[lk];}}}',

    // ── date helpers ──
    'function fd(s){',
    '  var mo=["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];',
    '  try{if(!s)return"";var dt=new Date(s);if(isNaN(dt.getTime()))return s;',
    '  var b=new Date(dt.toLocaleString("en-US",{timeZone:"Asia/Bangkok"}));',
    '  return b.getDate()+" "+mo[b.getMonth()+1]+" "+String(b.getFullYear()+543).slice(-2);}',
    '  catch(e){return s;}}',

    'function fsd(iso){',
    '  var mo=["","ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];',
    '  try{var dt=new Date(iso);',
    '  var b=new Date(dt.toLocaleString("en-US",{timeZone:"Asia/Bangkok"}));',
    '  return b.getDate()+" "+mo[b.getMonth()+1];}catch(e){return iso;}}',

    // ── esc ──
    'function esc(s){',
    '  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");}',

    // ── doSubmit ──
    'function doSubmit(){',
    '  var bs=document.getElementById("btn-s");',
    '  bs.disabled=true;bs.textContent="กำลังบันทึก...";',
    '  var list=Object.values(edits);',
    '  function pdf(){',
    '    bs.textContent="กำลังสร้าง PDF...";',
    '    google.script.run',
    '      .withSuccessHandler(function(res){',
    '        bs.disabled=false;bs.textContent="บันทึก + สร้าง Cover Sheet";',
    '        if(res&&res.url){toast("✅ สร้างเรียบร้อย");window.open(res.url,"_blank");}',
    '        else toast("⚠️ สร้างไม่ได้");',
    '      })',
    '      .withFailureHandler(function(e){',
    '        bs.disabled=false;bs.textContent="บันทึก + สร้าง Cover Sheet";',
    '        toast("❌ "+e.message);})',
    '      .generateCoverSheetPdf(EM);}',
    '  if(!list.length){pdf();return;}',
    '  google.script.run',
    '    .withSuccessHandler(function(){edits={};pdf();})',
    '    .withFailureHandler(function(e){',
    '      bs.disabled=false;bs.textContent="บันทึก + สร้าง Cover Sheet";',
    '      toast("❌ "+e.message);})',
    '    .saveDsrEdits(list);}',

    'load();',
  ].join('\n');

  return '<!DOCTYPE html><html lang="th"><head>' +
    '<meta charset="UTF-8">' +
    '<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@400;600;700&display=swap" rel="stylesheet">' +
    '<style>' + CSS + '</style>' +
    '</head><body>' +
    '<div class="hdr">' +
      '<h1>📋 ใบสรุปเงินสัปดาห์นี้</h1>' +
      '<p>คุณ__DSR_NAME__ &nbsp;·&nbsp; __DSR_EMAIL__</p>' +
    '</div>' +
    '<div class="wrap">' +
      '<div class="stats">' +
        '<div><div class="l">จำนวน</div><div class="n" id="cnt">—</div></div>' +
        '<div><div class="l">ยอดรวม</div><div class="n" id="sum">—</div></div>' +
      '</div>' +
      '<div id="app" style="padding:40px;text-align:center;color:#888">กำลังโหลด...</div>' +
    '</div>' +
    '<div class="act">' +
      '<button class="btn btn-w" onclick="doReload()">รีเฟรช</button>' +
      '<button class="btn btn-g" id="btn-s" onclick="doSubmit()">บันทึก + สร้าง Cover Sheet</button>' +
    '</div>' +
    '<div class="toast" id="t"></div>' +
    '<script>' + JS + '<\/script>' +
    '</body></html>';
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  DSR Operation Platform — Code.gs additions                      ║
// ║  เพิ่ม 2 ฟังก์ชันนี้ใน Code.gs ของ DSR Operation Platform      ║
// ║                                                                  ║
// ║  ข้อมูลบิลค้างชำระดึงมาจาก Slip2Go Spreadsheet                 ║
// ║  (SPREADSHEET_ID_SLIP ใน Script Properties)                     ║
// ╚══════════════════════════════════════════════════════════════════╝


// ── getBillsForPendingRow ──────────────────────────────────────────
// dsr_review.html เรียกเมื่อโหลด dropdown บิลสำหรับแถวที่เลขบิลว่าง
// รับ:  customerCode (string)  เช่น "113-869"
// คืน:  { ok, bills: [{invoiceNo, amount, dueDate, overdueDays}] }
//       เรียงตาม dueDate — เกิน due มากสุดขึ้นก่อน

function getBillsForPendingRow(customerCode) {
  customerCode = (customerCode||'').toString().trim();
  if (!customerCode) return { ok:false, error:'ไม่ระบุรหัสลูกค้า' };
 
  try {
    var slipSsId = prop('SPREADSHEET_ID_SLIP');
    if (!slipSsId) return { ok:false, error:'ไม่พบ SPREADSHEET_ID_SLIP' };
 
    var ss    = SpreadsheetApp.openById(slipSsId);
    var sheet = ss.getSheetByName('บิลค้างจ่าย');
    if (!sheet) return { ok:false, error:'ไม่พบ sheet บิลค้างจ่าย' };
 
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { ok:true, bills:[] };
    var h = data[0];
 
    function col(names) {
      for (var ni=0;ni<names.length;ni++) for (var hi=0;hi<h.length;hi++) if (String(h[hi]).trim().toLowerCase()===names[ni].toLowerCase()) return hi;
      return -1;
    }
 
    var iKey  = col(['รหัสหลัก','TaxNo','taxno','รหัสลูกค้า']);
    var iInv  = col(['InvoiceNo','invoiceno','เลขที่บิล','DocNo']);
    var iAmt  = col(['ยอดคงเหลือ','ยอดบิล','Amount','amount']);
    var iDue  = col(['DueDate','duedate','วันครบกำหนด','วันที่ครบกำหนด']);
    var iShop = col(['ชื่อลูกค้าหลัก','ชื่อลูกค้า','Sale','sale','CustomerName']);
 
    if (iKey<0||iInv<0) return { ok:false, error:'ไม่พบ column รหัสหลัก หรือ InvoiceNo' };
 
    var today = new Date(); today.setHours(0,0,0,0);
    var shopName = '';
    var bills = [];
 
    for (var r=1; r<data.length; r++) {
      var rowKey = String(data[r][iKey]||'').trim();
      if (rowKey !== customerCode) continue;
 
      var invoiceNo = String(data[r][iInv]||'').trim();
      if (!invoiceNo) continue;
 
      // ดึงชื่อร้านจากแถวแรกที่ตรง
      if (!shopName && iShop>=0) shopName = String(data[r][iShop]||'').trim();
 
      var amtRaw = iAmt>=0?data[r][iAmt]:0;
      var amount = parseFloat(String(amtRaw).replace(/[^0-9.\-]/g,''))||0;
 
      var dueDate=null, overdueDays=null;
      if (iDue>=0&&data[r][iDue]) {
        var rawDue=data[r][iDue], dueDt=(rawDue instanceof Date)?rawDue:new Date(rawDue);
        if (!isNaN(dueDt.getTime())) {
          dueDt.setHours(0,0,0,0);
          dueDate    = dueDt.toISOString().slice(0,10);
          overdueDays= Math.floor((today-dueDt)/86400000);
        }
      }
 
      bills.push({ invoiceNo:invoiceNo, amount:amount, dueDate:dueDate, overdueDays:overdueDays, shopName:shopName });
    }
 
    if (!bills.length) return { ok:true, bills:[], shopName:shopName };
 
    bills.sort(function(a,b){
      if(!a.dueDate&&!b.dueDate)return 0; if(!a.dueDate)return 1; if(!b.dueDate)return-1;
      return new Date(a.dueDate)-new Date(b.dueDate);
    });
 
    return { ok:true, bills:bills, shopName:shopName };
 
  } catch(err) {
    Logger.log('[getBillsForPendingRow] '+err.message);
    return { ok:false, error:err.message };
  }
}


// ── assignBillToSlipRow ────────────────────────────────────────────
// dsr_review.html เรียกเมื่อ DSR กด "บันทึก" หลังเลือก dropdown
// รับ:  rowIndex (number, 1-based), invoiceNo (string)
// คืน:  { ok } หรือ { ok: false, error }
// เขียนลง Slip2Go Spreadsheet sheet 'Slip2Go'

function assignBillToSlipRow(rowIndex, invoiceNo) {
  rowIndex  = parseInt(rowIndex);
  invoiceNo = (invoiceNo || '').toString().trim();

  if (!rowIndex || !invoiceNo) return { ok: false, error: 'ข้อมูลไม่ครบ' };

  try {
    var slipSsId = PropertiesService.getScriptProperties()
                     .getProperty('SPREADSHEET_ID_SLIP') || '';
    if (!slipSsId) return { ok: false, error: 'ไม่พบ SPREADSHEET_ID_SLIP' };

    var ss    = SpreadsheetApp.openById(slipSsId);
    var sheet = ss.getSheetByName('Slip2Go');
    if (!sheet) return { ok: false, error: 'ไม่พบ sheet Slip2Go' };

    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];

    function colIdx(name) {
      var idx = headers.indexOf(name);
      return idx >= 0 ? idx + 1 : -1; // 1-based สำหรับ getRange
    }

    var iInvoice = colIdx('เลขที่บิล');
    var iStatus  = colIdx('สถานะ');

    if (iInvoice < 0) return { ok: false, error: 'ไม่พบ column เลขที่บิล' };
    if (iStatus  < 0) return { ok: false, error: 'ไม่พบ column สถานะ' };

    // ตรวจว่าแถวนี้ยังว่างอยู่ (ป้องกัน double-save)
    var currentBill = sheet.getRange(rowIndex, iInvoice).getValue();
    if (currentBill && currentBill.toString().trim()) {
      return { ok: false, error: 'แถวนี้มีเลขบิลแล้ว: ' + currentBill + ' (กด refresh)' };
    }

    // เขียน
    sheet.getRange(rowIndex, iInvoice).setValue(invoiceNo);
    if (iStatus > 0) {
      sheet.getRange(rowIndex, iStatus).setValue('เรียบร้อย');
    }

    Logger.log('[assignBillToSlipRow] row=' + rowIndex + ' invoice=' + invoiceNo);
    return { ok: true };

  } catch(err) {
    Logger.log('[assignBillToSlipRow] ' + err.message);
    return { ok: false, error: err.message };
  }
}

// API: ดึงข้อมูลสลิปสัปดาห์นี้ของ DSR

function getMondayOfWeek() {
  var d = new Date();
  var day = d.getDay();
  var diff = d.getDate() - day + (day === 0 ? -6 : 1);
  var mon = new Date(d.setDate(diff));
  mon.setHours(0, 0, 0, 0);
  return mon;
}

function debugFernLogin() {
  // Test 1: ดู email ที่ Session เห็น
  var sessionEmail = Session.getActiveUser().getEmail();
  Logger.log('Session email: "' + sessionEmail + '"');
  
  // Test 2: ดูข้อมูลใน Sheet
  var u = findUserByEmail('fernery11@gmail.com');
  Logger.log('User found: ' + JSON.stringify(u));
  
  // Test 3: เช็ค active field
  if (u) {
    Logger.log('active value: "' + u.active + '"');
    Logger.log('active type: ' + typeof u.active);
    Logger.log('toUpperCase: "' + u.active.toUpperCase() + '"');
    Logger.log('=== TRUE: ' + (u.active.toUpperCase() === 'TRUE'));
  }
  
  // Test 4: isAllowedEmail
  Logger.log('isAllowed: ' + isAllowedEmail('fernery11@gmail.com'));
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  Code.gs patch v15                                               ║
// ║  1. getCoverSheetHtml — sort ตาม rowOrder (exact) หรือ          ║
// ║     sort วันที่ส่งสลิป ถ้าไม่มี rowOrder                        ║
// ║  2. lookupStoreInvoice — ใช้ console.log แทน Logger.log         ║
// ╚══════════════════════════════════════════════════════════════════╝

function getCoverSheetHtml(email, monISO, sunISO, billAmounts, rowOrder) {
  if (!email) throw new Error('missing email');
  var data = getDsrWeekSlipsWithRange(email, monISO, sunISO);
  var rows = data.rows || [];
  if (rows.length === 0) throw new Error('ไม่มีสลิปในช่วงนี้');

  rows.sort(function(a,b){
    return new Date(a['วันที่ส่งสลิป']||a['created_at']||0)
          -new Date(b['วันที่ส่งสลิป']||b['created_at']||0);
  });
  if (rowOrder && rowOrder.length>0) {
    var posMap={};
    rowOrder.forEach(function(ri,i){posMap[String(ri)]=i;});
    rows.sort(function(a,b){
      var pa=posMap[String(a._row)],pb=posMap[String(b._row)];
      if(pa==null)pa=9999; if(pb==null)pb=9999; return pa-pb;
    });
  }

  // ── build storeInvMap: { custCode: [inv1, inv2, ...] } ──────
  var storeInvMap = {};
  try {
    var custCodes = [];
    rows.forEach(function(r){
      var c=(r['รหัสลูกค้า']||'').toString().trim();
      if(c && custCodes.indexOf(c)<0) custCodes.push(c);
    });
    var STORE_SS_ID = '1ADwKdbF8Eo1ZuTXRRKUdgD-9NXvbphuA49PvB5sWGeY';
    var storeSh = SpreadsheetApp.openById(STORE_SS_ID).getSheetByName('Pay');
    if (storeSh) {
      var sData = storeSh.getDataRange().getValues();
      var sh = sData[0];
      var sCust=1, sInv=2, sRemain=5;
      for (var hi=0;hi<sh.length;hi++){
        var hn=String(sh[hi]).trim();
        if(hn==='รหัสลูกค้า') sCust=hi;
        if(hn==='เลขที่บิล'||hn==='DocNo'||hn==='InvoiceNo') sInv=hi;
        if(hn==='ยอดคงเหลือ'||hn==='คงเหลือ') sRemain=hi;
      }
      for (var sr=1;sr<sData.length;sr++){
        var rc=String(sData[sr][sCust]||'').trim();
        if(custCodes.indexOf(rc)<0) continue;
        var rr=parseFloat(String(sData[sr][sRemain]||0).replace(/[^0-9.\-]/g,''))||0;
        if(rr<=0) continue;
        var ri=String(sData[sr][sInv]||'').trim().toLowerCase();
        if(!ri) continue;
        if(!storeInvMap[rc]) storeInvMap[rc]=[];
        if(storeInvMap[rc].indexOf(ri)<0) storeInvMap[rc].push(ri);
        // suffix
        var sfx=ri.split('-').pop();
        if(sfx.length>=4 && storeInvMap[rc].indexOf(sfx)<0) storeInvMap[rc].push(sfx);
      }
    }
  } catch(e) {
    console.log('[getCoverSheet storeMap] '+e.message);
  }

  var dsrName   = getUserDisplayName(email);
  var today     = Utilities.formatDate(new Date(),'Asia/Bangkok','dd/MM/yy');
  var weekLabel = data.weekLabel || '';
  billAmounts   = billAmounts || {};
  return buildCoverSheetHtmlV15(rows, dsrName, today, data.total, weekLabel, billAmounts, storeInvMap);
}

function buildCoverSheetHtmlV15(rows, dsrName, today, total, weekLabel, billAmounts, storeInvMap) {
  storeInvMap = storeInvMap || {};
  // Logo
  var logoHtml = '';
  try {
    var names = ['Nice Center Oil x Castrol - Business Card ใส.png','logo_nco.png'];
    outer: for (var li = 0; li < names.length; li++) {
      var folds = DriveApp.getFoldersByName('NCO_CoverSheets');
      while (folds.hasNext()) {
        var ff = folds.next().getFilesByName(names[li]);
        if (ff.hasNext()) { var bb=ff.next().getBlob(); logoHtml='<img src="data:'+bb.getContentType()+';base64,'+Utilities.base64Encode(bb.getBytes())+'" style="height:44px;object-fit:contain;">'; break outer; }
      }
      var af = DriveApp.getFilesByName(names[li]);
      if (af.hasNext()) { var bb=af.next().getBlob(); logoHtml='<img src="data:'+bb.getContentType()+';base64,'+Utilities.base64Encode(bb.getBytes())+'" style="height:44px;object-fit:contain;">'; break; }
    }
  } catch(e) { console.log('[logo] '+e.message); }
  if (!logoHtml) logoHtml='<div style="text-align:right;line-height:1.4"><span style="font-size:14px;font-weight:700;color:#E8631A">NICE CENTER</span><br><span style="font-size:12px;color:#C8102E">x CASTROL</span></div>';

  function trimInv(inv){if(!inv)return'';var s=String(inv).trim();return /^[A-Za-z]{2}\d{2}/.test(s)?s.slice(4):s;}
  function fmtShort(raw){if(!raw)return'';try{var dt=(raw instanceof Date)?raw:new Date(raw);if(isNaN(dt.getTime()))return'';var bkk=new Date(dt.toLocaleString('en-US',{timeZone:'Asia/Bangkok'}));return String(bkk.getDate()).padStart(2,'0')+'/'+String(bkk.getMonth()+1).padStart(2,'0')+'/'+String(bkk.getFullYear()+543).slice(-2);}catch(e){return'';}}

  function isStoreBill(custCode, invNo) {
    if (!invNo || !custCode) return false;
    var set  = storeInvMap[custCode] || [];
    var norm = invNo.toLowerCase();
    var sfx  = norm.split('-').pop();
    return set.indexOf(norm)>=0 || (sfx.length>=4 && set.indexOf(sfx)>=0);
  }

  var tableRows = rows.map(function(r,i){
    var transferAmt = parseMoneyCell(r['ยอดเงิน']);
    var billAmt     = billAmounts[String(r._row)] ? parseMoneyCell(billAmounts[String(r._row)]) : 0;
    var dateStr     = fmtShort(r['วันที่โอน']);
    var invRaw      = r['เลขที่บิล'] || '';
    var invDisplay  = trimInv(invRaw);
    var custCode    = r['รหัสลูกค้า'] || '';
    var shopName    = r['ชื่อร้าน']   || '';
    var isPending   = !!(r._isPending);

    // ── หมายเหตุ: รวม note + store tag + pending tag ──────────────
    var note = r['note'] || '';
    var noteParts = [];
    if (note) noteParts.push(escapeHtmlSrv(note));

    // บิลหน้าร้าน
    if (isStoreBill(custCode, invRaw)) {
      noteParts.push('<span style="font-size:9px;font-weight:700;background:#E3F2FD;color:#1565C0;border:1px solid #90CAF9;border-radius:3px;padding:1px 4px;white-space:nowrap;">🏪 หน้าร้าน</span>');
    }

    // pending slip — ดึง cust+bill ที่ DSR พิมใน Line
    if (isPending) {
      var pendingParts = [];
      if (custCode) pendingParts.push(escapeHtmlSrv(custCode));
      if (invDisplay) pendingParts.push(escapeHtmlSrv(invDisplay));
      if (pendingParts.length) {
        noteParts.push('<span style="font-size:9px;font-weight:700;background:#FFF8E1;color:#F57F17;border:1px solid #FFD54F;border-radius:3px;padding:1px 4px;white-space:nowrap;">⏳ '+pendingParts.join(' / ')+'</span>');
      } else {
        noteParts.push('<span style="font-size:9px;font-weight:700;background:#FFF8E1;color:#F57F17;border:1px solid #FFD54F;border-radius:3px;padding:1px 4px;white-space:nowrap;">⏳ รอระบุ</span>');
      }
    }

    var noteHtml = noteParts.join(' ');

    return '<tr'+(isPending?' style="background:#FFFDE7"':'')+'>'+
      '<td class="c">'+(i+1)+'</td>'+
      '<td class="code">'+escapeHtmlSrv(custCode)+'</td>'+
      '<td class="shop">'+escapeHtmlSrv(shopName)+'</td>'+
      '<td class="c">'+escapeHtmlSrv(invDisplay)+'</td>'+
      '<td class="r">'+(billAmt?formatMoney(billAmt):'')+'</td>'+
      '<td class="r">'+formatMoney(transferAmt)+'</td>'+
      '<td class="c">'+escapeHtmlSrv(dateStr)+'</td>'+
      '<td>'+noteHtml+'</td>'+
      '</tr>';
  }).join('');

  var empty='';
  for(var i=rows.length;i<15;i++) empty+='<tr><td class="c">'+(i+1)+'</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>';

  var metaLine='วันที่พิมพ์ '+today+(weekLabel?' &nbsp;|&nbsp; สัปดาห์ '+escapeHtmlSrv(weekLabel):'')+' &nbsp;|&nbsp; DSR: '+escapeHtmlSrv(dsrName);

  var css=[
    '* { box-sizing:border-box; margin:0; padding:0; }',
    '@page { size:A4 landscape; margin:12mm 10mm; }',
    'body { font-family:"Sarabun",Tahoma,Arial,sans-serif; font-weight:400; font-size:13px; color:#111; }',
    '@media screen { body{background:#ddd;display:flex;justify-content:center;padding:24px 16px} .page-wrap{background:#fff;padding:15mm 13mm;width:297mm;min-height:210mm;box-shadow:0 4px 28px rgba(0,0,0,.18)} .print-btn{position:fixed;top:14px;right:14px;background:#007B40;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;cursor:pointer;font-family:inherit;z-index:99} }',
    '@media print { body{background:none;padding:0;display:block} .page-wrap{box-shadow:none;padding:0;width:100%} .print-btn{display:none} }',
    '.top{display:flex;justify-content:space-between;align-items:center;border-bottom:1.5px solid #111;padding-bottom:6px;margin-bottom:7px}',
    '.title{font-size:17px} .meta-line{font-size:12px;text-align:center}',
    'table{width:100%;border-collapse:collapse;table-layout:fixed;margin-top:3px}',
    'th{font-size:12px;font-weight:400;border:0.5px solid #aaa;padding:5px 4px;text-align:center;background:#fff;white-space:nowrap}',
    'td{border:0.5px solid #aaa;padding:5px 5px;font-size:13px;vertical-align:middle;overflow:hidden}',
    'tr:nth-child(even) td{background:#fafafa}',
    'col.no{width:4%} col.code{width:9%} col.shop{width:20%} col.bi{width:10%} col.am{width:10%} col.dt{width:9%} col.nt{width:20%}',
    '.c{text-align:center} .r{text-align:right} .code{font-size:12px;white-space:nowrap} .shop{font-size:12px}',
    '.sub{display:flex;justify-content:flex-end;margin-top:5px}',
    '.box{border:0.5px solid #aaa;padding:4px 12px;font-size:13px;min-width:150px;text-align:right;background:#fff}',
    '.foot{margin-top:16px;display:flex;align-items:flex-end;gap:24px}',
    '.note-area{width:46%} .note-label{font-size:12px;color:#555} .note-line{border-bottom:1px dotted #555;height:22px;margin-top:4px}',
    '.sig{min-width:210px;padding-left:16px;text-align:center} .sig-line{border-top:0.5px solid #555;margin-top:38px;padding-top:5px;font-size:13px}',
  ].join('\n');

  return '<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8">'
    +'<link rel="preconnect" href="https://fonts.googleapis.com">'
    +'<link href="https://fonts.googleapis.com/css2?family=Sarabun&display=swap" rel="stylesheet">'
    +'<title>สรุปใบโอน Slip2Go</title><style>'+css+'</style></head><body>'
    +'<button class="print-btn" onclick="window.print()">พิมพ์ / บันทึก PDF</button>'
    +'<div class="page-wrap">'
    +'<div class="top"><div class="title">สรุปใบโอน Slip2Go</div><div class="meta-line">'+metaLine+'</div><div>'+logoHtml+'</div></div>'
    +'<table><colgroup><col class="no"><col class="code"><col class="shop"><col class="bi"><col class="am"><col class="am"><col class="dt"><col class="nt"></colgroup>'
    +'<thead><tr><th>No.</th><th>รหัสลูกค้า</th><th>ชื่อลูกค้า</th><th>เลขที่บิล</th><th>ยอดบิล</th><th>ยอดโอน</th><th>วันที่โอน</th><th>หมายเหตุ</th></tr></thead>'
    +'<tbody>'+tableRows+empty+'</tbody></table>'
    +'<div class="sub"><div class="box">ยอดเก็บเงินรวม: '+formatMoney(total)+' ฿</div></div>'
    +'<div class="foot"><div class="note-area"><div class="note-label">Note :</div><div class="note-line"></div></div><div class="sig"><div class="sig-line">ลงชื่อผู้ส่งเงิน</div></div></div>'
    +'</div>'
    +'<script>(function(){var p=false;function go(){if(p)return;p=true;window.print();}if(document.fonts&&document.fonts.ready){document.fonts.ready.then(function(){setTimeout(go,150);});}else{window.addEventListener("load",function(){setTimeout(go,400);});}setTimeout(go,3000);})();<\/script>'
    +'</body></html>';
}

// ╔══════════════════════════════════════════════════════════════════╗
// ║  Code.gs patch v16                                               ║
// ║  แก้ lookupStoreInvoice: match logic ใหม่สำหรับ format จริง    ║
// ║  เพิ่ม getDsrWeekSlipsWithPending: รวม PENDING_SLIPS           ║
// ╚══════════════════════════════════════════════════════════════════╝

// ─── lookupStoreInvoice v16 ───────────────────────────────────────────
// จาก log: sheet Pay col C = เลขที่บิล เช่น "034-1666"  (ไม่มี prefix)
// frontend ส่ง trimmedInv มาเช่น "401-20022" หรือ "20022"
// ต้อง match ทั้ง: ตัวเลขหลังขีด, เลขเต็ม, suffix match

function lookupStoreInvoice(trimmedInv) {
  if (!trimmedInv) return null;
  try {
    var STORE_SS_ID = '1ADwKdbF8Eo1ZuTXRRKUdgD-9NXvbphuA49PvB5sWGeY';
    var ss    = SpreadsheetApp.openById(STORE_SS_ID);
    var sheet = ss.getSheetByName('Pay');
    if (!sheet) { console.log('[lookupStore] ไม่พบ sheet Pay'); return null; }

    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { found: false };
    var h = data[0];

    console.log('[lookupStore] headers: ' + h.map(function(c,i){return i+':'+String(c).trim();}).join(' | '));
    console.log('[lookupStore] row2: ' + data[1].map(function(c,i){return i+':'+String(c).trim();}).join(' | '));

    function colIdx(keywords) {
      for (var ki=0;ki<keywords.length;ki++) {
        var kw=keywords[ki].toLowerCase().trim();
        for (var hi=0;hi<h.length;hi++) {
          if (String(h[hi]).toLowerCase().trim().indexOf(kw)>=0) return hi;
        }
      }
      return -1;
    }

    var iInv    = colIdx(['เลขที่บิล','เลขบิล','invoice','docno','doc_no']);
    var iBill   = colIdx(['ยอดบิล','bill','total','ยอด']);
    var iPaid   = colIdx(['จ่ายมาแล้ว','จ่ายแล้ว','paid','ชำระ']);
    var iRemain = colIdx(['ยอดคงเหลือ','คงเหลือ','remaining','balance']);
    var iCust   = colIdx(['ลูกค้า','ชื่อลูกค้า','customer','sale']);

    // fallback ตาม column index จาก log (0=วันที่บิล 1=รหัสลูกค้า 2=เลขที่บิล 3=ยอดบิล 4=จ่ายมาแล้ว 5=ยอดคงเหลือ 6=ลูกค้า)
    if (iInv < 0)    iInv    = 2;
    if (iBill < 0)   iBill   = 3;
    if (iPaid < 0)   iPaid   = 4;
    if (iRemain < 0) iRemain = 5;
    if (iCust < 0)   iCust   = 6;

    console.log('[lookupStore] cols: inv='+iInv+' bill='+iBill+' paid='+iPaid+' remain='+iRemain+' cust='+iCust);
    console.log('[lookupStore] trimmedInv input: "'+trimmedInv+'"');

    // สร้าง variants สำหรับ match
    // trimmedInv อาจเป็น "401-20022" หรือ "20022"
    // sheet อาจมี "034-1666" (prefix ต่างกัน) หรือ "20022"
    // → เอาเฉพาะตัวเลขหลัง "-" ตัวสุดท้าย (suffix)
    function getSuffix(s) {
      var parts = s.split('-');
      return parts[parts.length-1].replace(/\s/g,'');
    }
    var targetFull   = trimmedInv.toLowerCase().replace(/\s/g,'');
    var targetSuffix = getSuffix(trimmedInv).toLowerCase();
    console.log('[lookupStore] targetFull="'+targetFull+'" targetSuffix="'+targetSuffix+'"');

    var results = []; // เก็บทุก match แล้วเลือก remaining > 0

    for (var r=1;r<data.length;r++) {
      var raw = String(data[r][iInv]||'').trim();
      if (!raw) continue;

      var rowFull   = raw.toLowerCase().replace(/\s/g,'');
      var rowSuffix = getSuffix(raw).toLowerCase();

      // match ถ้า: full match, หรือ suffix match (เลขหลัง "-" ตรงกัน)
      var isMatch = (rowFull === targetFull)
                 || (rowSuffix === targetSuffix && targetSuffix.length >= 4);

      if (!isMatch) continue;

      var remaining = iRemain>=0 ? parseFloat(String(data[r][iRemain]||0).replace(/[^0-9.\-]/g,''))||0 : 0;
      var billAmt   = iBill>=0   ? parseFloat(String(data[r][iBill]||0).replace(/[^0-9.\-]/g,''))||0   : 0;
      var custName  = iCust>=0   ? String(data[r][iCust]||'').trim() : '';

      console.log('[lookupStore] row '+(r+1)+' match "'+raw+'": bill='+billAmt+' remain='+remaining+' cust='+custName);

      if (remaining <= 0) continue; // skip ที่ชำระครบแล้ว

      results.push({ found:true, billAmt:billAmt, remaining:remaining, custName:custName, rawInv:raw });
    }

    if (results.length > 0) {
      // คืน row แรกที่มี remaining > 0
      console.log('[lookupStore] returning: '+JSON.stringify(results[0]));
      return results[0];
    }

    console.log('[lookupStore] not found or all paid: "'+trimmedInv+'"');
    return { found: false };

  } catch(err) {
    console.log('[lookupStore] ERROR: '+err.message);
    return null;
  }
}

// ─── getBillsForCustomerCode v18 ─────────────────────────────────────
// ค้นบิลจาก 2 แหล่ง: บิลค้างจ่าย (บิลหลัก) + Pay sheet (บิลหน้าร้าน)
// คืน { ok, bills, shopName, storeInvSet }

function getBillsForCustomerCode(customerCode) {
  customerCode = (customerCode||'').toString().trim();
  if (!customerCode) return { ok:false, error:'ไม่ระบุรหัสลูกค้า' };

  try {
    var slipSsId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID_SLIP');
    if (!slipSsId) return { ok:false, error:'ไม่พบ SPREADSHEET_ID_SLIP' };

    var ss    = SpreadsheetApp.openById(slipSsId);
    var sheet = ss.getSheetByName('บิลค้างจ่าย');
    if (!sheet) return { ok:false, error:'ไม่พบ sheet บิลค้างจ่าย' };

    var data = sheet.getDataRange().getValues();
    var h    = data.length ? data[0] : [];

    function col(names) {
      for (var ni=0; ni<names.length; ni++)
        for (var hi=0; hi<h.length; hi++)
          if (String(h[hi]).trim().toLowerCase() === names[ni].toLowerCase()) return hi;
      return -1;
    }

    var iKey  = col(['รหัสหลัก','TaxNo','taxno','รหัสลูกค้า']);
    var iInv  = col(['InvoiceNo','invoiceno','เลขที่บิล','DocNo']);
    var iAmt  = col(['ยอดคงเหลือ','ยอดบิล','Amount','amount']);
    var iDue  = col(['DueDate','duedate','วันครบกำหนด','วันที่ครบกำหนด']);
    var iShop = col(['ชื่อลูกค้าหลัก','ชื่อลูกค้า','Sale','sale','CustomerName']);

    var today    = new Date(); today.setHours(0,0,0,0);
    var shopName = '';
    var bills    = [];

    // ── ค้นจาก sheet บิลค้างจ่าย (บิลหลัก) ────────────────────────
    if (iKey>=0 && iInv>=0 && data.length>1) {
      for (var r=1; r<data.length; r++) {
        if (String(data[r][iKey]||'').trim() !== customerCode) continue;
        var invoiceNo = String(data[r][iInv]||'').trim();
        if (!invoiceNo) continue;
        if (!shopName && iShop>=0) shopName = String(data[r][iShop]||'').trim();
        var amount = parseFloat(String(data[r][iAmt>=0?iAmt:0]||0).replace(/[^0-9.\-]/g,''))||0;
        var dueDate=null, overdueDays=null;
        if (iDue>=0 && data[r][iDue]) {
          var rawDue=data[r][iDue];
          var dueDt=(rawDue instanceof Date)?rawDue:new Date(rawDue);
          if (!isNaN(dueDt.getTime())) {
            dueDt.setHours(0,0,0,0);
            dueDate     = dueDt.toISOString().slice(0,10);
            overdueDays = Math.floor((today-dueDt)/86400000);
          }
        }
        bills.push({ invoiceNo:invoiceNo, amount:amount, dueDate:dueDate, overdueDays:overdueDays, source:'main' });
      }
    }

    bills.sort(function(a,b){
      if(!a.dueDate&&!b.dueDate)return 0;
      if(!a.dueDate)return 1;
      if(!b.dueDate)return -1;
      return new Date(a.dueDate)-new Date(b.dueDate);
    });

    // ── ค้นจาก sheet Pay (บิลหน้าร้าน) ─────────────────────────────
    var storeInvSet = [];
    try {
      var STORE_SS_ID = '1ADwKdbF8Eo1ZuTXRRKUdgD-9NXvbphuA49PvB5sWGeY';
      var storeSs = SpreadsheetApp.openById(STORE_SS_ID);
      var storeSh = storeSs.getSheetByName('Pay');
      if (storeSh) {
        var sData = storeSh.getDataRange().getValues();
        var sh    = sData[0];

        // defaults จาก log ที่รู้แล้ว
        var sCust=1, sInv=2, sRemain=5, sShop=-1, sDue=9;
        for (var hi=0; hi<sh.length; hi++) {
          var hName = String(sh[hi]).trim();
          if (hName==='รหัสลูกค้า')                                    sCust=hi;
          if (hName==='เลขที่บิล'||hName==='DocNo'||hName==='InvoiceNo') sInv=hi;
          if (hName==='ยอดคงเหลือ'||hName==='คงเหลือ')                sRemain=hi;
          if (hName==='ลูกค้า'||hName==='ชื่อลูกค้า'||hName==='CustomerName') sShop=hi;
          if (hName==='ถึงกำหนดชำระ'||hName==='DueDate'||hName==='วันครบกำหนด') sDue=hi;
        }

        for (var sr=1; sr<sData.length; sr++) {
          var rowCust = String(sData[sr][sCust]||'').trim();
          if (rowCust !== customerCode) continue;

          if (!shopName && sShop>=0) shopName = String(sData[sr][sShop]||'').trim();

          var rowInv = String(sData[sr][sInv]||'').trim();
          if (!rowInv) continue;

          var rowRemain = parseFloat(String(sData[sr][sRemain]||0).replace(/[^0-9.\-]/g,''))||0;

          // เก็บ storeInvSet เสมอ (ไม่ว่า remain จะ 0 หรือไม่)
          var lower = rowInv.toLowerCase();
          if (storeInvSet.indexOf(lower)<0) storeInvSet.push(lower);
          var parts = rowInv.split('-');
          if (parts.length>1) {
            var suffix = parts[parts.length-1].toLowerCase();
            if (storeInvSet.indexOf(suffix)<0) storeInvSet.push(suffix);
          }

          // push เข้า bills เฉพาะ remain > 0 และยังไม่มีใน bills
          if (rowRemain > 0) {
            var normInv    = lower;
            var alreadyIn  = false;
            for (var bi=0; bi<bills.length; bi++) {
              var bNorm   = bills[bi].invoiceNo.toLowerCase();
              var bSuffix = bNorm.split('-').pop();
              var rSuffix = normInv.split('-').pop();
              if (bNorm === normInv || (rSuffix.length>=4 && bSuffix===rSuffix)) {
                alreadyIn = true;
                break;
              }
            }
            if (!alreadyIn) {
              var rowDueDate=null, rowOverdue=null;
              if (sDue>=0 && sData[sr][sDue]) {
                var rd  = sData[sr][sDue];
                var rdt = (rd instanceof Date)?rd:new Date(rd);
                if (!isNaN(rdt.getTime())) {
                  rdt.setHours(0,0,0,0);
                  rowDueDate = rdt.toISOString().slice(0,10);
                  rowOverdue = Math.floor((today-rdt)/86400000);
                }
              }
              bills.push({
                invoiceNo   : rowInv,
                amount      : rowRemain,
                dueDate     : rowDueDate,
                overdueDays : rowOverdue,
                source      : 'store'
              });
            }
          }
        } // end Pay loop

        console.log('[storeInvSet for '+customerCode+'] '+JSON.stringify(storeInvSet));
        console.log('[bills total] '+bills.length+' (after merge Pay)');
      }
    } catch(storeErr) {
      console.log('[store lookup] '+storeErr.message);
    }

    return { ok:true, bills:bills, shopName:shopName, storeInvSet:storeInvSet };

  } catch(err) {
    console.log('[getBillsForCustomerCode] '+err.message);
    return { ok:false, error:err.message };
  }
}

// ─── getDsrWeekSlipsWithPendingRows v17 ──────────────────────────────
// รวม PENDING_SLIPS เข้ากับ SLIPS ปกติ
// note ของ pending ไม่ใส่ "Ref: ..." ยาวๆ

function getDsrWeekSlipsWithPendingRows(email, monISO, sunISO) {
  try {
    var base = getDsrWeekSlipsWithRange(email, monISO, sunISO);
    var slipSsId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID_SLIP');
    if (!slipSsId) return base;

    var ss    = SpreadsheetApp.openById(slipSsId);
    var sheet = ss.getSheetByName('PENDING_SLIPS');
    if (!sheet) return base;

    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return base;

    var h = data[0];
    function pCol(names){for(var ni=0;ni<names.length;ni++){var n=names[ni].toLowerCase();for(var hi=0;hi<h.length;hi++){if(String(h[hi]).trim().toLowerCase().indexOf(n)>=0)return hi;}}return -1;}

    var iDate  = pCol(['transfer_date','created_at']);
    var iAmt   = pCol(['amount']);
    var iSender= pCol(['sender_name']);
    var iBank  = pCol(['bank']);
    var iRef   = pCol(['ref1']);
    var iCust  = pCol(['cust_code']);    // ← จาก column ใหม่
    var iInv   = pCol(['invoice_no']);   // ← จาก column ใหม่
    var iShop  = pCol(['sender_name']); // fallback ใช้ชื่อผู้โอน
    var iXDate = pCol(['transfer_date']);
    var iEmail = -1; // ไม่มีใน PENDING_SLIPS

    var mon = new Date(monISO), sun = new Date(sunISO);
    var pendingRows = [];

    for (var r=1;r<data.length;r++) {
      var rowDate = iDate>=0 ? new Date(data[r][iDate]) : null;
      if (!rowDate||isNaN(rowDate)) continue;
      if (rowDate<mon||rowDate>sun) continue;

      // ใหม่ — ขึ้นทุก pending ในช่วงวันที่ ไม่ filter email
      // (Admin เห็นทั้งทีม, DSR เห็นของตัวเอง — handle ฝั่ง frontend)
      // ลบ block filter email ทิ้ง หรือเปลี่ยนเป็น:
      if (iEmail>=0 && email && !email.includes('admin')) {
        var rowEmail=String(data[r][iEmail]||'').trim().toLowerCase();
        if (rowEmail && rowEmail !== email.toLowerCase()) continue;
      }
      // ไม่ filter status เลย — admin จะได้เห็นและแก้ไขได้  

      var amt   = iAmt>=0   ? parseFloat(String(data[r][iAmt]||0).replace(/[^0-9.\-]/g,''))||0   : 0;
      var inv   = iInv>=0   ? String(data[r][iInv]||'').trim()   : '';
      var cust  = iCust>=0  ? String(data[r][iCust]||'').trim()  : '';
      var shop  = iShop>=0  ? String(data[r][iShop]||'').trim()  : '';
      var xdate = iXDate>=0 ? data[r][iXDate] : null;

      pendingRows.push({
        _row        : 900000 + r,
        _isPending  : true,
        'วันที่ส่งสลิป': rowDate.toISOString(),
        'ยอดเงิน'   : iAmt>=0 ? parseFloat(String(data[r][iAmt]||0).replace(/[^0-9.\-]/g,''))||0 : 0,
        'เลขที่บิล'  : iInv>=0  ? String(data[r][iInv]||'').trim()  : '',
        'ชื่อร้าน'   : iSender>=0 ? String(data[r][iSender]||'').trim() : '',
        'รหัสลูกค้า' : iCust>=0 ? String(data[r][iCust]||'').trim() : '',
        'วันที่โอน'  : rowDate.toISOString(),
        'สถานะ'     : 'รอระบุ',
        'note'      : (iRef>=0 ? String(data[r][iRef]||'').trim() : '')
                    + (iBank>=0 ? ' ' + String(data[r][iBank]||'').trim() : ''),
      });
    }

    base.pendingRows = pendingRows;
    return base;

  } catch(err) {
    console.log('[getPendingRows] '+err.message);
    return getDsrWeekSlipsWithRange(email, monISO, sunISO);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  SECTION 22 │ SETTLEMENT INCOME / EXPENSES  (Module F)
// ─────────────────────────────────────────────────────────────────────

// ─── getMileageSummary ────────────────────────────────────────────────
// คืนรายการไมล์รายวัน Mon–Sat พร้อมค่าเสื่อมรถ
function getMileageSummary(weekStart, dsrEmail) {
  console.log('[getMileageSummary] weekStart=%s dsrEmail=%s', weekStart, dsrEmail);
  var thaiDay = ['อา','จ','อ','พ','พฤ','ศ','ส'];

  var start = new Date(weekStart + 'T00:00:00');
  var end   = new Date(weekStart + 'T00:00:00');
  end.setDate(end.getDate() + 5); // Mon–Sat

  function isoStr(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }
  function inRange(dateStr) {
    if (!dateStr) return false;
    var d = new Date(String(dateStr).split('T')[0] + 'T00:00:00');
    return d >= start && d <= end;
  }

  // อ่าน MILEAGE_LOG
  var mileRows = sheetToObjects(SH.MILEAGE).filter(function(r) {
    return r.dsr_id === dsrEmail && inRange(r.log_date);
  });
  console.log('[getMileageSummary] LOAD mileage: ' + mileRows.length + ' rows');

  // อ่าน depreciation_rate จาก USERS
  var userRow = sheetToObjects(SH.USERS).find(function(r){ return r.email === dsrEmail; }) || {};
  var deprRate = parseFloat(userRow.depreciation_rate);
  if (isNaN(deprRate)) deprRate = 2.5; // ค่าเริ่มต้น
  console.log('[getMileageSummary] DEPRECIATION rate: ' + deprRate + ' for ' + dsrEmail);

  // อ่าน VEHICLES เพื่อรู้ vehicle_type
  var vehicleMap = {};
  sheetToObjects(SH.VEHICLES).forEach(function(v) {
    vehicleMap[v.vehicle_id] = v;
  });

  // รวมระยะทางต่อวัน (morning + evening)
  var byDate = {};
  mileRows.forEach(function(r) {
    var dt = String(r.log_date).split('T')[0];
    if (!byDate[dt]) byDate[dt] = { distance: 0, zone: '', vehicleId: r.vehicle_id };
    byDate[dt].distance  += parseFloat(r.distance_km) || 0;
    byDate[dt].zone       = r.zone || r.province || byDate[dt].zone;
    byDate[dt].vehicleId  = r.vehicle_id || byDate[dt].vehicleId;
  });

  var result = Object.keys(byDate).sort().map(function(date) {
    var row     = byDate[date];
    var vehicle = vehicleMap[row.vehicleId] || {};
    // vehicle_type: 'company' ค่าเสื่อม 0, 'personal' ค่าเสื่อม = distance * deprRate
    var vType   = (vehicle.vehicle_type || vehicle.type || 'company').toLowerCase();
    var isPersonal = vType === 'personal' || vType === 'own';
    var depreciation = isPersonal ? r2(row.distance * deprRate) : 0;
    var d = new Date(date + 'T00:00:00');
    return {
      date:        date,
      dateLabel:   thaiDay[d.getDay()] + '. ' + d.getDate(),
      zone:        row.zone,
      distance:    r2(row.distance),
      vehicleId:   row.vehicleId,
      vehicleType: isPersonal ? 'personal' : 'company',
      depreciation: depreciation,
    };
  });

  return result;
}

// ─── Date normalization helper ────────────────────────────────────────
function normDateStr(val) {
  if (!val && val !== 0) return '';
  var s = String(val);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.split('T')[0];
  try {
    var d = new Date(s);
    if (!isNaN(d.getTime())) return Utilities.formatDate(d, 'Asia/Bangkok', 'yyyy-MM-dd');
  } catch(_) {}
  return s;
}
function normalizeDateFields(rows, fields) {
  if (!rows || !rows.length) return rows;
  return rows.map(function(r) {
    var out = {};
    Object.keys(r).forEach(function(k) { out[k] = r[k]; });
    fields.forEach(function(f) { if (f in out) out[f] = normDateStr(out[f]); });
    return out;
  });
}

// ─── saveCashChequeBatch ──────────────────────────────────────────────
function saveCashChequeBatch(rows, user) {
  console.log('[saveCashChequeBatch] count=%s user=%s', (rows||[]).length, user.email);
  rows = rows || [];
  var saved = 0, skipped = 0;
  rows.forEach(function(r) {
    if (!r.amount || parseFloat(r.amount) <= 0) { skipped++; return; }
    if (!r.invoice_no && !r.customer_code)       { skipped++; return; }
    try {
      if (r.type === 'cheque') { saveCheque(r, user); }
      else                     { saveCash(r, user); }
      saved++;
    } catch(e) { skipped++; console.error('[saveCashChequeBatch] skip: ' + e.message); }
  });
  return { saved: saved, skipped: skipped };
}

// ─── getWeeklySlipTotal ───────────────────────────────────────────────
function getWeeklySlipTotal(weekStart, dsrEmail) {
  console.log('[getWeeklySlipTotal] weekStart=%s dsrEmail=%s', weekStart, dsrEmail);
  try {
    var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID_SLIP'));
    var sheet = ss.getSheetByName(SH.SLIPS);
    if (!sheet) return { total: 0, count: 0 };
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { total: 0, count: 0 };
    var h = data[0];
    function col(names) {
      for (var ni = 0; ni < names.length; ni++)
        for (var hi = 0; hi < h.length; hi++)
          if (String(h[hi]).trim().toLowerCase() === names[ni].toLowerCase()) return hi;
      return -1;
    }
    var eIdx   = col(['email','dsr_email','dsr email']);
    var dIdx   = col(['วันที่โอน','วันที่ส่งสลิป','created_at']);
    var stIdx  = col(['สถานะ','status']);
    var amtIdx = col(['ยอดเงิน','amount']);
    if (eIdx < 0 || amtIdx < 0) return { total: 0, count: 0 };
    var start = new Date(weekStart + 'T00:00:00');
    var end   = new Date(weekStart + 'T00:00:00');
    end.setDate(end.getDate() + 5);
    var total = 0, count = 0;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][eIdx]||'').trim().toLowerCase() !== dsrEmail.toLowerCase()) continue;
      var st = stIdx >= 0 ? String(data[i][stIdx]||'').toLowerCase() : '';
      if (st !== 'matched' && st !== 'confirmed' && st !== 'จับคู่แล้ว') continue;
      if (dIdx >= 0 && data[i][dIdx]) {
        var dt = data[i][dIdx] instanceof Date ? data[i][dIdx] : new Date(data[i][dIdx]);
        if (!isNaN(dt.getTime())) {
          var dtBKK = new Date(dt.toLocaleString('en-US',{timeZone:'Asia/Bangkok'}));
          dtBKK.setHours(0,0,0,0);
          if (dtBKK < start || dtBKK > end) continue;
        }
      }
      total += parseFloat(data[i][amtIdx]) || 0;
      count++;
    }
    return { total: r2(total), count: count };
  } catch(err) {
    console.error('[getWeeklySlipTotal] err: ' + err.message);
    return { total: 0, count: 0 };
  }
}

// ─── getDsrWeekSlipsForWeek ───────────────────────────────────────────
function getDsrWeekSlipsForWeek(weekStart, dsrEmail) {
  console.log('[getDsrWeekSlipsForWeek] weekStart=%s dsrEmail=%s', weekStart, dsrEmail);
  try {
    var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID_SLIP'));
    var sheet = ss.getSheetByName(SH.SLIPS);
    if (!sheet) return { rows: [], total: 0, count: 0 };
    var data = sheet.getDataRange().getValues();
    if (data.length < 2) return { rows: [], total: 0, count: 0 };
    var h = data[0];
    function col(names) {
      for (var ni = 0; ni < names.length; ni++)
        for (var hi = 0; hi < h.length; hi++)
          if (String(h[hi]).trim().toLowerCase() === names[ni].toLowerCase()) return hi;
      return -1;
    }
    var eIdx   = col(['email','dsr_email','dsr email']);
    var dIdx   = col(['วันที่โอน','วันที่ส่งสลิป','created_at']);
    var stIdx  = col(['สถานะ','status']);
    var amtIdx = col(['ยอดเงิน','amount']);
    var billIdx = col(['เลขบิล','invoice_no','bill_no']);
    var senderIdx = col(['ชื่อผู้โอน','sender','ผู้โอน']);
    if (eIdx < 0) return { rows: [], total: 0, count: 0 };
    var start = new Date(weekStart + 'T00:00:00');
    var end   = new Date(weekStart + 'T00:00:00');
    end.setDate(end.getDate() + 5);
    var rows = [], total = 0;
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][eIdx]||'').trim().toLowerCase() !== dsrEmail.toLowerCase()) continue;
      var dateVal = dIdx >= 0 ? data[i][dIdx] : null;
      var dateStr = '';
      if (dateVal) {
        var dt = dateVal instanceof Date ? dateVal : new Date(dateVal);
        if (!isNaN(dt.getTime())) {
          var dtBKK = new Date(dt.toLocaleString('en-US',{timeZone:'Asia/Bangkok'}));
          dtBKK.setHours(0,0,0,0);
          if (dtBKK < start || dtBKK > end) continue;
          dateStr = Utilities.formatDate(dtBKK, 'Asia/Bangkok', 'yyyy-MM-dd');
        }
      }
      var amt = amtIdx >= 0 ? parseFloat(data[i][amtIdx]) || 0 : 0;
      total += amt;
      rows.push({
        _row:     i + 1,
        date:     dateStr,
        amount:   r2(amt),
        status:   stIdx  >= 0 ? String(data[i][stIdx]  || '') : '',
        bill_no:  billIdx >= 0 ? String(data[i][billIdx] || '') : '',
        sender:   senderIdx >= 0 ? String(data[i][senderIdx] || '') : '',
      });
    }
    rows.sort(function(a, b) { return (a.date || '').localeCompare(b.date || ''); });
    return { rows: rows, total: r2(total), count: rows.length };
  } catch(err) {
    console.error('[getDsrWeekSlipsForWeek] err: ' + err.message);
    return { rows: [], total: 0, count: 0 };
  }
}

// ─── updateSlipBillMapping ────────────────────────────────────────────
function updateSlipBillMapping(slipRowIndex, newBillNo, dsrEmail) {
  console.log('[updateSlipBillMapping] row=%s bill=%s dsr=%s', slipRowIndex, newBillNo, dsrEmail);
  var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID_SLIP'));
  var sheet = ss.getSheetByName(SH.SLIPS);
  if (!sheet) throw new Error('ไม่พบ Sheet: ' + SH.SLIPS);
  var h = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  function col1(names) {
    for (var ni = 0; ni < names.length; ni++)
      for (var hi = 0; hi < h.length; hi++)
        if (String(h[hi]).trim().toLowerCase() === names[ni].toLowerCase()) return hi + 1;
    return -1;
  }
  var billCol  = col1(['เลขบิล','invoice_no','bill_no']);
  var stCol    = col1(['สถานะ','status']);
  var updByCol = col1(['updated_by','updatedby']);
  var updAtCol = col1(['updated_at','updatedat']);
  if (billCol  > 0) sheet.getRange(slipRowIndex, billCol).setValue(newBillNo);
  if (stCol    > 0) sheet.getRange(slipRowIndex, stCol).setValue('matched');
  if (updByCol > 0) sheet.getRange(slipRowIndex, updByCol).setValue(dsrEmail);
  if (updAtCol > 0) sheet.getRange(slipRowIndex, updAtCol).setValue(new Date());
  return { ok: true };
}

function getSettlementIncome(weekStart, dsrEmail) {
  console.log('[getSettlementIncome] weekStart=%s dsrEmail=%s', weekStart, dsrEmail);

  // ใช้ week_number filter แทน date range
  // เพราะ rowToObj แปลง Date object เป็น locale string ทำให้ date range parse ผิด
  var targetWeekNum = weekNum(new Date(weekStart + 'T00:00:00'));
  console.log('[getSettlementIncome] targetWeekNum=%s', targetWeekNum);

  var thaiDay = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];

  var cashRows   = sheetToObjects('CASH_LOG');
  var chequeRows = sheetToObjects('CHEQUE_LOG');
  console.log('[getSettlementIncome] cashRows.total=%s chequeRows.total=%s', cashRows.length, chequeRows.length);

  var byDate = {};

  cashRows.forEach(function(r) {
    if (r.dsr_email !== dsrEmail) return;
    if (Number(r.week_number) !== targetWeekNum) return;
    var dt = normDateStr(r.log_date);
    if (!dt) return;
    if (!byDate[dt]) byDate[dt] = { cashAmount: 0, chequeAmount: 0, billCount: 0 };
    byDate[dt].cashAmount += parseFloat(r.amount) || 0;
    byDate[dt].billCount++;
  });

  chequeRows.forEach(function(r) {
    if (r.dsr_email !== dsrEmail) return;
    if (Number(r.week_number) !== targetWeekNum) return;
    var dt = normDateStr(r.log_date);
    if (!dt) return;
    if (!byDate[dt]) byDate[dt] = { cashAmount: 0, chequeAmount: 0, billCount: 0 };
    byDate[dt].chequeAmount += parseFloat(r.amount) || 0;
    byDate[dt].billCount++;
  });

  var matchedCash   = cashRows.filter(function(r){ return r.dsr_email === dsrEmail; }).length;
  var matchedWeek   = cashRows.filter(function(r){ return r.dsr_email === dsrEmail && Number(r.week_number) === targetWeekNum; }).length;
  console.log('[getSettlementIncome] cashRows for this dsr=%s, for this week=%s, byDate keys=%s', matchedCash, matchedWeek, Object.keys(byDate).length);

  var result = Object.keys(byDate).sort().map(function(date) {
    var d = new Date(date + 'T00:00:00');
    return {
      date:         date,
      dateLabel:    thaiDay[d.getDay()] + '. ' + d.getDate(),
      cashAmount:   r2(byDate[date].cashAmount),
      chequeAmount: r2(byDate[date].chequeAmount),
      billCount:    byDate[date].billCount,
    };
  });

  return result;
}

function ensureSettlementExpensesSheet() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  if (!ss.getSheetByName(SH.SETTLE_EXP)) {
    var sh = ss.insertSheet(SH.SETTLE_EXP);
    sh.appendRow(['dsrEmail', 'weekStart', 'date', 'fuel', 'hotel', 'allowance']);
    sh.setFrozenRows(1);
    console.log('[ensureSettlementExpensesSheet] created SettlementExpenses sheet');
  }
}

function getSettlementExpenses(weekStart, dsrEmail) {
  console.log('[getSettlementExpenses] weekStart=%s dsrEmail=%s', weekStart, dsrEmail);
  ensureSettlementExpensesSheet();
  var rows = sheetToObjects(SH.SETTLE_EXP);
  var result = rows
    .filter(function(r) { return r.dsrEmail === dsrEmail && r.weekStart === weekStart; })
    .map(function(r) {
      return {
        date:      r.date,
        fuel:      parseFloat(r.fuel)      || 0,
        hotel:     parseFloat(r.hotel)     || 0,
        allowance: parseFloat(r.allowance) || 0,
      };
    });
  return result;
}

function saveSettlementExpenses(data, user) {
  if (!data || !data.weekStart || !data.expenses) throw new Error('weekStart and expenses required');
  var targetEmail = (user.role === ROLES.DSR) ? user.email : (data.dsrEmail || user.email);
  console.log('[saveSettlementExpenses] weekStart=%s dsr=%s', data.weekStart, targetEmail);

  ensureSettlementExpensesSheet();

  var ss    = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  var sheet = ss.getSheetByName(SH.SETTLE_EXP);
  var vals  = sheet.getDataRange().getValues();

  // Upsert: ลบแถวเดิมของ dsrEmail+weekStart ก่อน (loop จากล่างขึ้นบน)
  if (vals.length > 1) {
    for (var i = vals.length - 1; i >= 1; i--) {
      if (String(vals[i][0]) === targetEmail && String(vals[i][1]) === data.weekStart) {
        sheet.deleteRow(i + 1);
      }
    }
  }

  var inserted = 0;
  data.expenses.forEach(function(ex) {
    var fuel  = parseFloat(ex.fuel)  || 0;
    var hotel = parseFloat(ex.hotel) || 0;
    if (fuel === 0 && hotel === 0) return; // skip empty rows
    var allowance = hotel > 0 ? 200 : 0;
    sheet.appendRow([targetEmail, data.weekStart, ex.date, fuel, hotel, allowance]);
    inserted++;
  });

  return { saved: inserted };
}

function generateSettlementPDF(payload) {
  console.log('[generateSettlementPDF] dsr=%s weekStart=%s', payload.dsrEmail, payload.weekStart);
  var logoHtml  = getLogoBase64Html();
  var dsrName   = escapeHtmlSrv(payload.dsrName || payload.dsrEmail);
  var incRows   = payload.incomeRows  || [];
  var expRows   = payload.expenseRows || [];
  var mileRows  = payload.mileageRows || [];

  var thaiMonths = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
  function fmtDateTh(iso) {
    if (!iso) return '';
    var d = new Date(iso + 'T00:00:00');
    return d.getDate() + ' ' + thaiMonths[d.getMonth()] + ' ' + (d.getFullYear() + 543);
  }
  function fmtMon(n) {
    var v = parseFloat(n) || 0;
    return v ? v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : '—';
  }
  function fmtMonAlways(n) {
    var v = parseFloat(n) || 0;
    return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
  }

  var printDate = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');
  var weekRange = fmtDateTh(payload.weekStart) + ' – ' + fmtDateTh(payload.weekEnd);

  // Income table
  var totalCash = 0, totalCheque = 0;
  var incHtml = incRows.map(function(r) {
    var tot = (parseFloat(r.cashAmount)||0) + (parseFloat(r.chequeAmount)||0);
    totalCash   += parseFloat(r.cashAmount)   || 0;
    totalCheque += parseFloat(r.chequeAmount) || 0;
    return '<tr>' +
      '<td>' + escapeHtmlSrv(r.dateLabel || r.date) + '</td>' +
      '<td class="r">' + fmtMon(r.cashAmount)   + '</td>' +
      '<td class="r">' + fmtMon(r.chequeAmount)  + '</td>' +
      '<td class="r b">' + fmtMonAlways(tot)     + '</td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="4" class="empty">ไม่มีข้อมูล</td></tr>';
  var totalInc = totalCash + totalCheque;

  var incFoot = '<tr><td class="b">รวม</td>' +
    '<td class="r b">' + fmtMonAlways(totalCash)   + '</td>' +
    '<td class="r b">' + fmtMonAlways(totalCheque) + '</td>' +
    '<td class="r b">' + fmtMonAlways(totalInc)    + '</td></tr>';

  // Expense table
  var totFuel = 0, totHotel = 0, totAllow = 0;
  var expHtml = expRows.map(function(r) {
    var hotel = parseFloat(r.hotel)     || 0;
    var fuel  = parseFloat(r.fuel)      || 0;
    var allow = parseFloat(r.allowance) || 0;
    totFuel  += fuel;
    totHotel += hotel;
    totAllow += allow;
    var hotelStyle = hotel > 500 ? ' style="background:#FFF3E0"' : '';
    return '<tr>' +
      '<td>' + escapeHtmlSrv(r.dateLabel || r.date) + '</td>' +
      '<td class="r">' + fmtMon(fuel) + '</td>' +
      '<td class="r"' + hotelStyle + '>' + fmtMon(hotel) + '</td>' +
      '<td class="r">' + fmtMon(allow) + '</td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="4" class="empty">ไม่มีค่าใช้จ่าย</td></tr>';

  var expFoot = '<tr><td class="b">รวม</td>' +
    '<td class="r b">' + fmtMonAlways(totFuel)  + '</td>' +
    '<td class="r b">' + fmtMonAlways(totHotel) + '</td>' +
    '<td class="r b">' + fmtMonAlways(totAllow) + '</td></tr>';

  // Travel / Mileage table
  var totDist = 0, totDepr = 0;
  var mileHtml = mileRows.map(function(r) {
    var dist = parseFloat(r.distance)    || 0;
    var depr = parseFloat(r.depreciation)|| 0;
    totDist += dist;
    totDepr += depr;
    return '<tr>' +
      '<td>' + escapeHtmlSrv(r.dateLabel || r.date) + '</td>' +
      '<td>' + escapeHtmlSrv(r.zone || '—') + '</td>' +
      '<td class="r">' + fmtMonAlways(dist) + '</td>' +
      '<td>' + (r.vehicleType === 'personal' ? 'รถส่วนตัว' : 'รถบริษัท') + '</td>' +
      '<td class="r">' + fmtMon(depr) + '</td>' +
      '</tr>';
  }).join('') || '<tr><td colspan="5" class="empty">ไม่มีข้อมูลไมล์</td></tr>';
  var mileFoot = '<tr><td colspan="2" class="b">รวม</td>' +
    '<td class="r b">' + fmtMonAlways(totDist) + ' กม.</td>' +
    '<td></td>' +
    '<td class="r b">' + fmtMonAlways(totDepr) + '</td></tr>';

  var slipTotal = parseFloat((payload.slipTotal || {}).total) || 0;
  var chequeTotal = 0;
  incRows.forEach(function(r){ chequeTotal += parseFloat(r.chequeAmount)||0; });
  var cashOnlyTotal = totalInc - chequeTotal;
  var netRemit  = cashOnlyTotal + slipTotal - totFuel - totHotel - totAllow - totDepr;
  var netClass  = netRemit >= 0 ? 'pos' : 'neg';

  var css = [
    '* { box-sizing: border-box; margin: 0; padding: 0; }',
    '@page { size: A4 landscape; margin: 12mm 15mm; }',
    'body { font-family: "Sarabun", Tahoma, sans-serif; font-size: 12px; color: #1A1A1A; }',
    '@media screen {',
    '  body { background: #f0f0f0; display: flex; flex-direction: column; align-items: center; padding: 24px; }',
    '  .page-wrap { background: #fff; padding: 12mm 15mm; width: 297mm; min-height: 210mm; box-shadow: 0 4px 24px rgba(0,0,0,.15); }',
    '  .print-btn { position: fixed; top: 16px; right: 16px; background: #007B40; color: #fff; border: none; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 700; cursor: pointer; font-family: inherit; box-shadow: 0 2px 8px rgba(0,0,0,.2); }',
    '  .print-btn:active { transform: scale(.97); }',
    '}',
    '@media print {',
    '  body { background: none; padding: 0; }',
    '  .page-wrap { box-shadow: none; padding: 0; width: 100%; }',
    '  .print-btn { display: none; }',
    '}',
    '.hdr { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #1A1A1A; padding-bottom: 8px; margin-bottom: 12px; gap: 12px; }',
    '.hdr-left { display: flex; align-items: center; gap: 10px; min-width: 140px; }',
    '.hdr-title { font-size: 15px; font-weight: 700; }',
    '.hdr-sub { font-size: 11px; color: #666; }',
    '.hdr-center { text-align: center; flex: 1; }',
    '.hdr-dsr { font-size: 15px; font-weight: 600; }',
    '.hdr-range { font-size: 12px; color: #555; margin-top: 2px; }',
    '.hdr-right { text-align: right; font-size: 11px; color: #666; min-width: 120px; }',
    /* ── landscape: 3 tables side-by-side ── */
    '.tables-row { display: grid; grid-template-columns: 2fr 2fr 1.5fr; gap: 12px; margin-bottom: 12px; }',
    '.table-col h3 { font-size: 12px; font-weight: 700; margin: 0 0 5px; border-left: 4px solid #E8631A; padding-left: 7px; }',
    'table { width: 100%; border-collapse: collapse; }',
    'th { font-size: 10px; font-weight: 700; border: 1px solid #555; padding: 3px 5px; text-align: center; background: #f0f0f0; }',
    'th:first-child { text-align: left; }',
    'td { border: 1px solid #ccc; padding: 3px 6px; font-size: 11px; }',
    'tfoot td { font-weight: 700; background: #f8f8f8; border: 1px solid #555; }',
    '.r { text-align: right; }',
    '.b { font-weight: 700; }',
    '.empty { text-align: center; color: #999; font-style: italic; padding: 10px; }',
    /* ── 2-column summary box ── */
    '.summary-box { border: 2px solid #1A1A1A; border-radius: 8px; padding: 12px 16px; display: grid; grid-template-columns: 1fr 1fr; gap: 0 28px; }',
    '.sum-col-label { font-size: 11px; font-weight: 700; color: #666; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 6px; border-bottom: 1px solid #ddd; padding-bottom: 4px; }',
    '.sum-row { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; font-size: 12px; }',
    '.sum-row.deduct { color: #444; }',
    '.sum-divider { border-top: 2px solid #1A1A1A; margin: 6px 0; }',
    '.net-row { display: flex; justify-content: space-between; align-items: baseline; padding-top: 4px; }',
    '.net-label { font-size: 13px; font-weight: 700; }',
    '.net-amount { font-size: 28px; font-weight: 700; line-height: 1; }',
    '.pos { color: #007B40; }',
    '.neg { color: #C8102E; }',
    '.net-col { display: flex; flex-direction: column; justify-content: space-between; }',
    /* ── signatures bottom-right ── */
    '.sig-row { display: flex; justify-content: flex-end; gap: 40px; margin-top: 16px; }',
    '.sig-box { text-align: center; min-width: 160px; }',
    '.sig-line { border-top: 1px solid #555; margin-top: 40px; padding-top: 5px; font-size: 11px; font-weight: 600; }',
  ].join('\n');

  return '<!DOCTYPE html><html lang="th"><head>' +
    '<meta charset="UTF-8">' +
    '<link rel="preconnect" href="https://fonts.googleapis.com">' +
    '<link href="https://fonts.googleapis.com/css2?family=Sarabun:wght@300;400;500;600;700&display=swap" rel="stylesheet">' +
    '<title>ใบสรุปยอดนำส่ง — ' + dsrName + '</title>' +
    '<style>' + css + '</style>' +
    '</head><body>' +
    '<button class="print-btn" onclick="window.print()">🖨️ พิมพ์ / บันทึก PDF</button>' +
    '<div class="page-wrap">' +

    '<div class="hdr">' +
      '<div class="hdr-left">' + logoHtml + '<div><div class="hdr-title">ใบสรุปยอดนำส่ง</div><div class="hdr-sub">Nice Center Oil</div></div></div>' +
      '<div class="hdr-center"><div class="hdr-dsr">' + dsrName + '</div><div class="hdr-range">' + escapeHtmlSrv(weekRange) + '</div></div>' +
      '<div class="hdr-right">วันที่พิมพ์<br><b>' + printDate + '</b></div>' +
    '</div>' +

    /* ── 3 tables in one row (landscape) ── */
    '<div class="tables-row">' +

      '<div class="table-col">' +
        '<h3>A. ยอดเก็บเงิน</h3>' +
        '<table><thead><tr><th>วันที่</th><th>เงินสด (฿)</th><th>เช็ค (฿)</th><th>รวม (฿)</th></tr></thead>' +
        '<tbody>' + incHtml + '</tbody><tfoot>' + incFoot + '</tfoot></table>' +
      '</div>' +

      '<div class="table-col">' +
        '<h3>B. ค่าใช้จ่าย</h3>' +
        '<table><thead><tr><th>วันที่</th><th>น้ำมัน (฿)</th><th>ที่พัก (฿)</th><th>เบี้ยเลี้ยง (฿)</th></tr></thead>' +
        '<tbody>' + expHtml + '</tbody><tfoot>' + expFoot + '</tfoot></table>' +
      '</div>' +

      '<div class="table-col">' +
        '<h3>C. การเดินทาง</h3>' +
        '<table><thead><tr><th>วันที่</th><th>เขต</th><th class="r">กม.</th><th class="r">เสื่อม (฿)</th></tr></thead>' +
        '<tbody>' + mileRows.map(function(r){
          var dist = parseFloat(r.distance)||0;
          var depr = parseFloat(r.depreciation)||0;
          return '<tr>' +
            '<td>' + escapeHtmlSrv(r.dateLabel||r.date) + '</td>' +
            '<td>' + escapeHtmlSrv(r.zone||'—') + '</td>' +
            '<td class="r">' + fmtMonAlways(dist) + '</td>' +
            '<td class="r">' + fmtMon(depr) + '</td>' +
            '</tr>';
        }).join('') || '<tr><td colspan="4" class="empty">ไม่มีข้อมูล</td></tr>' + '</tbody>' +
        '<tfoot><tr><td colspan="2" class="b">รวม</td><td class="r b">' + fmtMonAlways(totDist) + '</td><td class="r b">' + fmtMonAlways(totDepr) + '</td></tr></tfoot></table>' +
      '</div>' +

    '</div>' +

    /* ── 2-column summary box ── */
    '<div class="summary-box">' +
      /* left col: breakdown */
      '<div>' +
        '<div class="sum-col-label">รายละเอียด</div>' +
        '<div class="sum-row"><span>รวมเงินสด</span><span>' + fmtMonAlways(cashOnlyTotal) + ' ฿</span></div>' +
        (slipTotal ? '<div class="sum-row"><span>รวมเงินโอน Slip2Go</span><span>' + fmtMonAlways(slipTotal) + ' ฿</span></div>' : '') +
        '<div class="sum-divider"></div>' +
        '<div class="sum-row deduct"><span>หัก น้ำมัน/แก๊ส</span><span>− ' + fmtMonAlways(totFuel) + ' ฿</span></div>' +
        '<div class="sum-row deduct"><span>หัก ค่าที่พัก</span><span>− ' + fmtMonAlways(totHotel) + ' ฿</span></div>' +
        '<div class="sum-row deduct"><span>หัก เบี้ยเลี้ยง</span><span>− ' + fmtMonAlways(totAllow) + ' ฿</span></div>' +
        '<div class="sum-row deduct"><span>หัก ค่าเสื่อมรถ</span><span>− ' + fmtMonAlways(totDepr) + ' ฿</span></div>' +
        (chequeTotal ? '<div class="sum-row" style="margin-top:6px;color:#666;font-size:11px;"><span>รวมเช็ค (ส่งแยก)</span><span>' + fmtMonAlways(chequeTotal) + ' ฿</span></div>' : '') +
      '</div>' +
      /* right col: net + signatures */
      '<div class="net-col">' +
        '<div>' +
          '<div class="sum-col-label">ยอดนำส่งสุทธิ</div>' +
          '<div class="net-row"><span class="net-amount ' + netClass + '">' + fmtMonAlways(netRemit) + ' ฿</span></div>' +
        '</div>' +
        '<div class="sig-row">' +
          '<div class="sig-box"><div class="sig-line">ผู้ส่ง (DSR) · ' + dsrName + '</div></div>' +
          '<div class="sig-box"><div class="sig-line">ผู้รับ (ออฟฟิศ)</div></div>' +
        '</div>' +
      '</div>' +
    '</div>' +

    '</div>' +
    '<script>window.addEventListener("load",function(){setTimeout(function(){window.print();},400);});<\/script>' +
    '</body></html>';
}

// ─── getCoverSheetBatch ────────────────────────────────────────────────
// Batch: query บิลค้างจ่าย + Pay sheet ทีเดียว แทนที่จะ query per-row
// payload: { customers:[{custCode,invoiceNo,rowIndex}], weekStart:'YYYY-MM-DD' }
// return: { billsMap:{ custCode:{bills:[],shopName:'',storeInvSet:[]} }, invoiceMap:{} }

function getCoverSheetBatch(payload) {
  var t0 = Date.now();
  payload = payload || {};
  var customers  = payload.customers  || [];
  var weekStart  = payload.weekStart  || '';

  // รวบ unique custCodes
  var custSet = {};
  customers.forEach(function(c) { if (c.custCode) custSet[c.custCode] = true; });
  var uniqueCusts = Object.keys(custSet);

  // ── Cache check ──
  var cache    = CacheService.getScriptCache();
  var cacheKey = 'coversheet_batch_' + weekStart;
  var cached   = cache.get(cacheKey);
  if (cached) {
    console.log('[getCoverSheetBatch] BATCH hit cache weekStart=' + weekStart);
    return JSON.parse(cached);
  }
  console.log('[getCoverSheetBatch] BATCH query weekStart=' + weekStart + ' custs=' + uniqueCusts.length);

  var STORE_SS_ID = '1ADwKdbF8Eo1ZuTXRRKUdgD-9NXvbphuA49PvB5sWGeY';

  // เตรียม billsMap structure
  var billsMap = {};
  uniqueCusts.forEach(function(c) {
    billsMap[c] = { bills: [], shopName: '', storeInvSet: [] };
  });

  // Bangkok today (ไม่ใช้ server local time)
  function bkkToday() {
    var d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    d.setHours(0, 0, 0, 0);
    return d;
  }
  function bkkDate(raw) {
    var dt = (raw instanceof Date) ? raw : new Date(raw);
    if (isNaN(dt.getTime())) return null;
    var b = new Date(dt.toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
    b.setHours(0, 0, 0, 0);
    return b;
  }
  function isoFromDate(d) {
    return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  }

  var todayBKK = bkkToday();

  // ── Read บิลค้างจ่าย sheet 1 ครั้ง ──
  try {
    var slipSsId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID_SLIP');
    var ss       = SpreadsheetApp.openById(slipSsId);
    var sheet    = ss.getSheetByName('บิลค้างจ่าย');
    if (sheet) {
      var data = sheet.getDataRange().getValues();
      var h    = data[0] || [];

      function col(names) {
        for (var ni = 0; ni < names.length; ni++)
          for (var hi = 0; hi < h.length; hi++)
            if (String(h[hi]).trim().toLowerCase() === names[ni].toLowerCase()) return hi;
        return -1;
      }
      var iKey  = col(['รหัสหลัก','TaxNo','taxno','รหัสลูกค้า']);
      var iInv  = col(['InvoiceNo','invoiceno','เลขที่บิล','DocNo']);
      var iAmt  = col(['ยอดคงเหลือ','ยอดบิล','Amount','amount']);
      var iDue  = col(['DueDate','duedate','วันครบกำหนด','วันที่ครบกำหนด']);
      var iShop = col(['ชื่อลูกค้าหลัก','ชื่อลูกค้า','Sale','sale','CustomerName']);

      if (iKey >= 0 && iInv >= 0 && data.length > 1) {
        for (var r = 1; r < data.length; r++) {
          var cust = String(data[r][iKey] || '').trim();
          if (!billsMap[cust]) continue;
          var invoiceNo = String(data[r][iInv] || '').trim();
          if (!invoiceNo) continue;
          if (!billsMap[cust].shopName && iShop >= 0)
            billsMap[cust].shopName = String(data[r][iShop] || '').trim();
          var amount = parseFloat(String(data[r][iAmt >= 0 ? iAmt : 0] || 0).replace(/[^0-9.\-]/g, '')) || 0;
          var dueDate = null, overdueDays = null;
          if (iDue >= 0 && data[r][iDue]) {
            var dd = bkkDate(data[r][iDue]);
            if (dd) { dueDate = isoFromDate(dd); overdueDays = Math.floor((todayBKK - dd) / 86400000); }
          }
          billsMap[cust].bills.push({ invoiceNo: invoiceNo, amount: amount, dueDate: dueDate, overdueDays: overdueDays, source: 'main' });
        }
      }

      // Sort per cust by dueDate
      uniqueCusts.forEach(function(c) {
        billsMap[c].bills.sort(function(a, b) {
          if (!a.dueDate && !b.dueDate) return 0;
          if (!a.dueDate) return 1;
          if (!b.dueDate) return -1;
          return new Date(a.dueDate) - new Date(b.dueDate);
        });
      });
    }
  } catch(e) {
    console.log('[getCoverSheetBatch] debt sheet error: ' + e.message);
  }

  // ── Read Pay sheet 1 ครั้ง ──
  try {
    var storeSs = SpreadsheetApp.openById(STORE_SS_ID);
    var storeSh = storeSs.getSheetByName('Pay');
    if (storeSh) {
      var sData = storeSh.getDataRange().getValues();
      var sh    = sData[0];
      var sCust=1, sInv=2, sRemain=5, sShop=-1, sDue=9;
      for (var hi = 0; hi < sh.length; hi++) {
        var hN = String(sh[hi]).trim();
        if (hN==='รหัสลูกค้า')                                     sCust=hi;
        if (hN==='เลขที่บิล'||hN==='DocNo'||hN==='InvoiceNo')      sInv=hi;
        if (hN==='ยอดคงเหลือ'||hN==='คงเหลือ')                    sRemain=hi;
        if (hN==='ลูกค้า'||hN==='ชื่อลูกค้า'||hN==='CustomerName') sShop=hi;
        if (hN==='ถึงกำหนดชำระ'||hN==='DueDate'||hN==='วันครบกำหนด') sDue=hi;
      }

      for (var sr = 1; sr < sData.length; sr++) {
        var rowCust = String(sData[sr][sCust] || '').trim();
        if (!billsMap[rowCust]) continue;
        var entry  = billsMap[rowCust];
        if (!entry.shopName && sShop >= 0) entry.shopName = String(sData[sr][sShop] || '').trim();

        var rowInv = String(sData[sr][sInv] || '').trim();
        if (!rowInv) continue;
        var rowRemain = parseFloat(String(sData[sr][sRemain] || 0).replace(/[^0-9.\-]/g, '')) || 0;

        // Build storeInvSet (full + suffix)
        var lower = rowInv.toLowerCase();
        if (entry.storeInvSet.indexOf(lower) < 0) entry.storeInvSet.push(lower);
        var parts = rowInv.split('-');
        if (parts.length > 1) {
          var suffix = parts[parts.length-1].toLowerCase();
          if (entry.storeInvSet.indexOf(suffix) < 0) entry.storeInvSet.push(suffix);
        }

        // Add to bills if remain > 0 and not a duplicate
        if (rowRemain > 0) {
          var alreadyIn = false;
          for (var bi = 0; bi < entry.bills.length; bi++) {
            var bNorm = entry.bills[bi].invoiceNo.toLowerCase();
            var bSuf  = bNorm.split('-').pop();
            var rSuf  = lower.split('-').pop();
            if (bNorm === lower || (rSuf.length >= 4 && bSuf === rSuf)) { alreadyIn = true; break; }
          }
          if (!alreadyIn) {
            var rowDue = null, rowOd = null;
            if (sDue >= 0 && sData[sr][sDue]) {
              var rd = bkkDate(sData[sr][sDue]);
              if (rd) { rowDue = isoFromDate(rd); rowOd = Math.floor((todayBKK - rd) / 86400000); }
            }
            entry.bills.push({ invoiceNo: rowInv, amount: rowRemain, dueDate: rowDue, overdueDays: rowOd, source: 'store' });
          }
        }
      }
    }
  } catch(e) {
    console.log('[getCoverSheetBatch] Pay sheet error: ' + e.message);
  }

  // Build invoiceMap จาก storeInvSets
  var invoiceMap = {};
  customers.forEach(function(c) {
    if (!c.invoiceNo || !c.custCode || !billsMap[c.custCode]) return;
    var entry = billsMap[c.custCode];
    var norm  = c.invoiceNo.toLowerCase();
    var parts = c.invoiceNo.split('-');
    var suf   = parts.length > 1 ? parts[parts.length-1].toLowerCase() : norm;
    invoiceMap[c.invoiceNo] = {
      isStoreInvoice: (entry.storeInvSet.indexOf(norm) >= 0 || entry.storeInvSet.indexOf(suf) >= 0)
    };
  });

  var result = { billsMap: billsMap, invoiceMap: invoiceMap };

  // Cache (ถ้า response ใหญ่เกิน 100KB → skip silently)
  try { cache.put(cacheKey, JSON.stringify(result), 300); } catch(e) {}

  console.log('[getCoverSheetBatch] BATCH done: ' + (Date.now() - t0) + 'ms custs=' + uniqueCusts.length);
  return result;
}