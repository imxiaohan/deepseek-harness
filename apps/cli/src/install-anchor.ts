/**
 * This dsh installation's manifest anchor: both `src/` and the bundled `lib/`
 * sit one level under `apps/cli`, so the checked-in `package.json` resolves
 * from either artifact.
 * @module @deepseek-ai/dsh/install-anchor
 */

import { fileURLToPath } from 'node:url'

/** Absolute path of the dsh CLI installation's package.json. */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))
