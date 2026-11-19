/** Chat answers use the shared renderer (ui/Markdown.tsx) with headings shown as bold lines: a heading in a chat bubble shouts. */
import { Markdown as Md } from "../../ui/Markdown";

export { inline } from "../../ui/Markdown";
export function Markdown({ text }: { text: string }) {
  return <Md text={text} headings={false} />;
}
