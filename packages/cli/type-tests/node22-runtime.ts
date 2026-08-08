// @ts-expect-error Node 22 does not include disposable temp directories, added in Node 24.4.
import { mkdtempDisposableSync } from "node:fs";

void mkdtempDisposableSync;
