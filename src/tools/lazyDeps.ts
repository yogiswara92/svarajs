/**
 * @module tools/lazyDeps
 * SvaraJS - lazy loader for heavy, opt-in dependencies
 *
 * `playwright` is a peer dependency, not a regular one - most SvaraJS users
 * never touch a browser tool, so it isn't installed by default. This loads
 * it on first use and fails with an actionable message instead of a raw
 * "Cannot find module" error.
 */

export async function loadPlaywright(): Promise<typeof import('playwright')> {
  try {
    // Dynamic import - resolved at runtime only, so `playwright` being absent
    // doesn't break `npm install @yesvara/svara` or the build.
    return await import('playwright');
  } catch {
    // This text becomes the tool's error result, which the LLM sees and has
    // to explain to whoever asked - possibly over Telegram/Discord/etc, not
    // just the dashboard. Spelled out plainly so the model relays the real
    // reason (a missing optional dependency, admin-fixable in one click on
    // the dashboard) instead of guessing at a technical excuse.
    throw new Error(
      'Browser automation is not available yet: the optional "playwright" package is not installed on ' +
      'this server. This is not something you can fix from a chat message - tell the person you are ' +
      'talking to that the site owner/admin needs to open the dashboard, go to Settings > Capabilities, ' +
      'and click "Install now" next to the Browser tool warning (or run manually: ' +
      'npm install playwright && npx playwright install chromium). Do not claim the target website itself ' +
      'is the problem (e.g. "it uses JavaScript so it can\'t be scraped") - that is not the reason this failed.'
    );
  }
}

/**
 * Lets the dashboard warn *before* the agent tries (and confusingly fails
 * mid-conversation) instead of only surfacing the missing dependency as a
 * tool-call error the LLM has to explain to the user.
 */
export async function isPlaywrightInstalled(): Promise<boolean> {
  try {
    await import('playwright');
    return true;
  } catch {
    return false;
  }
}
