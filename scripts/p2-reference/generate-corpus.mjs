// P2 reference corpus (ZADANIE-P2-LOONTO-PRO.md §P2.16) - SYNTHETIC documents only.
// No real person, employer or owner document: every name, amount and date below is invented.
// Usage: node scripts/p2-reference/generate-corpus.mjs <outDir>
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { createCanvas } from '@napi-rs/canvas';

const outDir = process.argv[2];
if (!outDir) throw new Error('usage: generate-corpus.mjs <outDir>');
mkdirSync(outDir, { recursive: true });

async function textPdf(pages) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const lines of pages) {
    const page = doc.addPage([595, 842]);
    let y = 790;
    for (const line of lines) {
      const cells = Array.isArray(line) ? line : [line];
      const xs = [50, 260, 330, 400, 470];
      cells.forEach((cell, i) => {
        if (cell === '') return;
        const isHeading = typeof cell === 'string' && cell.startsWith('#');
        page.drawText(isHeading ? cell.slice(1) : cell, { x: Array.isArray(line) ? xs[i] : 50, y, size: isHeading ? 13 : 10, font: isHeading ? bold : font });
      });
      y -= Array.isArray(line) ? 18 : 20;
    }
  }
  return doc.save();
}

// 1. Text-layer payslip PDF (1 page) -------------------------------------------------------------
const PAYSLIP_TEXT = [[
  '#SALARISSPECIFICATIE',
  'Werkgever: Synthetic Uitzend B.V.',
  'Opdrachtgever: Synthetic Client B.V.',
  'Periode: week 10/2026 (02-03-2026 t/m 08-03-2026)',
  'Betaaldatum: 13-03-2026',
  'Uren per week: 40,00',
  '',
  ['Omschrijving', 'Uren', 'Tarief', '%', 'Bedrag'],
  ['Uren normaal', '40,00', '16,20', '', '648,00'],
  ['Overwerk 125%', '4,00', '16,20', '125%', '81,00'],
  ['Overwerk 150%', '6,00', '16,20', '150%', '145,80'],
  ['Toeslag onregelmatig', '8,00', '16,20', '50%', '64,80'],
  ['TOTAAL BRUTO', '', '', '', '939,60'],
  ['Pensioen StiPP Basis', 'grondslag 609,96', '', '7,50%', '45,75-'],
  ['PAWW', 'grondslag 939,60', '', '0,10%', '0,94-'],
  ['LOON VOOR HEFFINGEN', '', '', '', '892,91'],
  ['Loonheffing', '', '', '', '98,22-'],
  ['Netto loon', '', '', '', '794,69'],
  ['Reiskosten', '', '', '', '42,00'],
  ['Huisvesting', '', '', '', '95,00-'],
  ['Uit te betalen', '', '', '', '741,69'],
  'Reservering vakantiegeld: opgebouwd 75,17',
]];

// 2. Contract (5 pages, text layer) ----------------------------------------------------------------
const CONTRACT_PAGES = [
  ['#UITZENDOVEREENKOMST FASE A', 'Werkgever: Synthetic Uitzend B.V.', 'Inlener: Synthetic Client B.V.', 'Functie: Orderpicker',
    'Ingangsdatum: 5 januari 2026', 'Einddatum: 31 december 2026', 'Op deze overeenkomst is de CAO voor Uitzendkrachten (ABU) van toepassing.', 'Fase: A'],
  ['#Artikel 3 Beloning', 'Het bruto uurloon bedraagt EUR 16,20.', 'De arbeidsduur bedraagt 40 uur per week.'],
  ['#Artikel 4 Urengarantie', 'De uitzendkracht heeft recht op betaling van 64,00 uren per 4 weken.'],
  ['#Artikel 5 Overwerk en toeslagen', 'Voor de eerste 2 overuren per dag geldt een betaling van 125% van het uurloon;', 'daarna geldt een betaling van 150% van het uurloon.',
    'Voor uren op zondag wordt 200% van het uurloon betaald.', 'Voor uren op zaterdag geldt een toeslag van 50%.', 'Voor onregelmatige uren geldt een toeslag van 25%.'],
  ['#Artikel 6 Pensioen', 'De uitzendkracht neemt deel aan de pensioenregeling van StiPP.', 'Aldus overeengekomen en getekend.'],
];

// 3. Annex (1 page, text layer) --------------------------------------------------------------------
const ANNEX_PAGES = [[
  '#ADDENDUM BIJ UITZENDOVEREENKOMST', 'Werkgever: Synthetic Uitzend B.V.',
  'Met ingang van 1 september 2026 wordt het bruto uurloon verhoogd naar EUR 16,80.',
  'De overige bepalingen van de overeenkomst blijven ongewijzigd.',
]];

// 4. Photographed payslip (JPEG, no text layer; period type deliberately NOT stated) ---------------
function photoPayslip() {
  const canvas = createCanvas(1240, 1754);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#e9e6df';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.translate(40, 30);
  ctx.rotate(-0.012);
  ctx.fillStyle = '#fbfaf7';
  ctx.fillRect(40, 40, 1100, 1600);
  ctx.fillStyle = '#1d1d1d';
  const rows = [
    ['LOONSTROOK', '', '', ''],
    ['Werkgever: Synthetic Uitzend B.V.', '', '', ''],
    ['Periode 11 / 2026', '', '', ''],
    ['Betaaldatum: 20-03-2026', '', '', ''],
    ['', '', '', ''],
    ['Omschrijving', 'Uren', 'Tarief', 'Bedrag'],
    ['Uren normaal', '38,00', '16,20', '615,60'],
    ['Overwerk 150%', '2,00', '24,30', '48,60'],
    ['Pensioen StiPP Basis 7,50%', '', '', '29,34-'],
    ['PAWW 0,10%', '', '', '0,66-'],
    ['Loonheffing', '', '', '61,10-'],
    ['Netto', '', '', '573,10'],
    ['Uit te betalen', '', '', '573,10'],
  ];
  let y = 120;
  for (const r of rows) {
    ctx.font = r[0] === 'LOONSTROOK' ? 'bold 40px sans-serif' : '30px sans-serif';
    ctx.fillText(r[0], 90, y);
    ctx.fillText(r[1], 620, y);
    ctx.fillText(r[2], 780, y);
    ctx.fillText(r[3], 940, y);
    y += 62;
  }
  return canvas.toBuffer('image/jpeg', 85);
}

// 5. Scanned contract (4 pages, images only, no text layer) ---------------------------------------
function pageImage(lines) {
  const canvas = createCanvas(1240, 1754);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f4f2ec';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#222';
  let y = 140;
  for (const line of lines) {
    const heading = line.startsWith('#');
    ctx.font = heading ? 'bold 36px serif' : '30px serif';
    ctx.fillText(heading ? line.slice(1) : line, 100, y);
    y += 60;
  }
  return canvas.toBuffer('image/jpeg', 80);
}

async function scannedPdf(pages) {
  const doc = await PDFDocument.create();
  for (const lines of pages) {
    const jpg = await doc.embedJpg(pageImage(lines));
    const page = doc.addPage([595, 842]);
    page.drawImage(jpg, { x: 0, y: 0, width: 595, height: 842 });
  }
  return doc.save();
}

writeFileSync(path.join(outDir, 'payslip-text.pdf'), await textPdf(PAYSLIP_TEXT));
writeFileSync(path.join(outDir, 'contract-text.pdf'), await textPdf(CONTRACT_PAGES));
writeFileSync(path.join(outDir, 'annex-text.pdf'), await textPdf(ANNEX_PAGES));
writeFileSync(path.join(outDir, 'payslip-photo.jpg'), photoPayslip());
writeFileSync(path.join(outDir, 'contract-scan.pdf'), await scannedPdf(CONTRACT_PAGES.slice(0, 4)));
console.log(`corpus written to ${outDir}`);
