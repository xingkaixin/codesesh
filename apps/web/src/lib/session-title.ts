export interface SessionTitle {
  title: string;
  display_title?: string;
}

export function getSessionDisplayTitle(session: SessionTitle): string {
  return session.display_title ?? session.title;
}
