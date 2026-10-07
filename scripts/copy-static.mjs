// tsc compiles the TypeScript sources; this copies the HTML pages next to them.
import { cpSync } from 'node:fs';

cpSync('src/renderer', 'dist/renderer', { recursive: true, filter: (f) => !/\.[cm]?ts$/.test(f) });
