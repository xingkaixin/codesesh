import { messages } from "./messages";

const catalog: Record<string, string> = {};
for (const [key, [zh]] of Object.entries(messages)) {
  catalog[key] = zh;
}

export default catalog;
