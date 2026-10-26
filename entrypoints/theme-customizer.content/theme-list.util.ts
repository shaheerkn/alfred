import type { ContentScriptContext } from '#imports';
import { getSettings, isEnabled } from '~/utils/settings';
import { sendTrackEvent } from '~/utils/analytics';
import type { AnalyticsAction } from '~/utils/analytics-actions';
import { Toast } from '~/utils/toast';

const INJECTED_ATTR = 'data-alfred-theme-list';
const CHECKBOX_ATTR = 'data-alfred-theme-checkbox';
const TOOLBAR_ATTR = 'data-alfred-bulk-toolbar';
const THEMES_PATH = /\/themes\/?$/;
const DELETE_TEXT = /delete/i;
const CANCEL_TEXT = /cancel/i;
const DIALOG_SELECTOR = 'dialog[open], [role="dialog"], [role="alertdialog"]';

/** How long a confirmed delete gets to actually remove the theme (the mutation's round trip). */
const REMOVAL_TIMEOUT = 20000;
/** After a cancel, how long to still watch for the theme going, in case the answer was misread. */
const CANCEL_GRACE = 1500;
/** How long to wait for the user to answer Shopify's dialog before giving up on the whole run. */
const ANSWER_TIMEOUT = 5 * 60 * 1000;

/**
 * Layout for the injected copy row, checkboxes and bulk-delete toolbar. The actions row is
 * forced to wrap, since rollout cards set it to nowrap, so the full-width copy row drops below
 * it; `contain: inline-size` keeps it out of the actions row's natural width so the existing
 * buttons stay flush right, and a hidden copy of the "more actions" button lines the copy
 * buttons up under "Edit theme". Shopify moves the actions under the theme and aligns them left
 * at 831px and below for library themes, and at 30.6225em and below for the live theme, so the
 * copy row follows and drops the spacer. The live theme card is dark, so its copy buttons take
 * the card's light text and hover colors.
 */
const STYLES = `
  .Polaris-InlineStack:has(> [${INJECTED_ATTR}]) {
    flex-wrap: wrap;
  }
  [${INJECTED_ATTR}] {
    display: flex;
    flex-basis: 100%;
    contain: inline-size;
    justify-content: flex-end;
    gap: var(--p-space-100);
  }
  [${INJECTED_ATTR}] > [inert] {
    visibility: hidden;
    margin-inline-start: var(--p-space-100);
  }
  [class*="PublishedTheme"] [${INJECTED_ATTR}] {
    --p-color-text: var(--p-color-text-brand-on-accent);
    --p-color-icon: var(--p-color-text-brand-on-accent);
    --p-color-bg-fill-transparent-hover: rgba(255, 255, 255, 0.15);
  }
  @media (max-width: 831px) {
    ul[class*="ThemeList"] [${INJECTED_ATTR}] {
      justify-content: flex-start;
    }
    ul[class*="ThemeList"] [${INJECTED_ATTR}] > [inert] {
      display: none;
    }
  }
  @media (max-width: 30.6225em) {
    [class*="PublishedTheme"] [${INJECTED_ATTR}] {
      justify-content: flex-start;
    }
    [class*="PublishedTheme"] [${INJECTED_ATTR}] > [inert] {
      display: none;
    }
  }
  [${CHECKBOX_ATTR}] {
    margin-inline-end: var(--p-space-100);
  }
  [${TOOLBAR_ATTR}] {
    /* Resets the UA stylesheet's defaults for [popover] (inset: 0, border: solid, margin: auto,
       color-scheme-based background), which would otherwise fight with the rules below. */
    inset: auto;
    margin: 0;
    border: none;
    color: inherit;
    position: fixed;
    /* admin.shopify.com's own title bar (_AppTitleBarContainer) lives outside this iframe, so no
       z-index or top-layer trick here can ever render above it -- content can't escape its own
       iframe's box. Clearing its height is the only fix available from inside the iframe. */
    top: 72px;
    left: 50%;
    z-index: 2147483647;
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    align-items: center;
    gap: var(--p-space-200);
    box-sizing: border-box;
    width: 100%;
    max-width: 600px;
    padding: var(--p-space-200) var(--p-space-300);
    background: var(--p-color-bg-surface, #fff);
    border-radius: var(--p-border-radius-300, 12px);
    box-shadow:
      0 8px 24px rgba(0, 0, 0, 0.16),
      0 2px 6px rgba(0, 0, 0, 0.08);
    transform: translate(-50%, -12px);
    opacity: 0;
    visibility: hidden;
    transition:
      opacity 180ms ease,
      transform 180ms ease,
      visibility 0s linear 180ms;
  }
  [${TOOLBAR_ATTR}].alfred-bulk-toolbar--show {
    transform: translate(-50%, 0);
    opacity: 1;
    visibility: visible;
    transition:
      opacity 180ms ease,
      transform 180ms ease;
  }
  [${TOOLBAR_ATTR}] > .alfred-bulk-toolbar__count {
    font-weight: 600;
    white-space: nowrap;
    /* Fixed, with room for the longest realistic text ("Deleting 12 of 15 themes…"), so the
       buttons don't shift as the count's digits or wording change. */
    width: 250px;
    text-align: left;
  }
  /* Fixed to fit "Deselect all", so the buttons don't shift when it swaps with "Select all". */
  [${TOOLBAR_ATTR}] > [data-action="select-all"] {
    display: inline-flex;
    justify-content: center;
    width: 110px;
  }
`;

interface ThemeData {
  themeId: string;
  previewUrl: string;
}

interface ThemeElements extends ThemeData {
  name: string;
  editLink: HTMLAnchorElement;
  actions: Element;
  more: HTMLButtonElement | null;
  card: HTMLElement;
  isPublished: boolean;
}

/** An `s-checkbox` host. Its `checked` property is the component's own state, which it renders. */
type CheckboxElement = HTMLElement & { checked?: boolean };

/**
 * `s-checkbox`'s real `<input type="checkbox">` lives inside its own open shadow root (under
 * `.root > label > .control`). The shadow root only attaches once the element is connected to
 * the live document, so this returns `null` for one still detached.
 * @param checkbox - An `s-checkbox` host element.
 */
const checkboxInput = (checkbox: Element): HTMLInputElement | null =>
  checkbox.shadowRoot?.querySelector<HTMLInputElement>('input[type="checkbox"]') ?? null;

/**
 * Whether an `s-checkbox` is checked, read from the inner input a user's click toggles.
 * @param checkbox - An `s-checkbox` host element.
 */
const isCheckboxChecked = (checkbox: CheckboxElement) => checkboxInput(checkbox)?.checked ?? !!checkbox.checked;

/** Set while {@link setCheckboxChecked} clicks a checkbox, so that click isn't taken as the user's. */
let syncingCheckbox = false;

/**
 * Checks or unchecks an `s-checkbox` from code. The checkmark is drawn from the component's own
 * state, not the inner input, so writing only the input changes nothing visible. The `checked`
 * property and attribute set it on a checkbox the user hasn't touched, but like a native input
 * it stops following them once clicked, so one still showing the wrong state is clicked, the
 * same way a user would, which goes through the component's own handling. Everything is
 * written only when it differs, so a sync pass with nothing to change mutates nothing.
 * @param checkbox - An `s-checkbox` host element.
 * @param checked - Its new state.
 */
const setCheckboxChecked = (checkbox: CheckboxElement, checked: boolean) => {
  if (checkbox.checked !== checked) {
    checkbox.checked = checked;
  }
  if (checkbox.hasAttribute('checked') !== checked) {
    checkbox.toggleAttribute('checked', checked);
  }
  const input = checkboxInput(checkbox);
  if (input && input.checked !== checked) {
    syncingCheckbox = true;
    try {
      input.click();
    } finally {
      syncingCheckbox = false;
    }
  }
};

/**
 * Extracts theme ID and preview URL from a theme's "Edit theme" link.
 * The link points at `/themes/:id/editor`, or `/themes/:id/canvas` for Canvas themes.
 * @param editLink - The theme's "Edit theme" `<a>` element.
 * @returns The parsed theme data, or `null` if the link has no theme ID.
 */
const extractThemeData = (editLink: HTMLAnchorElement): ThemeData | null => {
  const href = editLink.getAttribute('href') ?? '';
  const themeId = /\/themes\/(\d+)/.exec(href)?.[1];
  if (!themeId) {
    return null;
  }

  const storeName = /\/store\/([^/]+)\//.exec(href)?.[1] ?? '';
  const previewUrl = storeName ? `https://${storeName}.myshopify.com/?preview_theme_id=${themeId}` : '';

  return { themeId, previewUrl };
};

/**
 * Parses an HTML string and returns the first element.
 * @param template - The HTML string to parse.
 * @returns The first child element of the parsed HTML.
 */
const html = (template: string): HTMLElement => {
  const container = document.createElement('div');
  container.innerHTML = template.trim();
  return container.firstElementChild as HTMLElement;
};

/**
 * Walks the live theme card and each library theme item, pairing each "Edit theme" link with
 * its actions row, "more actions" button and enclosing card. The live theme sits in a
 * `[class*="PublishedTheme"]` card; library themes each sit in their own `<li>`.
 * @returns One entry per theme found on the page.
 */
const collectThemeElements = (): ThemeElements[] => {
  const editLinks = document.querySelectorAll<HTMLAnchorElement>('a[class*="ThemeActionButton"][href*="/themes/"]');

  const themes: ThemeElements[] = [];

  editLinks.forEach((editLink) => {
    const actions = editLink.closest('.Polaris-InlineStack');
    if (!actions) {
      return;
    }

    const data = extractThemeData(editLink);
    if (!data) {
      return;
    }

    const publishedCard = editLink.closest<HTMLElement>('[class*="PublishedTheme"]');
    const card = publishedCard ?? editLink.closest<HTMLElement>('li');
    if (!card) {
      return;
    }

    const more = actions.querySelector<HTMLButtonElement>(':scope > button[command]');
    const name = card.querySelector('h3')?.textContent?.trim() ?? data.themeId;

    themes.push({ ...data, name, editLink, actions, more, card, isPublished: !!publishedCard });
  });

  return themes;
};

/**
 * Copies the button's `data-copy-value` to clipboard and briefly swaps the icon to a checkmark.
 * @param e - The click event from an `s-internal-button` element.
 */
const handleCopyClick = (e: Event) => {
  e.stopPropagation();
  const btn = e.currentTarget as HTMLElement;
  const value = btn.getAttribute('data-copy-value') ?? '';
  const action = btn.getAttribute('data-track-action');
  navigator.clipboard.writeText(value);
  btn.setAttribute('icon', 'check');
  setTimeout(() => btn.setAttribute('icon', 'clipboard'), 1200);
  if (action) {
    sendTrackEvent(action as AnalyticsAction);
  }
};

/**
 * Adds copy-ID / copy-preview-URL buttons on their own row below the action buttons of
 * the live theme and each theme in the library, laid out by `STYLES`.
 * Both cards share the "Edit theme" link and its `.Polaris-InlineStack` actions row.
 * The buttons use the page's own `s-internal-button` Polaris element.
 * @param themes - Themes found on the current render pass.
 * @returns `true` if at least one theme got a new copy row.
 */
const injectCopyRows = (themes: ThemeElements[]): boolean => {
  let injected = false;

  for (const theme of themes) {
    if (theme.actions.querySelector(`[${INJECTED_ATTR}]`)) {
      continue;
    }

    const row = html(`
      <div ${INJECTED_ATTR}>
        <s-internal-button variant="tertiary" icon="clipboard" data-copy-value="${theme.themeId}" data-track-action="${'admin.theme_list.id_copy' satisfies AnalyticsAction}">ID</s-internal-button>
        <s-internal-button variant="tertiary" icon="clipboard" data-copy-value="${theme.previewUrl}" data-track-action="${'admin.theme_list.preview_url_copy' satisfies AnalyticsAction}">Preview URL</s-internal-button>
      </div>
    `);
    row.querySelectorAll('s-internal-button').forEach((btn) => btn.addEventListener('click', handleCopyClick));

    // The inert copy of the "more actions" button is the spacer `STYLES` hides.
    if (theme.more) {
      const spacer = theme.more.cloneNode(true) as HTMLElement;
      spacer.removeAttribute('commandfor');
      spacer.setAttribute('inert', '');
      row.append(spacer);
    }

    theme.actions.append(row);
    injected = true;
  }

  return injected;
};

/** Theme IDs currently checked for bulk delete. The live theme is never eligible. */
const selectedThemeIds = new Set<string>();

/** Set while a bulk delete is running: which theme it's on, out of how many. */
let progress: { current: number; total: number } | null = null;

/** Set by the toolbar's "Stop" button to end a running bulk delete after the current theme. */
let stopRequested = false;

const themeCount = (n: number) => `${n} theme${n === 1 ? '' : 's'}`;

/**
 * Sets an element's text only when it differs. `updateToolbar` runs on every MutationObserver
 * pass, and an unconditional write is itself a mutation: that fed the observer back into itself,
 * rebuilding the button's contents every frame, so a click's mousedown and mouseup never landed
 * on the same node and the button never fired.
 * @param el - The element to update.
 * @param text - Its new text.
 */
const setText = (el: Element | null, text: string) => {
  if (el && el.textContent !== text) {
    el.textContent = text;
  }
};

/** Library themes on the page that can be selected: every theme but the live one. */
const eligibleThemeIds = () =>
  collectThemeElements()
    .filter((theme) => !theme.isPublished)
    .map((theme) => theme.themeId);

/**
 * Brings every checkbox in line with `selectedThemeIds`, and disables them while a bulk delete
 * runs so the selection can't change under it. Only writes what differs, for the same reason as
 * {@link setText}.
 */
const syncCheckboxes = () => {
  document.querySelectorAll<CheckboxElement>(`[${CHECKBOX_ATTR}]`).forEach((checkbox) => {
    // Enabled first: setCheckboxChecked may click it, and a disabled input ignores clicks.
    if (checkbox.hasAttribute('disabled') !== !!progress) {
      checkbox.toggleAttribute('disabled', !!progress);
    }
    setCheckboxChecked(checkbox, selectedThemeIds.has(checkbox.dataset.themeId ?? ''));
  });
};

/**
 * Shows or hides the floating bulk-delete toolbar and refreshes its text and buttons, and syncs
 * the checkboxes. While a delete runs it shows progress, disables "Select all" and "Delete
 * selected", and turns "Cancel" into "Stop". Visibility is a CSS class, not the `hidden`
 * attribute, so the show/hide transition can animate instead of snapping.
 */
const updateToolbar = () => {
  syncCheckboxes();

  const toolbar = document.querySelector<HTMLElement>(`[${TOOLBAR_ATTR}]`);
  if (!toolbar) {
    return;
  }

  const count = selectedThemeIds.size;
  toolbar.classList.toggle('alfred-bulk-toolbar--show', count > 0 || !!progress);

  setText(
    toolbar.querySelector('.alfred-bulk-toolbar__count'),
    progress ? `Deleting ${progress.current} of ${themeCount(progress.total)}…` : `${themeCount(count)} selected`
  );

  const eligible = eligibleThemeIds();
  const allSelected = eligible.length > 0 && eligible.every((id) => selectedThemeIds.has(id));
  const buttons: [string, string | null, boolean][] = [
    ['select-all', allSelected ? 'Deselect all' : 'Select all', !!progress],
    ['cancel', progress ? (stopRequested ? 'Stopping…' : 'Stop') : 'Cancel', !!progress && stopRequested],
    ['delete', null, !!progress]
  ];
  for (const [action, text, disabled] of buttons) {
    const button = toolbar.querySelector(`[data-action="${action}"]`);
    if (text !== null) {
      setText(button, text);
    }
    if (button && button.hasAttribute('disabled') !== disabled) {
      button.toggleAttribute('disabled', disabled);
    }
  }
};

/**
 * Toggles a theme's selection and refreshes the toolbar.
 * @param themeId - The theme being checked or unchecked.
 * @param checked - The checkbox's new state.
 */
const handleCheckboxChange = (themeId: string, checked: boolean) => {
  if (syncingCheckbox) {
    return; // Alfred's own click, already matching the selection
  }
  if (progress) {
    updateToolbar(); // puts the checkbox back; the selection is fixed while a delete runs
    return;
  }
  if (checked) {
    selectedThemeIds.add(themeId);
  } else {
    selectedThemeIds.delete(themeId);
  }
  updateToolbar();
};

/**
 * Adds a selection checkbox beside each library theme's name, skipping the live theme (Shopify
 * doesn't allow deleting the published theme). Checked state comes from `selectedThemeIds` via
 * {@link syncCheckboxes}, so it survives React re-rendering the row away and Alfred re-adding it.
 *
 * Uses the page's own `s-checkbox` element (Shopify's Polaris web component, also documented
 * publicly at shopify.dev/docs/api/checkout-ui-extensions/.../forms/checkbox) rather than a
 * hand-styled `<input>`, so it matches Shopify's own checkbox design for free. `accessibilitylabel`
 * (not `label`) gives it a screen-reader-only label, since the theme's name is already visible
 * right next to it. State goes through its real inner `<input>` (see {@link checkboxInput}), and
 * only after it's inserted into the document, since that's when its shadow root attaches.
 * @param themes - Themes found on the current render pass.
 * @returns `true` if at least one theme got a new checkbox.
 */
const injectCheckboxes = (themes: ThemeElements[]): boolean => {
  let injected = false;

  for (const theme of themes) {
    if (theme.isPublished) {
      continue;
    }

    const heading = theme.card.querySelector('h3');
    const nameStack = heading?.closest('.Polaris-InlineStack');
    if (!nameStack || nameStack.querySelector(`[${CHECKBOX_ATTR}]`)) {
      continue;
    }

    const checkbox = html(`
      <s-checkbox ${CHECKBOX_ATTR} data-theme-id="${theme.themeId}" accessibilitylabel="Select ${theme.name} for bulk delete"></s-checkbox>
    `);
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      handleCheckboxChange(theme.themeId, isCheckboxChecked(checkbox));
    });

    nameStack.prepend(checkbox);
    injected = true;
  }

  if (injected) {
    syncCheckboxes();
  }
  return injected;
};

/**
 * Drops selected themes that are no longer on the page (deleted from Shopify's own menu, say),
 * so the count never includes themes that can't be acted on. Skipped while a bulk delete runs,
 * which settles its own themes, and while the list isn't rendered at all.
 */
const pruneSelection = () => {
  if (progress || selectedThemeIds.size === 0 || !document.querySelector('ul[class*="ThemeList"]')) {
    return;
  }
  const eligible = new Set(eligibleThemeIds());
  for (const id of selectedThemeIds) {
    if (!eligible.has(id)) {
      selectedThemeIds.delete(id);
    }
  }
};

/**
 * Unchecks every theme, clears the selection and hides the toolbar. Deletes nothing.
 */
const clearSelection = () => {
  selectedThemeIds.clear();
  updateToolbar();
};

/**
 * Selects every library theme on the page, or clears the selection if they all already are.
 */
const handleSelectAllClick = () => {
  if (progress) {
    return;
  }
  const eligible = eligibleThemeIds();
  if (eligible.every((id) => selectedThemeIds.has(id))) {
    clearSelection();
    return;
  }
  eligible.forEach((id) => selectedThemeIds.add(id));
  updateToolbar();
};

/**
 * The toolbar's "Cancel" button: clears the selection normally, or asks a running bulk delete
 * to stop once the theme it's on is settled.
 */
const handleCancelClick = () => {
  if (progress) {
    stopRequested = true;
    updateToolbar();
  } else {
    clearSelection();
  }
};

/**
 * Adds the floating bulk-delete toolbar (fixed to the top center of the iframe's own viewport)
 * if it isn't already there (React re-renders can remove it, same as the per-theme injections).
 * It's a direct child of `<body>`, not anchored near the list: being `position: fixed`, where
 * it sits in the DOM doesn't affect where it renders, and `<body>` sidesteps the manual slot
 * assignment on `<s-internal-section>` (see the theme-list-placement test) for good.
 *
 * It also opens as a `popover="manual"`, the same mechanism {@link Toast} uses, which promotes
 * it into the browser's top layer: rendered above *all* regular content in this document
 * regardless of any ancestor's z-index, stacking context, `overflow`, or `transform` —
 * including Shopify's own `s-popover`/`s-modal` elements, which are top-layer themselves, so a
 * merely-high z-index on a regular element can still lose to them. `showPopover()` is called
 * once, right here, and never again: afterwards visibility is purely the `--show` class below,
 * so repeat calls (which the Popover API throws on if already open) never happen.
 *
 * "This document" is the operative limit: admin.shopify.com's own title bar lives outside this
 * iframe, in the parent frame, which no amount of z-index or top-layer promotion in here can
 * ever render above — an iframe's content can't paint outside its own box. `STYLES`' `top`
 * offset on this toolbar instead just clears the title bar's height so the two don't overlap.
 */
const injectBulkToolbar = () => {
  if (document.querySelector(`[${TOOLBAR_ATTR}]`)) {
    updateToolbar();
    return;
  }

  if (!document.querySelector('ul[class*="ThemeList"]')) {
    return;
  }

  const toolbar = html(`
    <div ${TOOLBAR_ATTR} popover="manual">
      <span class="alfred-bulk-toolbar__count"></span>
      <s-internal-button variant="tertiary" data-action="select-all">Select all</s-internal-button>
      <s-internal-button variant="tertiary" data-action="cancel">Cancel</s-internal-button>
      <s-internal-button variant="primary" data-action="delete">Delete selected</s-internal-button>
    </div>
  `);
  toolbar.querySelector('[data-action="select-all"]')?.addEventListener('click', handleSelectAllClick);
  toolbar.querySelector('[data-action="cancel"]')?.addEventListener('click', handleCancelClick);
  toolbar.querySelector('[data-action="delete"]')?.addEventListener('click', () => void confirmAndDeleteSelected());

  document.body.append(toolbar);
  toolbar.showPopover?.();
  updateToolbar();
};

/**
 * Waits for `check` to return a truthy value, polling every `interval` ms up to `timeout` ms.
 * Used to wait out Shopify's own async rendering (popovers, modals, list updates) since there's
 * no event to subscribe to for any of them.
 * @param check - Returns the found value, or a falsy value to keep waiting.
 * @param options - `timeout` and poll `interval` in milliseconds.
 * @returns The found value, or `null` if `timeout` elapsed first.
 */
const waitFor = async <T>(
  check: () => T | null | undefined | false,
  { timeout = 3000, interval = 50 }: { timeout?: number; interval?: number } = {}
): Promise<T | null> => {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = check();
    if (result) {
      return result;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  return null;
};

/**
 * Finds the "Delete" item in a theme's "more actions" popover. Shopify marks it with
 * `Polaris-ActionList--destructive` (it's the only destructive item in that menu), which is
 * tried first; falling back to matching its visible text in case that class ever changes.
 * @param popoverId - The `id` of the `s-popover` opened by the theme's "more actions" button.
 */
const findPopoverDeleteItem = (popoverId: string): HTMLElement | null => {
  const popover = document.getElementById(popoverId);
  if (!popover) {
    return null;
  }

  const destructive = popover.querySelector<HTMLElement>('.Polaris-ActionList--destructive');
  if (destructive) {
    return destructive;
  }

  for (const item of popover.querySelectorAll<HTMLElement>('a, button')) {
    if (DELETE_TEXT.test(item.textContent ?? '')) {
      return item;
    }
  }
  return null;
};

/**
 * Finds Shopify's open delete-confirmation dialog, if it's in this frame: a `<dialog open>` or
 * `[role="dialog"]`/`[role="alertdialog"]` that mentions "delete", including one rendered inside
 * an `s-modal`'s open shadow root. The theme's own "more actions" popover also says "Delete", so
 * it's excluded.
 * @param exclude - The theme's "more actions" popover.
 */
const findOpenDialog = (exclude: Element | null): HTMLElement | null => {
  const candidates = [...document.querySelectorAll<HTMLElement>(DIALOG_SELECTOR)];
  for (const modal of document.querySelectorAll<HTMLElement>('s-modal, s-internal-modal')) {
    if (modal.shadowRoot?.querySelector('dialog[open]')) {
      candidates.push(modal);
    }
  }

  return (
    candidates.find(
      (dialog) =>
        !exclude?.contains(dialog) &&
        !dialog.hidden &&
        dialog.getAttribute('aria-hidden') !== 'true' &&
        DELETE_TEXT.test(`${dialog.textContent ?? ''} ${dialog.shadowRoot?.textContent ?? ''}`)
    ) ?? null
  );
};

/**
 * Records which way the user answers Shopify's confirmation dialog, without touching it: a click
 * on a "Delete" button inside it is a confirm, any other button in it (Cancel, the close X) or
 * Escape is a cancel. Listens in the capture phase so it sees the click before Shopify's own
 * handler closes the dialog.
 * @param dialog - The open dialog from {@link findOpenDialog}.
 * @returns The answer so far (`null` until one is seen), and a function to stop listening.
 */
const watchDialogAnswer = (dialog: HTMLElement) => {
  let answer: 'confirm' | 'cancel' | null = null;

  const onClick = (e: Event) => {
    const path = e.composedPath();
    if (!path.includes(dialog)) {
      return;
    }
    const button = path.find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.matches('button, [role="button"], s-button, s-internal-button')
    );
    if (!button) {
      return;
    }
    const text = `${button.textContent ?? ''} ${button.getAttribute('aria-label') ?? ''}`;
    answer = DELETE_TEXT.test(text) && !CANCEL_TEXT.test(text) ? 'confirm' : 'cancel';
  };
  const onKeydown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      answer = 'cancel';
    }
  };

  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKeydown, true);

  return {
    answer: () => answer,
    stop: () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeydown, true);
    }
  };
};

/** How one theme's delete ended: removed, canceled by the user in Shopify's dialog, or failed. */
type DeleteOutcome = { status: 'deleted' } | { status: 'canceled' } | { status: 'failed'; reason: string };

const DELETED: DeleteOutcome = { status: 'deleted' };
const CANCELED: DeleteOutcome = { status: 'canceled' };
const failed = (reason: string): DeleteOutcome => ({ status: 'failed', reason });

/**
 * Whether a theme is no longer in the list. Checked by ID, freshly, rather than against a
 * captured node: an unrelated re-render can replace a theme's whole subtree with an equivalent
 * node, which a reference-identity check would report as "not removed". Off the themes page
 * every theme is "missing", so nothing counts as gone there.
 * @param themeId - The theme to look for.
 */
const isGone = (themeId: string) =>
  THEMES_PATH.test(window.location.pathname) && !collectThemeElements().some((t) => t.themeId === themeId);

/**
 * Deletes one theme by driving Shopify's own UI: opens its "more actions" popover and clicks
 * "Delete". Shopify then either deletes it straight away (seen for drafts) or asks first. Its
 * confirmation is left entirely to the user: Alfred never clicks it, only watches for the dialog
 * to close and which button closed it, then checks whether the theme actually went.
 * @param theme - The theme to delete, as collected by {@link collectThemeElements}.
 * @returns How it ended. Never rejects on a cancel and never waits forever for an answer.
 */
const deleteOneTheme = async (theme: ThemeElements): Promise<DeleteOutcome> => {
  const popoverId = theme.more?.getAttribute('commandfor');
  if (!theme.more || !popoverId) {
    return failed("Couldn't find the actions menu");
  }

  theme.more.click();

  const deleteItem = await waitFor(() => findPopoverDeleteItem(popoverId));
  if (!deleteItem) {
    theme.more.click(); // best-effort: close the popover we opened
    return failed("Couldn't find a delete option in the menu");
  }
  const popover = document.getElementById(popoverId);

  // A browser-native confirm() blocks inside click() until it's answered, so a click that takes
  // this long means one was shown. Which button was pressed can't be read back from it, so the
  // theme disappearing is the only signal: if it hasn't by the deadline, that was a cancel.
  const clickedAt = Date.now();
  deleteItem.click();
  if (Date.now() - clickedAt > 250) {
    return (await waitFor(() => isGone(theme.themeId), { timeout: REMOVAL_TIMEOUT })) ? DELETED : CANCELED;
  }

  const first = await waitFor(() => (isGone(theme.themeId) ? 'deleted' : findOpenDialog(popover)), {
    timeout: REMOVAL_TIMEOUT
  });
  if (first === 'deleted') {
    return DELETED;
  }
  if (!first) {
    return failed("It wasn't removed, and no confirmation dialog showed up in the theme list");
  }

  const watcher = watchDialogAnswer(first);
  try {
    const settled = await waitFor(
      () => (isGone(theme.themeId) ? 'deleted' : !findOpenDialog(popover) ? 'closed' : null),
      { timeout: ANSWER_TIMEOUT, interval: 100 }
    );
    if (settled === 'deleted') {
      return DELETED;
    }
    if (!settled) {
      // Carrying on would click the next theme's menu behind a dialog that's still open.
      stopRequested = true;
      return failed("Shopify's confirmation was left unanswered");
    }

    const confirmed = watcher.answer() === 'confirm';
    const gone = await waitFor(() => isGone(theme.themeId), { timeout: confirmed ? REMOVAL_TIMEOUT : CANCEL_GRACE });
    if (gone) {
      return DELETED;
    }
    return confirmed ? failed('It was still there after confirming') : CANCELED;
  } finally {
    watcher.stop();
  }
};

interface BulkDeleteResult {
  deleted: string[];
  canceled: string[];
  failed: { id: string; name: string; reason: string }[];
  /** Themes never reached because the run was stopped. */
  stopped: string[];
}

/**
 * Deletes each theme in turn, one at a time to avoid racing Shopify's own popovers and modals.
 * Each theme is independent: a cancel, failure or thrown error on one moves on to the next.
 * Deleted themes leave the selection; canceled, failed and stopped ones stay selected to retry.
 * @param ids - Theme IDs to delete.
 */
const deleteThemes = async (ids: string[]): Promise<BulkDeleteResult> => {
  const result: BulkDeleteResult = { deleted: [], canceled: [], failed: [], stopped: [] };

  for (const [index, id] of ids.entries()) {
    if (stopRequested) {
      result.stopped.push(...ids.slice(index));
      break;
    }

    progress = { current: index + 1, total: ids.length };
    updateToolbar();

    const theme = await waitFor(() => collectThemeElements().find((t) => t.themeId === id), { timeout: 1000 });
    let outcome: DeleteOutcome;
    try {
      // Selected themes come from the list, so one missing from it has already been deleted.
      outcome = theme ? await deleteOneTheme(theme) : isGone(id) ? DELETED : failed('The theme list went away');
    } catch (error) {
      outcome = failed(error instanceof Error ? error.message : String(error));
    }

    if (outcome.status === 'deleted') {
      result.deleted.push(id);
      selectedThemeIds.delete(id);
    } else if (outcome.status === 'canceled') {
      result.canceled.push(id);
    } else {
      const name = theme?.name ?? id;
      console.warn(`Alfred: couldn't bulk-delete theme "${name}" (${id}): ${outcome.reason}`);
      result.failed.push({ id, name, reason: outcome.reason });
    }

    // Lets Shopify's own UI settle (popover/modal close animations) before the next theme.
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // A slow delete can land after its theme was given up on; count it as what it turned out to be.
  for (const id of [...result.canceled, ...result.failed.map((f) => f.id)]) {
    if (isGone(id)) {
      result.canceled = result.canceled.filter((c) => c !== id);
      result.failed = result.failed.filter((f) => f.id !== id);
      result.deleted.push(id);
      selectedThemeIds.delete(id);
    }
  }

  return result;
};

/**
 * Sums up a bulk delete for the toast, e.g. "Deleted 3 themes, skipped 2 you canceled."
 * @param result - What {@link deleteThemes} returned.
 */
const summarizeBulkDelete = ({ deleted, canceled, failed, stopped }: BulkDeleteResult) => {
  const parts = [`Deleted ${themeCount(deleted.length)}`];
  if (canceled.length > 0) {
    parts.push(`skipped ${canceled.length} you canceled`);
  }
  if (stopped.length > 0) {
    parts.push(`stopped before ${stopped.length}`);
  }
  if (failed.length > 0) {
    parts.push(`couldn't delete ${failed.map((f) => f.name).join(', ')}`);
  }
  return `${parts.join(', ')}.`;
};

/**
 * Confirms, then deletes every checked theme, reporting the outcome via a toast and tracking
 * how many were actually removed. The toolbar always leaves its "Deleting" state, however the
 * run ends.
 */
const confirmAndDeleteSelected = async () => {
  const ids = [...selectedThemeIds];
  if (ids.length === 0 || progress) {
    return;
  }

  if (!confirm(`Delete ${themeCount(ids.length)}? Shopify may ask you to confirm each one. This can't be undone.`)) {
    return;
  }

  stopRequested = false;
  progress = { current: 0, total: ids.length };
  updateToolbar();

  let result: BulkDeleteResult;
  try {
    result = await deleteThemes(ids);
  } finally {
    progress = null;
    stopRequested = false;
    // Navigating away mid-run stops it; what's left of the selection goes with the page.
    if (THEMES_PATH.test(window.location.pathname)) {
      updateToolbar();
    } else {
      clearSelection();
    }
  }

  if (result.deleted.length > 0) {
    sendTrackEvent('admin.theme_list.theme_remove' as AnalyticsAction, { count: result.deleted.length });
  }

  Toast.show(summarizeBulkDelete(result), result.failed.length > 0 ? 'error' : 'success', 6000);
};

/**
 * Adds the copy buttons, selection checkboxes and bulk-delete toolbar for the live theme and
 * each theme in the library. Themes whose injections React has re-rendered away get them back
 * on the next scan.
 * @returns `true` if at least one theme was newly injected into.
 */
export const injectIntoThemeList = () => {
  const themes = collectThemeElements();

  const injected = injectCopyRows(themes);
  const checkboxesInjected = injectCheckboxes(themes);
  pruneSelection();
  injectBulkToolbar();

  return injected || checkboxesInjected;
};

/**
 * Adds the theme list buttons while the frame is on /themes, on first load and after
 * client-side navigation. A MutationObserver covers the list rendering after the URL changes.
 * @param ctx - The content script context, used to watch URL changes and clean up.
 */
export const setupThemeList = async (ctx: ContentScriptContext) => {
  const settings = await getSettings();
  if (!isEnabled(settings.admin.themeListUtils)) {
    return;
  }

  const style = document.createElement('style');
  style.textContent = STYLES;
  document.head.append(style);

  let observer: MutationObserver | undefined;

  const sync = (pathname: string) => {
    if (!THEMES_PATH.test(pathname)) {
      observer?.disconnect();
      observer = undefined;
      // The toolbar is fixed to <body>, so it would otherwise float over the next page.
      if (progress) {
        stopRequested = true;
      } else {
        clearSelection();
      }
      return;
    }
    if (observer) {
      return;
    }

    injectIntoThemeList();

    let queued = false;
    observer = new MutationObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        injectIntoThemeList();
        queued = false;
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  };

  sync(window.location.pathname);
  ctx.addEventListener(window, 'wxt:locationchange', ({ newUrl }) => sync(newUrl.pathname));
  ctx.onInvalidated(() => {
    observer?.disconnect();
    style.remove();
    // Removing an open popover element closes it too, no separate hidePopover() needed.
    document.querySelector(`[${TOOLBAR_ATTR}]`)?.remove();
  });
};
