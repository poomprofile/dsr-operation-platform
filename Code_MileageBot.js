// ╔══════════════════════════════════════════════════════════════════╗
// ║  Nice Center Oil — Mileage Bot Portal Backend                    ║
// ║  Code_MileageBot.gs  (dsr-operation-platform project)           ║
// ║  Portal read/edit functions — bot write logic is in nco-slip2go  ║
// ╚══════════════════════════════════════════════════════════════════╝

'use strict';

// ─── CONSTANTS ────────────────────────────────────────────────────────
var MB = {
  SHEET:       'Mileage',
  STATUS_SHEET:'MileageWeekStatus',
  MAX_DIST_KM: 500,
};

// Header columns (must match nco-slip2go/Code_MileageBot.js MB_COLS)
var MB_COLS = [
  'id', 'dsrEmail', 'date', 'session', 'rawMile', 'confirmedMile',
  'startMile', 'endMile', 'distance', 'vehicleId', 'vehicleType',
  'confidence', 'sourceFlag', 'errorFlag', 'errorMsg', 'pendingFill',
  'imageUrl', 'submitted', 'timestamp',
];

var MB_STATUS_COLS = ['id', 'dsrEmail', 'weekStart', 'submittedAt', 'fuelRate', 'fuelCost'];

// ─────────────────────────────────────────────────────────────────────
//  PORTAL BACKEND — getMileageBotSummary
//  Returns week's mileage, one entry per DSR per day
//  dsrEmail: filter to one DSR; pass '' for admin (all DSRs)
// ─────────────────────────────────────────────────────────────────────
function getMileageBotSummary(weekStart, dsrEmail) {
  console.log('[getMileageBotSummary] weekStart=%s dsrEmail=%s SPREADSHEET_ID=%s',
    weekStart, dsrEmail, prop('SPREADSHEET_ID'));
  ensureMileageSheet();
  var sheet = getMileageSheet();
  if (!sheet) {
    console.warn('[getMileageBotSummary] Mileage sheet NOT FOUND in spreadsheet');
    return [];
  }

  var data = sheet.getDataRange().getValues();
  console.log('[getMileageBotSummary] total rows (excl header): %s', data.length - 1);
  if (data.length < 2) return [];
  var headers = data[0];
  var _dIdx = headers.indexOf('date'), _eIdx = headers.indexOf('dsrEmail');
  console.log('[getMileageBotSummary] sample[1] date=%j(%s) email=%j(%s)',
    data[1][_dIdx], typeof data[1][_dIdx], data[1][_eIdx], typeof data[1][_eIdx]);

  var start = new Date(weekStart + 'T00:00:00');
  var end   = new Date(weekStart + 'T00:00:00');
  end.setDate(end.getDate() + 6); // Mon–Sun

  // Build per-DSR per-day map keyed by dsrEmail|date
  var map = {};
  data.slice(1).forEach(function(row) {
    var r = {};
    headers.forEach(function(h, i) {
      var v = row[i];
      // Date objects (Google Sheets) → ISO string in Bangkok TZ ป้องกัน "undefined.NaN"
      if (v instanceof Date) {
        r[h] = Utilities.formatDate(v, 'Asia/Bangkok', 'yyyy-MM-dd');
      } else {
        r[h] = (v !== undefined && v !== null) ? String(v) : '';
      }
    });
    if (!r.date) return;
    if (dsrEmail && r.dsrEmail !== dsrEmail) return;
    var dt = new Date(r.date + 'T00:00:00');
    if (dt < start || dt > end) return;
    var key = r.dsrEmail + '|' + r.date;
    if (!map[key]) map[key] = { dsrEmail: r.dsrEmail, date: r.date, morning: null, evening: null };
    if (r.session === 'morning') map[key].morning = r;
    if (r.session === 'evening') map[key].evening = r;
  });
  console.log('[getMileageBotSummary] map entries after filter: %s', Object.keys(map).length);

  var thaiDay    = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  var thaiMonths = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];

  // อ่าน USERS ครั้งเดียวแล้ว build lookup map (ป้องกัน N×sheetRead bottleneck)
  var usersArr = sheetToObjects('USERS');
  var userMap  = {};
  usersArr.forEach(function(u) { if (u.email) userMap[u.email] = u; });

  // อ่าน SettlementExpenses เพื่อ pre-fill ค่าน้ำมันรายวัน (บริษัท)
  var weekNumber = weekNum(new Date(weekStart + 'T00:00:00'));
  var fuelMap = {};
  try {
    sheetToObjects(SH.SETTLE_EXP).forEach(function(r) {
      if (dsrEmail && r.dsrEmail !== dsrEmail) return;
      if (parseInt(r.weekNumber) !== weekNumber) return;
      var dateStr = (r.date instanceof Date)
        ? Utilities.formatDate(r.date, 'Asia/Bangkok', 'yyyy-MM-dd')
        : normDateStr(String(r.date));
      fuelMap[r.dsrEmail + '|' + dateStr] = parseFloat(r.fuel) || 0;
    });
  } catch(_) {}

  var result = Object.values(map).map(function(day) {
    var morn = day.morning;
    var eve  = day.evening;
    var d    = new Date(day.date + 'T00:00:00');
    var userRow = userMap[day.dsrEmail] || {};

    // อ่านไมล์จาก column ที่ถูกต้องตาม session structure จริง
    // morning row → startMile column; evening row → endMile column
    var mornMileRaw = morn ? parseFloat(morn.startMile) : NaN;
    var eveMileRaw  = eve  ? parseFloat(eve.endMile)    : NaN;
    var morningMile = (isFinite(mornMileRaw) && mornMileRaw > 0) ? mornMileRaw : null;
    var eveningMile = (isFinite(eveMileRaw)  && eveMileRaw  > 0) ? eveMileRaw  : null;

    // Re-compute status + distance จากค่าจริง (อย่าเชื่อ errorFlag ดิบใน sheet)
    var status, distance = null;
    if (morningMile !== null && eveningMile !== null) {
      var diff = eveningMile - morningMile;
      if (diff < 0 || diff > MB.MAX_DIST_KM) {
        status = 'abnormal'; // evening < morning หรือต่างเกินปกติ
      } else {
        status   = 'complete';
        distance = Math.round(diff * 100) / 100;
      }
    } else if (morningMile !== null) {
      status = 'no_evening';
    } else if (eveningMile !== null) {
      status = 'no_morning';
    } else {
      status = 'empty';
    }

    // Depreciation (personal vehicle only)
    var deprRate   = parseFloat(userRow.depreciation_rate);
    if (isNaN(deprRate)) deprRate = 0;
    var vType      = ((morn || eve || {}).vehicleType) || userRow.defaultVehicleType || 'company';
    var isPersonal = vType === 'personal';
    var deprCost   = (isPersonal && distance !== null) ? Math.round(distance * deprRate * 100) / 100 : 0;

    // dateLabel: "จ. 10 มิ.ย." — ใช้ thaiDay/thaiMonths เหมือน frontend
    var dateLabel  = thaiDay[d.getDay()] + '. ' + d.getDate() + ' ' + thaiMonths[d.getMonth()];

    return {
      date:             day.date,
      dateLabel:        dateLabel,
      dsrEmail:         day.dsrEmail,
      morningMile:      morningMile,
      eveningMile:      eveningMile,
      morningId:        morn ? (morn.id || '') : '',
      eveningId:        eve  ? (eve.id  || '') : '',
      morningImageUrl:  morn ? (morn.imageUrl || '') : '',
      eveningImageUrl:  eve  ? (eve.imageUrl  || '') : '',
      distance:         distance,
      vehicleType:      isPersonal ? 'personal' : 'company',
      vehicleId:        ((morn || eve || {}).vehicleId) || '',
      depreciationCost: deprCost,
      fuelEntry:        fuelMap[day.dsrEmail + '|' + day.date] || 0,
      status:           status,
      zone:             userRow.province_zone || '',
    };
  });

  result.sort(function(a, b) { return (a.dsrEmail + a.date).localeCompare(b.dsrEmail + b.date); });
  if (result.length > 0) console.log('[getMileageBotSummary] sample[0]:', JSON.stringify(result[0]));
  console.log('[getMileageBotSummary] returned %s rows', result.length);
  return result;
}

// ─────────────────────────────────────────────────────────────────────
//  INTERNAL — Recompute startMile/endMile/distance/errorFlag for a day pair
//  ใช้ confirmedMile เป็น source of truth, เขียน cross-pair columns ทั้งสอง session
// ─────────────────────────────────────────────────────────────────────
function _recomputeDayPair(sheet, data, headers, dsrEmail, dateStr) {
  var eIdx    = headers.indexOf('dsrEmail');
  var dIdx    = headers.indexOf('date');
  var sIdx    = headers.indexOf('session');
  var cmIdx   = headers.indexOf('confirmedMile');
  var smIdx   = headers.indexOf('startMile');
  var emIdx   = headers.indexOf('endMile');
  var distIdx = headers.indexOf('distance');
  var efIdx   = headers.indexOf('errorFlag');
  var emsgIdx = headers.indexOf('errorMsg');

  var mornIdx = -1, eveIdx = -1;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][eIdx]) !== dsrEmail) continue;
    if (normDateStr(data[i][dIdx]) !== dateStr) continue;
    var sess = String(data[i][sIdx]);
    if (sess === 'morning' && mornIdx < 0) mornIdx = i;
    if (sess === 'evening' && eveIdx  < 0) eveIdx  = i;
  }

  var mornMile = (mornIdx >= 0) ? parseFloat(String(data[mornIdx][cmIdx])) : NaN;
  var eveMile  = (eveIdx  >= 0) ? parseFloat(String(data[eveIdx][cmIdx]))  : NaN;

  // Morning row: sync startMile = confirmedMile
  if (mornIdx >= 0) {
    var mRow = data[mornIdx].slice();
    mRow[smIdx] = isNaN(mornMile) ? '' : String(mornMile);
    sheet.getRange(mornIdx + 1, 1, 1, headers.length).setValues([mRow]);
  }

  // Evening row: sync startMile + endMile + compute distance/errorFlag
  if (eveIdx >= 0) {
    var eRow = data[eveIdx].slice();
    eRow[smIdx] = isNaN(mornMile) ? '' : String(mornMile);
    eRow[emIdx] = isNaN(eveMile)  ? '' : String(eveMile);
    var dist = '', eflag = '', emsg = '';
    if (!isNaN(mornMile) && !isNaN(eveMile)) {
      var diff = eveMile - mornMile;
      if (eveMile < mornMile) {
        eflag = 'eve<morn';
        emsg  = 'ไมล์เย็น (' + eveMile + ') น้อยกว่าไมล์เช้า (' + mornMile + ')';
      } else if (diff > MB.MAX_DIST_KM) {
        eflag = 'long_dist';
        emsg  = 'ระยะทาง ' + diff + ' กม. เกิน ' + MB.MAX_DIST_KM + ' กม.';
      } else {
        dist = String(Math.round(diff * 100) / 100);
      }
    }
    eRow[distIdx] = dist;
    eRow[efIdx]   = eflag;
    eRow[emsgIdx] = emsg;
    sheet.getRange(eveIdx + 1, 1, 1, headers.length).setValues([eRow]);
  }
}

// ─────────────────────────────────────────────────────────────────────
//  PORTAL BACKEND — updateMileageBotRecord  (upsert)
//  payload: { id, dsrEmail, date, session, newMile, weekStart }
//  Logic: หา id ก่อน → ไม่เจอ/ไม่มี id → หาด้วย dsrEmail+date+session
//         เจอ = UPDATE, ไม่เจอจริง = INSERT
// ─────────────────────────────────────────────────────────────────────
function updateMileageBotRecord(payload, user) {
  var id        = String(payload.id       || '').trim();
  var dsrEmail  = String(payload.dsrEmail || '').trim();
  var dateStr   = normDateStr(payload.date);
  var session   = String(payload.session  || '').trim();
  var newMile   = parseInt(payload.newMile, 10);
  var weekStart = String(payload.weekStart || '').trim();

  // ── Validate ─────────────────────────────────────────────────────
  if (!dsrEmail)                                      throw new Error('dsrEmail ต้องระบุ');
  if (!dateStr)                                       throw new Error('date ต้องระบุ');
  if (session !== 'morning' && session !== 'evening') throw new Error('session ต้องเป็น morning หรือ evening');
  if (isNaN(newMile) || newMile <= 0)                 throw new Error('ไมล์ต้องเป็นจำนวนเต็มบวก');
  if (newMile > 9999999)                              throw new Error('ไมล์ต้องไม่เกิน 7 หลัก');
  if (user.role === 'dsr' && user.email !== dsrEmail) throw new Error('Access denied — ไม่ใช่ข้อมูลของคุณ');

  // ── Frozen week check ─────────────────────────────────────────────
  var weekFrozen = false;
  if (weekStart) {
    try {
      ensureMileageWeekStatusSheet();
      weekFrozen = sheetToObjects(MB.STATUS_SHEET).some(function(r) {
        return r.dsrEmail === dsrEmail && normDateStr(r.weekStart) === normDateStr(weekStart);
      });
    } catch(_) {}
  }
  // ── Load sheet ────────────────────────────────────────────────────
  ensureMileageSheet();
  var sheet   = getMileageSheet();
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];

  var idIdx  = headers.indexOf('id');
  var eIdx   = headers.indexOf('dsrEmail');
  var dIdx   = headers.indexOf('date');
  var sIdx   = headers.indexOf('session');
  var cmIdx  = headers.indexOf('confirmedMile');
  var smIdx  = headers.indexOf('startMile');
  var emIdx  = headers.indexOf('endMile');
  var sfIdx  = headers.indexOf('sourceFlag');
  var pfIdx  = headers.indexOf('pendingFill');
  var rmIdx  = headers.indexOf('rawMile');
  var cfIdx  = headers.indexOf('confidence');
  var tsIdx  = headers.indexOf('timestamp');
  var viIdx  = headers.indexOf('vehicleId');
  var vtIdx  = headers.indexOf('vehicleType');

  // ── Find target row (upsert logic) ───────────────────────────────
  var targetRowIdx = -1;
  // 1. by id
  if (id) {
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][idIdx]) === id) { targetRowIdx = i; break; }
    }
  }
  // 2. fallback: dsrEmail + normalize(date) + session
  if (targetRowIdx < 0) {
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][eIdx]) !== dsrEmail) continue;
      if (normDateStr(data[i][dIdx]) !== dateStr) continue;
      if (String(data[i][sIdx]) !== session) continue;
      targetRowIdx = i; break;
    }
  }

  var op      = targetRowIdx >= 0 ? 'UPDATE' : 'INSERT';
  var oldMile = '';

  if (op === 'UPDATE') {
    oldMile = String(data[targetRowIdx][cmIdx]);
    var updRow = data[targetRowIdx].slice();
    updRow[cmIdx] = String(newMile);
    updRow[sfIdx] = 'manual';
    updRow[pfIdx] = 'FALSE';
    if (session === 'morning') updRow[smIdx] = String(newMile);
    if (session === 'evening') updRow[emIdx] = String(newMile);
    data[targetRowIdx] = updRow; // อัป in-memory ก่อน _recomputeDayPair
    sheet.getRange(targetRowIdx + 1, 1, 1, headers.length).setValues([updRow]);

  } else {
    // ── Copy vehicleId/vehicleType จาก sibling session วันเดียวกัน ──
    var sibVehicleId = '', sibVehicleType = '';
    for (var i = 1; i < data.length; i++) {
      if (String(data[i][eIdx]) !== dsrEmail) continue;
      if (normDateStr(data[i][dIdx]) !== dateStr) continue;
      if (String(data[i][sIdx]) === session) continue;
      sibVehicleId   = String(data[i][viIdx] || '');
      sibVehicleType = String(data[i][vtIdx] || '');
      break;
    }
    // Fallback: USERS sheet
    if (!sibVehicleType) {
      var uRows = sheetToObjects('USERS');
      var uRow  = uRows.filter(function(u) { return u.email === dsrEmail; })[0] || {};
      sibVehicleType = uRow.defaultVehicleType || '';
      if (!sibVehicleId) sibVehicleId = uRow.vehicleId || '';
    }
    if (!sibVehicleType) sibVehicleType = 'company'; // ห้ามว่าง

    var newRow = headers.map(function() { return ''; });
    newRow[idIdx]  = uuid();
    newRow[eIdx]   = dsrEmail;
    newRow[dIdx]   = dateStr;
    newRow[sIdx]   = session;
    newRow[rmIdx]  = '';
    newRow[cmIdx]  = String(newMile);
    newRow[smIdx]  = session === 'morning' ? String(newMile) : '';
    newRow[emIdx]  = session === 'evening' ? String(newMile) : '';
    newRow[viIdx]  = sibVehicleId;
    newRow[vtIdx]  = sibVehicleType;
    newRow[cfIdx]  = '';
    newRow[sfIdx]  = 'manual';
    newRow[pfIdx]  = 'FALSE';
    newRow[tsIdx]  = ts();
    sheet.appendRow(newRow);

    // Re-read ให้ _recomputeDayPair เห็น row ใหม่
    data    = sheet.getDataRange().getValues();
    headers = data[0];
  }

  // ── Cascade recompute ─────────────────────────────────────────────
  _recomputeDayPair(sheet, data, headers, dsrEmail, dateStr);

  // ── Audit ─────────────────────────────────────────────────────────
  writeAudit(user.email, 'EDIT_MILEAGE_BOT', {
    dsrEmail: dsrEmail, date: dateStr, session: session,
    oldMile: oldMile, newMile: newMile, op: op,
  });

  // ── Build response ────────────────────────────────────────────────
  var days = weekStart ? getMileageBotSummary(weekStart, dsrEmail) : [];

  var totalKm = 0;
  days.forEach(function(r) { if (r.distance !== null) totalKm += r.distance; });
  totalKm = Math.round(totalKm * 100) / 100;

  // fuelCost: personal vehicle เท่านั้น (company = null)
  var fuelCost = null;
  var uRows2 = sheetToObjects('USERS');
  var uRow2  = uRows2.filter(function(u) { return u.email === dsrEmail; })[0] || {};
  if ((uRow2.defaultVehicleType || 'company') === 'personal') {
    fuelCost = Math.round(totalKm * (parseFloat(uRow2.depreciation_rate) || 0));
  }

  console.log('[updateMileageBotRecord] op=%s dsrEmail=%s date=%s session=%s old=%s new=%s',
    op, dsrEmail, dateStr, session, oldMile, newMile);

  if (weekFrozen) _invalidateSettlementCache(dsrEmail, weekStart);

  return {
    success:     true,
    weekFrozen:  weekFrozen,
    days:        days,
    weekSummary: { totalKm: totalKm, fuelCost: fuelCost },
  };
}

// ─────────────────────────────────────────────────────────────────────
//  PORTAL BACKEND — getMileageWeeklySummary
// ─────────────────────────────────────────────────────────────────────
function getMileageWeeklySummary(dsrEmail, weekStart) {
  var rows          = getMileageBotSummary(weekStart, dsrEmail);
  var totalDistance = 0;
  var totalDeprCost = 0;
  var workDays      = 0;
  var incompleteDays = 0;

  rows.forEach(function(r) {
    if (r.dsrEmail !== dsrEmail) return;
    workDays++;
    if (r.distance !== null) totalDistance += r.distance;
    totalDeprCost += r.depreciationCost || 0;
    if (r.status !== 'complete') incompleteDays++;
  });
  totalDistance = Math.round(totalDistance * 100) / 100;

  // Vehicle type + default rate from USERS
  var usersArr = sheetToObjects('USERS');
  var userRow  = usersArr.find(function(u) { return u.email === dsrEmail; }) || {};
  var vehicleType = userRow.defaultVehicleType || 'company';
  var defaultRate = parseFloat(userRow.depreciation_rate);
  if (isNaN(defaultRate)) defaultRate = 0;

  // Read MileageWeekStatus once
  var allStatusRows = [];
  try {
    ensureMileageWeekStatusSheet();
    allStatusRows = sheetToObjects(MB.STATUS_SHEET).filter(function(r) {
      return r.dsrEmail === dsrEmail;
    });
  } catch(_) {}

  console.log('[getMileageWeeklySummary] lookYkup dsrEmail=%j weekStart=%j(%s)',
    dsrEmail, weekStart, typeof weekStart);
  // ── หา freeze row: ถ้ามีหลายแถว dsrEmail+weekStart ตรงกัน (ซ้ำ) ──
  //    หยิบแถวที่ submittedAt ล่าสุด ไม่ใช่แถวแรกที่เจอในชีต
  var matchingStatusRows = allStatusRows.filter(function(r) {
    var match = (r.dsrEmail === dsrEmail && normDateStr(r.weekStart) === normDateStr(weekStart));
    console.log('[getMileageWeeklySummary] row dsrEmail=%j weekStart=%j match=%s',
      r.dsrEmail, r.weekStart, match);
    return match;
  });
  matchingStatusRows.sort(function(a, b) {
    return new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime();
  });
  var currentStatusRow = matchingStatusRows[0] || null;
  var submitted = !!currentStatusRow;

  // Previous week's fuelRate (last submitted week before current)
  var prevRows = allStatusRows.filter(function(r) {
    return normDateStr(r.weekStart) < normDateStr(weekStart) && r.fuelRate !== undefined && r.fuelRate !== '';
  });
  prevRows.sort(function(a, b) { return normDateStr(b.weekStart).localeCompare(normDateStr(a.weekStart)); });
  var prevFuelRate = prevRows.length > 0 ? (parseFloat(prevRows[0].fuelRate) || 0) : 0;

  var fuelRate, fuelCost;
  if (submitted) {
    fuelRate = parseFloat(currentStatusRow.fuelRate) || 0;
    fuelCost = parseFloat(currentStatusRow.fuelCost) || 0;
  } else {
    fuelRate = prevFuelRate || defaultRate;
    fuelCost = Math.round(totalDistance * fuelRate);
  }

  return {
    dsrEmail:       dsrEmail,
    weekStart:      weekStart,
    totalDistance:  totalDistance,
    totalDeprCost:  Math.round(totalDeprCost * 100) / 100,
    workDays:       workDays,
    incompleteDays: incompleteDays,
    submitted:      submitted,
    vehicleType:    vehicleType,
    defaultRate:    defaultRate,
    prevFuelRate:   prevFuelRate,
    fuelRate:       fuelRate,
    fuelCost:       fuelCost,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  PORTAL BACKEND — submitWeeklyMileageSummary
// ─────────────────────────────────────────────────────────────────────
function submitWeeklyMileageSummary(dsrEmail, weekStart, user, fuelRate) {
  if (user.role === 'dsr' && user.email !== dsrEmail) {
    throw new Error('Access denied — ไม่ใช่ข้อมูลของคุณ');
  }

  var resolvedFuelRate = parseFloat(fuelRate) || 0;

  console.log('[submitWeeklyMileageSummary] PRE-APPEND dsrEmail=%s weekStart=%j(%s) fuelRate=%s',
    dsrEmail, weekStart, typeof weekStart, fuelRate);

  ensureMileageWeekStatusSheet();
  var exists = sheetToObjects(MB.STATUS_SHEET).some(function(r) {
    return r.dsrEmail === dsrEmail && normDateStr(r.weekStart) === normDateStr(weekStart);
  });
  if (exists) return { submitted: true, alreadySubmitted: true };

  // Compute totalDistance for fuelCost
  var weekRows = getMileageBotSummary(weekStart, dsrEmail);
  var totalDistance = 0;
  weekRows.forEach(function(r) { if (r.distance !== null) totalDistance += r.distance; });
  var fuelCost = Math.round(totalDistance * resolvedFuelRate);

  // Mark individual Mileage rows as submitted
  var sheet   = getMileageSheet();
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var eIdx    = headers.indexOf('dsrEmail');
  var dIdx    = headers.indexOf('date');
  var subIdx  = headers.indexOf('submitted');
  var start   = new Date(weekStart + 'T00:00:00');
  var end     = new Date(weekStart + 'T00:00:00');
  end.setDate(end.getDate() + 6);

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][eIdx]) !== dsrEmail) continue;
    var dt = new Date(normDateStr(data[i][dIdx]) + 'T00:00:00');
    if (dt < start || dt > end) continue;
    sheet.getRange(i + 1, subIdx + 1).setValue('TRUE');
  }

  appendSheetRow(MB.STATUS_SHEET, {
    id:          uuid(),
    dsrEmail:    dsrEmail,
    weekStart:   weekStart,
    submittedAt: ts(),
    fuelRate:    resolvedFuelRate,
    fuelCost:    fuelCost,
  });

  _invalidateSettlementCache(dsrEmail, weekStart);

  console.log('[submitWeeklyMileageSummary] dsrEmail=%s weekStart=%s fuelRate=%s fuelCost=%s',
    dsrEmail, weekStart, resolvedFuelRate, fuelCost);
  return { submitted: true, alreadySubmitted: false };
}

// ─────────────────────────────────────────────────────────────────────
//  SHEET HELPERS
// ─────────────────────────────────────────────────────────────────────
function getMileageSheet() {
  return SpreadsheetApp.openById(prop('SPREADSHEET_ID')).getSheetByName(MB.SHEET);
}

function getMileageWeekStatusSheet() {
  return SpreadsheetApp.openById(prop('SPREADSHEET_ID')).getSheetByName(MB.STATUS_SHEET);
}

function ensureMileageSheet() {
  var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID'));
  var sheet = ss.getSheetByName(MB.SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MB.SHEET);
    sheet.appendRow(MB_COLS);
    sheet.getRange(1, 1, 1, MB_COLS.length).setFontWeight('bold').setBackground('#F3F4F6');
    console.log('[MileagePortal] created sheet: ' + MB.SHEET);
  }
}

function ensureMileageWeekStatusSheet() {
  var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID'));
  var sheet = ss.getSheetByName(MB.STATUS_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(MB.STATUS_SHEET);
    sheet.appendRow(MB_STATUS_COLS);
    sheet.getRange(1, 1, 1, MB_STATUS_COLS.length).setFontWeight('bold').setBackground('#F3F4F6');
    console.log('[MileagePortal] created sheet: ' + MB.STATUS_SHEET);
  }
  ensureMileageStatusColumns();
}

function ensureMileageStatusColumns() {
  var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID'));
  var sheet = ss.getSheetByName(MB.STATUS_SHEET);
  if (!sheet) return;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  ['fuelRate', 'fuelCost'].forEach(function(col) {
    if (headers.indexOf(col) < 0) {
      var next = sheet.getLastColumn() + 1;
      sheet.getRange(1, next).setValue(col).setFontWeight('bold');
      console.log('[MileagePortal] added MileageWeekStatus column: ' + col);
    }
  });
}

// Add mileage-related columns to USERS sheet if not present
function ensureUsersColumns() {
  var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID'));
  var sheet = ss.getSheetByName('USERS');
  if (!sheet) return;
  var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  ['lineUserId', 'defaultVehicleType', 'vehicleId', 'depreciation_rate'].forEach(function(col) {
    if (headers.indexOf(col) < 0) {
      var next = sheet.getLastColumn() + 1;
      sheet.getRange(1, next).setValue(col).setFontWeight('bold');
      console.log('[MileagePortal] added USERS column: ' + col);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────
//  ONE-TIME SETUP
// ─────────────────────────────────────────────────────────────────────
function setupMileagePortal() {
  ensureMileageSheet();
  ensureMileageWeekStatusSheet();
  ensureUsersColumns();
  console.log('[MileagePortal] setupMileagePortal() done');
  return { ok: true };
}
