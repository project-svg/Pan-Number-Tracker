# IRD Nepal PAN Filing Status Checker — Chrome Extension v2

## What's new in v2
- ✅ Runs in the background — works even when you click away or close the popup
- ✅ NON-FILER year now recorded in the Excel export (`NON_FILER_YEAR` column)
- ✅ State is saved — reopen the popup anytime to see live progress

---

## ⚠ STEP 0 — Add SheetJS (required, one-time)

The extension needs one library file that cannot be bundled from a CDN:

1. Open this link in your browser and save the file:
   **https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js**
   (Right-click the page → Save As → filename: `xlsx.full.min.js`)
2. Copy it into the extension folder, replacing the placeholder file there.

---

## Installation on your laptop (Chrome / Edge / Brave)

### Step 1 — Extract the zip
- Right-click `pan-checker-extension-v2.zip`
- Click **Extract All** (Windows) or double-click (Mac)
- You'll get a folder called `pan-checker-extension`
- Put it somewhere permanent — e.g. `Documents\pan-checker-extension`
  ⚠ **Do not move or delete this folder after installing** — Chrome loads it from this location every time

### Step 2 — Add SheetJS into the folder (see Step 0 above)
The folder must contain `xlsx.full.min.js` before you load the extension.

### Step 3 — Enable Developer Mode in Chrome
1. Open Chrome
2. In the address bar type: `chrome://extensions` and press Enter
3. In the top-right corner, toggle **Developer mode** ON
   (you'll see a blue toggle switch appear)

### Step 4 — Load the extension
1. Click the **Load unpacked** button (top-left)
2. Navigate to and select the `pan-checker-extension` folder
3. Click **Select Folder**
4. The extension appears in the list with the name "IRD Nepal PAN Filing Status Checker"

### Step 5 — Pin it to your toolbar (optional but recommended)
1. Click the puzzle-piece icon 🧩 in Chrome's top-right corner
2. Find "IRD Nepal PAN Filing Status Checker"
3. Click the pin icon 📌 next to it
4. The IRD icon now shows in your toolbar permanently

---

## How to use

### Prepare your Excel file
Your file needs at minimum one column:

| Column | Required? | Notes |
|--------|-----------|-------|
| `PAN_NUMBER` | ✅ Yes | The PAN numbers to check |
| `FILING_STATUS` | No | If already filled (FILER/NON-FILER), that row is skipped |
| `FILER_YEAR` | No | Auto-filled for filers |
| `NON_FILER_YEAR` | No | Auto-filled for non-filers |
| `REMARKS` | No | Auto-filled with notes |

Sheet name: **PAN Filing Status** (or the first sheet is used).

### Running a check
1. Click the IRD extension icon in your toolbar
2. **Upload** your Excel file — drag & drop or click to browse
3. Set **Delay** to 4–6 seconds (lower = faster but more likely to hit CAPTCHA)
4. Click **▶ Start**
5. You can now click away — checking runs in the background
6. Reopen the popup anytime to see live progress
7. When done, click **↓ Export Excel** to download results

### If CAPTCHA appears
- A blue notice appears in the popup
- Click the link to switch to the IRD tab
- Solve the CAPTCHA
- Come back — the next PAN starts automatically after 30 seconds

---

## Exported Excel format (v2)

The exported file has two sheets:

**Sheet 1: PAN Filing Status**
| Column | Description |
|--------|-------------|
| S.N. | Row number |
| PAN_NUMBER | The PAN checked |
| FILING_STATUS | FILER / NON-FILER / CAPTCHA / ERROR / PENDING |
| FILER_YEAR | Fiscal year(s) for filers (e.g. `2079/80`) |
| NON_FILER_YEAR | Fiscal year IRD checked for non-filers (e.g. `2079/80`) |
| REMARKS | Notes (e.g. "No filing found for FY 2079/80") |

**Sheet 2: Summary** — total counts by category

---

## Troubleshooting

**"Column PAN_NUMBER not found"**
→ Check your Excel column header spelling. You can change the column name in the "PAN Column Name" field before uploading.

**All results show ERROR / Timeout**
→ IRD's website may have changed its layout. Try opening https://ird.gov.np/pan-search/ manually and checking if it loads.

**Extension disappears after Chrome restart**
→ This happens if you move or delete the extension folder. Reload it from `chrome://extensions` → Load unpacked.

**NON_FILER_YEAR is empty**
→ IRD may not show a year on the result page for some PANs. The REMARKS column will still say "Record not found". This is an IRD website limitation.

---

## Privacy & Security
- Everything runs locally in your own browser
- No data is sent to any external server
- The extension only has permission to access `ird.gov.np`
- No accounts, logins, or telemetry of any kind
