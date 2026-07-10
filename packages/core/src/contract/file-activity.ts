import type { SessionFileActivity, SessionHead } from "./session.js";

export interface FileActivityResult extends SessionFileActivity {
  session: SessionHead;
}
