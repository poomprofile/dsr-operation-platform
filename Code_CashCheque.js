// ╔══════════════════════════════════════════════════════════════════╗
// ║  Nice Center Oil — Cash / Cheque Module                          ║
// ║  Code_CashCheque.gs                                              ║
// ╚══════════════════════════════════════════════════════════════════╝

'use strict';

var SH_CC = {
  CASH:   'CASH_LOG',
  CHEQUE: 'CHEQUE_LOG',
};

// ─────────────────────────────────────────────────────────────────────
//  SAVE CASH
// ─────────────────────────────────────────────────────────────────────
function saveCash(data, user) {
  validate(data, ['customer_code', 'invoice_no', 'amount']);
  ensureCashChequeSheets();
  var date = data.log_date || todayStr();
  var row = {
    log_id:        uuid(),
    dsr_id:        user.email,
    dsr_email:     user.email,
    log_date:      date,
    customer_code: String(data.customer_code).trim(),
    customer_name: data.customer_name || '',
    invoice_no:    String(data.invoice_no).trim(),
    amount:        parseFloat(data.amount) || 0,
    note:          data.note || '',
    week_number:   weekNum(new Date(date)),
    created_at:    ts(),
  };
  appendSheetRow(SH_CC.CASH, row);
  // force log_date เป็น plain text — ป้องกัน Sheets auto-convert เป็น Date object
  var caSh   = getSheet(SH_CC.CASH);
  var caHdrs = caSh.getDataRange().getValues()[0];
  var ldColC = caHdrs.indexOf('log_date') + 1;
  if (ldColC > 0) caSh.getRange(caSh.getLastRow(), ldColC).setNumberFormat('@').setValue(date);
  return { appended: true, id: row.log_id };
}

// ─────────────────────────────────────────────────────────────────────
//  SAVE CHEQUE
// ─────────────────────────────────────────────────────────────────────
function saveCheque(data, user) {
  validate(data, ['customer_code', 'invoice_no', 'amount']);
  ensureCashChequeSheets();
  var date = data.log_date || todayStr();
  var row = {
    log_id:        uuid(),
    dsr_id:        user.email,
    dsr_email:     user.email,
    log_date:      date,
    customer_code: String(data.customer_code).trim(),
    customer_name: data.customer_name || '',
    invoice_no:    String(data.invoice_no).trim(),
    amount:        parseFloat(data.amount) || 0,
    cheque_date:   data.cheque_date || '',
    cheque_no:     String(data.cheque_no).trim(),
    bank_name:     data.bank_name || '',
    branch_name:   data.branch_name || '',
    note:          data.note || '',
    week_number:   weekNum(new Date(date)),
    created_at:    ts(),
  };
  appendSheetRow(SH_CC.CHEQUE, row);
  // force log_date + cheque_date เป็น plain text — ป้องกัน Sheets auto-convert เป็น Date object
  var cqSh    = getSheet(SH_CC.CHEQUE);
  var cqHdrs  = cqSh.getDataRange().getValues()[0];
  var lastRow = cqSh.getLastRow();
  var ldColQ  = cqHdrs.indexOf('log_date')    + 1;
  var cdCol   = cqHdrs.indexOf('cheque_date') + 1;
  if (ldColQ > 0) cqSh.getRange(lastRow, ldColQ).setNumberFormat('@').setValue(date);
  if (cdCol  > 0 && data.cheque_date) cqSh.getRange(lastRow, cdCol).setNumberFormat('@').setValue(data.cheque_date);
}

// ─────────────────────────────────────────────────────────────────────
//  GET LOGS
// ─────────────────────────────────────────────────────────────────────
function getCashLog(user, filters) {
  filters = filters || {};
  var rows = sheetToObjects(SH_CC.CASH);
  if (user.role === ROLES.DSR) {
    rows = rows.filter(function(r){ return r.dsr_email === user.email; });
  }
  return applyFilters(rows, filters, ['week_number', 'log_date', 'dsr_email']);
}

function getChequeLog(user, filters) {
  filters = filters || {};
  var rows = sheetToObjects(SH_CC.CHEQUE);
  if (user.role === ROLES.DSR) {
    rows = rows.filter(function(r){ return r.dsr_email === user.email; });
  }
  return applyFilters(rows, filters, ['week_number', 'log_date', 'dsr_email']);
}

// ─────────────────────────────────────────────────────────────────────
//  GET SUMMARY DATA (for print sheets)
// ─────────────────────────────────────────────────────────────────────
function getSummaryData(user, weekNumber, dsrEmail) {
  var email = (user.role === ROLES.DSR) ? user.email : (dsrEmail || user.email);
  var wn    = String(weekNumber || weekNum(new Date()));

  ensureCashChequeSheets();

  var cash = sheetToObjects(SH_CC.CASH).filter(function(r){
    return r.dsr_email === email && String(r.week_number) === wn;
  });

  var cheque = sheetToObjects(SH_CC.CHEQUE).filter(function(r){
    return r.dsr_email === email && String(r.week_number) === wn;
  });

  var transfers = getTransferRowsForSummary(email);

  var fuelRows  = sheetToObjects(SH.FUEL).filter(function(r){
    return r.dsr_id === email && String(r.week_number) === wn;
  });
  var allowRows = sheetToObjects(SH.ALLOWANCE).filter(function(r){
    return r.dsr_id === email && String(r.week_number) === wn;
  });
  var maintRows = sheetToObjects(SH.MAINTENANCE).filter(function(r){
    return r.dsr_id === email && String(r.week_number) === wn;
  });

  var sum = function(arr, field){
    return arr.reduce(function(s, r){ return s + (parseFloat(r[field]) || 0); }, 0);
  };

  var totalCash     = sum(cash,      'amount');
  var totalCheque   = sum(cheque,    'amount');
  var totalTransfer = sum(transfers, 'ยอดโอน');
  var totalFuel     = sum(fuelRows,  'total_cost');
  var totalAccom    = sum(allowRows, 'accommodation_claimed');
  var totalDaily    = sum(allowRows, 'daily_allowance');
  var totalMaint    = sum(maintRows, 'cost');
  var totalExpenses = totalFuel + totalAccom + totalDaily + totalMaint;
  var netRemittance = totalCash - totalExpenses;

  var dsrUser = findUserByEmail(email);
  var dsrName = dsrUser ? dsrUser.display_name : email;

  return {
    dsr_email:   email,
    dsr_name:    dsrName,
    week_number: wn,
    week_range:  ccWeekRangeStr(parseInt(wn)),
    print_date:  Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm'),
    cash:        cash,
    cheque:      cheque,
    transfers:   transfers,
    totals: {
      cash:            r2(totalCash),
      cheque:          r2(totalCheque),
      transfer:        r2(totalTransfer),
      fuel:            r2(totalFuel),
      accommodation:   r2(totalAccom),
      daily_allowance: r2(totalDaily),
      maintenance:     r2(totalMaint),
      expenses:        r2(totalExpenses),
      net_remittance:  r2(netRemittance),
    },
  };
}

function getTransferRowsForSummary(email) {
  try {
    var slipSsId = prop('SPREADSHEET_ID_SLIP');
    if (!slipSsId) return [];
    var ss    = SpreadsheetApp.openById(slipSsId);
    var sheet = ss.getSheetByName('SLIP_MAPPING');
    if (!sheet || sheet.getLastRow() < 2) return [];
    var data    = sheet.getDataRange().getValues();
    var headers = data[0];
    var iEmail  = headers.indexOf('DSR Email');
    var iStatus = headers.indexOf('สถานะ Match');
    if (iEmail < 0) return [];
    var results = [];
    for (var i = 1; i < data.length; i++) {
      var rowEmail  = String(data[i][iEmail]  || '');
      var rowStatus = iStatus >= 0 ? String(data[i][iStatus] || '') : '';
      if (rowEmail !== email) continue;
      if (rowStatus === 'unmatched') continue;
      var obj = {};
      headers.forEach(function(h, j){
        obj[h] = (data[i][j] !== null && data[i][j] !== undefined) ? String(data[i][j]) : '';
      });
      results.push(obj);
    }
    return results;
  } catch(e) {
    Logger.log('[getTransferRowsForSummary] error: ' + e.message);
    return [];
  }
}

function ccWeekRangeStr(wn) {
  var year   = new Date().getFullYear();
  var jan4   = new Date(year, 0, 4);
  var dow    = (jan4.getDay() + 6) % 7;
  var monday = new Date(jan4.getTime() - dow * 86400000 + (wn - 1) * 7 * 86400000);
  var sunday = new Date(monday.getTime() + 6 * 86400000);
  var fmt    = function(d){ return Utilities.formatDate(d, 'Asia/Bangkok', 'dd/MM/yyyy'); };
  return fmt(monday) + ' \u2013 ' + fmt(sunday);
}

// ─────────────────────────────────────────────────────────────────────
//  PAGE SERVERS
// ─────────────────────────────────────────────────────────────────────
function serveCashEntryPage() {
  return HtmlService.createHtmlOutputFromFile('cash_entry')
    .setTitle('บันทึกเงินสด / เช็ค — NCO DSR')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function servePrintCashChequePage(email, week) {
  var tmpl   = HtmlService.createTemplateFromFile('print_cash_cheque');
  tmpl.email = email || '';
  tmpl.week  = week  || String(weekNum(new Date()));
  return tmpl.evaluate()
    .setTitle('ใบสรุปเงินสด/เช็ค')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function servePrintTransferPage(email, week) {
  var tmpl   = HtmlService.createTemplateFromFile('print_transfer');
  tmpl.email = email || '';
  tmpl.week  = week  || String(weekNum(new Date()));
  return tmpl.evaluate()
    .setTitle('ใบสรุปโอน')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ─────────────────────────────────────────────────────────────────────
//  ENSURE SHEETS EXIST
// ─────────────────────────────────────────────────────────────────────
function ensureCashChequeSheets() {
  var ss = SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);

  if (!ss.getSheetByName(SH_CC.CASH)) {
    var cs = ss.insertSheet(SH_CC.CASH);
    cs.appendRow([
      'log_id','dsr_id','dsr_email','log_date',
      'customer_code','customer_name','invoice_no',
      'amount','note','week_number','created_at',
    ]);
    cs.setFrozenRows(1);
  }

  if (!ss.getSheetByName(SH_CC.CHEQUE)) {
    var qs = ss.insertSheet(SH_CC.CHEQUE);
    qs.appendRow([
      'log_id','dsr_id','dsr_email','log_date',
      'customer_code','customer_name','invoice_no','amount',
      'cheque_date','cheque_no','bank_name','branch_name',
      'note','week_number','created_at',
    ]);
    qs.setFrozenRows(1);
  }
}
