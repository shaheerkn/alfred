import type { ContentScriptContext } from '#imports';
import { getSettings, isEnabled } from '~/utils/settings';
import { sendTrackEvent } from '~/utils/analytics';
import type { AnalyticsAction } from '~/utils/analytics-actions';
import { Toast } from '~/utils/toast';
import { sendRuntimeMessage, type ThemeDeleteResponse } from '~/utils/messages';

const INJECTED_ATTR = 'data-alfred-theme-list';
const CHECKBOX_ATTR = 'data-alfred-theme-checkbox';
const TOOLBAR_ATTR = 'data-alfred-bulk-toolbar';
const SELECT_ALL_ATTR = 'data-alfred-select-all';
const THEMES_PATH = /\/themes\/?$/;
const DELETED_ATTR = 'data-alfred-deleted';
/** The theme library header's Import/New button group, on stores that have New. See `findThemeActions`. */
const THEME_ACTIONS_SELECTOR = '[role="group"][aria-label="Theme actions"]';

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
  /* The checkbox sits before the card's thumbnail/details grid, which takes the remaining width. */
  :has(> [${CHECKBOX_ATTR}]) {
    display: flex;
    align-items: center;
    gap: var(--p-space-300);
  }
  :has(> [${CHECKBOX_ATTR}]) > .Polaris-InlineGrid {
    flex: 1;
    min-width: 0;
  }
  [${DELETED_ATTR}] {
    display: none !important;
  }
  /* Shopify's group is nowrap; on narrow screens the toolbar would push Import and New off the
     edge, so it wraps onto its own line instead. */
  .Polaris-InlineStack:has(> [${TOOLBAR_ATTR}]) {
    flex-wrap: wrap;
    justify-content: flex-end;
  }
  [${TOOLBAR_ATTR}] {
    display: none;
    align-items: center;
    gap: var(--p-space-200);
  }
  [${TOOLBAR_ATTR}].alfred-bulk-toolbar--show {
    display: flex;
  }
  /* Fixed so the buttons don't shift as the count and progress in its text change. */
  [${TOOLBAR_ATTR}] > [data-action="delete"] {
    display: inline-flex;
    justify-content: center;
    width: 124px;
  }
  /* "Select all" sits in line after the theme library heading. */
  :has(> [${SELECT_ALL_ATTR}]) {
    display: flex;
    align-items: center;
    gap: var(--p-space-300);
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

/**
 * Themes Alfred deleted through the API. Shopify's list doesn't know they're gone until it next
 * loads its data, so their cards are hidden in the meantime.
 */
const deletedThemeIds = new Set<string>();

/** Hides the cards of themes Alfred deleted, including ones React has rendered again. */
const hideDeletedThemes = () => {
  for (const theme of collectThemeElements()) {
    if (deletedThemeIds.has(theme.themeId) && !theme.card.hasAttribute(DELETED_ATTR)) {
      theme.card.setAttribute(DELETED_ATTR, '');
    }
  }
};

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

/** Library themes on the page that can be selected: every theme but the live one and deleted ones. */
const eligibleThemeIds = () =>
  collectThemeElements()
    .filter((theme) => !theme.isPublished && !deletedThemeIds.has(theme.themeId))
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

/** Shared by every fixed-width toolbar button's shadow root; created on first use. */
let fillButtonSheet: CSSStyleSheet | null = null;

/**
 * Stretches the real `<button>` inside the fixed-width toolbar buttons to their full width, so
 * the whole width is filled and clickable. It lives in `s-internal-button`'s shadow root, which
 * page CSS can't reach, so the rule is adopted into that root; `!important` beats the
 * component's own sizing of `.button`. Runs on every toolbar update, since a shadow root can
 * attach after the toolbar is inserted, and skips roots that already have the rule. Adopting a
 * sheet isn't a DOM mutation, so it can't retrigger the observer.
 * @param toolbar - The bulk-delete toolbar.
 */
const fillFixedWidthButtons = (toolbar: HTMLElement) => {
  for (const button of toolbar.querySelectorAll('[data-action="delete"]')) {
    const root = button.shadowRoot;
    if (!root || (fillButtonSheet && root.adoptedStyleSheets.includes(fillButtonSheet))) {
      continue;
    }
    if (!fillButtonSheet) {
      fillButtonSheet = new CSSStyleSheet();
      fillButtonSheet.replaceSync('button.button { width: 100% !important; inline-size: 100% !important; }');
    }
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, fillButtonSheet];
  }
};

/**
 * Refreshes the "Select all" button beside the theme library heading. Always shown, so a
 * selection can start from it; it reads "Deselect all" once every theme is selected, and is
 * disabled while a delete runs or when there are no themes to select. Only writes what differs,
 * like the toolbar.
 */
const updateSelectAll = () => {
  const button = document.querySelector(`[${SELECT_ALL_ATTR}]`);
  if (!button) {
    return;
  }
  const eligible = eligibleThemeIds();
  const allSelected = eligible.length > 0 && eligible.every((id) => selectedThemeIds.has(id));
  setText(button, allSelected ? 'Deselect all' : 'Select all');
  const disabled = !!progress || eligible.length === 0;
  if (button.hasAttribute('disabled') !== disabled) {
    button.toggleAttribute('disabled', disabled);
  }
};

/**
 * Shows or hides the bulk-delete toolbar, refreshes its buttons and "Select all", and syncs the
 * checkboxes. The delete button carries the count ("Delete 3 themes"), and progress while a
 * delete runs ("Deleting 2 of 3…"), when it's disabled and "Cancel" turns into "Stop".
 */
const updateToolbar = () => {
  syncCheckboxes();
  updateSelectAll();

  const toolbar = document.querySelector<HTMLElement>(`[${TOOLBAR_ATTR}]`);
  if (!toolbar) {
    return;
  }

  const count = selectedThemeIds.size;
  toolbar.classList.toggle('alfred-bulk-toolbar--show', count > 0 || !!progress);
  fillFixedWidthButtons(toolbar);

  const buttons: [string, string, boolean][] = [
    ['cancel', progress ? (stopRequested ? 'Stopping…' : 'Stop') : 'Cancel', !!progress && stopRequested],
    [
      'delete',
      progress ? `Deleting ${progress.current} of ${progress.total}…` : `Delete ${themeCount(count)}`,
      !!progress
    ]
  ];
  for (const [action, text, disabled] of buttons) {
    const button = toolbar.querySelector(`[data-action="${action}"]`);
    setText(button, text);
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
 * Adds a selection checkbox before each library theme's thumbnail, skipping the live theme (Shopify
 * doesn't allow deleting the published theme). Checked state comes from `selectedThemeIds` via
 * {@link syncCheckboxes}, so it survives React re-rendering the row away and Alfred re-adding it.
 *
 * Uses the page's own `s-checkbox` element (Shopify's Polaris web component, also documented
 * publicly at shopify.dev/docs/api/checkout-ui-extensions/.../forms/checkbox) rather than a
 * hand-styled `<input>`, so it matches Shopify's own checkbox design for free. `accessibilitylabel`
 * (not `label`) gives it a screen-reader-only label, since the theme's name is already visible
 * in the same row. State goes through its real inner `<input>` (see {@link checkboxInput}), and
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

    // The card's grid holds the thumbnail and the details as columns; the checkbox goes in the
    // grid's parent, ahead of it, so it doesn't take a column (laid out by `STYLES`).
    const row = theme.card.querySelector('.Polaris-InlineGrid')?.parentElement;
    if (!row || row.querySelector(`:scope > [${CHECKBOX_ATTR}]`)) {
      continue;
    }

    const checkbox = html(`
      <s-checkbox ${CHECKBOX_ATTR} data-theme-id="${theme.themeId}" accessibilitylabel="Select ${theme.name} for bulk delete"></s-checkbox>
    `);
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    checkbox.addEventListener('change', () => {
      handleCheckboxChange(theme.themeId, isCheckboxChecked(checkbox));
    });

    row.prepend(checkbox);
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
 * The theme library header's button row holding Import (and New, where the store has it), which
 * the toolbar goes at the start of. Stores with New wrap both in a "Theme actions" group; stores
 * without it have no group, and Import sits straight in the header's button row. Either way the
 * row is the nearest `InlineStack` around Import, or around New (the only button with a plus
 * icon) if Import's label is translated.
 */
const findThemeActions = () => {
  const group = document.querySelector(THEME_ACTIONS_SELECTOR);
  if (group) {
    return group;
  }
  const button =
    document.querySelector('s-internal-button[accessibilitylabel="Import themes"]') ??
    document.querySelector('s-internal-button[icon="plus"]');
  return button?.closest('.Polaris-InlineStack') ?? null;
};

/**
 * Adds the bulk-delete toolbar to the theme library's header, just before Import and New, if it
 * isn't already there (React re-renders can remove it, same as the per-theme injections). Its
 * state lives in module variables, so a re-added toolbar picks up where the old one left off,
 * even mid-delete.
 */
const injectBulkToolbar = () => {
  if (document.querySelector(`[${TOOLBAR_ATTR}]`)) {
    updateToolbar();
    return;
  }

  const actions = findThemeActions();
  if (!actions || !document.querySelector('ul[class*="ThemeList"]')) {
    return;
  }

  const toolbar = html(`
    <div ${TOOLBAR_ATTR}>
      <s-internal-button variant="secondary" data-action="cancel">Cancel</s-internal-button>
      <s-internal-button variant="primary" tone="critical" data-action="delete">Delete</s-internal-button>
    </div>
  `);
  toolbar.querySelector('[data-action="cancel"]')?.addEventListener('click', handleCancelClick);
  toolbar.querySelector('[data-action="delete"]')?.addEventListener('click', () => void confirmAndDeleteSelected());

  actions.prepend(toolbar);
  updateToolbar();
};

/**
 * Adds "Select all" right after the theme library's heading ("Draft themes"), if it isn't there
 * already. The heading is the one in the same header as Import, found by walking up from its
 * button row.
 */
const injectSelectAll = () => {
  if (document.querySelector(`[${SELECT_ALL_ATTR}]`)) {
    return;
  }

  let header = findThemeActions()?.parentElement ?? null;
  while (header && !header.querySelector('s-internal-heading')) {
    header = header.parentElement;
  }
  const heading = header?.querySelector('s-internal-heading');
  if (!heading || !document.querySelector('ul[class*="ThemeList"]')) {
    return;
  }

  const button = html(
    `<s-internal-button ${SELECT_ALL_ATTR} variant="secondary" data-action="select-all">Select all</s-internal-button>`
  );
  button.addEventListener('click', handleSelectAllClick);
  heading.after(button);
  updateSelectAll();
};

/**
 * Deletes one theme through Shopify's own admin API. The request needs the admin's session and
 * CSRF token, which this iframe doesn't have, so the background relays it to the admin page in
 * the same tab (shopify-admin.content/theme-delete.ts), which sends it.
 * @param themeId - The theme to delete.
 * @returns Whether Shopify deleted it, and why not if it didn't.
 */
const deleteOneTheme = async (themeId: string): Promise<ThemeDeleteResponse> => {
  try {
    const response = (await sendRuntimeMessage({ type: 'delete_theme', themeId })) as ThemeDeleteResponse | undefined;
    return response ?? { ok: false, error: 'The admin page gave no answer. Reload it and try again' };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
};

interface BulkDeleteResult {
  deleted: string[];
  failed: { id: string; name: string; reason: string }[];
  /** Themes never reached because the run was stopped. */
  stopped: string[];
}

/**
 * Deletes each theme in turn, so "Stop" takes effect between themes and progress stays accurate.
 * Each theme is independent: a failure on one moves on to the next. Deleted themes leave the
 * selection and are hidden from the list; failed and stopped ones stay selected to retry.
 * @param ids - Theme IDs to delete.
 * @param names - Theme names by ID, for the summary.
 */
const deleteThemes = async (ids: string[], names: Map<string, string>): Promise<BulkDeleteResult> => {
  const result: BulkDeleteResult = { deleted: [], failed: [], stopped: [] };

  for (const [index, id] of ids.entries()) {
    if (stopRequested) {
      result.stopped.push(...ids.slice(index));
      break;
    }

    progress = { current: index + 1, total: ids.length };
    updateToolbar();

    const response = await deleteOneTheme(id);
    if (response.ok) {
      result.deleted.push(id);
      selectedThemeIds.delete(id);
      deletedThemeIds.add(id);
      hideDeletedThemes();
    } else {
      const name = names.get(id) ?? id;
      console.warn(`Alfred: couldn't bulk-delete theme "${name}" (${id}): ${response.error}`);
      result.failed.push({ id, name, reason: response.error });
    }
  }

  return result;
};

/**
 * Sums up a bulk delete for the toast, e.g. "Deleted 3 themes, couldn't delete Horizon (reason)."
 * @param result - What {@link deleteThemes} returned.
 */
const summarizeBulkDelete = ({ deleted, failed, stopped }: BulkDeleteResult) => {
  const parts = [`Deleted ${themeCount(deleted.length)}`];
  if (stopped.length > 0) {
    parts.push(`stopped before ${stopped.length}`);
  }
  if (failed.length > 0) {
    parts.push(`couldn't delete ${failed.map((f) => `${f.name} (${f.reason})`).join(', ')}`);
  }
  return `${parts.join(', ')}.`;
};

/** The most theme names the confirmation lists before summing up the rest. */
const CONFIRM_NAME_LIMIT = 10;

/**
 * Confirms, then deletes every checked theme, reporting the outcome via a toast and tracking
 * how many were actually removed. Shopify asks nothing further when deleting through its API,
 * so the confirmation names every theme. The toolbar always leaves its "Deleting" state, however
 * the run ends.
 */
const confirmAndDeleteSelected = async () => {
  const ids = [...selectedThemeIds];
  if (ids.length === 0 || progress) {
    return;
  }

  const names = new Map(collectThemeElements().map((theme) => [theme.themeId, theme.name]));
  const listed = ids.slice(0, CONFIRM_NAME_LIMIT).map((id) => `• ${names.get(id) ?? id}`);
  if (ids.length > CONFIRM_NAME_LIMIT) {
    listed.push(`…and ${ids.length - CONFIRM_NAME_LIMIT} more`);
  }
  if (!confirm(`Permanently delete ${themeCount(ids.length)}? This can't be undone.\n\n${listed.join('\n')}`)) {
    return;
  }

  stopRequested = false;
  progress = { current: 0, total: ids.length };
  updateToolbar();

  let result: BulkDeleteResult;
  try {
    result = await deleteThemes(ids, names);
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
  hideDeletedThemes();
  pruneSelection();
  injectSelectAll();
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
      // A selection made on this page shouldn't still be there on returning to it.
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
    document.querySelector(`[${TOOLBAR_ATTR}]`)?.remove();
    document.querySelector(`[${SELECT_ALL_ATTR}]`)?.remove();
  });
};
