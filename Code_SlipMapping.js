// ╔══════════════════════════════════════════════════════════════════╗
// ║  Nice Center Oil — Slip Mapping & Settlement                     ║
// ║  Code_SlipMapping.gs                                             ║
// ║  เชื่อม SLIPS (Make) กับ บิลค้างจ่าย (BCAccount)               ║
// ╚══════════════════════════════════════════════════════════════════╝

// ─── SHEET NAMES (ปรับให้ตรงกับ Sheet จริง) ──────────────────────
var SM = {
  SLIPS:   'Slip2Go',          // Sheet ที่ Make เขียน
  DEBTS:   'บิลค้างจ่าย',     // Sheet ที่ BCAccount sync ทุกวัน
  MAPPING: 'SLIP_MAPPING',     // Sheet ผลลัพธ์ mapping
  SUMMARY: 'WEEKLY_SUMMARY',   // Sheet สรุปรายสัปดาห์
};

// ─── MAIN: รัน mapping สลิปกับบิล ────────────────────────────────
function runSlipMapping() {
  var ss      = SpreadsheetApp.openById(prop('SPREADSHEET_ID'));
  var slips   = getSlipsData(ss);
  var debts   = getDebtsData(ss);
  var results = [];

  slips.forEach(function(slip) {
    var matched = matchSlipToDebt(slip, debts);
    results.push(Object.assign({}, slip, {
      matched_invoice:   matched ? matched.InvoiceNo   : '',
      matched_customer:  matched ? matched.Sale        : slip['ชื่อร้าน'] || '',
      matched_amount:    matched ? matched['ยอดบิล']   : '',
      matched_due:       matched ? matched.DueDate     : '',
      matched_dsr_email: matched ? matched.Email       : slip['Email'] || '',
      match_status:      matched ? 'matched' : 'unmatched',
      overdue_days:      matched ? calcOverdue(matched.DueDate) : '',
    }));
  });

  // เขียนผลลัพธ์ลง SLIP_MAPPING sheet
  writeMappingSheet(ss, results);

  Logger.log('Mapped ' + results.filter(function(r){ return r.match_status === 'matched'; }).length
    + ' / ' + results.length + ' slips');

  return {
    total:    results.length,
    matched:  results.filter(function(r){ return r.match_status === 'matched'; }).length,
    unmatched:results.filter(function(r){ return r.match_status === 'unmatched'; }).length,
  };
}

// ─── ดึงข้อมูล SLIPS จาก Make ────────────────────────────────────
function getSlipsData(ss) {
  // อ่านจาก Slip2Go Spreadsheet (คนละไฟล์กับ Operation)
  var slipSS = SpreadsheetApp.openById(prop('SPREADSHEET_ID_SLIP'));
  var sheet  = slipSS.getSheetByName(SM.SLIPS);
  if (!sheet) throw new Error('ไม่พบ Sheet: ' + SM.SLIPS + ' ใน Slip Spreadsheet');

  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var rows    = [];

  data.slice(1).forEach(function(row) {
    if (!row[0]) return; // skip empty rows
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i] || ''; });
    rows.push(obj);
  });

  return rows;
}

// ─── ดึงข้อมูล บิลค้างจ่าย จาก BCAccount ─────────────────────────
function getDebtsData(ss) {
  // อ่านจาก Slip2Go Spreadsheet เช่นกัน (บิลค้างจ่าย sync จาก BCAccount)
  var slipSS = SpreadsheetApp.openById(prop('SPREADSHEET_ID_SLIP'));
  var sheet  = slipSS.getSheetByName(SM.DEBTS);
  if (!sheet) throw new Error('ไม่พบ Sheet: ' + SM.DEBTS + ' ใน Slip Spreadsheet');

  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  var rows    = [];

  data.slice(1).forEach(function(row) {
    if (!row[0]) return;
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i] || ''; });
    rows.push(obj);
  });

  return rows;
}

// ─── MATCHING LOGIC ───────────────────────────────────────────────
// รองรับเลขย่อที่ DSR พิมพ์ เช่น:
//   CA66050-2467  → ย่อเป็น  050-2467  หรือ  50-2467
//   CR66045-2241/1 → ย่อเป็น 045-2241  หรือ  45-2241
function matchSlipToDebt(slip, debts) {
  // DSR พิมพ์: รหัสลูกค้า = รหัสหลัก (col I) เช่น 113-82
  //            เลขที่บิล  = ย่อจาก InvoiceNo เช่น 370-18457 จาก CR69370-18457
  var slipCustomer = String(slip['รหัสลูกค้า'] || '').trim();
  var slipInvoice  = normalizeInvoice(String(slip['เลขที่บิล'] || '').trim());
  var slipEmail    = String(slip['Email'] || '').trim().toLowerCase();

  if (!slipCustomer) return null;

  // กรอง debts ตาม รหัสหลัก (column I) ซึ่ง DSR ใช้พิมพ์
  var candidates = debts.filter(function(d) {
    var rCode = String(d['รหัสหลัก'] || d['รหัสสินค้า'] || '').trim();
    return rCode === slipCustomer;
  });

  if (!candidates.length) return null;

  // ถ้ามีแค่บิลเดียว และไม่ได้ระบุเลขบิล → match เลย
  if (candidates.length === 1 && !slipInvoice) return candidates[0];

  // ถ้าระบุเลขบิล → fuzzy match กับ InvoiceNo
  if (slipInvoice) {
    // Level 1: normalize แล้ว exact match
    var exactMatch = candidates.find(function(d) {
      var inv = normalizeInvoice(String(d.InvoiceNo || d['InvoiceNo'] || ''));
      return inv === slipInvoice;
    });
    if (exactMatch) return exactMatch;

    // Level 2: suffix match
    // slip "370-18457" match กับ normalize("CR69370-18457") = "370-18457" ✅
    var suffixMatch = candidates.find(function(d) {
      var inv = normalizeInvoice(String(d.InvoiceNo || ''));
      return inv.endsWith(slipInvoice) || slipInvoice.endsWith(inv);
    });
    if (suffixMatch) return suffixMatch;

    // Level 3: digit-only match (ตัด dash ออกเทียบ)
    var slipDigits = digitOnly(slipInvoice);
    var digitMatch = candidates.find(function(d) {
      var invDigits = digitOnly(normalizeInvoice(String(d.InvoiceNo || '')));
      return invDigits === slipDigits || invDigits.endsWith(slipDigits) || slipDigits.endsWith(invDigits);
    });
    if (digitMatch) return digitMatch;
  }

  // มีหลายบิลของลูกค้านี้แต่ระบุเลขบิลไม่ตรง → ambiguous
  return { _ambiguous: true, _candidates: candidates, _count: candidates.length };
}

// normalize: ตัด prefix ตัวอักษร + ปีออก, ตัด /suffix ออก
// CA66050-2467  → 050-2467
// CR66045-2241/1 → 045-2241
// INV-67-05617  → 05617  (format ใหม่)
// SUP : SUP     → sup:sup (lower)
function normalizeInvoice(inv) {
  if (!inv) return '';
  inv = inv.trim().toLowerCase();
  // ตัด /ตัวเลข ท้าย เช่น /1
  inv = inv.replace(/\/\d+$/, '');
  // ถ้าเป็น format XX66XXX-XXXX → เอาหลัง XX66 (ปี 2 หลักหลัง prefix)
  // pattern: ตัวอักษร 2+ ตามด้วยเลข 2 หลัก (ปี) แล้วตามด้วยตัวเลข
  inv = inv.replace(/^[a-z]{2,}\d{2}/, '');
  // ตัด INV-67- หรือ INV-68- ออก
  inv = inv.replace(/^inv-\d{2}-/, '');
  // trim whitespace
  return inv.trim();
}

// เอาเฉพาะตัวเลขและ dash
function digitOnly(s) {
  return s.replace(/[^0-9-]/g, '');
}

// ─── คำนวณวันเกินกำหนด ────────────────────────────────────────────
function calcOverdue(dueDateStr) {
  if (!dueDateStr) return '';
  try {
    var due  = new Date(dueDateStr);
    var diff = Math.floor((new Date() - due) / 86400000);
    return diff;
  } catch(e) { return ''; }
}

// ─── เขียนผล mapping ลง Sheet ────────────────────────────────────
function writeMappingSheet(ss, results) {
  var sheet = ss.getSheetByName(SM.MAPPING);
  if (!sheet) {
    sheet = ss.insertSheet(SM.MAPPING);
  }

  var headers = [
    'วันที่ส่งสลิป', 'วันที่โอน', 'เวลาโอน', 'ยอดโอน',
    'รหัสลูกค้า', 'ชื่อร้าน (Slip)', 'เลขที่บิล (Slip)',
    'ชื่อลูกค้า (BCAccount)', 'เลขที่บิล (BCAccount)', 'ยอดบิล',
    'ครบกำหนด', 'อายุหนี้ (วัน)', 'DSR Email',
    'Slip Ref', 'สถานะ Match', 'ชื่อ DSR',
  ];

  var rows = results.map(function(r) {
    return [
      r['วันที่ส่งสลิป'] || '',
      r['วันที่โอน']     || '',
      r['เวลาโอน']       || '',
      r['ยอดเงิน']       || '',
      r['รหัสลูกค้า']    || '',
      r['ชื่อร้าน']      || '',
      r['เลขที่บิล']     || '',
      r['matched_customer']  || '',
      r['matched_invoice']   || '',
      r['matched_amount'] !== undefined ? r['matched_amount'] : '',
      r['matched_due']       || '',
      r['overdue_days']      || '',
      r['matched_dsr_email'] || '',
      r['Slip Ref']          || '',
      r['match_status']      || '',
      r['ชื่อ DSR']          || '',
    ];
  });

  // เคลียร์ข้อมูลเก่าแล้วเขียนใหม่
  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#E8631A').setFontColor('#fff').setFontWeight('bold');
  sheet.setFrozenRows(1);

  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
  }

  // Color code: matched = เขียว, unmatched = แดง
  rows.forEach(function(row, i) {
    var color = row[14] === 'matched' ? '#E2F4ED' : '#FEE9E9';
    sheet.getRange(i + 2, 1, 1, headers.length).setBackground(color);
  });

  Logger.log('Written ' + rows.length + ' rows to ' + SM.MAPPING);
}

// ─── WEEKLY SUMMARY: สรุปรายสัปดาห์ต่อ DSR ──────────────────────
function generateWeeklySummary() {
  var ss      = SpreadsheetApp.openById(prop('SPREADSHEET_ID'));
  var mapping = getMappingData(ss);
  var debts   = getDebtsData(ss);

  // จัดกลุ่มตาม DSR email
  var byDSR = {};
  mapping.forEach(function(row) {
    var email = String(row['DSR Email'] || '').trim();
    if (!email) return;
    if (!byDSR[email]) byDSR[email] = { matched: [], unmatched: [] };
    if (row['สถานะ Match'] === 'matched') byDSR[email].matched.push(row);
    else byDSR[email].unmatched.push(row);
  });

  // คำนวณสรุปต่อ DSR
  var summaries = Object.keys(byDSR).map(function(email) {
    var data      = byDSR[email];
    var totalSlip = data.matched.reduce(function(s, r) {
      return s + (parseFloat(String(r['ยอดโอน']).replace(/[฿,]/g,'')) || 0);
    }, 0);
    var totalBill = data.matched.reduce(function(s, r) {
      return s + (parseFloat(String(r['ยอดบิล']).replace(/[฿,]/g,'')) || 0);
    }, 0);

    return {
      email:          email,
      dsr_name:       data.matched[0] ? data.matched[0]['ชื่อ DSR'] : email,
      matched_count:  data.matched.length,
      unmatched_count:data.unmatched.length,
      total_slip_amt: totalSlip,
      total_bill_amt: totalBill,
      diff:           totalSlip - totalBill,
    };
  });

  // เขียน summary sheet
  writeWeeklySummarySheet(ss, summaries);
  return summaries;
}

function getMappingData(ss) {
  var sheet = ss.getSheetByName(SM.MAPPING);
  if (!sheet) return [];
  var data    = sheet.getDataRange().getValues();
  var headers = data[0];
  return data.slice(1).map(function(row) {
    var obj = {};
    headers.forEach(function(h, i) { obj[h] = row[i] || ''; });
    return obj;
  });
}

function writeWeeklySummarySheet(ss, summaries) {
  var sheet = ss.getSheetByName(SM.SUMMARY);
  if (!sheet) sheet = ss.insertSheet(SM.SUMMARY);

  var now     = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'dd/MM/yyyy HH:mm');
  var headers = ['DSR', 'Email', 'บิล Match', 'บิลไม่ Match',
                 'ยอดโอนรวม (฿)', 'ยอดบิลรวม (฿)', 'ส่วนต่าง (฿)', 'อัปเดตล่าสุด'];

  var rows = summaries.map(function(s) {
    return [
      s.dsr_name, s.email,
      s.matched_count, s.unmatched_count,
      s.total_slip_amt, s.total_bill_amt, s.diff, now
    ];
  });

  sheet.clearContents();
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length)
    .setBackground('#007B40').setFontColor('#fff').setFontWeight('bold');
  sheet.setFrozenRows(1);
  if (rows.length > 0) {
    sheet.getRange(2, 1, rows.length, headers.length).setValues(rows);
    // แดงถ้ามีส่วนต่าง
    rows.forEach(function(row, i) {
      var diff  = parseFloat(row[6]) || 0;
      var color = Math.abs(diff) < 1 ? '#E2F4ED' : diff > 0 ? '#FEF0E7' : '#FEE9E9';
      sheet.getRange(i + 2, 1, 1, headers.length).setBackground(color);
    });
  }
}

// ─── API HANDLER: เรียกจาก DSR Portal ───────────────────────────
function getSlipMappingForPortal(dsrEmail, weekOffset) {
  weekOffset = weekOffset || 0;
  var ss      = SpreadsheetApp.openById(prop('SPREADSHEET_ID'));
  var mapping = getMappingData(ss);

  // Filter ตาม DSR และสัปดาห์
  var filtered = mapping.filter(function(row) {
    if (dsrEmail && row['DSR Email'] !== dsrEmail) return false;
    return true;
  });

  var matched   = filtered.filter(function(r){ return r['สถานะ Match'] === 'matched'; });
  var unmatched = filtered.filter(function(r){ return r['สถานะ Match'] !== 'matched'; });

  var totalAmt = matched.reduce(function(s, r) {
    return s + (parseFloat(String(r['ยอดโอน']).replace(/[฿,]/g,'')) || 0);
  }, 0);

  return {
    matched:       matched,
    unmatched:     unmatched,
    total_amount:  totalAmt,
    matched_count: matched.length,
    slip_count:    filtered.length,
  };
}

// ─── TRIGGER: รัน mapping อัตโนมัติทุกคืน ────────────────────────
function setupDailyMappingTrigger() {
  // ลบ trigger เก่าก่อน
  ScriptApp.getProjectTriggers()
    .filter(function(t){ return t.getHandlerFunction() === 'runSlipMapping'; })
    .forEach(function(t){ ScriptApp.deleteTrigger(t); });

  // สร้าง trigger ใหม่ รันทุกวัน 01:00 น.
  ScriptApp.newTrigger('runSlipMapping')
    .timeBased()
    .everyDays(1)
    .atHour(1)
    .inTimezone('Asia/Bangkok')
    .create();

  Logger.log('Daily mapping trigger set at 01:00 Bangkok time');
}

// ─── MANUAL MATCH: Admin จับคู่เอง ───────────────────────────────
function manualMatch(slipRef, invoiceNo) {
  if (!slipRef || !invoiceNo)
    throw new Error('ต้องระบุทั้ง slipRef และ invoiceNo');

  var ss      = SpreadsheetApp.openById(prop('SPREADSHEET_ID'));
  var mSheet  = ss.getSheetByName(SM.MAPPING);
  if (!mSheet) throw new Error('ไม่พบ SLIP_MAPPING sheet');

  var data    = mSheet.getDataRange().getValues();
  var headers = data[0];
  var refIdx  = headers.indexOf('Slip Ref');
  var stIdx   = headers.indexOf('สถานะ Match');
  var invIdx  = headers.indexOf('เลขที่บิล (BCAccount)');

  for (var i = 1; i < data.length; i++) {
    if (String(data[i][refIdx]).trim() === slipRef) {
      mSheet.getRange(i+1, stIdx+1).setValue('matched_manual');
      mSheet.getRange(i+1, invIdx+1).setValue(invoiceNo);
      mSheet.getRange(i+1, 1, 1, headers.length).setBackground('#FFF3CD');
      Logger.log('Manual match: ' + slipRef + ' → ' + invoiceNo);
      return { success: true };
    }
  }
  throw new Error('ไม่พบ Slip Ref: ' + slipRef);
}

// ─── HELPER ──────────────────────────────────────────────────────
function prop(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

// ─── SETUP: เพิ่ม Script Property SPREADSHEET_ID_SLIP ────────────
// รันครั้งเดียว แล้วใส่ ID ของ Slip2Go Spreadsheet
function setSlipSpreadsheetId() {
  PropertiesService.getScriptProperties().setProperty(
    'SPREADSHEET_ID_SLIP',
    '1pasq-MYRBvUwx3V6BL0Nze5aYpJYhEj1pHTm-eynDjo' // Slip2Go spreadsheet ID
  );
  Logger.log('SPREADSHEET_ID_SLIP set');

  // ทดสอบเปิดได้ไหม
  try {
    var ss    = SpreadsheetApp.openById('1pasq-MYRBvUwx3V6BL0Nze5aYpJYhEj1pHTm-eynDjo');
    var tabs  = ss.getSheets().map(function(s){ return s.getName(); });
    Logger.log('Tabs found: ' + tabs.join(', '));
  } catch(e) {
    Logger.log('ERROR: ' + e.message);
  }
}

// ─── TEST: ทดสอบ mapping โดยไม่เขียน Sheet ──────────────────────
function testMappingDryRun() {
  var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID'));
  var slips = getSlipsData(ss);
  var debts = getDebtsData(ss);

  Logger.log('Slips loaded: ' + slips.length);
  Logger.log('Debts loaded: ' + debts.length);

  var matched = 0, unmatched = 0;
  slips.forEach(function(slip) {
    var result = matchSlipToDebt(slip, debts);
    if (result && result._ambiguous) {
      unmatched++;
      Logger.log('⚠️ Ambiguous: ' + slip['รหัสลูกค้า'] + ' / ' + slip['เลขที่บิล']
        + ' | พบ ' + result._count + ' บิลของลูกค้านี้ — ต้องระบุเลขบิลเพิ่ม');
    } else if (result) {
      matched++;
      Logger.log('✅ Match: ' + slip['รหัสลูกค้า'] + ' / ' + slip['เลขที่บิล']
        + ' → ' + result.InvoiceNo + ' (' + result.Sale + ')'
        + ' ยอด ' + result['ยอดบิล']);
    } else {
      unmatched++;
      Logger.log('❌ No match: ' + slip['รหัสลูกค้า'] + ' / ' + slip['เลขที่บิล']
        + ' | ชื่อร้าน: ' + slip['ชื่อร้าน']);
    }
  });

  Logger.log('─────────────────────────────');
  Logger.log('Matched:   ' + matched + ' / ' + slips.length);
  Logger.log('Unmatched: ' + unmatched + ' / ' + slips.length);
  return { matched: matched, unmatched: unmatched, total: slips.length };
}

// ─── DEBUG: ตรวจ normalize output ────────────────────────────────
function debugNormalize() {
  var testCases = [
    'CR69394-19652',   // → 394-19652
    'CA66050-2467',    // → 050-2467
    'CR66045-2241/1',  // → 045-2241
    'INV-69-01383',    // → 01383
    'INV-67-05617',    // → 05617
    'CR69393-19632',
    'CA69501-25043',
  ];

  testCases.forEach(function(inv) {
    Logger.log(inv + '  →  ' + normalizeInvoice(inv));
  });

  // ทดสอบ slip จริงกับ debt จริง
  // ทดสอบ real cases
  var realTests = [
    ['394-19652',  'CR69394-19652'],
    ['370-18457',  'CR69370-18457'],
    ['400-19976',  'CR69400-19976'],
    ['321-16007',  'CA68321-16007/1'],
    ['183-9135',   'CR67183-9135'],
  ];
  Logger.log('--- Real case tests ---');
  realTests.forEach(function(t) {
    var slipInv = normalizeInvoice(t[0]);
    var debtInv = normalizeInvoice(t[1]);
    var match   = slipInv === debtInv || debtInv.endsWith(slipInv);
    Logger.log((match ? '✅' : '❌') + ' slip=' + slipInv + ' debt=' + debtInv);
  });

  // ทดสอบ รหัสหลัก column name
  Logger.log('--- Check debt column names ---');
  var ss    = SpreadsheetApp.openById(prop('SPREADSHEET_ID_SLIP'));
  var sheet = ss.getSheetByName('บิลค้างจ่าย');
  if (sheet) {
    var headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
    Logger.log('Columns: ' + headers.join(' | '));
    // แสดง row แรกของข้อมูล
    var row1 = sheet.getRange(2, 1, 1, sheet.getLastColumn()).getValues()[0];
    Logger.log('Row2: ' + row1.join(' | '));
  }
}