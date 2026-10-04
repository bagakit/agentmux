/** Small valid PDF with selectable Latin/CJK text and a non-embedded standard font. */
export function pdfReaderFixture(withOutline = false): Uint8Array {
  const objects = [
    withOutline ? '<< /Type /Catalog /Pages 2 0 R /Outlines 12 0 R /Names << /Dests << /Names [(second) [8 0 R /Fit]] >> >> >>' : '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [6 0 R 8 0 R 10 0 R] /Count 3 >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type0 /BaseFont /SimSun /Encoding /UniGB-UCS2-H /DescendantFonts [5 0 R] >>',
    '<< /Type /Font /Subtype /CIDFontType0 /BaseFont /SimSun /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 5 >> /DW 1000 >>'
  ]
  for (let index = 0; index < 3; index++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${7 + index * 2} 0 R >>`)
    const text = `BT /F1 24 Tf 54 720 Td (File surface reading - page ${index + 1}) Tj 0 -40 Td /F1 13 Tf (Selectable text, local fonts, and real page navigation.) Tj${index === 1 ? ' 0 -40 Td /F2 20 Tf <4E2D658796058BFB> Tj' : ''} ET\n`
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}endstream`)
  }
  if (withOutline) objects.push(
    '<< /Type /Outlines /First 13 0 R /Last 14 0 R /Count 3 >>',
    '<< /Title (Introduction) /Parent 12 0 R /Next 14 0 R /Dest [6 0 R /Fit] >>',
    '<< /Title (Second chapter) /Parent 12 0 R /Prev 13 0 R /First 15 0 R /Last 15 0 R /Count 1 /Dest (second) >>',
    '<< /Title (Final section) /Parent 14 0 R /Dest [10 0 R /Fit] >>'
  )
  let result = '%PDF-1.4\n'
  const offsets = [0]
  for (const [index, object] of objects.entries()) { offsets.push(result.length); result += `${index + 1} 0 obj\n${object}\nendobj\n` }
  const start = result.length
  result += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`
  return new TextEncoder().encode(result)
}
