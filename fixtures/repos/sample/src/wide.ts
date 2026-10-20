// Wide lines on purpose: several of these are at the 100 character limit of a code scene.
export interface WideRecord {
  readonly identifier: string;
  readonly displayName: string;
}

export function describeRecords(records: readonly WideRecord[], separator = ' | '): string[] {
  const rows: string[] = [];
  for (const record of records) {
    const id = record.identifier.padEnd(12, '.');
    const label = `${id}${separator}${record.displayName.toUpperCase()}`; // upper-case display name
    const clipped = label.length <= 100 ? label : `${label.slice(0, 97)}...`; // max 100 cols
    rows.push(clipped);
  }
  const widest = Math.max(0, ...rows.map((row) => row.length)); // widest label
  rows.push(`${rows.length} record(s) described; the widest label has ${widest} characters.`);
  return rows;
}
