/**
 * AI-001: the model's answer as display blocks - short paragraphs and "- " bullet lists, which is all the advisor is
 * asked to write. Rendered by React as text (never as HTML); stray markdown emphasis or heading marks are dropped
 * rather than interpreted. The words themselves are passed through untouched.
 */

export type TextBlock = { kind: 'p'; text: string } | { kind: 'ul'; items: string[] } | { kind: 'ol'; items: string[] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const NUMBERED = /^\s*\d{1,2}[.)]\s+(.*)$/;
const clean = (line: string) => line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/^#{1,6}\s+/, '').trim();

export function textBlocks(answer: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) blocks.push({ kind: 'p', text: paragraph.join(' ') });
    paragraph = [];
  };
  for (const raw of answer.replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = BULLET.exec(raw);
    const numbered = bullet ? null : NUMBERED.exec(raw);
    if (bullet || numbered) {
      flush();
      const kind = bullet ? 'ul' : 'ol';
      const item = clean((bullet ?? numbered)![1] as string);
      const last = blocks[blocks.length - 1];
      if (last && last.kind === kind) last.items.push(item);
      else blocks.push({ kind, items: [item] });
      continue;
    }
    const line = clean(raw);
    if (line === '') flush();
    else paragraph.push(line);
  }
  flush();
  return blocks.filter((b) => (b.kind === 'p' ? b.text.length > 0 : b.items.length > 0));
}
