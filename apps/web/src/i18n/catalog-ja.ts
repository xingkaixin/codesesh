import { messages } from "./messages";

const catalog: Record<string, string> = {};
for (const [key, [, ja]] of Object.entries(messages)) {
  catalog[key] = ja;
}

export default catalog;
