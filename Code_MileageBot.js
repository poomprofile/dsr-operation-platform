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

var MB_STATUS_COLS = ['id', 'dsrEmail', 'weekStart', 'submittedAt'];

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
    headers.forEach(function(h, i) { r[h] = String(row[i] !== undefined ? row[i] : ''); });
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

  var thaiDay = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
  var result  = Object.values(map).map(function(day) {
    var morn = day.morning;
    var eve  = day.evening;
    var d    = new Date(day.date + 'T00:00:00');

    var startMile = morn && morn.confirmedMile ? parseFloat(morn.confirmedMile) : null;
    var endMile   = eve  && eve.confirmedMile  ? parseFloat(eve.confirmedMile)  : null;
    var distance  = (startMile !== null && endMile !== null) ? endMile - startMile : null;

    // Depreciation cost (personal vehicles only)
    var userRow  = sheetToObjects('USERS').find(function(u) { return u.email === day.dsrEmail; }) || {};
    var deprRate = parseFloat(userRow.depreciation_rate);
    if (isNaN(deprRate)) deprRate = 0;
    var vType      = (morn || eve || {}).vehicleType || userRow.defaultVehicleType || 'company';
    var isPersonal = vType === 'personal';
    var deprCost   = (isPersonal && distance !== null) ? Math.round(distance * deprRate * 100) / 100 : 0;

    var errFlag = (eve && eve.errorFlag) || (morn && morn.errorFlag) || '';

    return {
      date:     day.date,
      dateLabel:thaiDay[d.getDay()] + '. ' + d.getDate(),
      dsrEmail: day.dsrEmail,
      morning:  morn ? {
        id:            morn.id,
        rawMile:       morn.rawMile       ? parseFloat(morn.rawMile)       : null,
        confirmedMile: morn.confirmedMile ? parseFloat(morn.confirmedMile) : null,
        sourceFlag:    morn.sourceFlag,
        pendingFill:   morn.pendingFill === 'TRUE',
        imageUrl:      morn.imageUrl,
        errorFlag:     morn.errorFlag,
      } : null,
      evening: eve ? {
        id:            eve.id,
        rawMile:       eve.rawMile       ? parseFloat(eve.rawMile)       : null,
        confirmedMile: eve.confirmedMile ? parseFloat(eve.confirmedMile) : null,
        sourceFlag:    eve.sourceFlag,
        pendingFill:   eve.pendingFill === 'TRUE',
        imageUrl:      eve.imageUrl,
        errorFlag:     eve.errorFlag,
      } : null,
      zone:             userRow.province_zone || '',
      startMile:        startMile,
      endMile:          endMile,
      distance:         distance,
      vehicleType:      isPersonal ? 'personal' : 'company',
      depreciationCost: deprCost,
      errorFlag:        errFlag,
    };
  });

  result.sort(function(a, b) { return (a.dsrEmail + a.date).localeCompare(b.dsrEmail + b.date); });
  console.log('[getMileageBotSummary] returned %s day-rows', result.length);
  return result;
}

// ─────────────────────────────────────────────────────────────────────
//  PORTAL BACKEND — updateMileageBotRecord
//  DSR edits own records only; Admin edits anyone
// ─────────────────────────────────────────────────────────────────────
function updateMileageBotRecord(id, newConfirmedMile, user) {
  ensureMileageSheet();
  var sheet   = getMileageSheet();
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];

  var idIdx   = headers.indexOf('id');
  var eIdx    = headers.indexOf('dsrEmail');
  var dIdx    = headers.indexOf('date');
  var sIdx    = headers.indexOf('session');
  var cmIdx   = headers.indexOf('confirmedMile');
  var sfIdx   = headers.indexOf('sourceFlag');
  var pfIdx   = headers.indexOf('pendingFill');
  var smIdx   = headers.indexOf('startMile');
  var emIdx   = headers.indexOf('endMile');
  var distIdx = headers.indexOf('distance');
  var efIdx   = headers.indexOf('errorFlag');
  var emsgIdx = headers.indexOf('errorMsg');

  var targetRow  = -1;
  var targetData = null;
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][idIdx]) === id) { targetRow = i + 1; targetData = data[i]; break; }
  }
  if (targetRow < 0) throw new Error('ไม่พบ record id: ' + id);

  var dsrEmail = String(targetData[eIdx]);
  var dateStr  = String(targetData[dIdx]);
  var session  = String(targetData[sIdx]);

  if (user.role === 'dsr' && user.email !== dsrEmail) {
    throw new Error('Access denied — ไม่ใช่ข้อมูลของคุณ');
  }

  var newMile = parseFloat(newConfirmedMile);
  if (isNaN(newMile)) throw new Error('confirmedMile ต้องเป็นตัวเลข');

  // Update target record
  var updRow = data[targetRow - 1].slice();
  updRow[cmIdx] = String(newMile);
  updRow[sfIdx] = 'manual';
  updRow[pfIdx] = 'FALSE';
  if (session === 'morning') updRow[smIdx] = String(newMile);
  sheet.getRange(targetRow, 1, 1, headers.length).setValues([updRow]);

  // Cascade: update related session row's start/end/distance/errorFlag
  for (var j = 1; j < data.length; j++) {
    if (j === targetRow - 1) continue;
    if (String(data[j][eIdx]) !== dsrEmail || String(data[j][dIdx]) !== dateStr) continue;
    var otherSession = String(data[j][sIdx]);

    if (session === 'morning' && otherSession === 'evening') {
      var eveConfirmed = parseFloat(String(data[j][cmIdx]));
      var relRow = data[j].slice();
      relRow[smIdx] = String(newMile);
      if (!isNaN(eveConfirmed)) {
        var dist = eveConfirmed - newMile;
        relRow[distIdx] = String(dist);
        relRow[emIdx]   = String(eveConfirmed);
        if (eveConfirmed < newMile) {
          relRow[efIdx]   = 'eve<morn';
          relRow[emsgIdx] = 'ไมล์เย็น (' + eveConfirmed + ') น้อยกว่าไมล์เช้า (' + newMile + ')';
        } else if (dist > MB.MAX_DIST_KM) {
          relRow[efIdx]   = 'long_dist';
          relRow[emsgIdx] = 'ระยะทาง ' + dist + ' กม. เกิน ' + MB.MAX_DIST_KM + ' กม.';
        } else {
          relRow[efIdx]   = '';
          relRow[emsgIdx] = '';
        }
      }
      sheet.getRange(j + 1, 1, 1, headers.length).setValues([relRow]);
      break;
    }

    if (session === 'evening' && otherSession === 'morning') {
      var mornConfirmed = parseFloat(String(data[j][cmIdx]));
      var relRow2 = updRow.slice();
      if (!isNaN(mornConfirmed)) {
        var dist2 = newMile - mornConfirmed;
        relRow2[smIdx]   = String(mornConfirmed);
        relRow2[emIdx]   = String(newMile);
        relRow2[distIdx] = String(dist2);
        if (newMile < mornConfirmed) {
          relRow2[efIdx]   = 'eve<morn';
          relRow2[emsgIdx] = 'ไมล์เย็น (' + newMile + ') น้อยกว่าไมล์เช้า (' + mornConfirmed + ')';
        } else if (dist2 > MB.MAX_DIST_KM) {
          relRow2[efIdx]   = 'long_dist';
          relRow2[emsgIdx] = 'ระยะทาง ' + dist2 + ' กม. เกิน ' + MB.MAX_DIST_KM + ' กม.';
        } else {
          relRow2[efIdx]   = '';
          relRow2[emsgIdx] = '';
        }
        sheet.getRange(targetRow, 1, 1, headers.length).setValues([relRow2]);
      }
      break;
    }
  }

  console.log('[updateMileageBotRecord] id=%s newMile=%s user=%s', id, newMile, user.email);
  return { updated: true };
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
    var mornOk = r.morning && !r.morning.pendingFill && r.morning.confirmedMile !== null;
    var eveOk  = r.evening && !r.evening.pendingFill && r.evening.confirmedMile !== null;
    if (!mornOk || !eveOk) incompleteDays++;
  });

  var submitted = false;
  try {
    ensureMileageWeekStatusSheet();
    submitted = sheetToObjects(MB.STATUS_SHEET).some(function(r) {
      return r.dsrEmail === dsrEmail && r.weekStart === weekStart;
    });
  } catch (_) {}

  return {
    dsrEmail:       dsrEmail,
    weekStart:      weekStart,
    totalDistance:  Math.round(totalDistance * 100) / 100,
    totalDeprCost:  Math.round(totalDeprCost * 100) / 100,
    workDays:       workDays,
    incompleteDays: incompleteDays,
    submitted:      submitted,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  PORTAL BACKEND — submitWeeklyMileageSummary
// ─────────────────────────────────────────────────────────────────────
function submitWeeklyMileageSummary(dsrEmail, weekStart, user) {
  if (user.role === 'dsr' && user.email !== dsrEmail) {
    throw new Error('Access denied — ไม่ใช่ข้อมูลของคุณ');
  }

  ensureMileageWeekStatusSheet();
  var exists = sheetToObjects(MB.STATUS_SHEET).some(function(r) {
    return r.dsrEmail === dsrEmail && r.weekStart === weekStart;
  });
  if (exists) return { submitted: true, alreadySubmitted: true };

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
    var dt = new Date(String(data[i][dIdx]) + 'T00:00:00');
    if (dt < start || dt > end) continue;
    sheet.getRange(i + 1, subIdx + 1).setValue('TRUE');
  }

  appendSheetRow(MB.STATUS_SHEET, {
    id:          uuid(),
    dsrEmail:    dsrEmail,
    weekStart:   weekStart,
    submittedAt: ts(),
  });

  console.log('[submitWeeklyMileageSummary] dsrEmail=%s weekStart=%s', dsrEmail, weekStart);
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
