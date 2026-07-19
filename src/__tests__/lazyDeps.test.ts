import { describe, it, expect } from 'vitest';
import { isPlaywrightInstalled } from '../tools/lazyDeps.js';

describe('isPlaywrightInstalled', () => {
  it('resolves to a boolean without throwing', async () => {
    // playwright is a devDependency of this repo (used by browserTools.test.ts's
    // own imports), so this should resolve true here - the real value of this
    // function is not throwing in environments where it's genuinely absent.
    await expect(isPlaywrightInstalled()).resolves.toBe(true);
  });
});
