import { desktopIcons } from '../generated/desktop';
import { currentDesktopIcons } from '../generated/currentDesktopIcons';
export function Icon({ name }: { name: string }) {
  return <span aria-hidden="true" className="icon" dangerouslySetInnerHTML={{ __html: currentDesktopIcons[name] ?? desktopIcons[name] ?? desktopIcons.Help }} />;
}
